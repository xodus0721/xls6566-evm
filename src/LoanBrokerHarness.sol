// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {WadMath} from "./libraries/WadMath.sol";

/// @title LoanBrokerHarness
/// @notice Opt-in defensive layer for the XLS-66 LoanBroker (Sixth Sense DeFi article §4.2).
///         Sits in front of three LoanBroker operations and tightens the institution's
///         ability to set its own loss-absorption terms to zero:
///
///         ① Concentration limit  (at LoanSet / originate): a single loan — and a single
///            borrower — may not exceed a fraction of total debt.
///         ② Recovery timelock    (at LoanBrokerCoverWithdraw): cover proportional to a
///            recent default stays un-withdrawable for `lockDuration`, so cover linked to
///            loan size stays linked to loss absorption.
///         ③ History-linked cover rate (at LoanBrokerSet / originate): the CoverRateMinimum
///            floor rises with the institution's on-chain default rate — an objective,
///            deterministic substitute for depositor governance.
///
/// @dev An abstract mixin: `LoanBroker` inherits it and provides its live state through the
///      `virtual` getters. All checks are no-ops until {._initHarnessConfig} enables them
///      (write-once), so a LoanBroker that never calls it behaves exactly as before.
abstract contract LoanBrokerHarness {
    using WadMath for uint256;

    uint256 internal constant WAD = 1e18;

    // --- config (write-once via _initHarnessConfig) ---
    bool public harnessEnabled;
    bool public harnessInitialized;
    uint256 public alphaWad; // ① single-loan cap as fraction of debt
    uint256 public alphaBorrowerWad; // ① per-borrower cap
    uint256 public debtFloor; // ① D_floor (native), avoids 0 basis at inception
    uint256 public lockDuration; // ② T_lock (seconds)
    uint256 public lambdaWad; // ③ default-rate sensitivity

    // --- tracking ---
    mapping(address => uint256) public borrowerDebt;
    uint256 public totalOriginatedPrincipal;
    uint256 public totalDefaultedAmount;

    struct DefaultRec {
        uint64 ts;
        uint256 amount;
    }

    DefaultRec[] internal defaultRecs;

    error HarnessAlreadyInitialized();
    error ConcentrationExceeded(uint256 requested, uint256 cap);
    error BorrowerConcentrationExceeded(uint256 requested, uint256 cap);
    error CoverLockedByTimelock(uint256 requested, uint256 withdrawable);

    event HarnessInitialized(bool enabled, uint256 alpha, uint256 alphaBorrower, uint256 debtFloor, uint256 lockDuration, uint256 lambda);

    // --- broker state accessors (overridden by LoanBroker) ---
    function _hDebtTotal() internal view virtual returns (uint256);
    function _hCrmSetWad() internal view virtual returns (uint256);
    function _hCrmFloorWad() internal view virtual returns (uint256);

    // --- config ---
    function _initHarnessConfig(
        bool enabled,
        uint256 alpha,
        uint256 alphaBorrower,
        uint256 debtFloor_,
        uint256 lockDuration_,
        uint256 lambda
    ) internal {
        if (harnessInitialized) revert HarnessAlreadyInitialized();
        harnessInitialized = true;
        harnessEnabled = enabled;
        alphaWad = alpha;
        alphaBorrowerWad = alphaBorrower;
        debtFloor = debtFloor_;
        lockDuration = lockDuration_;
        lambdaWad = lambda;
        emit HarnessInitialized(enabled, alpha, alphaBorrower, debtFloor_, lockDuration_, lambda);
    }

    // --- ③ history-linked cover rate ---
    function defaultRateWad() public view returns (uint256) {
        if (totalOriginatedPrincipal == 0) return 0;
        return totalDefaultedAmount.wdiv(totalOriginatedPrincipal);
    }

    /// @notice Effective CoverRateMinimum after the history-linked floor.
    ///         = max(CRM_set, CRM_floor + λ × DefaultRate), capped at 100%.
    function _effectiveCRM() internal view returns (uint256) {
        if (!harnessEnabled) return _hCrmSetWad();
        uint256 dyn = _hCrmFloorWad() + lambdaWad.wmul(defaultRateWad());
        uint256 crmSet = _hCrmSetWad();
        uint256 eff = crmSet > dyn ? crmSet : dyn;
        return eff < WAD ? eff : WAD;
    }

    // --- ① concentration ---
    function _harnessCheckConcentration(uint256 newDebt, address borrower) internal view {
        if (!harnessEnabled) return;
        uint256 basis = _hDebtTotal() + newDebt;
        // Floor the basis (D_floor) so the very first loan isn't measured against a ~0 book.
        uint256 capBasis = basis > debtFloor ? basis : debtFloor;
        uint256 loanCap = alphaWad.wmul(capBasis);
        if (newDebt > loanCap) revert ConcentrationExceeded(newDebt, loanCap);
        uint256 borrowerCap = alphaBorrowerWad.wmul(capBasis);
        uint256 wouldOwe = borrowerDebt[borrower] + newDebt;
        if (wouldOwe > borrowerCap) revert BorrowerConcentrationExceeded(wouldOwe, borrowerCap);
    }

    // --- tracking hooks ---
    function _harnessOnOriginate(uint256 principal, address borrower, uint256 newDebt) internal {
        if (!harnessEnabled) return;
        totalOriginatedPrincipal += principal;
        borrowerDebt[borrower] += newDebt;
    }

    function _harnessSubBorrowerDebt(address borrower, uint256 amount) internal {
        if (!harnessEnabled) return;
        uint256 cur = borrowerDebt[borrower];
        borrowerDebt[borrower] = amount < cur ? cur - amount : 0;
    }

    function _harnessOnDefault(uint256 defaultAmount) internal {
        if (!harnessEnabled) return;
        totalDefaultedAmount += defaultAmount;
        defaultRecs.push(DefaultRec({ts: uint64(block.timestamp), amount: defaultAmount}));
    }

    // --- ② recovery timelock ---
    /// @notice Cover currently locked by recent defaults (Σ DefaultAmount_τ × CRM_eff over
    ///         the last `lockDuration` seconds).
    function lockedCover() public view returns (uint256) {
        if (!harnessEnabled) return 0;
        uint256 crm = _effectiveCRM();
        uint256 cutoff = block.timestamp > lockDuration ? block.timestamp - lockDuration : 0;
        uint256 sum;
        uint256 n = defaultRecs.length;
        for (uint256 i = n; i > 0; i--) {
            DefaultRec storage r = defaultRecs[i - 1];
            if (r.ts > cutoff) {
                sum += r.amount.wmul(crm);
            } else {
                break; // records are append-only in time order
            }
        }
        return sum;
    }
}
