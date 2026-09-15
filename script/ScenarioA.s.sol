// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {console2} from "forge-std/console2.sol";
import {LendingDemo} from "./LendingDemo.s.sol";

/// @notice Scenario A — healthy loan.
///         Deposit -> lend -> full on-time repayment -> broker recovers cover ->
///         depositor withdraws with interest.
///         Run: forge script script/ScenarioA.s.sol -vv
contract ScenarioA is LendingDemo {
    function run() external {
        _setUp();

        console2.log("###########################################");
        console2.log("# XLS-65/66 EVM demo - Scenario A (healthy)");
        console2.log("###########################################");

        uint256 aliceStart = token.balanceOf(alice);

        // 1. Alice funds the vault.
        _deposit(alice, 50_000 * UNIT);
        _snapshot("1. Alice deposits 50,000 dUSD");

        // 2. Broker posts first-loss capital.
        _coverDeposit(5_000 * UNIT);
        _snapshot("2. Broker deposits 5,000 cover");

        // 3. Originate a 30,000 loan to Bob (12% APR, 12 monthly payments).
        uint256 loanId = _originate(30_000 * UNIT);
        _snapshot("3. Originate 30,000 loan to Bob");
        console2.log("   -> 30,000 moved from 'available' to 'on loan'; Bob received the cash.");

        // 4. Bob repays all 12 installments on time.
        for (uint256 i = 0; i < PAYMENTS; i++) {
            _payOnce(loanId);
        }
        _snapshot("4. Bob repays all 12 installments");
        console2.log("   -> principal back in vault + net interest; debt cleared.");

        // 5. Broker recovers its first-loss capital (no defaults occurred).
        vm.prank(opAddr);
        broker.coverWithdraw(5_000 * UNIT);
        _snapshot("5. Broker recovers 5,000 cover");

        // 6. Alice withdraws everything.
        uint256 out = vault.maxWithdraw(alice);
        vm.prank(alice);
        vault.withdraw(out, alice, alice);
        _snapshot("6. Alice withdraws everything");

        _line();
        uint256 aliceEnd = token.balanceOf(alice);
        console2.log("RESULT: Alice net P&L (dUSD):", _t(aliceEnd - aliceStart));
        console2.log("        (positive = earned interest as a depositor)");
    }
}
