import { ethers } from "ethers";
import ART from "../artifacts.json";

declare global {
  interface Window {
    ethereum?: any;
    DEMO_RPC?: string;
  }
}

export const SEPOLIA = 11155111n;
const CHAIN_HEX = "0xaa36a7";
const RPC = (typeof window !== "undefined" && window.DEMO_RPC) || "https://ethereum-sepolia-rpc.publicnode.com";
const POLL_MS = 1000; // receipt poll interval (ethers default is 4000)
const DEADLINE = 4102444800;
const RATE = { late: 24000, close: 2000 };
const FUND = { broker: "0.06", each: "0.01" };

const TYPES = {
  LoanTerms: [
    { name: "borrower", type: "address" }, { name: "principal", type: "uint256" },
    { name: "interestRate", type: "uint256" }, { name: "lateInterestRate", type: "uint256" },
    { name: "closeInterestRate", type: "uint256" }, { name: "paymentInterval", type: "uint32" },
    { name: "gracePeriod", type: "uint32" }, { name: "paymentsTotal", type: "uint32" },
    { name: "loanServiceFee", type: "uint256" }, { name: "latePaymentFee", type: "uint256" },
    { name: "closePaymentFee", type: "uint256" }, { name: "originationFee", type: "uint256" },
    { name: "nonce", type: "uint256" }, { name: "deadline", type: "uint256" },
  ],
};

export const U = (v: number | string) => ethers.parseUnits(String(v), 18);
export const N = (v: bigint) => Number(ethers.formatUnits(v, 18));
export const fmt = (v: bigint) => N(v).toLocaleString(undefined, { maximumFractionDigits: 2 });
export const short = (a: string) => a.slice(0, 6) + "…" + a.slice(-4);

const IFACES: Array<[string, ethers.Interface]> = [
  ["Vault", new ethers.Interface((ART as any).vault.abi)],
  ["LoanBroker", new ethers.Interface((ART as any).broker.abi)],
  ["dUSD", new ethers.Interface((ART as any).token.abi)],
];

/** address → contract name, filled in by attach(). Lets a revert be attributed to the
 *  contract that actually raised it rather than to whichever ABI parses the selector first. */
const ADDR_BOOK = new Map<string, string>();

const isHexData = (v: any): v is string => typeof v === "string" && /^0x[0-9a-fA-F]{8,}$/.test(v);

/** Custom-error amounts are WAD token amounts; printing them raw (45000000000000000000000)
 *  makes the decoded error unreadable. Timestamps, nonces and role ids stay below the cut-off. */
const fmtArg = (v: any) => (typeof v === "bigint" && v >= 10n ** 15n ? fmt(v) : String(v));

/** Providers disagree about where revert data lives: ethers lifts it to `e.data`, but JSON-RPC
 *  nodes wrap it under `info.error` / `error`, sometimes one object deeper. `??` stops at the
 *  first non-nullish value, so a wrapper object would hide the payload underneath it — collect
 *  every candidate instead and take the first one that is actually hex. */
function revertData(e: any): string | undefined {
  for (const r of [e?.data, e?.info?.error?.data, e?.error?.data, e?.error?.error?.data]) {
    if (isHexData(r)) return r;
    if (r && typeof r === "object" && isHexData((r as any).data)) return (r as any).data;
  }
  return undefined;
}

/** ethers decodes a revert only against the ABI of the contract it called, so a Vault error
 *  raised inside a LoanBroker call surfaces as "unknown custom error". Try every ABI we have,
 *  and fall back to the raw selector so an unrecognised revert is still identifiable. */
