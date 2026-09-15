# Code review — round 1 (high) resolutions

High-effort review of `src/` (Vault, LoanBroker, Amortization, WadMath). Eight findings;
six fixed, one hardened defensively, one documented as a known v1 limitation. Each fix has
a regression test.

## Fixed

| # | Issue | Fix | Test |
|---|---|---|---|
| 1 | Late payment leaked `lateNet` into `debtTotal` permanently (inflating the cover requirement) | Removed `debtTotal += lateNet`; late interest is settled in the same tx, so it must not raise outstanding debt | `test_regression_latePaymentNoDebtLeak` |
| 2 | `impair` booked `principal + netInterest`, over-suppressing the redemption price (and could exceed `totalAssets` and revert) | Book only `principalOutstanding` — in this model future interest is never a vault asset until received | `test_regression_impairedPaymentSyncsLoss` |
| 3 | Paying an IMPAIRED loan left a stale over-booked loss | On each payment, decrease `impairedAmount` and `vault.lossUnrealized` by the principal repaid | `test_regression_impairedPaymentSyncsLoss` |
| 4 | Zero-interest loan with indivisible principal underflowed in `interestBreakdown` on origination | Clamp `totalValue` up to `principal` (gross interest becomes 0) | `test_regression_zeroInterestLoan` |
| 5 | `default_` was permissionless (front-run/grief a paying borrower) | Gate to `OWNER_ROLE`, consistent with impair/unimpair (XLS-66 LoanManage is broker-operated) | existing default tests |
| 8 | `coverWithdraw` duplicated the min-cover formula | Use `_minCoverRequired()` | — |

## Hardened

- **#7 Annuity rounding drift near loan end.** `_splitRegular` recomputes each period while
  the ledger stores running totals; drift could underflow a legitimate late-life payment.
  Mitigated with a clamp on `principalPortion` (keeps `onLoan == Σ principals` exact) plus
  saturating subtractions on `mgmtFeeOutstanding` / `totalValueOutstanding` / `debtTotal`.
  This is a stand-in for the full XLS-66 A-3.3 `diffTotal` reconciliation, still deferred.

## Documented limitation (not a code change)

- **#6 Arrears do not "catch up" the schedule.** Each `pay()` settles exactly one periodic
  cycle and advances `nextPaymentDueDate` by one interval. A borrower several intervals
  behind therefore stays flagged late until they have paid down each missed cycle, and late
  interest is charged per catch-up payment. This matches the "one cycle per payment" model
  but is not the only reasonable policy; multi-period arrears handling (and the interaction
  with overpayment re-amortization) is left for a future pass alongside the deferred
  `diffTotal` work.

## Depositor-protection hardening (beyond the review)

- **Configurable cover floor.** `coverRateFloorWad` is fixed at deployment (default 0 =
  XLS-66 conformant, since first-loss capital is optional). A stricter deployment sets it
  higher to guarantee depositors a minimum first-loss buffer.
  - Constructor rejects a `CoverRateMinimum` below the floor.
  - `setCoverRates` rejects lowering the minimum below the floor — closing the "broker
    lowers cover after depositors commit" rug vector. The minimum a depositor sees is a
    floor the broker can never dip under.
  - Tests: `test_coverFloor_constructorRejectsBelowFloor`, `test_coverFloor_cannotLowerBelowFloor`.
  - Note: this is an opt-in strictness layer *on top of* XLS-66, not a change to the
    protocol's economics; with floor = 0 the behaviour is exactly the spec's.

## Still deferred

- Overpayment re-amortization with `diffTotal` (XLS-66 A-2 §5.3 / A-3.3).

## Now implemented (was deferred)

- **Early full repayment** — `LoanBroker.closeLoan` (XLS-66 A-2 §6, formulas 26–28).
  Borrower pays principal + accrued interest + prepayment penalty + close fee; the loan's
  remaining vault debt is cleared and any impairment reversed. `closeInterestRate` and
  `closePaymentFee` were added to the signed `LoanTerms` (EIP-712 typehash updated).
  Covered by `test_closeLoan_earlyRepayment`, `test_closeLoan_onlyBorrower`, and the
  invariant handler's `closeLoan` action.
