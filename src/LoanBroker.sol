// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

import {Vault} from "./Vault.sol";
import {LoanBrokerHarness} from "./LoanBrokerHarness.sol";
import {Amortization} from "./libraries/Amortization.sol";
import {WadMath} from "./libraries/WadMath.sol";

/// @title LoanBroker
/// @notice EVM port of the XLS-66 Lending Protocol. Sits on top of an XLS-65 {Vault},
///         underwriting uncollateralized fixed-term loans out of pooled vault liquidity
///         and absorbing default losses with its own first-loss capital.
/// @dev Money convention: all amounts are native token units; only *rates* are WAD
///      (1e18) fractions. {Amortization} is unit-agnostic on amounts, so vault amounts
///      pass straight through. Rate inputs use the XLS "1/10th bps" scale (see
///      {Amortization.fromTenthBps}).
///
///      Loan agreement (XLS-66 LoanSet) is a mutual agreement: the broker owner submits
///      {originate} (agreeing by sending the tx) with the borrower's EIP-712 signature
///      over the terms (agreeing off-chain). This replaces XRPL's dual-signed transaction.
///
///      NOT in this version (documented for the port): overpayment re-amortization
///      (XLS-66 A-2 §5.3 diffTotal) and early full repayment (§6). The pure math for the
///      latter already exists in {Amortization}; only the ledger wiring is deferred.
contract LoanBroker is LoanBrokerHarness, AccessControl, ReentrancyGuard, EIP712 {
    using SafeERC20 for IERC20;
    using WadMath for uint256;

    bytes32 public constant OWNER_ROLE = keccak256("OWNER_ROLE");

    uint8 internal constant STATUS_ACTIVE = 0;
    uint8 internal constant STATUS_IMPAIRED = 1 << 0;
    uint8 internal constant STATUS_DEFAULTED = 1 << 1;
    uint8 internal constant STATUS_CLOSED = 1 << 2;

    bytes32 private constant LOAN_TERMS_TYPEHASH = keccak256(
        "LoanTerms(address borrower,uint256 principal,uint256 interestRate,uint256 lateInterestRate,uint256 closeInterestRate,uint32 paymentInterval,uint32 gracePeriod,uint32 paymentsTotal,uint256 loanServiceFee,uint256 latePaymentFee,uint256 closePaymentFee,uint256 originationFee,uint256 nonce,uint256 deadline)"
    );

    struct LoanTerms {
        address borrower;
        uint256 principal;
        uint256 interestRate; // annual, 1/10th bps
        uint256 lateInterestRate; // annual, 1/10th bps
        uint256 closeInterestRate; // annual, 1/10th bps — early-repayment penalty rate
        uint32 paymentInterval; // seconds
        uint32 gracePeriod; // seconds
        uint32 paymentsTotal;
        uint256 loanServiceFee; // per payment, native
        uint256 latePaymentFee; // native
        uint256 closePaymentFee; // native, charged on early full repayment
        uint256 originationFee; // native, deducted from principal at disbursement
        uint256 nonce;
        uint256 deadline;
    }

    struct Loan {
        address borrower;
        uint256 principalOutstanding;
        uint256 totalValueOutstanding; // principal + gross interest (incl. mgmt fee)
        uint256 mgmtFeeOutstanding; // broker's remaining cut of interest
        uint256 impairedAmount; // unrealized loss booked to the vault, if impaired
        uint256 interestRateWad; // annual
        uint256 lateInterestRateWad; // annual
        uint256 closeInterestRateWad; // annual, early-repayment penalty
        uint32 paymentInterval;
        uint32 gracePeriod;
        uint32 paymentsRemaining;
        uint64 nextPaymentDueDate;
        uint256 loanServiceFee;
        uint256 latePaymentFee;
        uint256 closePaymentFee;
        uint8 status;
    }

    Vault public immutable vault;
    IERC20 public immutable asset;
    address public owner;

    /// @notice First-loss capital held by this contract. XLS-66 CoverAvailable.
    uint256 public coverAvailable;
    /// @notice Total debt (principal + net interest) owed to the vault across active loans.
    uint256 public debtTotal;
    /// @notice Optional cap on total debt (0 = unlimited). XLS-66 DebtMaximum.
    uint256 public debtMaximum;

    uint256 public managementFeeRateWad; // broker cut of interest
    uint256 public coverRateMinimumWad; // required cover as % of debtTotal
    uint256 public coverRateLiquidationWad; // max % of min cover liquidated on default

    /// @notice Immutable lower bound on `coverRateMinimumWad`, fixed at deployment. Default
    ///         0 preserves XLS-66 (first-loss capital is optional); a stricter deployment
    ///         sets it higher to guarantee depositors a minimum first-loss buffer that the
    ///         broker can never configure — or later lower — below.
    uint256 public immutable coverRateFloorWad;

    uint256 public loanSequence;
    mapping(uint256 => Loan) public loans;
    mapping(address => uint256) public nonces;

    error DebtMaximumExceeded(uint256 requested, uint256 max);
    error InsufficientCover(uint256 available, uint256 required);
    error InsufficientPayment(uint256 provided, uint256 due);
    error LoanNotActive(uint256 loanId);
    error NotYetImpairable(uint256 loanId);
    error NotImpaired(uint256 loanId);
    error NotYetDefaultable(uint256 loanId);
    error BadSignature();
    error Expired();
    error NotBorrower(uint256 loanId);
    error CoverRateBelowFloor(uint256 provided, uint256 floor);

    event LoanOriginated(uint256 indexed loanId, address indexed borrower, uint256 principal);
    event LoanPaid(
        uint256 indexed loanId, uint256 principalPaid, uint256 interestToVault, uint256 brokerRevenue
    );
    event LoanClosed(uint256 indexed loanId);
    event LoanClosedEarly(uint256 indexed loanId, uint256 totalPaid, uint256 interestToVault);
    event LoanImpaired(uint256 indexed loanId, uint256 lossBooked);
    event LoanUnimpaired(uint256 indexed loanId, uint256 lossReversed);
    event LoanDefaulted(uint256 indexed loanId, uint256 covered, uint256 lossToDepositors);
    event CoverDeposited(uint256 amount, uint256 coverAvailable);
    event CoverWithdrawn(uint256 amount, uint256 coverAvailable);

    constructor(
        Vault vault_,
        address owner_,
        uint256 debtMaximum_,
        uint256 managementFeeRate_,
        uint256 coverRateMinimum_,
        uint256 coverRateLiquidation_,
        uint256 coverRateFloor_
    ) EIP712("XLS66-LoanBroker", "1") {
        vault = vault_;
        asset = IERC20(vault_.asset());
        owner = owner_;
        _grantRole(DEFAULT_ADMIN_ROLE, owner_);
        _grantRole(OWNER_ROLE, owner_);

        debtMaximum = debtMaximum_;
        managementFeeRateWad = Amortization.fromTenthBps(managementFeeRate_);
        coverRateFloorWad = Amortization.fromTenthBps(coverRateFloor_);
        coverRateMinimumWad = Amortization.fromTenthBps(coverRateMinimum_);
        if (coverRateMinimumWad < coverRateFloorWad) {
            revert CoverRateBelowFloor(coverRateMinimumWad, coverRateFloorWad);
        }
        coverRateLiquidationWad = Amortization.fromTenthBps(coverRateLiquidation_);

        // Allow the vault to pull repayments from this contract via receiveRepay.
        asset.forceApprove(address(vault_), type(uint256).max);
    }

    // =====================================================================
    // Harness (Sixth Sense DeFi §4.2) — opt-in, write-once, admin-gated
    // =====================================================================

    /// @notice Enable and configure the defensive harness once. Reverts if already set.
    /// @dev Gated to DEFAULT_ADMIN_ROLE, not OWNER_ROLE: in production the party that
    ///      imposes the harness should differ from the broker owner, otherwise the
    ///      institution could just disable its own limits.
    function initHarness(
        bool enabled,
        uint256 alpha,
        uint256 alphaBorrower,
        uint256 debtFloor_,
        uint256 lockDuration_,
        uint256 lambda
    ) external onlyRole(DEFAULT_ADMIN_ROLE) {
        _initHarnessConfig(enabled, alpha, alphaBorrower, debtFloor_, lockDuration_, lambda);
    }

    function _hDebtTotal() internal view override returns (uint256) {
        return debtTotal;
    }

    function _hCrmSetWad() internal view override returns (uint256) {
        return coverRateMinimumWad;
    }

    function _hCrmFloorWad() internal view override returns (uint256) {
        return coverRateFloorWad;
    }

    /// @notice Current effective CoverRateMinimum (WAD) after the harness ③ history-linked
    ///         floor. Equals coverRateMinimumWad when the harness is disabled.
    function effectiveCoverRateMinimum() external view returns (uint256) {
        return _effectiveCRM();
    }

    /// @notice Cover the broker may withdraw right now (after min-cover and harness ② locks).
    function coverWithdrawable() external view returns (uint256) {
        uint256 reserve = _minCoverRequired() + lockedCover();
        return coverAvailable > reserve ? coverAvailable - reserve : 0;
    }

    // =====================================================================
    // First-loss capital (XLS-66 LoanBrokerCoverDeposit / CoverWithdraw)
    // =====================================================================

    function coverDeposit(uint256 amount) external onlyRole(OWNER_ROLE) nonReentrant {
        asset.safeTransferFrom(_msgSender(), address(this), amount);
        coverAvailable += amount;
        emit CoverDeposited(amount, coverAvailable);
    }

    /// @notice XLS-66 `LoanBrokerCoverWithdraw`. Harness ② adds a recovery timelock: cover
    ///         proportional to recent defaults stays locked for `lockDuration`.
    function coverWithdraw(uint256 amount) external onlyRole(OWNER_ROLE) nonReentrant {
        uint256 minCover = _minCoverRequired();
        uint256 locked = lockedCover(); // ② harness: 0 when disabled
        // withdrawable = coverAvailable − minCover − recentlyLockedCover
        uint256 floorReserve = minCover + locked;
        if (coverAvailable < amount || coverAvailable - amount < floorReserve) {
            uint256 withdrawable = coverAvailable > floorReserve ? coverAvailable - floorReserve : 0;
            revert CoverLockedByTimelock(amount, withdrawable);
        }
        coverAvailable -= amount;
        asset.safeTransfer(_msgSender(), amount);
        emit CoverWithdrawn(amount, coverAvailable);
    }

    function _minCoverRequired() internal view returns (uint256) {
        // Uses the harness's effective CRM (③ history-linked floor); equals
        // coverRateMinimumWad when the harness is disabled.
        return debtTotal.wmul(_effectiveCRM());
    }

    /// @notice XLS-66: when cover is short, the broker cannot take fees — they are
    ///         redirected into first-loss capital to restore compliance.
    function _coverIsShort() internal view returns (bool) {
        return coverAvailable < _minCoverRequired();
    }

    // =====================================================================
    // Origination (XLS-66 LoanSet)
    // =====================================================================

    /// @notice XLS-66 `LoanSet`. Harness ① caps a single loan / single borrower as a
    ///         fraction of total debt; ③ raises the required cover with default history.
    function originate(LoanTerms calldata terms, bytes calldata borrowerSig)
        external
        onlyRole(OWNER_ROLE)
        nonReentrant
        returns (uint256 loanId)
    {
        if (block.timestamp > terms.deadline) revert Expired();
        _verifyBorrower(terms, borrowerSig);

        uint256 interestRateWad = Amortization.fromTenthBps(terms.interestRate);
        uint256 periodicRateWad = Amortization.periodicRate(interestRateWad, terms.paymentInterval);

        // Theoretical schedule.
        uint256 periodicPayment =
            Amortization.periodicPayment(terms.principal, periodicRateWad, terms.paymentsTotal);
        uint256 totalValue = Amortization.totalValueOutstanding(periodicPayment, terms.paymentsTotal);
        // Zero/near-zero interest with an indivisible principal floors the periodic payment
        // so that totalValue < principal; the loan still owes the full principal, so clamp
        // up (grossInterest then becomes 0). Prevents underflow in interestBreakdown.
        if (totalValue < terms.principal) totalValue = terms.principal;
        (, uint256 mgmtFee, uint256 netInterest) =
            Amortization.interestBreakdown(totalValue, terms.principal, managementFeeRateWad);

        uint256 newDebt = terms.principal + netInterest; // XLS-66: principal + (interest − fee)
        if (debtMaximum != 0 && debtTotal + newDebt > debtMaximum) {
            revert DebtMaximumExceeded(debtTotal + newDebt, debtMaximum);
        }
        // ① harness: single-loan / single-borrower concentration limit (no-op when disabled).
        _harnessCheckConcentration(newDebt, terms.borrower);
        // Must remain adequately covered after issuing (XLS-66 cover constraint), using the
        // harness ③ effective CoverRateMinimum.
        uint256 requiredCover = (debtTotal + newDebt).wmul(_effectiveCRM());
        if (coverAvailable < requiredCover) revert InsufficientCover(coverAvailable, requiredCover);

        loanId = ++loanSequence;
        loans[loanId] = Loan({
            borrower: terms.borrower,
            principalOutstanding: terms.principal,
            totalValueOutstanding: totalValue,
            mgmtFeeOutstanding: mgmtFee,
            impairedAmount: 0,
            interestRateWad: interestRateWad,
            lateInterestRateWad: Amortization.fromTenthBps(terms.lateInterestRate),
            closeInterestRateWad: Amortization.fromTenthBps(terms.closeInterestRate),
            paymentInterval: terms.paymentInterval,
            gracePeriod: terms.gracePeriod,
            paymentsRemaining: terms.paymentsTotal,
            nextPaymentDueDate: uint64(block.timestamp + terms.paymentInterval),
            loanServiceFee: terms.loanServiceFee,
            latePaymentFee: terms.latePaymentFee,
            closePaymentFee: terms.closePaymentFee,
            status: STATUS_ACTIVE
        });

        debtTotal += newDebt;
        _harnessOnOriginate(terms.principal, terms.borrower, newDebt); // ①③ tracking
        nonces[terms.borrower] = terms.nonce + 1;

        // Disburse: pull principal from the vault, keep origination fee, send the rest to
        // the borrower. (XLS-66: origination fee is deducted from principal at creation.)
        vault.lendOut(terms.principal, address(this));
        if (terms.originationFee > 0) {
            _payBrokerRevenue(terms.originationFee);
        }
        asset.safeTransfer(terms.borrower, terms.principal - terms.originationFee);

        emit LoanOriginated(loanId, terms.borrower, terms.principal);
    }

    function _verifyBorrower(LoanTerms calldata terms, bytes calldata sig) internal view {
        if (terms.nonce != nonces[terms.borrower]) revert BadSignature();
        bytes32 structHash = keccak256(
            abi.encode(
                LOAN_TERMS_TYPEHASH,
                terms.borrower,
                terms.principal,
                terms.interestRate,
                terms.lateInterestRate,
                terms.closeInterestRate,
                terms.paymentInterval,
                terms.gracePeriod,
                terms.paymentsTotal,
                terms.loanServiceFee,
                terms.latePaymentFee,
                terms.closePaymentFee,
                terms.originationFee,
                terms.nonce,
                terms.deadline
            )
        );
        address signer = ECDSA.recover(_hashTypedDataV4(structHash), sig);
        if (signer != terms.borrower) revert BadSignature();
    }

    // =====================================================================
    // Repayment (XLS-66 LoanPay) — regular + late; overpayment out of scope
    // =====================================================================

    function pay(uint256 loanId, uint256 amount) external nonReentrant {
        Loan storage loan = loans[loanId];
        if (loan.status != STATUS_ACTIVE && loan.status != STATUS_IMPAIRED) {
            revert LoanNotActive(loanId);
        }
        if (loan.paymentsRemaining == 0) revert LoanNotActive(loanId);

        (uint256 principalPortion, uint256 mgmtFee, uint256 netInterest, uint256 periodicPayment) =
            _splitRegular(loan);

        // Guard against annuity rounding drift making the recomputed principal portion
        // exceed what actually remains (the final-payment override only protects the last
        // installment). Keeps the vault's onLoan == sum(active principals) invariant exact.
        // The full XLS-66 A-3.3 diffTotal reconciliation is deferred; this is its stand-in.
        if (principalPortion > loan.principalOutstanding) principalPortion = loan.principalOutstanding;

        // Late components.
        uint256 lateNet;
        uint256 lateMgmt;
        if (block.timestamp > loan.nextPaymentDueDate) {
            uint256 secondsOverdue = block.timestamp - loan.nextPaymentDueDate;
            uint256 lateRateWad = Amortization.latePeriodicRate(loan.lateInterestRateWad, secondsOverdue);
            (, lateMgmt, lateNet) = Amortization.latePaymentInterest(
                loan.principalOutstanding, lateRateWad, managementFeeRateWad
            );
        }

        bool isLate = lateNet > 0 || lateMgmt > 0;
        uint256 lateFee = isLate ? loan.latePaymentFee : 0;

        uint256 vaultInterest = netInterest + lateNet;
        uint256 brokerRevenue = mgmtFee + lateMgmt + loan.loanServiceFee + lateFee;

        // periodicPayment already contains principalPortion + netInterest + mgmtFee.
        // Late gross interest (net + mgmt) and the fixed fees are added on top.
        uint256 totalDue = periodicPayment + loan.loanServiceFee + lateNet + lateMgmt + lateFee;

        if (amount < totalDue) revert InsufficientPayment(amount, totalDue);

        // Pull exactly what is due; route principal + interest to the vault.
        asset.safeTransferFrom(_msgSender(), address(this), totalDue);
        vault.receiveRepay(principalPortion, vaultInterest);
        _payBrokerRevenue(brokerRevenue);

        // Update ledger (saturating subtractions absorb residual annuity rounding rather
        // than reverting a legitimate payment near loan end).
        loan.principalOutstanding -= principalPortion; // exact: clamped above
        loan.mgmtFeeOutstanding = _satSub(loan.mgmtFeeOutstanding, mgmtFee);
        loan.totalValueOutstanding =
            _satSub(loan.totalValueOutstanding, principalPortion + netInterest + mgmtFee);
        debtTotal = _satSub(debtTotal, principalPortion + netInterest);
        _harnessSubBorrowerDebt(loan.borrower, principalPortion + netInterest); // ① tracking
        // NOTE: late net interest is settled in this same transaction (paid to the vault
        // via receiveRepay), so it must NOT be added to debtTotal — doing so would leak a
        // permanent overstatement into the cover requirement.
        loan.paymentsRemaining -= 1;
        loan.nextPaymentDueDate += loan.paymentInterval;

        // Keep the booked impairment in step with the principal actually repaid, so the
        // vault's redemption price is not left suppressed by a stale over-booked loss.
        if (loan.status == STATUS_IMPAIRED && loan.impairedAmount > 0) {
            uint256 dec = principalPortion < loan.impairedAmount ? principalPortion : loan.impairedAmount;
            loan.impairedAmount -= dec;
            vault.decreaseLoss(dec);
        }

        emit LoanPaid(loanId, principalPortion, vaultInterest, brokerRevenue);

        if (loan.paymentsRemaining == 0) {
            _closeIfImpaired(loan);
            loan.status = STATUS_CLOSED;
            emit LoanClosed(loanId);
        }
    }

    /// @dev Regular payment split, with the XLS-66 final-payment override (use stored
    ///      TotalValueOutstanding when one payment remains, avoiding rounding dust).
    function _splitRegular(Loan storage loan)
        internal
        view
        returns (uint256 principalPortion, uint256 mgmtFee, uint256 netInterest, uint256 periodicPayment)
    {
        if (loan.paymentsRemaining == 1) {
            principalPortion = loan.principalOutstanding;
            mgmtFee = loan.mgmtFeeOutstanding;
            uint256 grossInterest = loan.totalValueOutstanding - loan.principalOutstanding;
            netInterest = grossInterest - mgmtFee;
            periodicPayment = loan.totalValueOutstanding;
        } else {
            uint256 periodicRateWad =
                Amortization.periodicRate(loan.interestRateWad, loan.paymentInterval);
            periodicPayment = Amortization.periodicPayment(
                loan.principalOutstanding, periodicRateWad, loan.paymentsRemaining
            );
            uint256 interest;
            (principalPortion, interest) = Amortization.paymentBreakdown(
                loan.principalOutstanding, periodicPayment, periodicRateWad
            );
            mgmtFee = Amortization.managementFee(interest, managementFeeRateWad);
            netInterest = interest - mgmtFee;
        }
    }

    /// @dev Send broker revenue to the owner, or divert it into first-loss capital when
    ///      cover is short (XLS-66 fee redirect).
    function _payBrokerRevenue(uint256 amount) internal {
        if (amount == 0) return;
        if (_coverIsShort()) {
            coverAvailable += amount; // tokens already held by this contract
        } else {
            asset.safeTransfer(owner, amount);
        }
    }

    // =====================================================================
    // Early full repayment (XLS-66 LoanPay full-payment path, A-2 §6)
    // =====================================================================

    /// @notice Borrower repays the entire loan before maturity, paying accrued interest and
    ///         a prepayment penalty. XLS-66 A-2 §6 (formulas 26–28).
    function closeLoan(uint256 loanId) external nonReentrant {
        Loan storage loan = loans[loanId];
        if (loan.status != STATUS_ACTIVE && loan.status != STATUS_IMPAIRED) {
            revert LoanNotActive(loanId);
        }
        if (loan.paymentsRemaining == 0) revert LoanNotActive(loanId);
        if (_msgSender() != loan.borrower) revert NotBorrower(loanId);

        uint256 principal = loan.principalOutstanding;
        uint256 periodicRateWad = Amortization.periodicRate(loan.interestRateWad, loan.paymentInterval);

        // secondsSinceLastPayment = now − max(previousPaymentDueDate, startDate). Since the
        // due date advances by exactly one interval per settled installment (and the first
        // due date is startDate + interval), (nextPaymentDueDate − interval) is that boundary.
        uint256 lastBoundary = uint256(loan.nextPaymentDueDate) - loan.paymentInterval;
        uint256 secondsSince = block.timestamp > lastBoundary ? block.timestamp - lastBoundary : 0;

        uint256 accrued =
            Amortization.accruedInterest(principal, periodicRateWad, secondsSince, loan.paymentInterval); // (27)
        uint256 penalty = Amortization.prepaymentPenalty(principal, loan.closeInterestRateWad); // (28)

        uint256 closeInterest = accrued + penalty;
        uint256 mgmtFee = Amortization.managementFee(closeInterest, managementFeeRateWad);
        uint256 vaultInterest = closeInterest - mgmtFee;

        uint256 totalDue = principal + closeInterest + loan.closePaymentFee; // (26)

        // Remaining vault debt for this loan (cleared regardless of interest actually paid).
        uint256 netInterestOut = loan.totalValueOutstanding - principal - loan.mgmtFeeOutstanding;

        asset.safeTransferFrom(_msgSender(), address(this), totalDue);
        vault.receiveRepay(principal, vaultInterest);
        _payBrokerRevenue(mgmtFee + loan.closePaymentFee);

        debtTotal = _satSub(debtTotal, principal + netInterestOut);
        _harnessSubBorrowerDebt(loan.borrower, principal + netInterestOut); // ① tracking

        if (loan.status == STATUS_IMPAIRED && loan.impairedAmount > 0) {
            vault.decreaseLoss(loan.impairedAmount);
            loan.impairedAmount = 0;
        }

        loan.principalOutstanding = 0;
        loan.totalValueOutstanding = 0;
        loan.mgmtFeeOutstanding = 0;
        loan.paymentsRemaining = 0;
        loan.status = STATUS_CLOSED;

        emit LoanClosedEarly(loanId, totalDue, vaultInterest);
    }

    // =====================================================================
    // Impairment (XLS-66 LoanManage: impair / unimpair)
    // =====================================================================

    function impair(uint256 loanId) external onlyRole(OWNER_ROLE) {
        Loan storage loan = loans[loanId];
        if (loan.status != STATUS_ACTIVE) revert LoanNotActive(loanId);
        // XLS-66 fixCleanup3_4_0: impair only once a payment is overdue.
        if (block.timestamp <= loan.nextPaymentDueDate) revert NotYetImpairable(loanId);

        // Book only the outstanding PRINCIPAL as the paper loss. In this EVM model future
        // interest is never counted in the vault's totalAssets until it is actually
        // received, so it is not at risk on the balance sheet — booking it would
        // over-suppress the redemption price (and could exceed totalAssets and revert).
        uint256 loss = loan.principalOutstanding;
        loan.impairedAmount = loss;
        loan.status = STATUS_IMPAIRED;
        vault.increaseLoss(loss);
        emit LoanImpaired(loanId, loss);
    }

    function unimpair(uint256 loanId) external onlyRole(OWNER_ROLE) {
        Loan storage loan = loans[loanId];
        if (loan.status != STATUS_IMPAIRED) revert NotImpaired(loanId);
        uint256 reversed = loan.impairedAmount;
        loan.impairedAmount = 0;
        loan.status = STATUS_ACTIVE;
        vault.decreaseLoss(reversed);
        emit LoanUnimpaired(loanId, reversed);
    }

    function _closeIfImpaired(Loan storage loan) internal {
        if (loan.status == STATUS_IMPAIRED && loan.impairedAmount > 0) {
            uint256 reversed = loan.impairedAmount;
            loan.impairedAmount = 0;
            loan.status = STATUS_ACTIVE;
            vault.decreaseLoss(reversed);
        }
    }

    // =====================================================================
    // Default + first-loss waterfall (XLS-66 A-2 §8, formulas 34–37)
    // =====================================================================

    /// @dev Broker-gated, consistent with impair/unimpair (XLS-66 LoanManage is a broker
    ///      operation). This removes the front-running/griefing vector of a permissionless
    ///      default against a borrower who is about to pay. A deliberately permissionless,
    ///      keeper-triggered default could be added later as an explicit opt-in.
    function default_(uint256 loanId) external onlyRole(OWNER_ROLE) nonReentrant {
        Loan storage loan = loans[loanId];
        if (loan.status != STATUS_ACTIVE && loan.status != STATUS_IMPAIRED) {
            revert LoanNotActive(loanId);
        }
        // Only after the grace period has fully elapsed.
        if (block.timestamp <= uint256(loan.nextPaymentDueDate) + loan.gracePeriod) {
            revert NotYetDefaultable(loanId);
        }

        uint256 principal = loan.principalOutstanding;
        uint256 defaultAmount = _defaultAmount(loan); // (34) principal + net interest

        // (35) DefaultCovered = min(minCover * liquidationRate, DefaultAmount, CoverAvailable)
        uint256 liquidatable = _minCoverRequired().wmul(coverRateLiquidationWad);
        uint256 covered = _min3(liquidatable, defaultAmount, coverAvailable);

        // Reverse any unrealized loss (we now realize it), then write down the lent
        // principal and return the covered funds to the vault.
        if (loan.status == STATUS_IMPAIRED && loan.impairedAmount > 0) {
            vault.decreaseLoss(loan.impairedAmount);
            loan.impairedAmount = 0;
        }
        vault.writeDownOnLoan(principal); // depositors lose the lent principal ...
        if (covered > 0) {
            coverAvailable -= covered;
            asset.safeTransfer(address(vault), covered); // ... offset by first-loss capital
        }

        debtTotal -= defaultAmount; // remove this loan's remaining debt
        _harnessOnDefault(defaultAmount); // ②③ record default (timelock + default rate)
        _harnessSubBorrowerDebt(loan.borrower, defaultAmount); // ① tracking

        uint256 lossToDepositors = principal > covered ? principal - covered : 0;
        loan.principalOutstanding = 0;
        loan.totalValueOutstanding = 0;
        loan.mgmtFeeOutstanding = 0;
        loan.paymentsRemaining = 0;
        loan.status = STATUS_DEFAULTED;

        emit LoanDefaulted(loanId, covered, lossToDepositors);
    }

    /// @dev XLS-66 (34): principal outstanding + net interest outstanding.
    function _defaultAmount(Loan storage loan) internal view returns (uint256) {
        uint256 netInterestOutstanding =
            loan.totalValueOutstanding - loan.principalOutstanding - loan.mgmtFeeOutstanding;
        return loan.principalOutstanding + netInterestOutstanding;
    }

    // =====================================================================
    // Admin
    // =====================================================================

    function setDebtMaximum(uint256 v) external onlyRole(OWNER_ROLE) {
        debtMaximum = v;
    }

    function setManagementFeeRate(uint256 tenthBps) external onlyRole(OWNER_ROLE) {
        managementFeeRateWad = Amortization.fromTenthBps(tenthBps);
    }

    /// @notice XLS-66 `LoanBrokerSet` (cover rates). The set minimum is a floor for the
    ///         effective CRM; harness ③ raises the effective floor further with default
    ///         history (see {_effectiveCRM}).
    function setCoverRates(uint256 minTenthBps, uint256 liqTenthBps) external onlyRole(OWNER_ROLE) {
        uint256 newMin = Amortization.fromTenthBps(minTenthBps);
        // The broker can never drop the minimum below the immutable floor depositors relied
        // on — this closes the "lower cover after depositors commit" rug vector.
        if (newMin < coverRateFloorWad) revert CoverRateBelowFloor(newMin, coverRateFloorWad);
        coverRateMinimumWad = newMin;
        coverRateLiquidationWad = Amortization.fromTenthBps(liqTenthBps);
    }

    // =====================================================================
    // Helpers
    // =====================================================================

    function _min3(uint256 a, uint256 b, uint256 c) internal pure returns (uint256) {
        uint256 m = a < b ? a : b;
        return m < c ? m : c;
    }

    /// @dev Saturating subtraction: returns 0 instead of underflowing.
    function _satSub(uint256 a, uint256 b) internal pure returns (uint256) {
        return a > b ? a - b : 0;
    }

    /// @notice Full loan record (convenience getter; the public `loans` mapping returns a
    ///         flat tuple that is awkward to consume).
    function getLoan(uint256 loanId) external view returns (Loan memory) {
        return loans[loanId];
    }
}