export function explainError(e: any): string {
  const callee = typeof e?.transaction?.to === "string" ? ADDR_BOOK.get(e.transaction.to.toLowerCase()) : undefined;
  const suffix = (n?: string) => (n ? ` · ${n}` : "");
  const data = revertData(e);
  if (data) {
    const hits: Array<[string, ethers.ErrorDescription]> = [];
    for (const [name, iface] of IFACES) {
      try { const d = iface.parseError(data); if (d) hits.push([name, d]); } catch { /* not this ABI */ }
    }
    if (hits.length) {
      // Error(string)/Panic parse against every ABI, and Vault and LoanBroker both declare the
      // AccessControl / ReentrancyGuard / SafeERC20 errors — so a match is not evidence of
      // origin. Name a contract only when we know the callee or exactly one ABI declares it.
      const [only, d] = hits.find(([n]) => n === callee) ?? hits[0];
      return `${d.name}(${d.args.map(fmtArg).join(", ")})${suffix(callee ?? (hits.length === 1 ? only : undefined))}`;
    }
    return `${e.shortMessage || e.message} · selector ${data.slice(0, 10)}`;
  }
  // ethers decoded it itself, against the called contract's own ABI (v6 CallExceptionError.revert
  // is { signature, name, args } — it carries no `data`, so the branch above never sees it).
  if (e?.revert?.name) return `${e.revert.name}(${[...(e.revert.args ?? [])].map(fmtArg).join(", ")})${suffix(callee)}`;
  return e?.shortMessage || e?.message || String(e);
}

export interface Snapshot {
  vaultTotal: number; onLoan: number; loss: number; cover: number; debt: number; maxWithdraw: number;
  balDep: number; balBor: number; balBrk: number;
  addrDep: string; addrBor: string; addrBrk: string;
  mgmtFeeRate: number; crmSetPct: number; crmFloorPct: number;
  // harness (§4.2)
  harnessOn: boolean; effCrmPct: number; defaultRatePct: number; coverWithdrawable: number;
  alpha: number; alphaBorrower: number; debtFloorAmt: number; lambda: number; borrowerDebt: number;
}

// LoanBroker constructor config (debtMaximum; then rates in 1/10th bps: 1000 = 1%).
const BROKER_CFG = { debtMax: 0n, mgmtFee: 1000n, crm: 10000n, crmLiq: 100000n, crmFloor: 0n };
export const MGMT_FEE_RATE = Number(BROKER_CFG.mgmtFee) / 1e5;

// Harness demo config (WAD fractions; lockDuration seconds).
export const HARNESS = {
  alpha: 5n * 10n ** 17n, // 50% single-loan
  alphaBorrower: 5n * 10n ** 17n, // 50% per-borrower
  lockDuration: 60n, // T_lock seconds
  lambda: 10n ** 18n, // λ = 1.0
};

/** D_floor for a fresh deployment. The cap a young book gets is loanCap = α × max(debt, D_floor),
 *  and it is measured against a loan's *debt* (principal + net interest), not its principal.
 *  Deriving D_floor from the params actually in use keeps both halves of scenario C true at any
 *  principal — the ordinary loan fits under the cap while the oversized one does not — whereas a
 *  fixed number can only ever be right for one principal, and initHarness is write-once, so the
 *  wrong choice bricks the scenarios until the demo is redeployed.
 *  @param headroom the largest loan debt that must stay admissible (scenario D borrows twice). */
export function harnessDebtFloor(loanDebt: number, headroom = 0): bigint {
  const cap = Math.max(loanDebt * 1.2, headroom);
  return U(Math.ceil(cap / (Number(HARNESS.alpha) / 1e18)));
}

/** The terms of one origination, enough to price it the way LoanBroker.originate does. */
export interface LoanPlan { principal: number; interestRaw: number; interval: number; payments: number }

// WadMath, as the contracts use it: floor(a*b/WAD) and floor(a*WAD/b), exponentiation by
// squaring. Reproduced here so a quote agrees with the chain bit for bit — in doubles the
// annuity factor drifts by ~5e-6 relative, which is enough to disagree about a cover
// requirement near the boundary, and disagreeing with the contract is the whole bug class
// this precheck exists to remove.
const WAD = 10n ** 18n;
const wmul = (a: bigint, b: bigint) => (a * b) / WAD;
const wdiv = (a: bigint, b: bigint) => (a * WAD) / b;
function wpow(base: bigint, n: bigint): bigint {
  let r = WAD;
  while (n > 0n) { if (n & 1n) r = wmul(r, base); n >>= 1n; if (n > 0n) base = wmul(base, base); }
  return r;
}

