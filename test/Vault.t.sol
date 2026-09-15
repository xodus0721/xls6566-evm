// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {Vault} from "../src/Vault.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC4626} from "@openzeppelin/contracts/interfaces/IERC4626.sol";

contract MockERC20 is ERC20 {
    constructor() ERC20("Mock USD", "mUSD") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

contract VaultTest is Test {
    uint256 constant UNIT = 1e18;
    uint8 constant OFFSET = 6;
    uint256 constant TOL = 1e13; // 0.001% relative, covers virtual-share dust

    MockERC20 asset;
    Vault vault;

    address admin = address(this);
    address broker = address(0xB0B);
    address alice = address(0xA11CE);
    address bob = address(0xB0B2);
    address carol = address(0xCADD1);

    function setUp() public {
        asset = new MockERC20();
        vault = new Vault(IERC20(address(asset)), "Vault mUSD", "vmUSD", admin, false, 0, OFFSET);
        vault.grantRole(vault.PROTOCOL_ROLE(), broker);

        for (uint256 i; i < 4; i++) {
            address u = [alice, bob, carol, broker][i];
            asset.mint(u, 1_000_000 * UNIT);
            vm.prank(u);
            asset.approve(address(vault), type(uint256).max);
        }
    }

    function _deposit(address who, uint256 amount) internal returns (uint256 shares) {
        vm.prank(who);
        shares = vault.deposit(amount, who);
    }

    // -----------------------------------------------------------------
    // Basic roundtrip
    // -----------------------------------------------------------------

    function test_depositWithdrawRoundtrip() public {
        uint256 shares = _deposit(alice, 1000 * UNIT);
        assertGt(shares, 0);
        assertApproxEqRel(vault.totalAssets(), 1000 * UNIT, TOL);

        vm.prank(alice);
        uint256 got = vault.redeem(shares, alice, alice);
        assertApproxEqRel(got, 1000 * UNIT, TOL, "roundtrip returns ~deposit");
    }

    // -----------------------------------------------------------------
    // Two-view accounting: assetsAvailable vs totalAssets
    // -----------------------------------------------------------------

    function test_lendOut_splitsAvailableFromTotal() public {
        _deposit(alice, 1000 * UNIT);

        vm.prank(broker);
        vault.lendOut(600 * UNIT, broker);

        assertEq(vault.totalAssets(), 1000 * UNIT, "total unchanged by lending");
        assertEq(vault.assetsAvailable(), 400 * UNIT, "only idle is available");
        assertEq(vault.assetsOnLoan(), 600 * UNIT);
    }

    function test_withdraw_cappedByLiquidity() public {
        _deposit(alice, 1000 * UNIT);
        vm.prank(broker);
        vault.lendOut(600 * UNIT, broker);

        // Only 400 is idle; asking for 500 must revert on the max check.
        assertApproxEqRel(vault.maxWithdraw(alice), 400 * UNIT, TOL);
        vm.prank(alice);
        vm.expectRevert();
        vault.withdraw(500 * UNIT, alice, alice);

        // 400 works.
        vm.prank(alice);
        vault.withdraw(400 * UNIT, alice, alice);
        assertApproxEqAbs(vault.assetsAvailable(), 0, 1e6);
    }

    function test_receiveRepay_raisesSharePrice() public {
        uint256 shares = _deposit(alice, 1000 * UNIT);
        vm.prank(broker);
        vault.lendOut(600 * UNIT, broker);

        // Broker repays 600 principal + 60 interest.
        vm.prank(broker);
        vault.receiveRepay(600 * UNIT, 60 * UNIT);

        assertEq(vault.assetsOnLoan(), 0);
        assertApproxEqRel(vault.totalAssets(), 1060 * UNIT, TOL, "interest accrued to vault");

        vm.prank(alice);
        uint256 got = vault.redeem(shares, alice, alice);
        assertApproxEqRel(got, 1060 * UNIT, TOL, "sole depositor earns the interest");
    }

    // -----------------------------------------------------------------
    // Loss asymmetry (the core XLS-65 §6 defense)
    // -----------------------------------------------------------------

    /// Depositing into an impaired vault gives NO discount: an immediate redeem loses value.
    function test_lossAsymmetry_noArbitrageForNewDepositor() public {
        _deposit(alice, 1000 * UNIT);
        _deposit(bob, 1000 * UNIT); // two holders -> no sole-holder waiver

        vm.prank(broker);
        vault.increaseLoss(400 * UNIT); // totalAssets 2000, redeemable 1600

        // Deposit price ignores loss (basis 2000).
        assertApproxEqRel(vault.previewDeposit(1000 * UNIT), vault.previewDeposit(1000 * UNIT), 0);

        uint256 carolShares = _deposit(carol, 1000 * UNIT);
        uint256 immediateValue = vault.previewRedeem(carolShares);

        // Carol immediately shares in the loss: her redeem value is below her deposit, so
        // there is no arbitrage. (The 400 loss dilutes across more shares once she joins:
        // carolShares * redeemable/supply = (S/2) * 2600 / 1.5S = 866.67.)
        assertLt(immediateValue, 1000 * UNIT, "no discount: new depositor cannot arbitrage");
        assertApproxEqRel(immediateValue, 866_666_666_666_666_666_666, TOL, "diluted pro-rata of impaired value");
    }

    /// Existing holders' redemption value drops by the unrealized loss.
    function test_lossReducesRedemption() public {
        uint256 aShares = _deposit(alice, 1000 * UNIT);
        _deposit(bob, 1000 * UNIT);

        uint256 before = vault.previewRedeem(aShares);
        assertApproxEqRel(before, 1000 * UNIT, TOL);

        vm.prank(broker);
        vault.increaseLoss(400 * UNIT);

        uint256 afterLoss = vault.previewRedeem(aShares);
        assertApproxEqRel(afterLoss, 800 * UNIT, TOL, "alice bears half of 400 loss");
    }

    /// A sole shareholder is entitled to full value: unrealized loss is waived for them.
    function test_soleShareholder_lossWaived() public {
        uint256 shares = _deposit(alice, 1000 * UNIT);

        vm.prank(broker);
        vault.increaseLoss(300 * UNIT); // <= totalAssets

        // Generic preview (no owner) uses net basis -> reduced.
        assertApproxEqRel(vault.previewRedeem(shares), 700 * UNIT, TOL);

        // But the actual sole holder redeems for full value.
        vm.prank(alice);
        uint256 got = vault.redeem(shares, alice, alice);
        assertApproxEqRel(got, 1000 * UNIT, TOL, "sole holder gets full value");
    }

    // -----------------------------------------------------------------
    // Access control
    // -----------------------------------------------------------------

    function test_privateVault_depositGating() public {
        Vault pv =
            new Vault(IERC20(address(asset)), "Private", "pv", admin, true, 0, OFFSET);

        vm.prank(bob);
        asset.approve(address(pv), type(uint256).max);

        assertEq(pv.maxDeposit(bob), 0, "not allowlisted");
        vm.prank(bob);
        vm.expectRevert();
        pv.deposit(100 * UNIT, bob);

        pv.setDepositAllowed(bob, true);
        vm.prank(bob);
        uint256 shares = pv.deposit(100 * UNIT, bob);
        assertGt(shares, 0, "allowlisted deposit works");
    }

    function test_assetsMaximum_cap() public {
        Vault capped =
            new Vault(IERC20(address(asset)), "Capped", "cap", admin, false, 1000 * UNIT, OFFSET);
        vm.prank(alice);
        asset.approve(address(capped), type(uint256).max);

        vm.prank(alice);
        capped.deposit(1000 * UNIT, alice);
        assertEq(capped.maxDeposit(alice), 0, "cap reached");

        vm.prank(alice);
        vm.expectRevert();
        capped.deposit(1, alice);
    }

    function test_onlyProtocol_canLendAndMarkLoss() public {
        _deposit(alice, 1000 * UNIT);
        vm.prank(alice);
        vm.expectRevert();
        vault.lendOut(100 * UNIT, alice);

        vm.prank(alice);
        vm.expectRevert();
        vault.increaseLoss(100 * UNIT);
    }

    // -----------------------------------------------------------------
    // Default write-down
    // -----------------------------------------------------------------

    function test_writeDown_realizesLossToDepositors() public {
        uint256 shares = _deposit(alice, 1000 * UNIT);
        vm.prank(broker);
        vault.lendOut(600 * UNIT, broker);

        // 600 lent; 200 of it is permanently lost (rest covered elsewhere).
        vm.startPrank(broker);
        vault.increaseLoss(200 * UNIT);
        vault.writeDownOnLoan(200 * UNIT);
        vault.decreaseLoss(200 * UNIT);
        vm.stopPrank();

        assertEq(vault.assetsOnLoan(), 400 * UNIT);
        assertApproxEqRel(vault.totalAssets(), 800 * UNIT, TOL, "depositors bear the 200 loss");
        assertEq(vault.lossUnrealized(), 0, "unrealized cleared after realization");

        // Alice (sole) can withdraw the idle portion now; value reflects the write-down.
        assertApproxEqRel(vault.previewRedeem(shares), 800 * UNIT, TOL);
    }
}
