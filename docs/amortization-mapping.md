# Amortization: XLS-66 → EVM formula mapping

`src/libraries/Amortization.sol` ports the standard amortization math from
**XLS-66, Appendix A-2 "Equation Glossary"**. All values are WAD (1e18) fixed-point.
Token decimals and on-ledger rounding reconciliation (A-3.3 `diffTotal`) are **not**
here — they belong to the `LoanBroker` layer, whose stored values are the source of truth.

| XLS-66 formula | Meaning | Solidity function |
|---|---|---|
| (1) | annual → per-period rate | `periodicRate(annualRateWad, interval)` |
| (5),(6) | annuity factor `r(1+r)^n / ((1+r)^n − 1)` | `factor(periodicRateWad, n)` |
| (7) | constant periodic payment | `periodicPayment(principalWad, r, n)` |
| (8),(9) | split payment into interest / principal | `paymentBreakdown(principalWad, payWad, r)` |
| (10),(11) | reverse: principal from payment | `principalFromPeriodic(payWad, r, n)` |
| (12) | management fee on interest | `managementFee(interestWad, feeWad)` |
| (30) | theoretical total value outstanding | `totalValueOutstanding(payWad, n)` |
| (31),(32),(33) | gross / fee / net interest split | `interestBreakdown(tvoWad, principalWad, feeWad)` |

## Rate units

XLS rates are in **1/10th of a basis point**: raw `1` = 0.001% = 1e-5.
`fromTenthBps(raw)` converts to a WAD fraction (`raw * 1e13`). Ranges from the spec:
`InterestRate` 0..100000 (0..100%), `ManagementFeeRate` 0..10000 (0..10%).

## Special cases handled

- **Zero interest**: `periodicPayment = principal / n`; `principalFromPeriodic = pay * n`.
- **Final payment (n = 1)**: `payment = principal * (1 + r)`. NOTE: XLS-66's ledger
  override ("on the last payment use the stored `TotalValueOutstanding`") is a
  rounding-reconciliation concern for the `LoanBroker` layer, not this theoretical core.
- **Payment below one period's interest** → `PaymentBelowInterest` (maps to XLS-66
  `tecPRECISION_LOSS`, validation #16).

## Also ported (pure-math parts)

| XLS-66 formula | Meaning | Solidity function |
|---|---|---|
| (2),(3),(16),(13),(17),(18) | late-payment penalty interest (gross/fee/net) | `latePeriodicRate`, `latePaymentInterest` |
| (20),(14),(21),(22),(23) | overpayment breakdown | `overpaymentBreakdown` |
| (27) | accrued interest since last payment | `accruedInterest` |
| (28) | prepayment penalty | `prepaymentPenalty` |
| (26),(29) | early full repayment total due + signed value change | `earlyFullRepayment` |

## NOT ported here (need ledger context → LoanBroker layer)

- Overpayment re-amortization `diffTotal` reconciliation (A-2 §5.3, formulas 24a–24c; A-3.3):
  requires the stored ledger `TotalValueOutstanding`.
- First-loss default coverage (A-2 §8, formulas 34–37): lives in `LoanBroker` /
  `LossWaterfall`, and drives `Vault.increaseLoss` / `writeDownOnLoan`.
