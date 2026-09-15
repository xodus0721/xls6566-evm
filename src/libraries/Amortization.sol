// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {WadMath} from "./WadMath.sol";

/// @title Amortization
/// @notice Standard fixed-term amortization math ported from XLS-66 (XRPL Lending
///         Protocol), Appendix A-2 "Equation Glossary". This is a PURE, high-precision
///         math core: everything is WAD (1e18) fixed-point, and no token decimals or
///         on-ledger rounding (the `diffTotal` reconciliation of XLS-66 A-3.3) live here.
///         Those belong to the LoanBroker layer, whose stored values are the source of
///         truth. This library computes the *theoretical* schedule.
/// @dev Formula numbers in comments (e.g. "(7)") refer to XLS-66 Appendix A-2.
library Amortization {
    using WadMath for uint256;

    uint256 internal constant WAD = 1e18;

    /// @notice 365 * 24 * 60 * 60. XLS-66 A-2 §1.1.
    uint256 internal constant SECONDS_PER_YEAR = 31_536_000;

    /// @notice XLS rates are expressed in "1/10th of a basis point": raw 1 = 0.001% =
    ///         1e-5. Converting to WAD (1e18) is therefore raw * 1e13.
    uint256 internal constant TENTH_BPS_TO_WAD = 1e13;

    error ZeroPayments();
    error ZeroPeriodicRate();
    /// @notice Periodic payment does not even cover one period of interest, so principal
    ///         can never amortize. Corresponds to XLS-66 tecPRECISION_LOSS (validation #16).
    error PaymentBelowInterest();

    // ---------------------------------------------------------------------
    // Unit conversion
    // ---------------------------------------------------------------------

    /// @notice Convert an XLS "1/10th bps" rate (0..100000 == 0..100%) to a WAD fraction.
    function fromTenthBps(uint256 rawRate) internal pure returns (uint256) {
        return rawRate * TENTH_BPS_TO_WAD;
    }

    // ---------------------------------------------------------------------
    // §1 Interest rate conversion
    // ---------------------------------------------------------------------

    /// @notice Per-period interest rate from an annualized rate. XLS-66 A-2 (1).
    /// @param annualRateWad Annualized interest rate as a WAD fraction.
    /// @param paymentInterval Seconds between scheduled payments.
    function periodicRate(uint256 annualRateWad, uint256 paymentInterval)
        internal
        pure
        returns (uint256)
    {
        // periodicRate = annualRate * paymentInterval / secondsPerYear
        return WadMath.mulDiv(annualRateWad, paymentInterval, SECONDS_PER_YEAR);
    }

    // ---------------------------------------------------------------------
    // §2 Standard amortization
    // ---------------------------------------------------------------------

    /// @notice Annuity factor. XLS-66 A-2 (5),(6):
    ///         raisedRate = (1 + r)^n ; factor = r * raisedRate / (raisedRate - 1)
    /// @dev Reverts for a zero periodic rate (factor is undefined / division by zero);
    ///      callers must route zero-interest loans through the special cases below.
    function factor(uint256 periodicRateWad, uint256 paymentsRemaining)
        internal
        pure
        returns (uint256)
    {
        if (paymentsRemaining == 0) revert ZeroPayments();
        if (periodicRateWad == 0) revert ZeroPeriodicRate();

        uint256 raisedRate = (WAD + periodicRateWad).wpow(paymentsRemaining); // (5)
        uint256 numerator = periodicRateWad.wmul(raisedRate);
        return numerator.wdiv(raisedRate - WAD); // (6)
    }

    /// @notice Constant periodic payment that amortizes `principalWad` over
    ///         `paymentsRemaining` periods at `periodicRateWad`. XLS-66 A-2 (7).
    /// @dev Handles both special cases from the spec:
    ///      - zero interest: principal / n
    ///      - single payment left: principal * (1 + r) (equivalently the final TVO).
    ///      NOTE: XLS-66's ledger override "on the final payment, use the stored
    ///      TotalValueOutstanding" is a rounding-reconciliation concern and belongs to
    ///      the LoanBroker layer, not this theoretical core.
    function periodicPayment(
        uint256 principalWad,
        uint256 periodicRateWad,
        uint256 paymentsRemaining
    ) internal pure returns (uint256) {
        if (paymentsRemaining == 0) revert ZeroPayments();

        if (periodicRateWad == 0) {
            return principalWad / paymentsRemaining; // zero-interest special case
        }
        return principalWad.wmul(factor(periodicRateWad, paymentsRemaining)); // (7)
    }

    /// @notice Split one periodic payment into its interest and principal portions.
    ///         XLS-66 A-2 (8),(9).
    /// @return principalPortion Amount that reduces the outstanding principal.
    /// @return interest Interest accrued this period.
    function paymentBreakdown(
        uint256 principalWad,
        uint256 periodicPaymentWad,
        uint256 periodicRateWad
    ) internal pure returns (uint256 principalPortion, uint256 interest) {
        interest = principalWad.wmul(periodicRateWad); // (8)
        if (periodicPaymentWad < interest) revert PaymentBelowInterest();
        principalPortion = periodicPaymentWad - interest; // (9)
    }

    /// @notice Reverse of (7): recover principal outstanding from a known periodic
    ///         payment. XLS-66 A-2 (10),(11). Used to detect rounding drift during
    ///         overpayment re-amortization.
    function principalFromPeriodic(
        uint256 periodicPaymentWad,
        uint256 periodicRateWad,
        uint256 paymentsRemaining
    ) internal pure returns (uint256) {
        if (paymentsRemaining == 0) revert ZeroPayments();

        if (periodicRateWad == 0) {
            return periodicPaymentWad * paymentsRemaining; // (11)
        }
        return periodicPaymentWad.wdiv(factor(periodicRateWad, paymentsRemaining)); // (10)
    }

    // ---------------------------------------------------------------------
    // §3 & §7 Management fee and theoretical loan value
    // ---------------------------------------------------------------------

    /// @notice Management fee on an interest amount. XLS-66 A-2 (12).
    function managementFee(uint256 interestWad, uint256 mgmtFeeRateWad)
        internal
        pure
        returns (uint256)
    {
        return interestWad.wmul(mgmtFeeRateWad); // (12)
    }

    /// @notice Theoretical total value outstanding. XLS-66 A-2 (30).
    function totalValueOutstanding(uint256 periodicPaymentWad, uint256 paymentsRemaining)
        internal
        pure
        returns (uint256)
    {
        return periodicPaymentWad * paymentsRemaining; // (30)
    }

    /// @notice Break a total value outstanding into gross interest, management fee, and
    ///         net interest (the part that accrues to the vault). XLS-66 A-2 (31),(32),(33).
    function interestBreakdown(
        uint256 totalValueOutstandingWad,
        uint256 principalWad,
        uint256 mgmtFeeRateWad
    )
        internal
        pure
        returns (uint256 grossInterest, uint256 mgmtFee, uint256 netInterest)
    {
        grossInterest = totalValueOutstandingWad - principalWad; // (31)
        mgmtFee = grossInterest.wmul(mgmtFeeRateWad); // (32)
        netInterest = grossInterest - mgmtFee; // (33)
    }

    // ---------------------------------------------------------------------
    // §4 Late payment
    // ---------------------------------------------------------------------

    /// @notice Penalty rate applied over the overdue window. XLS-66 A-2 (2),(3).
    /// @param lateAnnualRateWad Annualized penalty rate (WAD).
    /// @param secondsOverdue lastLedgerCloseTime − NextPaymentDueDate (formula 3), in seconds.
    function latePeriodicRate(uint256 lateAnnualRateWad, uint256 secondsOverdue)
        internal
        pure
        returns (uint256)
    {
        return WadMath.mulDiv(lateAnnualRateWad, secondsOverdue, SECONDS_PER_YEAR); // (2)
    }

    /// @notice Late-payment penalty interest, split gross / fee / net.
    ///         XLS-66 A-2 (16),(13),(17). The net portion is `valueChange` (18):
    ///         positive, applied directly to Vault.AssetsTotal and LoanBroker.DebtTotal
    ///         (it is NOT part of the loan's original TotalValueOutstanding).
    function latePaymentInterest(
        uint256 principalWad,
        uint256 latePeriodicRateWad,
        uint256 mgmtFeeRateWad
    ) internal pure returns (uint256 gross, uint256 mgmtFee, uint256 net) {
        gross = principalWad.wmul(latePeriodicRateWad); // (16)
        mgmtFee = gross.wmul(mgmtFeeRateWad); // (13)
        net = gross - mgmtFee; // (17) == valueChange (18)
    }

    // ---------------------------------------------------------------------
    // §5 Overpayment (pure parts; ledger diffTotal reconciliation is LoanBroker's job)
    // ---------------------------------------------------------------------

    /// @notice Decompose an overpayment amount into its interest, fee, and the portion
    ///         that actually reduces principal. XLS-66 A-2 (20),(14),(21),(22),(23).
    /// @param overpaymentAmountWad Excess funds after all full periodic cycles are settled (19).
    function overpaymentBreakdown(
        uint256 overpaymentAmountWad,
        uint256 overpaymentRateWad,
        uint256 overpaymentFeeRateWad,
        uint256 mgmtFeeRateWad
    )
        internal
        pure
        returns (uint256 interestNet, uint256 mgmtFee, uint256 fee, uint256 principalPortion)
    {
        uint256 gross = overpaymentAmountWad.wmul(overpaymentRateWad); // (20)
        mgmtFee = gross.wmul(mgmtFeeRateWad); // (14)
        interestNet = gross - mgmtFee; // (21)
        fee = overpaymentAmountWad.wmul(overpaymentFeeRateWad); // (22)
        // (23) principal = overpayment − netInterest − mgmtFee − overpaymentFee
        principalPortion = overpaymentAmountWad - interestNet - mgmtFee - fee;
    }

    // ---------------------------------------------------------------------
    // §6 Early full repayment
    // ---------------------------------------------------------------------

    /// @notice Interest accrued since the last payment, pro-rated over the interval.
    ///         XLS-66 A-2 (27).
    function accruedInterest(
        uint256 principalWad,
        uint256 periodicRateWad,
        uint256 secondsSinceLastPayment,
        uint256 paymentInterval
    ) internal pure returns (uint256) {
        // principal * periodicRate * (secondsSinceLastPayment / paymentInterval)
        uint256 timeFractionWad = WadMath.mulDiv(secondsSinceLastPayment, WAD, paymentInterval);
        return principalWad.wmul(periodicRateWad).wmul(timeFractionWad);
    }

    /// @notice Prepayment penalty for closing a loan early. XLS-66 A-2 (28).
    function prepaymentPenalty(uint256 principalWad, uint256 closeInterestRateWad)
        internal
        pure
        returns (uint256)
    {
        return principalWad.wmul(closeInterestRateWad); // (28)
    }

    /// @notice Total due to close a loan early and the signed value change to the vault.
    ///         XLS-66 A-2 (26),(29). `valueChange` can be negative when the penalty plus
    ///         accrued interest is less than the net interest the vault would have earned.
    /// @param netInterestOutstandingWad Remaining net interest from ledger values (33).
    function earlyFullRepayment(
        uint256 principalWad,
        uint256 accruedInterestWad,
        uint256 prepaymentPenaltyWad,
        uint256 closePaymentFeeWad,
        uint256 netInterestOutstandingWad
    ) internal pure returns (uint256 totalDue, int256 valueChange) {
        totalDue = principalWad + accruedInterestWad + prepaymentPenaltyWad + closePaymentFeeWad; // (26)
        // (29) valueChange = (accruedInterest + prepaymentPenalty) − netInterestOutstanding
        valueChange =
            int256(accruedInterestWad + prepaymentPenaltyWad) - int256(netInterestOutstandingWad);
    }
}
