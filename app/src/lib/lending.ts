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

export interface Snapshot {
  vaultTotal: number; onLoan: number; loss: number; cover: number; debt: number; maxWithdraw: number;
  balDep: number; balBor: number; balBrk: number;
  addrDep: string; addrBor: string; addrBrk: string;
  // harness (§4.2)
  harnessOn: boolean; effCrmPct: number; defaultRatePct: number; coverWithdrawable: number;
}

// Harness demo config (WAD fractions; debtFloor native; lockDuration seconds).
export const HARNESS = {
  alpha: 5n * 10n ** 17n, // 50% single-loan
  alphaBorrower: 5n * 10n ** 17n, // 50% per-borrower
  debtFloor: U(60000), // D_floor
  lockDuration: 60n, // T_lock seconds
  lambda: 10n ** 18n, // λ = 1.0
};

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

  private async txw(p: Promise<any>, label: string) {
    const t = await p;
    this.log(`${label} · 처리 중`, t.hash);
    await t.wait();
    this.log(`✓ ${label}`, t.hash);
    return t;
  }

  attach(a: { token: string; vault: string; broker: string }) {
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

  async setup(onStatus: (s: string) => void, harnessEnabled = false) {
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
      .deploy(await V.getAddress(), B.address, 0n, 1000n, 10000n, 100000n, 0n);
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
        true, HARNESS.alpha, HARNESS.alphaBorrower, HARNESS.debtFloor, HARNESS.lockDuration, HARNESS.lambda
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
    const [ta, ol, loss, cov, debt, mw, bd, bb, bk] = await Promise.all([
      this.vault.totalAssets(), this.vault.assetsOnLoan(), this.vault.lossUnrealized(),
      this.broker.coverAvailable(), this.broker.debtTotal(), this.vault.maxWithdraw(this.W.depositor.address),
      this.token.balanceOf(this.W.depositor.address), this.token.balanceOf(this.W.borrower.address),
      this.token.balanceOf(this.W.broker.address),
    ]);
    let harnessOn = false, effCrmPct = 0, defaultRatePct = 0, coverWithdrawable = 0;
    try {
      const [h, e, d, w] = await Promise.all([
        this.broker.harnessEnabled(), this.broker.effectiveCoverRateMinimum(),
        this.broker.defaultRateWad(), this.broker.coverWithdrawable(),
      ]);
      harnessOn = h; effCrmPct = N(e) * 100; defaultRatePct = N(d) * 100; coverWithdrawable = N(w);
    } catch { /* old deployment without harness */ }
    return {
      vaultTotal: N(ta), onLoan: N(ol), loss: N(loss), cover: N(cov), debt: N(debt), maxWithdraw: N(mw),
      balDep: N(bd), balBor: N(bb), balBrk: N(bk),
      addrDep: this.W.depositor.address, addrBor: this.W.borrower.address, addrBrk: this.W.broker.address,
      harnessOn, effCrmPct, defaultRatePct, coverWithdrawable,
    };
  }

  /** Attempt an origination; return whether it was blocked (e.g. by harness concentration). */
  async tryOriginate(prin: number, interval: number, grace: number, payments: number, interestRaw: number): Promise<{ ok: boolean; error?: string }> {
    try { await this.originate(prin, interval, grace, payments, interestRaw); return { ok: true }; }
    catch (e: any) { return { ok: false, error: e.shortMessage || e.message || String(e) }; }
  }

  // --- actions (role-signed) ---
  deposit(a: number) { return this.txw(this.vault.connect(this.W.depositor).deposit(U(a), this.W.depositor.address), `예금자 → Vault 예치 ${a.toLocaleString()}`); }
  cover(a: number) { return this.txw(this.broker.connect(this.W.broker).coverDeposit(U(a)), `Broker cover 적립 ${a.toLocaleString()}`); }
  coverWithdraw(a: number) { return this.txw(this.broker.connect(this.W.broker).coverWithdraw(U(a)), `Broker cover 회수 ${a.toLocaleString()}`); }
  setCoverRates(minRaw: number, liqRaw: number) { return this.txw(this.broker.connect(this.W.broker).setCoverRates(minRaw, liqRaw), `cover 비율 설정 (min ${minRaw / 1000}% · liq ${liqRaw / 1000}%)`); }
  pay() { return this.txw(this.broker.connect(this.W.borrower).pay(this.loanId, U(10000000)), `차입자 → Vault 상환 (대출 #${this.loanId})`); }
  impair() { return this.txw(this.broker.connect(this.W.broker).impair(this.loanId), `Broker 부실 표시 (대출 #${this.loanId})`); }
  default_() { return this.txw(this.broker.connect(this.W.broker)["default_"](this.loanId), `default · first-loss waterfall`); }

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
