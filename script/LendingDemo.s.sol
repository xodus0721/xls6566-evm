// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script} from "forge-std/Script.sol";
import {console2} from "forge-std/console2.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Vault} from "../src/Vault.sol";
import {LoanBroker} from "../src/LoanBroker.sol";

contract DemoUSD is ERC20 {
    constructor() ERC20("Demo USD", "dUSD") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

/// @notice Shared harness for the XLS-65/66 EVM lending demo. Deploys a token, a Vault and
///         a LoanBroker on the local EVM, wires three roles (depositor, broker, borrower),
///         and prints a readable ledger snapshot after each step. The concrete scenarios
///         (A = full repayment, B = default) live in the sibling scripts.
///
///         Run (no broadcast needed — it simulates against a fresh in-memory EVM):
///           forge script script/ScenarioA.s.sol -vv
///           forge script script/ScenarioB.s.sol -vv
abstract contract LendingDemo is Script {
    uint256 internal constant UNIT = 1e18;

    bytes32 internal constant LOAN_TERMS_TYPEHASH = keccak256(
        "LoanTerms(address borrower,uint256 principal,uint256 interestRate,uint256 lateInterestRate,uint256 closeInterestRate,uint32 paymentInterval,uint32 gracePeriod,uint32 paymentsTotal,uint256 loanServiceFee,uint256 latePaymentFee,uint256 closePaymentFee,uint256 originationFee,uint256 nonce,uint256 deadline)"
    );

    DemoUSD internal token;
    Vault internal vault;
    LoanBroker internal broker;

    address internal admin = makeAddr("admin"); // vault admin / deployer role
    address internal opAddr = makeAddr("brokerOp");
    address internal alice = makeAddr("alice"); // depositor
    uint256 internal borrowerPk = 0xB0B0B0;
    address internal bob; // borrower

    // Scenario knobs.
    uint32 internal constant INTERVAL = 30 days;
    uint32 internal constant PAYMENTS = 12;
    uint256 internal constant INTEREST = 12_000; // 12% annual (1/10th bps)

    function _setUp() internal {
        bob = vm.addr(borrowerPk);

        token = new DemoUSD();
        vault = new Vault(IERC20(address(token)), "Demo Vault", "dVLT", admin, false, 0, 6);
        broker = new LoanBroker(
            vault,
            opAddr,
            0, // debtMaximum unlimited
            1_000, // management fee 1%
            10_000, // cover minimum 10%
            100_000, // cover liquidation 100%
            0 // cover floor 0% (spec default)
        );
        bytes32 protocolRole = vault.PROTOCOL_ROLE();
        vm.prank(admin);
        vault.grantRole(protocolRole, address(broker));

        _fund(alice, 100_000 * UNIT);
        _fund(opAddr, 50_000 * UNIT);
        _fund(bob, 50_000 * UNIT);

        _approve(alice);
        _approve(opAddr);
        _approve(bob);
    }

    function _fund(address who, uint256 amt) private {
        token.mint(who, amt);
    }

    function _approve(address who) private {
        vm.startPrank(who);
        token.approve(address(vault), type(uint256).max);
        token.approve(address(broker), type(uint256).max);
        vm.stopPrank();
    }

    // ------------------------------------------------------------------
    // Actions
    // ------------------------------------------------------------------

    function _deposit(address who, uint256 amt) internal {
        vm.prank(who);
        vault.deposit(amt, who);
    }

    function _coverDeposit(uint256 amt) internal {
        vm.prank(opAddr);
        broker.coverDeposit(amt);
    }

    function _originate(uint256 principal) internal returns (uint256 loanId) {
        LoanBroker.LoanTerms memory t = LoanBroker.LoanTerms({
            borrower: bob,
            principal: principal,
            interestRate: INTEREST,
            lateInterestRate: 24_000,
            closeInterestRate: 2_000,
            paymentInterval: INTERVAL,
            gracePeriod: 7 days,
            paymentsTotal: PAYMENTS,
            loanServiceFee: 0,
            latePaymentFee: 0,
            closePaymentFee: 0,
            originationFee: 0,
            nonce: broker.nonces(bob),
            deadline: block.timestamp + 1 days
        });
        bytes memory sig = _sign(t);
        vm.prank(opAddr);
        loanId = broker.originate(t, sig);
    }

    function _payOnce(uint256 loanId) internal {
        vm.warp(broker.getLoan(loanId).nextPaymentDueDate);
        vm.prank(bob);
        broker.pay(loanId, 100_000 * UNIT); // pulls only what is due
    }

    function _sign(LoanBroker.LoanTerms memory t) private view returns (bytes memory) {
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

    // ------------------------------------------------------------------
    // Reporting
    // ------------------------------------------------------------------

    /// @dev Whole-token view (integer part) for readable logs.
    function _t(uint256 wad) internal pure returns (uint256) {
        return wad / UNIT;
    }

    function _snapshot(string memory title) internal view {
        console2.log("");
        console2.log(string.concat("== ", title, " =="));
        console2.log("  Vault  total assets   :", _t(vault.totalAssets()));
        console2.log("  Vault  available (idle):", _t(vault.assetsAvailable()));
        console2.log("  Vault  on loan         :", _t(vault.assetsOnLoan()));
        console2.log("  Vault  unrealized loss :", _t(vault.lossUnrealized()));
        console2.log("  Broker cover available :", _t(broker.coverAvailable()));
        console2.log("  Broker debt total      :", _t(broker.debtTotal()));
        console2.log("  Alice  dUSD balance    :", _t(token.balanceOf(alice)));
        console2.log("  Alice  vault shares    :", _t(vault.balanceOf(alice)));
        console2.log("  Alice  withdrawable    :", _t(vault.maxWithdraw(alice)));
        console2.log("  Bob    dUSD balance    :", _t(token.balanceOf(bob)));
    }

    function _line() internal pure {
        console2.log("--------------------------------------------------");
    }
}