/** newDebt = principal + netInterest — the figure both the cover constraint and the harness
 *  concentration cap are measured against. Mirrors Amortization (1),(5),(6),(7),(30)–(33) and
 *  originate()'s clamp; `interestRaw` is in 1/10th bps, as the contract takes it. */
export function quoteNewDebt(loan: LoanPlan, mgmtFeeRate: number): number {
  const { principal, interestRaw, interval, payments } = loan;
  if (payments <= 0) return principal;
  const p = U(principal), n = BigInt(Math.trunc(payments));
  // fromTenthBps, then periodicRate (1): annualised → per period.
  const r = (BigInt(Math.round(interestRaw)) * 10n ** 13n * BigInt(Math.trunc(interval))) / 31536000n;
  let pay: bigint;
  if (r === 0n) pay = p / n; // zero-interest special case
  else {
    const raised = wpow(WAD + r, n); // (5)
    pay = wmul(p, wdiv(wmul(r, raised), raised - WAD)); // (6),(7)
  }
  let total = pay * n; // (30)
  if (total < p) total = p; // the clamp originate() applies before the breakdown
  const gross = total - p; // (31)
  return N(p + gross - wmul(gross, U(mgmtFeeRate))); // (32),(33)
}

export interface OriginationIssue {
  kind: "cover" | "concentration";
  /** Which concentration cap was hit — the single-loan α cap, or the per-borrower one. They
   *  are different rules with different remedies, so the UI must not describe one as the other. */
  limit?: "loan" | "borrower";
  loan: LoanPlan; debt: number; need: number; have: number;
  /** Debt already outstanding that counts toward the cap: the book's for "loan", this
   *  borrower's for "borrower". */
  existing: number;
}

/** Replay origination's two gates against a snapshot, in the contract's order (concentration,
 *  then cover), carrying debt forward between loans so a multi-loan scenario is checked as a
 *  whole. Returns the first gate that would fail, so the UI can say so before spending gas
 *  instead of reverting mid-scenario.
 *  @param cover extra cover the scenario deposits before originating. */
export function checkOriginations(s: Snapshot, cover: number, crmSetPct: number, loans: LoanPlan[]): OriginationIssue | null {
  const crmEff = Math.min(100, Math.max(crmSetPct, s.harnessOn ? s.crmFloorPct + s.lambda * s.defaultRatePct : 0)) / 100;
  let debtTotal = s.debt, borrowerDebt = s.borrowerDebt;
  const coverAvail = s.cover + cover;
  for (const loan of loans) {
    const debt = quoteNewDebt(loan, s.mgmtFeeRate);
    if (s.harnessOn) {
      const basis = Math.max(debtTotal + debt, s.debtFloorAmt);
      const cap = s.alpha * basis, borrowerCap = s.alphaBorrower * basis;
      if (debt > cap) {
        return { kind: "concentration", limit: "loan", loan, debt, need: debt, have: cap, existing: debtTotal };
      }
      if (borrowerDebt + debt > borrowerCap) {
        return { kind: "concentration", limit: "borrower", loan, debt, need: borrowerDebt + debt, have: borrowerCap, existing: borrowerDebt };
      }
    }
    const required = (debtTotal + debt) * crmEff;
    if (coverAvail < required) {
      return { kind: "cover", loan, debt, need: required, have: coverAvail, existing: debtTotal };
    }
    debtTotal += debt; borrowerDebt += debt;
  }
  return null;
}

/** Largest single-loan debt the harness admits right now. x is admissible iff
 *  x ≤ α × max(debtTotal + x, D_floor), which is monotone in x, so bisect on the exact
 *  predicate rather than re-deriving the closed form for each branch. */
export function harnessLoanCap(s: Snapshot): number {
  if (!s.harnessOn) return Infinity;
  const admits = (x: number) => {
    const basis = Math.max(s.debt + x, s.debtFloorAmt);
    return x <= s.alpha * basis && s.borrowerDebt + x <= s.alphaBorrower * basis;
  };
  if (!admits(0)) return 0;
  let lo = 0, hi = Math.max(s.debtFloorAmt, s.debt, 1) * 1e3;
  if (admits(hi)) return hi;
  for (let i = 0; i < 60; i++) { const mid = (lo + hi) / 2; if (admits(mid)) lo = mid; else hi = mid; }
  return lo;
}

