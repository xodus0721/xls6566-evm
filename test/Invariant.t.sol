// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {CommonBase} from "forge-std/Base.sol";
import {StdCheats} from "forge-std/StdCheats.sol";
import {StdUtils} from "forge-std/StdUtils.sol";
import {TestToken} from "./utils/TestToken.sol";
import {Vault} from "../src/Vault.sol";
import {LoanBroker} from "../src/LoanBroker.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @notice Drives random sequences of deposits, loans, repayments, impairments and
///         defaults against the vault + broker. Every action is guarded with try/catch so
///         a rejected precondition just no-ops instead of aborting the run.
contract Handler is CommonBase, StdCheats, StdUtils {
    bytes32 constant LOAN_TERMS_TYPEHASH = keccak256(
        "LoanTerms(address borrower,uint256 principal,uint256 interestRate,uint256 lateInterestRate,uint256 closeInterestRate,uint32 paymentInterval,uint32 gracePeriod,uint32 paymentsTotal,uint256 loanServiceFee,uint256 latePaymentFee,uint256 closePaymentFee,uint256 originationFee,uint256 nonce,uint256 deadline)"
    );

    TestToken public token;
    Vault public vault;
    LoanBroker public broker;
    address public ownerOp;

    address[3] public depositors;
    uint256[3] public borrowerPks;
    address[3] public borrowers;

    uint256[] public loanIds;

    constructor(
        TestToken token_,
        Vault vault_,
        LoanBroker broker_,
        address ownerOp_,
        address[3] memory depositors_,
        uint256[3] memory borrowerPks_
    ) {
        token = token_;
        vault = vault_;
        broker = broker_;
        ownerOp = ownerOp_;
        depositors = depositors_;
        borrowerPks = borrowerPks_;
        for (uint256 i = 0; i < 3; i++) {
            borrowers[i] = vm.addr(borrowerPks_[i]);
        }
    }

    function getLoanIds() external view returns (uint256[] memory) {
        return loanIds;
    }

    // ---------------------------------------------------------------

    function deposit(uint256 actorSeed, uint256 amt) external {
        address actor = depositors[actorSeed % 3];
        uint256 bal = token.balanceOf(actor);
        if (bal == 0) return;
        amt = bound(amt, 1, bal);
        vm.prank(actor);
        try vault.deposit(amt, actor) {} catch {}
    }

    function withdraw(uint256 actorSeed, uint256 amt) external {
        address actor = depositors[actorSeed % 3];
        uint256 maxW = vault.maxWithdraw(actor);
        if (maxW == 0) return;
        amt = bound(amt, 1, maxW);
        vm.prank(actor);
        try vault.withdraw(amt, actor, actor) {} catch {}
    }

    function addCover(uint256 amt) external {
        uint256 bal = token.balanceOf(ownerOp);
        if (bal == 0) return;
        amt = bound(amt, 1, bal);
        vm.prank(ownerOp);
        try broker.coverDeposit(amt) {} catch {}
    }

    function originate(uint256 borrowerSeed, uint256 principalSeed) external {
        uint256 avail = vault.assetsAvailable();
        if (avail < 1e18) return;
        uint256 idx = borrowerSeed % 3;
        address borrower = borrowers[idx];
        uint256 principal = bound(principalSeed, 1e18, avail);

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
        bytes memory sig = _sign(borrowerPks[idx], t);
        vm.prank(ownerOp);
        try broker.originate(t, sig) returns (uint256 id) {
            loanIds.push(id);
        } catch {}
    }

    function payLoan(uint256 loanSeed) external {
        (uint256 id, bool found) = _pickActive(loanSeed);
        if (!found) return;
        LoanBroker.Loan memory l = broker.getLoan(id);
        if (block.timestamp < l.nextPaymentDueDate) vm.warp(l.nextPaymentDueDate);
        vm.prank(l.borrower);
        try broker.pay(id, type(uint128).max) {} catch {}
    }

    function closeLoan(uint256 loanSeed) external {
        (uint256 id, bool found) = _pickActive(loanSeed);
        if (!found) return;
        LoanBroker.Loan memory l = broker.getLoan(id);
        vm.prank(l.borrower);
        try broker.closeLoan(id) {} catch {}
    }

    function impairLoan(uint256 loanSeed) external {
        (uint256 id, bool found) = _pickActive(loanSeed);
        if (!found) return;
        LoanBroker.Loan memory l = broker.getLoan(id);
        vm.warp(uint256(l.nextPaymentDueDate) + 1);
        vm.prank(ownerOp);
        try broker.impair(id) {} catch {}
    }

    function defaultLoan(uint256 loanSeed) external {
        (uint256 id, bool found) = _pickActive(loanSeed);
        if (!found) return;
        LoanBroker.Loan memory l = broker.getLoan(id);
        vm.warp(uint256(l.nextPaymentDueDate) + l.gracePeriod + 1);
        vm.prank(ownerOp);
        try broker.default_(id) {} catch {}
    }

    function passTime(uint256 delta) external {
        vm.warp(block.timestamp + bound(delta, 1, 40 days));
    }

    // ---------------------------------------------------------------

    function _pickActive(uint256 seed) internal view returns (uint256 id, bool found) {
        uint256 n = loanIds.length;
        for (uint256 i = 0; i < n; i++) {
            uint256 cand = loanIds[(seed + i) % n];
            uint8 s = broker.getLoan(cand).status;
            if (s == 0 || s == 1) return (cand, true);
        }
        return (0, false);
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

contract LendingInvariants is Test {
    uint256 constant UNIT = 1e18;

    TestToken token;
    Vault vault;
    LoanBroker broker;
    Handler handler;

    address ownerOp = address(0x0BEE);
    address[3] depositors = [address(0xD1), address(0xD2), address(0xD3)];
    uint256[3] borrowerPks = [uint256(0xB1), uint256(0xB2), uint256(0xB3)];

    address[] accounts;
    uint256 totalMinted;

    function setUp() public {
        token = new TestToken();
        vault = new Vault(IERC20(address(token)), "V", "V", address(this), false, 0, 6);
        broker = new LoanBroker(vault, ownerOp, 0, 1_000, 10_000, 100_000, 0);
        vault.grantRole(vault.PROTOCOL_ROLE(), address(broker));

        handler = new Handler(token, vault, broker, ownerOp, depositors, borrowerPks);

        // Non-funded token holders (they only ever receive tokens from flows).
        accounts.push(address(vault));
        accounts.push(address(broker));
        // Funded actors are pushed by _fund.
        _fund(ownerOp, 100_000 * UNIT);
        for (uint256 i = 0; i < 3; i++) {
            _fund(depositors[i], 100_000 * UNIT);
            address b = vm.addr(borrowerPks[i]);
            _fund(b, 100_000 * UNIT);
        }

        // Approvals (owner approves broker for cover; depositors approve vault; borrowers
        // approve broker for repayment).
        vm.prank(ownerOp);
        token.approve(address(broker), type(uint256).max);
        for (uint256 i = 0; i < 3; i++) {
            vm.prank(depositors[i]);
            token.approve(address(vault), type(uint256).max);
            address b = vm.addr(borrowerPks[i]);
            vm.prank(b);
            token.approve(address(broker), type(uint256).max);
        }

        targetContract(address(handler));
    }

    function _fund(address who, uint256 amt) internal {
        token.mint(who, amt);
        totalMinted += amt;
        accounts.push(who);
    }

    // -----------------------------------------------------------------
    // Invariants
    // -----------------------------------------------------------------

    /// Nothing is minted or destroyed outside setUp.
    function invariant_tokenConservation() public view {
        uint256 sum;
        for (uint256 i = 0; i < accounts.length; i++) {
            sum += token.balanceOf(accounts[i]);
        }
        assertEq(sum, totalMinted);
    }

    /// totalAssets is exactly the idle balance plus what is out on loan.
    function invariant_totalAssetsIdentity() public view {
        assertEq(vault.totalAssets(), token.balanceOf(address(vault)) + vault.assetsOnLoan());
    }

    /// The vault's on-loan figure equals the sum of active loan principals.
    function invariant_onLoanEqualsActivePrincipal() public view {
        uint256[] memory ids = handler.getLoanIds();
        uint256 principalSum;
        for (uint256 i = 0; i < ids.length; i++) {
            LoanBroker.Loan memory l = broker.getLoan(ids[i]);
            if (l.status == 0 || l.status == 1) principalSum += l.principalOutstanding;
        }
        assertEq(vault.assetsOnLoan(), principalSum);
    }

    /// The broker always physically holds at least the first-loss capital it reports.
    function invariant_coverIsBacked() public view {
        assertGe(token.balanceOf(address(broker)), broker.coverAvailable());
    }

    /// Unrealized loss can never exceed the vault's assets.
    function invariant_lossBounded() public view {
        assertLe(vault.lossUnrealized(), vault.totalAssets());
    }

    function invariant_callSummary() public view {
        // touch to keep the handler referenced; no assertion.
        handler.getLoanIds();
    }
}
