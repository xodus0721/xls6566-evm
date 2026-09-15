// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {console2} from "forge-std/console2.sol";
import {LendingDemo} from "./LendingDemo.s.sol";
import {LoanBroker} from "../src/LoanBroker.sol";

/// @notice Scenario B — default with loss.
///         Deposit -> lend -> mark impaired -> default (first-loss waterfall) ->
///         depositor withdraws after cover depletion, taking a loss.
///         Run: forge script script/ScenarioB.s.sol -vv
contract ScenarioB is LendingDemo {
    function run() external {
        _setUp();

        console2.log("############################################");
        console2.log("# XLS-65/66 EVM demo - Scenario B (default)");
        console2.log("############################################");

        uint256 aliceStart = token.balanceOf(alice);

        // 1. Alice funds the vault.
        _deposit(alice, 50_000 * UNIT);
        _snapshot("1. Alice deposits 50,000 dUSD");

        // 2. Broker posts a first-loss buffer big enough to originate, but far below the
        //    eventual default loss (only ~min-cover gets liquidated on default).
        _coverDeposit(4_000 * UNIT);
        _snapshot("2. Broker deposits 4,000 cover");

        // 3. Originate a 30,000 loan to Bob.
        uint256 loanId = _originate(30_000 * UNIT);
        _snapshot("3. Originate 30,000 loan to Bob");

        // 4. Bob never pays. Once overdue, the broker marks the loan impaired: the vault
        //    reports a conservative (lower) value to depositors immediately.
        vm.warp(uint256(broker.getLoan(loanId).nextPaymentDueDate) + 1);
        vm.prank(opAddr);
        broker.impair(loanId);
        _snapshot("4. Broker marks the loan impaired");
        console2.log("   -> 30,000 unrealized loss booked; the vault's redemption value is");
        console2.log("      immediately suppressed (here withdrawable is also liquidity-capped).");

        // 5. After the grace period the loan defaults. First-loss waterfall:
        //    cover is consumed first, depositors absorb the remainder.
        uint256 coverBefore = broker.coverAvailable();
        uint256 totalBefore = vault.totalAssets();
        LoanBroker.Loan memory l = broker.getLoan(loanId);
        vm.warp(uint256(l.nextPaymentDueDate) + l.gracePeriod + 1);
        vm.prank(opAddr);
        broker.default_(loanId);
        _snapshot("5. Loan defaults (first-loss waterfall)");

        uint256 coverUsed = coverBefore - broker.coverAvailable();
        uint256 depositorLoss = totalBefore - vault.totalAssets();
        console2.log("   waterfall  cover absorbed   :", _t(coverUsed));
        console2.log("   waterfall  depositors absorb :", _t(depositorLoss));
        console2.log("   (cover absorbed + depositor loss == 30,000 principal lent)");

        // 6. Alice withdraws whatever is left.
        uint256 out = vault.maxWithdraw(alice);
        vm.prank(alice);
        vault.withdraw(out, alice, alice);
        _snapshot("6. Alice withdraws what remains");

        _line();
        uint256 aliceEnd = token.balanceOf(alice);
        if (aliceEnd >= aliceStart) {
            console2.log("RESULT: Alice net P&L (dUSD): +", _t(aliceEnd - aliceStart));
        } else {
            console2.log("RESULT: Alice net LOSS (dUSD): -", _t(aliceStart - aliceEnd));
        }
        console2.log("        (she lost the principal the first-loss cover could not absorb)");
    }
}