type LogFn = (msg: string, hash?: string) => void;

export class LendingClient {
  ro!: ethers.JsonRpcProvider;
  funder!: ethers.Signer;
  account = "";
  W!: { depositor: ethers.Wallet; borrower: ethers.Wallet; broker: ethers.Wallet };
  // ethers v6 Contract methods are dynamic; typed as any for ergonomic access.
  token!: any;
  vault!: any;
  broker!: any;
  loanId = 0;
  log: LogFn;

  constructor(log: LogFn) { this.log = log; }

  private dkey() { return `xls6566:dep:${this.account}`; }
  private wkey() { return `xls6566:wal:${this.account}`; }

  hasDeployment() { return !!localStorage.getItem(this.dkey()); }

  async connect(): Promise<string> {
    if (!window.ethereum) throw new Error("MetaMask가 없습니다");
    let bp = new ethers.BrowserProvider(window.ethereum);
    await bp.send("eth_requestAccounts", []);
    const net = await bp.getNetwork();
    if (net.chainId !== SEPOLIA) {
      await window.ethereum.request({ method: "wallet_switchEthereumChain", params: [{ chainId: CHAIN_HEX }] });
      bp = new ethers.BrowserProvider(window.ethereum);
    }
    // The demo runs 30+ sequential transactions; the default 4s receipt poll adds up.
    bp.pollingInterval = POLL_MS;
    this.funder = await bp.getSigner();
    this.account = await this.funder.getAddress();
    this.ro = new ethers.JsonRpcProvider(RPC, SEPOLIA, { staticNetwork: true });
    this.ro.pollingInterval = POLL_MS;
    this.loadWallets();
    return this.account;
  }

  private loadWallets() {
    const s = localStorage.getItem(this.wkey());
    let k: { depositor: string; borrower: string; broker: string };
    if (s) k = JSON.parse(s);
    else {
      k = {
        depositor: ethers.Wallet.createRandom().privateKey,
        borrower: ethers.Wallet.createRandom().privateKey,
        broker: ethers.Wallet.createRandom().privateKey,
      };
      localStorage.setItem(this.wkey(), JSON.stringify(k));
    }
    this.W = {
      depositor: new ethers.Wallet(k.depositor, this.ro),
      borrower: new ethers.Wallet(k.borrower, this.ro),
      broker: new ethers.Wallet(k.broker, this.ro),
    };
  }

  addrs() {
    return { dep: this.W.depositor.address, bor: this.W.borrower.address, brk: this.W.broker.address };
  }

  reset() { localStorage.removeItem(this.dkey()); localStorage.removeItem(this.wkey()); }

  /** Drop the deployment pointer but keep the role wallets: they hold gas ETH already sent
   *  from MetaMask, and new random keys would strand it. */
  resetDeployment() { localStorage.removeItem(this.dkey()); this.loanId = 0; }

  private async txw(p: Promise<any>, label: string) {
    const t = await p;
    this.log(`${label} · 처리 중`, t.hash);
    await t.wait();
    this.log(`✓ ${label}`, t.hash);
    return t;
  }

  attach(a: { token: string; vault: string; broker: string }) {
    ADDR_BOOK.clear();
    ADDR_BOOK.set(a.token.toLowerCase(), "dUSD");
    ADDR_BOOK.set(a.vault.toLowerCase(), "Vault");
    ADDR_BOOK.set(a.broker.toLowerCase(), "LoanBroker");
    this.token = new ethers.Contract(a.token, (ART as any).token.abi, this.ro);
    this.vault = new ethers.Contract(a.vault, (ART as any).vault.abi, this.ro);
    this.broker = new ethers.Contract(a.broker, (ART as any).broker.abi, this.ro);
  }

