// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC4626} from "@openzeppelin/contracts/token/ERC20/extensions/ERC4626.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @title Vault
/// @notice EVM port of the XLS-65 Single Asset Vault, built on ERC-4626.
/// @dev Two behaviours make this more than a stock ERC-4626, both required to sit under
///      the XLS-66 lending protocol:
///
///      1. TWO-VIEW ACCOUNTING (XLS-65 AssetsTotal vs AssetsAvailable). `totalAssets()`
///         is idle balance + `assetsOnLoan` (capital lent out to the protocol). Only the
///         idle balance can actually be withdrawn.
///
///      2. LOSS ASYMMETRY (XLS-65 §6 LossUnrealized, ι). Deposits price against the FULL
///         asset total (loss ignored); withdrawals/redemptions price against
///         `totalAssets() - lossUnrealized`. This is the anti-arbitrage rule from the
///         spec: an attacker cannot buy cheap shares into an impaired vault and profit
///         when the loss clears. The lone exception is a sole shareholder, who is
///         entitled to the full value and so is not charged the unrealized loss.
///
///      XRPL plumbing (pseudo-account, RippleState, MPT flags, reserves) is absorbed by
///      the contract itself and does not appear here. `_decimalsOffset` plays the role of
///      XLS-65 `Scale` and provides ERC-4626 inflation-attack resistance.
contract Vault is ERC4626, AccessControl, ReentrancyGuard {
    using Math for uint256;
    using SafeERC20 for IERC20;

    /// @notice Held by the XLS-66 LoanBroker: may pull/return liquidity and mark losses.
    bytes32 public constant PROTOCOL_ROLE = keccak256("PROTOCOL_ROLE");

    /// @notice Assets lent out to the protocol. Counted in `totalAssets()` but not
    ///         withdrawable. (XLS-65: AssetsTotal − AssetsAvailable.)
    uint256 public assetsOnLoan;

    /// @notice Unrealized ("paper") loss, ι. Only reduces the withdrawal/redemption price.
    uint256 public lossUnrealized;

    /// @notice Optional deposit cap (0 = unlimited). XLS-65 AssetsMaximum.
    uint256 public assetsMaximum;

    /// @notice If true, only allowlisted accounts (or the admin) may deposit. XLS-65
    ///         private vault. Withdrawals are never gated (spec: owner must not be able
    ///         to lock depositors out of their funds).
    bool public immutable isPrivate;

    /// @notice Deposit allowlist for a private vault (the EVM stand-in for XLS-80
    ///         permissioned domains / XLS-70 credentials).
    mapping(address => bool) public depositAllowed;

    uint8 private immutable _offset;

    error NotEnoughLiquidity(uint256 requested, uint256 available);
    error ExceedsOnLoan(uint256 requested, uint256 onLoan);
    error AssetsMaximumBelowTotal(uint256 requested, uint256 total);
    error LossExceedsAssets(uint256 requested, uint256 available);

    event LentOut(address indexed to, uint256 amount);
    event Repaid(address indexed from, uint256 principal, uint256 interest);
    event LossIncreased(uint256 amount, uint256 newLoss);
    event LossDecreased(uint256 amount, uint256 newLoss);
    event OnLoanWrittenDown(uint256 amount, uint256 newOnLoan);
    event DepositAllowedSet(address indexed account, bool allowed);
    event AssetsMaximumSet(uint256 assetsMaximum);

    constructor(
        IERC20 asset_,
        string memory name_,
        string memory symbol_,
        address admin,
        bool isPrivate_,
        uint256 assetsMaximum_,
        uint8 decimalsOffset_
    ) ERC20(name_, symbol_) ERC4626(asset_) {
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        isPrivate = isPrivate_;
        assetsMaximum = assetsMaximum_;
        _offset = decimalsOffset_;
    }

    // =====================================================================
    // Accounting: two-view total assets
    // =====================================================================

    /// @inheritdoc ERC4626
    /// @dev XLS-65 AssetsTotal = idle balance (AssetsAvailable) + assetsOnLoan.
    function totalAssets() public view override returns (uint256) {
        return _idleAssets() + assetsOnLoan;
    }

    /// @notice Idle, immediately-withdrawable balance. XLS-65 AssetsAvailable.
    function assetsAvailable() public view returns (uint256) {
        return _idleAssets();
    }

    function _idleAssets() internal view returns (uint256) {
        return IERC20(asset()).balanceOf(address(this));
    }

    /// @notice Asset basis used to price redemptions: total minus unrealized loss.
    function _redeemableAssets() internal view returns (uint256) {
        uint256 total = totalAssets();
        return total > lossUnrealized ? total - lossUnrealized : 0;
    }

    function _isSoleShareholder(address owner) internal view returns (bool) {
        uint256 supply = totalSupply();
        return supply > 0 && balanceOf(owner) == supply;
    }

    /// @dev A sole shareholder is entitled to full value (XLS-65 §6), so the redemption
    ///      basis ignores unrealized loss for them.
    function _redeemBasis(address owner) internal view returns (uint256) {
        return _isSoleShareholder(owner) ? totalAssets() : _redeemableAssets();
    }

    // =====================================================================
    // Conversions (loss asymmetry via preview overrides)
    // =====================================================================

    function _sharesFor(uint256 assets, uint256 assetBasis, Math.Rounding rounding)
        internal
        view
        returns (uint256)
    {
        return assets.mulDiv(totalSupply() + 10 ** _decimalsOffset(), assetBasis + 1, rounding);
    }

    function _assetsFor(uint256 shares, uint256 assetBasis, Math.Rounding rounding)
        internal
        view
        returns (uint256)
    {
        return shares.mulDiv(assetBasis + 1, totalSupply() + 10 ** _decimalsOffset(), rounding);
    }

    /// @dev Deposits price against the full asset total (loss ignored).
    function previewDeposit(uint256 assets) public view override returns (uint256) {
        return _sharesFor(assets, totalAssets(), Math.Rounding.Floor);
    }

    function previewMint(uint256 shares) public view override returns (uint256) {
        return _assetsFor(shares, totalAssets(), Math.Rounding.Ceil);
    }

    /// @dev Withdrawals/redemptions price against total minus unrealized loss.
    function previewWithdraw(uint256 assets) public view override returns (uint256) {
        return _sharesFor(assets, _redeemableAssets(), Math.Rounding.Ceil);
    }

    function previewRedeem(uint256 shares) public view override returns (uint256) {
        return _assetsFor(shares, _redeemableAssets(), Math.Rounding.Floor);
    }

    function _decimalsOffset() internal view override returns (uint8) {
        return _offset;
    }

    // =====================================================================
    // Deposit / withdraw limits
    // =====================================================================

    function _canDeposit(address receiver) internal view returns (bool) {
        if (!isPrivate) return true;
        return depositAllowed[receiver] || hasRole(DEFAULT_ADMIN_ROLE, receiver);
    }

    function maxDeposit(address receiver) public view override returns (uint256) {
        if (!_canDeposit(receiver)) return 0;
        if (assetsMaximum == 0) return type(uint256).max;
        uint256 total = totalAssets();
        return total >= assetsMaximum ? 0 : assetsMaximum - total;
    }

    function maxMint(address receiver) public view override returns (uint256) {
        uint256 maxA = maxDeposit(receiver);
        if (maxA == type(uint256).max) return type(uint256).max;
        return previewDeposit(maxA);
    }

    /// @dev Withdrawals are capped by idle liquidity (assets on loan are not available).
    function maxWithdraw(address owner) public view override returns (uint256) {
        uint256 ownerMax = _assetsFor(balanceOf(owner), _redeemBasis(owner), Math.Rounding.Floor);
        uint256 liquid = _idleAssets();
        return ownerMax < liquid ? ownerMax : liquid;
    }

    function maxRedeem(address owner) public view override returns (uint256) {
        uint256 shares = balanceOf(owner);
        uint256 maxByLiquidity = _sharesFor(_idleAssets(), _redeemBasis(owner), Math.Rounding.Floor);
        return shares < maxByLiquidity ? shares : maxByLiquidity;
    }

    // =====================================================================
    // Withdraw / redeem (sole-shareholder loss waiver)
    // =====================================================================

    function withdraw(uint256 assets, address receiver, address owner)
        public
        override
        nonReentrant
        returns (uint256)
    {
        uint256 maxAssets = maxWithdraw(owner);
        if (assets > maxAssets) revert ERC4626ExceededMaxWithdraw(owner, assets, maxAssets);

        uint256 shares = _sharesFor(assets, _redeemBasis(owner), Math.Rounding.Ceil);
        _withdraw(_msgSender(), receiver, owner, assets, shares);
        return shares;
    }

    function redeem(uint256 shares, address receiver, address owner)
        public
        override
        nonReentrant
        returns (uint256)
    {
        uint256 maxShares = maxRedeem(owner);
        if (shares > maxShares) revert ERC4626ExceededMaxRedeem(owner, shares, maxShares);

        uint256 assets = _assetsFor(shares, _redeemBasis(owner), Math.Rounding.Floor);
        _withdraw(_msgSender(), receiver, owner, assets, shares);
        return assets;
    }

    // deposit()/mint() inherit OZ behaviour: they call our previewDeposit/previewMint
    // (full-total basis) and maxDeposit/maxMint (allowlist + cap). We only add reentrancy
    // guards by overriding thin wrappers.

    function deposit(uint256 assets, address receiver)
        public
        override
        nonReentrant
        returns (uint256)
    {
        return super.deposit(assets, receiver);
    }

    function mint(uint256 shares, address receiver)
        public
        override
        nonReentrant
        returns (uint256)
    {
        return super.mint(shares, receiver);
    }

    // =====================================================================
    // Protocol hooks (XLS-66 LoanBroker only)
    // =====================================================================

    /// @notice Lend idle liquidity to the protocol. Moves value from AssetsAvailable to
    ///         assetsOnLoan; `totalAssets()` is unchanged.
    function lendOut(uint256 amount, address to) external onlyRole(PROTOCOL_ROLE) nonReentrant {
        uint256 liquid = _idleAssets();
        if (amount > liquid) revert NotEnoughLiquidity(amount, liquid);
        assetsOnLoan += amount;
        IERC20(asset()).safeTransfer(to, amount);
        emit LentOut(to, amount);
    }

    /// @notice Receive a repayment: `principal` reduces assetsOnLoan, `interest` is net
    ///         gain to depositors (raises the share price). Pulls `principal + interest`
    ///         from the caller (the LoanBroker).
    function receiveRepay(uint256 principal, uint256 interest)
        external
        onlyRole(PROTOCOL_ROLE)
        nonReentrant
    {
        if (principal > assetsOnLoan) revert ExceedsOnLoan(principal, assetsOnLoan);
        assetsOnLoan -= principal;
        IERC20(asset()).safeTransferFrom(_msgSender(), address(this), principal + interest);
        emit Repaid(_msgSender(), principal, interest);
    }

    /// @notice Mark unrealized loss (XLS-66 impairment). Raises ι.
    function increaseLoss(uint256 amount) external onlyRole(PROTOCOL_ROLE) {
        uint256 newLoss = lossUnrealized + amount;
        if (newLoss > totalAssets()) revert LossExceedsAssets(newLoss, totalAssets());
        lossUnrealized = newLoss;
        emit LossIncreased(amount, newLoss);
    }

    /// @notice Reverse unrealized loss (XLS-66 unimpair, or after realization).
    function decreaseLoss(uint256 amount) external onlyRole(PROTOCOL_ROLE) {
        amount = amount > lossUnrealized ? lossUnrealized : amount;
        lossUnrealized -= amount;
        emit LossDecreased(amount, lossUnrealized);
    }

    /// @notice Realize a permanent loss of on-loan principal (XLS-66 default, after
    ///         first-loss capital has absorbed its share). Depositors bear this: it
    ///         lowers `totalAssets()`. The caller should also clear any matching
    ///         unrealized loss via {decreaseLoss}.
    function writeDownOnLoan(uint256 amount) external onlyRole(PROTOCOL_ROLE) {
        if (amount > assetsOnLoan) revert ExceedsOnLoan(amount, assetsOnLoan);
        assetsOnLoan -= amount;
        emit OnLoanWrittenDown(amount, assetsOnLoan);
    }

    // =====================================================================
    // Admin (XLS-65 VaultSet)
    // =====================================================================

    function setDepositAllowed(address account, bool allowed)
        external
        onlyRole(DEFAULT_ADMIN_ROLE)
    {
        depositAllowed[account] = allowed;
        emit DepositAllowedSet(account, allowed);
    }

    /// @dev XLS-65 VaultSet: AssetsMaximum cannot drop below current AssetsTotal.
    function setAssetsMaximum(uint256 newMax) external onlyRole(DEFAULT_ADMIN_ROLE) {
        uint256 total = totalAssets();
        if (newMax != 0 && newMax < total) revert AssetsMaximumBelowTotal(newMax, total);
        assetsMaximum = newMax;
        emit AssetsMaximumSet(newMax);
    }
}
