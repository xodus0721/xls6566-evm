// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {Vault} from "../src/Vault.sol";
import {LoanBroker} from "../src/LoanBroker.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

contract MockERC20 is ERC20 {
    constructor() ERC20("Mock USD", "mUSD") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

contract LoanBrokerTest is Test {
    uint256 constant UNIT = 1e18;
    uint256 constant TOL = 1e14; // 0.01%

    bytes32 constant LOAN_TERMS_TYPEHASH = keccak256(
        "LoanTerms(address borrower,uint256 principal,uint256 interestRate,uint256 lateInterestRate,uint256 closeInterestRate,uint32 paymentInterval,uint32 gracePeriod,uint32 paymentsTotal,uint256 loanServiceFee,uint256 latePaymentFee,uint256 closePaymentFee,uint256 originationFee,uint256 nonce,uint256 deadline)"
    );

    MockERC20 asset;
    Vault vault;
    LoanBroker broker;

    address admin = address(this);
    address ownerOp = address(0x0BEE); // broker operator
    address depositor = address(0xD3);
    uint256 borrowerPk = 0xA11CE;
    address borrower;

    uint32 constant INTERVAL = 30 days;
    uint32 constant PAYMENTS = 12;
    uint256 constant INTEREST = 12_000; // 12% annual (1/10th bps)
    uint256 constant PRINCIPAL = 12_000 * UNIT;
    uint256 constant DEPOSIT = 30_000 * UNIT;
    uint256 constant COVER = 3_000 * UNIT;

    function setUp() public {
        borrower = vm.addr(borrowerPk);
        asset = new MockERC20();

        vault = new Vault(IERC20(address(asset)), "V", "V", admin, false, 0, 6);
        broker = new LoanBroker(
            vault,
            ownerOp,
            0, // debtMaximum unlimited
            1_000, // mgmt fee 1%
            10_000, // cover minimum 10%
            100_000, // cover liquidation 100%
            0 // cover floor 0% (spec default)
        );
        vault.grantRole(vault.PROTOCOL_ROLE(), address(broker));

        // Fund vault.
        asset.mint(depositor, DEPOSIT);
        vm.startPrank(depositor);
        asset.approve(address(vault), type(uint256).max);
        vault.deposit(DEPOSIT, depositor);
        vm.stopPrank();

        // Fund broker cover.
        asset.mint(ownerOp, COVER);
        vm.startPrank(ownerOp);
        asset.approve(address(broker), type(uint256).max);
        broker.coverDeposit(COVER);
        vm.stopPrank();

        // Borrower funds to repay.
        asset.mint(borrower, 50_000 * UNIT);
        vm.prank(borrower);
        asset.approve(address(broker), type(uint256).max);
    }

    // -----------------------------------------------------------------
    // EIP-712 helpers
    // -----------------------------------------------------------------

    function _terms() internal view returns (LoanBroker.LoanTerms memory t) {
        t = LoanBroker.LoanTerms({
            borrower: borrower,
            principal: PRINCIPAL,
            interestRate: INTEREST,
            lateInterestRate: 24_000, // 24% annual
            closeInterestRate: 2_000, // 2% prepayment penalty
            paymentInterval: INTERVAL,
            gracePeriod: 7 days,
            paymentsTotal: PAYMENTS,
            loanServiceFee: 0,
            latePaymentFee: 0,
            closePaymentFee: 0,
            originationFee: 0,
            nonce: broker.nonces(borrower),
            deadline: block.timestamp + 1 days
        });
    }

    function _sign(LoanBroker.LoanTerms memory t) internal view returns (bytes memory) {
        bytes32 structHash = keccak256(
            abi.encode(
                LOAN_TERMS_TYPEHASH,
                t.borrower,
                t.principal,
                t.interestRate,
                t.lateInterestRate,
                t.closeInterestRate,
                t.paymentInterval,
                t.gracePeriod,
                t.paymentsTotal,
                t.loanServiceFee,
                t.latePaymentFee,
                t.closePaymentFee,
                t.originationFee,
                t.nonce,
                t.deadline
            )
        );
        bytes32 domainSeparator = keccak256(
            abi.encode(
                keccak256(
                    "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"
                ),
                keccak256(bytes("XLS66-LoanBroker")),
                keccak256(bytes("1")),
                block.chainid,
                address(broker)
            )
        );
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", domainSeparator, structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(borrowerPk, digest);
        return abi.encodePacked(r, s, v);
    }

    function _originate() internal returns (uint256 loanId) {
        LoanBroker.LoanTerms memory t = _terms();
        bytes memory sig = _sign(t);
        vm.prank(ownerOp);
        loanId = broker.originate(t, sig);
    }

    function _originateCustom(uint256 principal, uint256 interestRate)
        internal
        returns (uint256 loanId)
    {
        LoanBroker.LoanTerms memory t = _terms();
        t.principal = principal;
        t.interestRate = interestRate;
        bytes memory sig = _sign(t);
        vm.prank(ownerOp);
        loanId = broker.originate(t, sig);
    }

    // -----------------------------------------------------------------
    // Origination
    // -----------------------------------------------------------------

    function test_originate_disbursesAndTracksDebt() public {
        uint256 loanId = _originate();

        // Borrower started with 50k mint, receives full principal (no origination fee).
        assertEq(asset.balanceOf(borrower), 50_000 * UNIT + PRINCIPAL, "borrower funded");
        assertEq(vault.assetsOnLoan(), PRINCIPAL, "vault lent principal");
        assertEq(vault.totalAssets(), DEPOSIT, "total unchanged (idle -> onLoan)");

        LoanBroker.Loan memory l = broker.getLoan(loanId);
        assertEq(l.principalOutstanding, PRINCIPAL);
        assertGt(l.totalValueOutstanding, PRINCIPAL, "TVO includes interest");
        assertGt(broker.debtTotal(), PRINCIPAL, "debt = principal + net interest");
    }

    function test_originate_rejectsBadSignature() public {
        LoanBroker.LoanTerms memory t = _terms();
        bytes memory sig = _sign(t);
        t.principal = PRINCIPAL + 1; // tamper after signing
        vm.prank(ownerOp);
        vm.expectRevert(LoanBroker.BadSignature.selector);
        broker.originate(t, sig);
    }

    // -----------------------------------------------------------------
    // Full repayment
    // -----------------------------------------------------------------

    function test_fullRepayment_returnsPrincipalPlusInterest() public {
        uint256 loanId = _originate();
        uint256 ownerBefore = asset.balanceOf(ownerOp);

        for (uint256 i = 0; i < PAYMENTS; i++) {
            vm.warp(broker.getLoan(loanId).nextPaymentDueDate); // on-time
            vm.prank(borrower);
            broker.pay(loanId, PRINCIPAL); // amount >= due; contract pulls only what's due
        }

        LoanBroker.Loan memory l = broker.getLoan(loanId);
        assertEq(l.principalOutstanding, 0, "principal fully repaid");
        assertEq(l.status, 1 << 2, "STATUS_CLOSED");
        assertEq(vault.assetsOnLoan(), 0, "nothing left on loan");
        assertGt(vault.totalAssets(), DEPOSIT, "depositors earned net interest");
        assertGt(asset.balanceOf(ownerOp), ownerBefore, "broker earned management fees");
        assertApproxEqAbs(broker.debtTotal(), 0, 1e12, "debt cleared");
    }

    // -----------------------------------------------------------------
    // Impairment
    // -----------------------------------------------------------------

    function test_impair_booksUnrealizedLoss() public {
        uint256 loanId = _originate();

        // Warp past first due date without paying.
        vm.warp(uint256(broker.getLoan(loanId).nextPaymentDueDate) + 1);

        vm.prank(ownerOp);
        broker.impair(loanId);

        assertGt(vault.lossUnrealized(), 0, "vault marks paper loss");
        assertEq(vault.lossUnrealized(), broker.getLoan(loanId).impairedAmount, "loss == booked impairment");

        // Unimpair reverses it.
        vm.prank(ownerOp);
        broker.unimpair(loanId);
        assertEq(vault.lossUnrealized(), 0, "loss reversed");
    }

    function test_impair_revertsBeforeDue() public {
        uint256 loanId = _originate();
        vm.prank(ownerOp);
        vm.expectRevert(abi.encodeWithSelector(LoanBroker.NotYetImpairable.selector, loanId));
        broker.impair(loanId);
    }

    // -----------------------------------------------------------------
    // Default + first-loss waterfall
    // -----------------------------------------------------------------

    function test_default_waterfall_coverAbsorbsThenDepositors() public {
        uint256 loanId = _originate();

        uint256 coverBefore = broker.coverAvailable();
        uint256 totalBefore = vault.totalAssets(); // == DEPOSIT

        // Warp past due + grace, never paid.
        LoanBroker.Loan memory l0 = broker.getLoan(loanId);
        vm.warp(uint256(l0.nextPaymentDueDate) + l0.gracePeriod + 1);

        vm.prank(ownerOp);
        broker.default_(loanId);

        LoanBroker.Loan memory l = broker.getLoan(loanId);
        assertEq(l.principalOutstanding, 0);
        assertEq(l.status, 1 << 1, "STATUS_DEFAULTED");

        uint256 coverUsed = coverBefore - broker.coverAvailable();
        uint256 depositorLoss = totalBefore - vault.totalAssets();

        assertGt(coverUsed, 0, "first-loss capital absorbed part");
        assertGt(depositorLoss, 0, "depositors bore the rest");

        // Core waterfall invariant: coverUsed + depositorLoss == principal lent.
        assertApproxEqAbs(coverUsed + depositorLoss, PRINCIPAL, 1e12, "waterfall conserves principal");
    }

    function test_default_revertsBeforeGrace() public {
        uint256 loanId = _originate();
        LoanBroker.Loan memory l = broker.getLoan(loanId);
        vm.warp(uint256(l.nextPaymentDueDate) + l.gracePeriod - 1);
        vm.prank(ownerOp);
        vm.expectRevert(abi.encodeWithSelector(LoanBroker.NotYetDefaultable.selector, loanId));
        broker.default_(loanId);
    }

    // -----------------------------------------------------------------
    // Cover-rate floor (depositor protection)
    // -----------------------------------------------------------------

    function test_coverFloor_constructorRejectsBelowFloor() public {
        // minimum 3% below a 5% floor must revert at deployment.
        vm.expectRevert(
            abi.encodeWithSelector(LoanBroker.CoverRateBelowFloor.selector, uint256(3e16), uint256(5e16))
        );
        new LoanBroker(vault, ownerOp, 0, 1_000, 3_000, 100_000, 5_000);
    }

    function test_coverFloor_cannotLowerBelowFloor() public {
        // Broker deployed with a 5% floor and 10% minimum.
        LoanBroker b = new LoanBroker(vault, ownerOp, 0, 1_000, 10_000, 100_000, 5_000);
        assertEq(b.coverRateFloorWad(), 5e16);

        // Lowering to 4% (below the 5% floor) is rejected — no post-hoc rug.
        vm.prank(ownerOp);
        vm.expectRevert(
            abi.encodeWithSelector(LoanBroker.CoverRateBelowFloor.selector, uint256(4e16), uint256(5e16))
        );
        b.setCoverRates(4_000, 100_000);

        // Lowering to exactly the floor is allowed.
        vm.prank(ownerOp);
        b.setCoverRates(5_000, 100_000);
        assertEq(b.coverRateMinimumWad(), 5e16);
    }

    // -----------------------------------------------------------------
    // Early full repayment
    // -----------------------------------------------------------------

    function test_closeLoan_earlyRepayment() public {
        uint256 loanId = _originate();

        // Close 15 days into the first period.
        vm.warp(block.timestamp + 15 days);
        uint256 borrowerBefore = asset.balanceOf(borrower);

        vm.prank(borrower);
        broker.closeLoan(loanId);

        LoanBroker.Loan memory l = broker.getLoan(loanId);
        assertEq(l.principalOutstanding, 0, "loan cleared");
        assertEq(l.status, 1 << 2, "STATUS_CLOSED");
        assertEq(vault.assetsOnLoan(), 0, "principal returned");
        assertApproxEqAbs(broker.debtTotal(), 0, 1e12, "debt cleared");

        // Borrower paid more than the principal (accrued interest + prepayment penalty).
        uint256 paid = borrowerBefore - asset.balanceOf(borrower);
        assertGt(paid, PRINCIPAL, "paid principal + interest + penalty");

        // Vault recovered principal plus some net interest.
        assertGt(vault.totalAssets(), DEPOSIT, "vault earned early-close interest");
    }

    function test_closeLoan_onlyBorrower() public {
        uint256 loanId = _originate();
        vm.warp(block.timestamp + 15 days);
        vm.prank(ownerOp);
        vm.expectRevert(abi.encodeWithSelector(LoanBroker.NotBorrower.selector, loanId));
        broker.closeLoan(loanId);
    }

    // -----------------------------------------------------------------
    // Review regressions
    // -----------------------------------------------------------------

    /// #4: zero-interest loan with an indivisible principal must originate (no underflow).
    function test_regression_zeroInterestLoan() public {
        // 10,000 / 12 is not integral.
        uint256 loanId = _originateCustom(10_000 * UNIT, 0);
        LoanBroker.Loan memory l = broker.getLoan(loanId);
        assertEq(l.totalValueOutstanding, 10_000 * UNIT, "no interest: TVO == principal");
        assertEq(l.mgmtFeeOutstanding, 0);

        // Repay to term; vault gets back exactly the principal (zero net interest).
        for (uint256 i = 0; i < PAYMENTS; i++) {
            vm.warp(broker.getLoan(loanId).nextPaymentDueDate);
            vm.prank(borrower);
            broker.pay(loanId, 20_000 * UNIT);
        }
        assertEq(broker.getLoan(loanId).principalOutstanding, 0);
        assertApproxEqAbs(vault.totalAssets(), DEPOSIT, 1e6, "no interest earned");
    }

    /// #3: paying an impaired loan reduces the booked unrealized loss in step.
    function test_regression_impairedPaymentSyncsLoss() public {
        uint256 loanId = _originate();
        vm.warp(uint256(broker.getLoan(loanId).nextPaymentDueDate) + 1);
        vm.prank(ownerOp);
        broker.impair(loanId);

        uint256 lossBefore = vault.lossUnrealized();
        assertEq(lossBefore, PRINCIPAL, "impair books principal only (#2)");

        // Borrower makes a (late) payment.
        vm.prank(borrower);
        broker.pay(loanId, 20_000 * UNIT);

        uint256 lossAfter = vault.lossUnrealized();
        assertLt(lossAfter, lossBefore, "loss syncs down with principal repaid");
        assertEq(lossAfter, broker.getLoan(loanId).impairedAmount, "impairedAmount stays in step");
        assertEq(lossAfter, broker.getLoan(loanId).principalOutstanding, "== remaining principal");
    }

    /// #1: a late payment must not permanently inflate debtTotal.
    function test_regression_latePaymentNoDebtLeak() public {
        uint256 loanId = _originate();
        // Pay first installment well past the due date (late).
        vm.warp(uint256(broker.getLoan(loanId).nextPaymentDueDate) + 10 days);
        vm.prank(borrower);
        broker.pay(loanId, 20_000 * UNIT);

        // debtTotal must equal this loan's remaining principal + net interest, with no
        // late-interest residue left behind.
        LoanBroker.Loan memory l = broker.getLoan(loanId);
        uint256 netInterestOut = l.totalValueOutstanding - l.principalOutstanding - l.mgmtFeeOutstanding;
        assertApproxEqAbs(
            broker.debtTotal(), l.principalOutstanding + netInterestOut, 1e12, "no debt leak"
        );
    }
}