  async loadExisting(): Promise<boolean> {
    const dep = localStorage.getItem(this.dkey());
    if (!dep) return false;
    this.attach(JSON.parse(dep));
    try { this.loanId = Number(await this.broker.loanSequence()); } catch { /* ignore */ }
    return true;
  }

  /** @param debtFloor harness ① D_floor; write-once, so it is fixed to the params in use
   *         at deployment time (see {@link harnessDebtFloor}). */
  async setup(onStatus: (s: string) => void, harnessEnabled = false, debtFloor = harnessDebtFloor(30000)) {
    onStatus("브로커 지갑 가스 충전 (MetaMask 서명 1회)…");
    const bal = await this.ro.getBalance(this.W.broker.address);
    if (bal < ethers.parseEther("0.04")) {
      const ft = await this.funder.sendTransaction({ to: this.W.broker.address, value: ethers.parseEther(FUND.broker) });
      this.log(`MetaMask → 브로커 가스 충전 ${FUND.broker} ETH`, ft.hash);
      await ft.wait();
    }
    const B = this.W.broker;
    onStatus("DemoUSD 배포…");
    const T = await new ethers.ContractFactory((ART as any).token.abi, (ART as any).token.bytecode, B).deploy();
    await T.waitForDeployment();
    onStatus("Vault 배포…");
    const V = await new ethers.ContractFactory((ART as any).vault.abi, (ART as any).vault.bytecode, B)
      .deploy(await T.getAddress(), "Demo Vault", "dVLT", B.address, false, 0n, 6);
    await V.waitForDeployment();
    onStatus("LoanBroker 배포…");
    const K = await new ethers.ContractFactory((ART as any).broker.abi, (ART as any).broker.bytecode, B)
      .deploy(await V.getAddress(), B.address,
        BROKER_CFG.debtMax, BROKER_CFG.mgmtFee, BROKER_CFG.crm, BROKER_CFG.crmLiq, BROKER_CFG.crmFloor);
    await K.waitForDeployment();
    const tokenAddr = await T.getAddress();
    const vaultAddr = await V.getAddress();
    const brokerAddr = await K.getAddress();

    // Everything below is broker-signed and mutually independent, so the transactions go out
    // together and are only awaited at the end — one block instead of one per call. NonceManager
    // hands out distinct nonces for the concurrent sends.
    onStatus("권한 설정 · 가스 충전 · dUSD 지급…");
    const BN = new ethers.NonceManager(B);
    const Tb = (T as any).connect(BN);
    const batch: Promise<any>[] = [
      (V as any).connect(BN).grantRole(await (V as any).PROTOCOL_ROLE(), brokerAddr),
      BN.sendTransaction({ to: this.W.depositor.address, value: ethers.parseEther(FUND.each) }),
      BN.sendTransaction({ to: this.W.borrower.address, value: ethers.parseEther(FUND.each) }),
      Tb.mint(this.W.depositor.address, U(100000)),
      Tb.mint(this.W.borrower.address, U(20000)),
      Tb.mint(B.address, U(100000)),
      Tb.approve(brokerAddr, ethers.MaxUint256),
    ];
    if (harnessEnabled) {
      batch.push((K as any).connect(BN).initHarness(
        true, HARNESS.alpha, HARNESS.alphaBorrower, debtFloor, HARNESS.lockDuration, HARNESS.lambda
      ));
    }
    await Promise.all((await Promise.all(batch)).map((t: any) => t.wait()));
    if (harnessEnabled) this.log("✓ 하네스 활성화 (①집중도 ②타임락 ③이력연동)");

    // The role wallets could not pay for gas until the sends above were mined; their approvals
    // come from different accounts, so they need no nonce coordination.
    onStatus("승인 처리…");
    await Promise.all((await Promise.all([
      (T as any).connect(this.W.depositor).approve(vaultAddr, ethers.MaxUint256),
      (T as any).connect(this.W.borrower).approve(brokerAddr, ethers.MaxUint256),
    ])).map((t: any) => t.wait()));

    const a = { token: tokenAddr, vault: vaultAddr, broker: brokerAddr };
    localStorage.setItem(this.dkey(), JSON.stringify(a));
    this.attach(a);
    this.log("배포 완료");
    return a;
  }

