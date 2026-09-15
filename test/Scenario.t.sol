// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {TestToken} from "./utils/TestToken.sol";
import {Vault} from "../src/Vault.sol";
import {LoanBroker} from "../src/LoanBroker.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @notice End-to-end multi-actor scenario: two depositors, two loans, partial repayment,
///         one default, then withdrawals — asserting cross-contract accounting and token
///         conservation at every major step.
contract ScenarioTest is Test {
    uint256 constant UNIT = 1e18;

    bytes32 constant LOAN_TERMS_TYPEHASH = keccak256(
        "LoanTerms(address borrower,uint256 principal,uint256 interestRate,uint256 lateInterestRate,uint256 closeInterestRate,uint32 paymentInterval,uint32 gracePeriod,uint32 paymentsTotal,uint256 loanServiceFee,uint256 latePaymentFee,uint256 closePaymentFee,uint256 originationFee,uint256 nonce,uint256 deadline)"
    );

    TestToken token;
    Vault vault;
    LoanBroker broker;

    address ownerOp = address(0x0BEE);
    address dep1 = address(0xD1);
    address dep2 = address(0xD2);
    uint256 pk1 = 0xB0110A1;
    uint256 pk2 = 0xB0110A2;
    address bor1;
    address bor2;

    uint256 totalMinted;
    address[] accounts;

    function setUp() public {
        bor1 = vm.addr(pk1);
        bor2 = vm.addr(pk2);

        token = new TestToken();
        vault = new Vault(IERC20(address(token)), "V", "V", address(this), false, 0, 6);
        broker = new LoanBroker(vault, ownerOp, 0, 1_000, 10_000, 100_000, 0);
        vault.grantRole(vault.PROTOCOL_ROLE(), address(broker));

        accounts = [dep1, dep2, bor1, bor2, ownerOp, address(vault), address(broker)];

        _mint(dep1, 40_000 * UNIT);
        _mint(dep2, 40_000 * UNIT);
        _mint(bor1, 20_000 * UNIT);
        _mint(bor2, 20_000 * UNIT);
        _mint(ownerOp, 10_000 * UNIT);

        _approveAll(dep1);
        _approveAll(dep2);
        _approveAll(bor1);
        _approveAll(bor2);
        vm.prank(ownerOp);
        token.approve(address(broker), type(uint256).max);
    }

    function _mint(address to, uint256 amt) internal {
        token.mint(to, amt);
        totalMinted += amt;
    }

    function _approveAll(address who) internal {
        vm.startPrank(who);
        token.approve(address(vault), type(uint256).max);
        token.approve(address(broker), type(uint256).max);
        vm.stopPrank();
    }

    // -----------------------------------------------------------------
    // The scenario
    // -----------------------------------------------------------------

    function test_endToEnd() public {
        // 1. Both depositors fund the vault.
        vm.prank(dep1);
        vault.deposit(30_000 * UNIT, dep1);
        vm.prank(dep2);
        vault.deposit(20_000 * UNIT, dep2);
        _checkAll();
        assertEq(vault.totalAssets(), 50_000 * UNIT);

        // 2. Broker deposits first-loss capital.
        vm.prank(ownerOp);
        broker.coverDeposit(5_000 * UNIT);
        _checkAll();

        // 3. Originate two loans.
        uint256 loan1 = _originate(pk1, bor1, 12_000 * UNIT);
        uint256 loan2 = _originate(pk2, bor2, 8_000 * UNIT);
        _checkAll();
        assertEq(vault.assetsOnLoan(), 20_000 * UNIT, "both principals lent");
        assertEq(vault.totalAssets(), 50_000 * UNIT, "total unchanged by lending");

        // 4. Borrower 1 pays 4 installments on time.
        for (uint256 i = 0; i < 4; i++) {
            vm.warp(broker.getLoan(loan1).nextPaymentDueDate);
            vm.prank(bor1);
            broker.pay(loan1, 12_000 * UNIT);
            _checkAll();
        }
        assertLt(broker.getLoan(loan1).principalOutstanding, 12_000 * UNIT, "loan1 amortizing");

        // 5. Borrower 2 never pays and defaults after grace.
        LoanBroker.Loan memory l2 = broker.getLoan(loan2);
        vm.warp(uint256(l2.nextPaymentDueDate) + l2.gracePeriod + 1);
        uint256 coverBefore = broker.coverAvailable();
        uint256 totalBefore = vault.totalAssets();
        vm.prank(ownerOp);
        broker.default_(loan2);
        _checkAll();

        uint256 coverUsed = coverBefore - broker.coverAvailable();
        uint256 depLoss = totalBefore - vault.totalAssets();
        assertApproxEqAbs(coverUsed + depLoss, 8_000 * UNIT, 1e12, "waterfall conserves loan2 principal");

        // 6. Depositor 1 withdraws part of their position (liquidity permitting).
        uint256 maxW = vault.maxWithdraw(dep1);
        assertGt(maxW, 0);
        vm.prank(dep1);
        vault.withdraw(maxW / 2, dep1, dep1);
        _checkAll();

        // 7. Finish loan1 to term.
        while (broker.getLoan(loan1).paymentsRemaining > 0) {
            vm.warp(broker.getLoan(loan1).nextPaymentDueDate);
            vm.prank(bor1);
            broker.pay(loan1, 12_000 * UNIT);
        }
        _checkAll();
        assertEq(broker.getLoan(loan1).status, 1 << 2, "loan1 closed");
        assertEq(vault.assetsOnLoan(), 0, "no loans outstanding");
    }

    // -----------------------------------------------------------------
    // Cross-contract accounting checks (run after every step)
    // -----------------------------------------------------------------

    function _checkAll() internal view {
        // Token conservation: nothing minted or burned outside setup.
        uint256 sum;
        for (uint256 i = 0; i < accounts.length; i++) {
            sum += token.balanceOf(accounts[i]);
        }
        assertEq(sum, totalMinted, "token conservation");

        // Vault two-view identity.
        assertEq(
            vault.totalAssets(),
            token.balanceOf(address(vault)) + vault.assetsOnLoan(),
            "totalAssets = idle + onLoan"
        );

        // assetsOnLoan equals the sum of active loan principals.
        uint256 principalSum;
        uint256 debtSum;
        for (uint256 id = 1; id <= broker.loanSequence(); id++) {
            LoanBroker.Loan memory l = broker.getLoan(id);
            if (l.status == 0 || l.status == 1) {
                // ACTIVE or IMPAIRED
                principalSum += l.principalOutstanding;
                uint256 netInterest =
                    l.totalValueOutstanding - l.principalOutstanding - l.mgmtFeeOutstanding;
                debtSum += l.principalOutstanding + netInterest;
            }
        }
        assertEq(vault.assetsOnLoan(), principalSum, "onLoan = sum active principals");
        assertApproxEqAbs(broker.debtTotal(), debtSum, 1e12, "debtTotal = sum active debt");

        // Broker holds at least its declared first-loss capital.
        assertGe(token.balanceOf(address(broker)), broker.coverAvailable(), "cover is backed");

        // Unrealized loss never exceeds vault assets.
        assertLe(vault.lossUnrealized(), vault.totalAssets(), "loss bounded by assets");
    }

    // -----------------------------------------------------------------
    // Origination helper (EIP-712)
    // -----------------------------------------------------------------

    function _originate(uint256 pk, address borrower, uint256 principal)
        internal
        returns (uint256 loanId)
    {
        LoanBroker.LoanTerms memory t = LoanBroker.LoanTerms({
            borrower: borrower,
            principal: principal,
            interestRate: 12_000,
            lateInterestRate: 24_000,
            closeInterestRate: 2_000,
            paymentInterval: 30 days,
            gracePeriod: 7 days,
            paymentsTotal: 12,
            loanServiceFee: 0,
            latePaymentFee: 0,
            closePaymentFee: 0,
            originationFee: 0,
            nonce: broker.nonces(borrower),
            deadline: block.timestamp + 1 days
        });
        bytes memory sig = _sign(pk, t);
        vm.prank(ownerOp);
        loanId = broker.originate(t, sig);
    }

    function _sign(uint256 pk, LoanBroker.LoanTerms memory t) internal view returns (bytes memory) {
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
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        return abi.encodePacked(r, s, v);
    }
}