  /** Send leftover gas ETH from the three role wallets back to the connected account. */
  async sweepGas(): Promise<number> {
    const fee = await this.ro.getFeeData();
    const gp = fee.maxFeePerGas ?? fee.gasPrice ?? ethers.parseUnits("2", "gwei");
    const reserve = gp * 21000n * 3n; // leave enough for the sweep tx + buffer
    let total = 0n;
    for (const name of ["broker", "depositor", "borrower"] as const) {
      const wal = this.W[name];
      const bal = await this.ro.getBalance(wal.address);
      if (bal > reserve) {
        const value = bal - reserve;
        const tx = await wal.sendTransaction({ to: this.account, value });
        this.log(`${name} 남은 가스 회수 → 내 지갑 ${ethers.formatEther(value).slice(0, 7)} ETH`, tx.hash);
        await tx.wait();
        total += value;
      }
    }
    if (total === 0n) this.log("회수할 잔여 ETH가 없습니다");
    return Number(ethers.formatEther(total));
  }

  async readState(): Promise<Snapshot> {
    const [ta, ol, loss, cov, debt, mw, bd, bb, bk, mgmt, crmSet, crmFloor] = await Promise.all([
      this.vault.totalAssets(), this.vault.assetsOnLoan(), this.vault.lossUnrealized(),
      this.broker.coverAvailable(), this.broker.debtTotal(), this.vault.maxWithdraw(this.W.depositor.address),
      this.token.balanceOf(this.W.depositor.address), this.token.balanceOf(this.W.borrower.address),
      this.token.balanceOf(this.W.broker.address),
      this.broker.managementFeeRateWad(), this.broker.coverRateMinimumWad(), this.broker.coverRateFloorWad(),
    ]);
    let harnessOn = false, effCrmPct = 0, defaultRatePct = 0, coverWithdrawable = 0;
    let alpha = 0, alphaBorrower = 0, debtFloorAmt = 0, lambda = 0, borrowerDebt = 0;
    try {
      const [h, e, d, w, al, alb, df, lam, bdebt] = await Promise.all([
        this.broker.harnessEnabled(), this.broker.effectiveCoverRateMinimum(),
        this.broker.defaultRateWad(), this.broker.coverWithdrawable(),
        this.broker.alphaWad(), this.broker.alphaBorrowerWad(), this.broker.debtFloor(),
        this.broker.lambdaWad(), this.broker.borrowerDebt(this.W.borrower.address),
      ]);
      harnessOn = h; effCrmPct = N(e) * 100; defaultRatePct = N(d) * 100; coverWithdrawable = N(w);
      alpha = N(al); alphaBorrower = N(alb); debtFloorAmt = N(df); lambda = N(lam); borrowerDebt = N(bdebt);
    } catch { /* old deployment without harness */ }
    return {
      vaultTotal: N(ta), onLoan: N(ol), loss: N(loss), cover: N(cov), debt: N(debt), maxWithdraw: N(mw),
      balDep: N(bd), balBor: N(bb), balBrk: N(bk),
      addrDep: this.W.depositor.address, addrBor: this.W.borrower.address, addrBrk: this.W.broker.address,
      mgmtFeeRate: N(mgmt), crmSetPct: N(crmSet) * 100, crmFloorPct: N(crmFloor) * 100,
      harnessOn, effCrmPct, defaultRatePct, coverWithdrawable,
      alpha, alphaBorrower, debtFloorAmt, lambda, borrowerDebt,
    };
  }

  /** Attempt an origination; on failure return the decoded reason. This is the path that
   *  catches the harness's own ConcentrationExceeded / BorrowerConcentrationExceeded, which
   *  only {@link explainError} can name — they are LoanBroker custom errors, and callers
   *  must be able to tell them apart from an ordinary revert. */
  async tryOriginate(prin: number, interval: number, grace: number, payments: number, interestRaw: number): Promise<{ ok: boolean; error?: string }> {
    try { await this.originate(prin, interval, grace, payments, interestRaw); return { ok: true }; }
    catch (e: any) { const error = explainError(e); this.log(`✗ 대출 실행 실패: ${error}`); return { ok: false, error }; }
  }

  // --- actions (role-signed) ---
  deposit(a: number) { return this.txw(this.vault.connect(this.W.depositor).deposit(U(a), this.W.depositor.address), `예금자 → Vault 예치 ${a.toLocaleString()}`); }
  cover(a: number) { return this.txw(this.broker.connect(this.W.broker).coverDeposit(U(a)), `Broker cover 적립 ${a.toLocaleString()}`); }
  coverWithdraw(a: number) { return this.txw(this.broker.connect(this.W.broker).coverWithdraw(U(a)), `Broker cover 회수 ${a.toLocaleString()}`); }
  setCoverRates(minRaw: number, liqRaw: number) { return this.txw(this.broker.connect(this.W.broker).setCoverRates(minRaw, liqRaw), `cover 비율 설정 (min ${minRaw / 1000}% · liq ${liqRaw / 1000}%)`); }
  pay() { return this.txw(this.broker.connect(this.W.borrower).pay(this.loanId, U(10000000)), `차입자 → Vault 상환 (대출 #${this.loanId})`); }
  impair() { return this.txw(this.broker.connect(this.W.broker).impair(this.loanId), `Broker 부실 표시 (대출 #${this.loanId})`); }
  default_() { return this.txw(this.broker.connect(this.W.broker)["default_"](this.loanId), `default · first-loss waterfall`); }

  /** Seconds until this loan can be impaired / defaulted, on the chain's clock rather than the
   *  browser's. Both gates are `block.timestamp` comparisons, and eth_estimateGas evaluates
   *  them against the latest block — which trails wall-clock time by up to a block interval —
   *  so a sleep sized from the loan parameters can send the transaction early and revert with
   *  NotYetImpairable / NotYetDefaultable. Zero means the chain itself agrees it is due. */
  async secondsUntil(gate: "impair" | "default"): Promise<number> {
    const [loan, block] = await Promise.all([this.broker.loans(this.loanId), this.ro.getBlock("latest")]);
    const due = Number(loan.nextPaymentDueDate) + (gate === "default" ? Number(loan.gracePeriod) : 0);
    return Math.max(0, due + 1 - Number(block?.timestamp ?? 0));
  }

  async withdraw() {
    const m = await this.vault.maxWithdraw(this.W.depositor.address);
    if (m === 0n) { this.log("인출 잔액 없음"); return; }
    await this.txw(this.vault.connect(this.W.depositor).withdraw(m, this.W.depositor.address, this.W.depositor.address), `Vault → 예금자 인출 ${fmt(m)}`);
  }

  async originate(prin: number, interval: number, grace: number, payments: number, interestRaw: number) {
    const nonce = await this.broker.nonces(this.W.borrower.address);
    const terms = {
      borrower: this.W.borrower.address, principal: U(prin), interestRate: interestRaw, lateInterestRate: RATE.late,
      closeInterestRate: RATE.close, paymentInterval: interval, gracePeriod: grace, paymentsTotal: payments,
      loanServiceFee: 0, latePaymentFee: 0, closePaymentFee: 0, originationFee: 0, nonce, deadline: DEADLINE,
    };
    const domain = { name: "XLS66-LoanBroker", version: "1", chainId: SEPOLIA, verifyingContract: await this.broker.getAddress() };
    this.log("차입자 EIP-712 서명 (자동)…");
    const sig = await this.W.borrower.signTypedData(domain, TYPES, terms);
    const arr = [terms.borrower, terms.principal, terms.interestRate, terms.lateInterestRate, terms.closeInterestRate,
      terms.paymentInterval, terms.gracePeriod, terms.paymentsTotal, terms.loanServiceFee, terms.latePaymentFee,
      terms.closePaymentFee, terms.originationFee, terms.nonce, terms.deadline];
    await this.txw(this.broker.connect(this.W.broker).originate(arr, sig), `Vault → 차입자 대출 지급 ${prin.toLocaleString()}`);
    this.loanId = Number(await this.broker.loanSequence());
  }
}
