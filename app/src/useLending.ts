import { useCallback, useEffect, useRef, useState } from "react";
import {
  LendingClient, MGMT_FEE_RATE, N, checkOriginations, explainError, harnessDebtFloor, harnessLoanCap,
  quoteNewDebt, type LoanPlan, type Snapshot,
} from "./lib/lending";
import { DEFAULT_PARAMS, type FlowEvent, type LogLine, type Params, type ResultBox, type Step } from "./types";

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
const r0 = (v: number) => Math.round(v).toLocaleString();

type Scen = "A" | "B" | "C" | "D";

const MONTH = 2592000; // scenario A's payment interval
/** Scenario D's own amounts. They are fixed rather than derived from the form, so the harness
 *  D_floor chosen at deploy time has to leave room for both of its loans. */
export const D_CFG = { deposit: 50000, cover: 30000, each: 10000, loans: 2, payments: 2, interval: 40, grace: 20 };

/** XLS rates are 1/10th bps: 12% → 12000. */
const tenthBps = (pct: number) => Math.round(clamp(pct, 0, 100) * 1000);

const planA = (p: Params): LoanPlan => ({ principal: p.principal, interestRaw: tenthBps(p.interestPct), interval: MONTH, payments: p.payments });
const planB = (p: Params): LoanPlan => ({ ...planA(p), interval: p.interval });
// Scenarios C and D use zero-interest loans so newDebt == principal (the point is concentration
// and default history, not interest).
const planC = (p: Params, principal: number): LoanPlan => ({ principal, interestRaw: 0, interval: 40, payments: p.payments });
const planD = (): LoanPlan => ({ principal: D_CFG.each, interestRaw: 0, interval: D_CFG.interval, payments: D_CFG.payments });

/** The D_floor a deployment made right now would carry (see {@link harnessDebtFloor}). */
const floorFor = (p: Params) => harnessDebtFloor(quoteNewDebt(planA(p), MGMT_FEE_RATE), D_CFG.each * D_CFG.loans);

/** Would a fresh deployment change the answer? Only when this one carries state no scenario can
 *  undo: debt still outstanding, a recorded default (③ keeps CRM_eff raised for good), or a
 *  D_floor pinned to different params — initHarness is write-once. On a clean book the gate is
 *  about the parameters on screen, and redeploying would just burn gas to fail the same way. */
export function redeployWouldHelp(s: Snapshot, p: Params): boolean {
  if (s.debt > 0 || s.borrowerDebt > 0 || s.defaultRatePct > 0) return true;
  return s.harnessOn && Math.abs(s.debtFloorAmt - N(floorFor(p))) > 1;
}

/** The oversized loan scenario C attempts. It has to exceed the harness ① cap to demonstrate
 *  anything, and that cap follows the *deployed* D_floor — not the principal in the form, which
 *  may have been changed since. */
function bigLoanPrincipal(s: Snapshot | null, p: Params): number {
  const naive = Math.round(p.principal * 1.5);
  const cap = s ? harnessLoanCap(s) : Infinity;
  return Number.isFinite(cap) ? Math.max(naive, Math.ceil(cap * 1.05) + 1) : naive;
}

export function useLending() {
  const [phase, setPhase] = useState<"connect" | "ready">("connect");
  const [account, setAccount] = useState("");
  const [deployed, setDeployed] = useState(false);
  const [setupBusy, setSetupBusy] = useState(false);
  const [setupStatus, setSetupStatus] = useState("");
  // Each scenario keeps its own parameters, so values tuned for one never leak into another.
  const [paramsBy, setParamsBy] = useState<Record<Scen, Params>>({ A: DEFAULT_PARAMS, B: DEFAULT_PARAMS, C: DEFAULT_PARAMS, D: DEFAULT_PARAMS });
  /** The scenario whose parameter screen is open; `scenario` is only set once it runs. */
  const [selected, setSelected] = useState<Scen | null>(null);
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [scenario, setScenario] = useState<Scen | null>(null);
  const [scenarioSub, setScenarioSub] = useState("");
  const [steps, setSteps] = useState<Step[]>([]);
  const [stepIndex, setStepIndex] = useState(0);
  const [running, setRunning] = useState(false);
  const [flow, setFlow] = useState<FlowEvent | null>(null);
  const [defaulted, setDefaulted] = useState(false);
  const [result, setResult] = useState<ResultBox | null>(null);
  const [log, setLog] = useState<LogLine[]>([]);
  const [countdownMsg, setCountdownMsg] = useState("");

  const logRef = useRef((text: string, hash?: string) =>
    setLog((l) => [{ text, hash, key: Date.now() + Math.random() }, ...l].slice(0, 60)));
  const clientRef = useRef<LendingClient | null>(null);
  const client = () => (clientRef.current ??= new LendingClient(logRef.current));

  const refresh = useCallback(async () => {
    try { setSnap(await client().readState()); } catch (e: any) { logRef.current(`✗ ${explainError(e)}`); }
  }, []);

  // `textTo` is the same transfer seen from the receiving side: money leaving the depositor
  // (－50,000) is money arriving at the Vault (＋50,000). The packet flips label mid-flight.
  const doFlow = useCallback(async (from: FlowEvent["from"], to: FlowEvent["to"], text: string, cls: FlowEvent["cls"] = "", textTo?: string, clsTo?: FlowEvent["cls"]) => {
    setFlow({ from, to, text, cls, textTo, clsTo, key: Date.now() + Math.random() });
    await wait(1350);
  }, []);

  const setStep = useCallback((i: number) => { setStepIndex(i); setCountdownMsg(""); }, []);

  const connect = useCallback(async () => {
    try {
      const acc = await client().connect();
      setAccount(acc); setPhase("ready");
      const has = await client().loadExisting();
      setDeployed(has);
      if (has) await refresh();
    } catch (e: any) { logRef.current(`✗ ${explainError(e)}`); }
  }, [refresh]);

  const [harnessToggle, setHarnessToggle] = useState(false);
  const setup = useCallback(async () => {
    setSetupBusy(true);
    try {
      // initHarness is write-once, so D_floor is pinned here to scenario A's params; it also
      // has to keep scenario D's two loans against one borrower admissible.
      const floor = harnessDebtFloor(quoteNewDebt(planA(paramsBy.A), MGMT_FEE_RATE), D_CFG.each * D_CFG.loans);
      await client().setup(setSetupStatus, harnessToggle, floor);
      setDeployed(true); setSetupStatus(""); await refresh();
    }
    catch (e: any) { logRef.current(`✗ ${explainError(e)}`); }
    finally { setSetupBusy(false); }
  }, [refresh, harnessToggle, paramsBy]);

  const [sweeping, setSweeping] = useState(false);
  const [sweepMsg, setSweepMsg] = useState("");
  const sweep = useCallback(async () => {
    setSweeping(true); setSweepMsg("");
    try {
      const got = await client().sweepGas();
      const m = got > 0 ? `✓ ${got.toFixed(4)} ETH를 내 지갑으로 회수했습니다.` : "회수할 잔여 ETH가 없습니다.";
      setSweepMsg(m); logRef.current(m);
    } catch (e: any) { const m = `✗ ${explainError(e)}`; setSweepMsg(m); logRef.current(m); }
    finally { setSweeping(false); }
  }, []);

  const forget = useCallback(() => { client().reset(); localStorage.clear(); location.reload(); }, []);
  const resetParams = useCallback(() => {
    if (selected) setParamsBy((b) => ({ ...b, [selected]: DEFAULT_PARAMS }));
  }, [selected]);
  const setParam = useCallback((k: keyof Params, v: number) => {
    if (selected) setParamsBy((b) => ({ ...b, [selected]: { ...b[selected], [k]: v } }));
  }, [selected]);
  /** Open a scenario's parameter screen, starting from its defaults every time. */
  const selectScenario = useCallback((scen: Scen) => {
    setParamsBy((b) => ({ ...b, [scen]: DEFAULT_PARAMS }));
    setSelected(scen);
  }, []);

  /** Count down to a chain-clock deadline. The last few seconds are re-read from the chain, so
   *  the transaction only goes out once the node's own latest block agrees the gate has passed
   *  — a browser-side sleep can run out while the block eth_estimateGas sees is still behind. */
  async function countdownUntil(remaining: () => Promise<number>, label: string) {
    let s = await remaining();
    while (s > 0) {
      setCountdownMsg(`${label} ${s}초…`);
      await wait(1000);
      s = s > 3 ? s - 1 : await remaining();
    }
    setCountdownMsg("");
  }

  /** Report a scenario that stopped early. Logging alone leaves an empty result panel, which
   *  is indistinguishable from the demo hanging. */
  const fail = useCallback((e: any) => {
    const msg = explainError(e);
    logRef.current(`✗ ${msg}`);
    setResult({ tone: "bad", title: "시나리오 중단", body: msg });
  }, []);

  /** Re-running a scenario after a redeploy means calling its runner again. They are declared
   *  below, so route through a ref: a callback that captured itself would be read while it is
   *  still being initialised. */
  const runnersRef = useRef<Partial<Record<Scen, () => void>>>({});

  /** Redeploy in place and resume the scenario that could not start. Keeps the role wallets
   *  (they hold gas already funded from MetaMask) and the deployment's harness setting, so the
   *  scenario the user was trying to see keeps its meaning. */
  const redeployAndRun = useCallback(async (harnessOn: boolean, scen?: Scen) => {
    setResult(null); setSetupBusy(true); setHarnessToggle(harnessOn);
    let ok = false;
    try {
      client().resetDeployment();
      setDeployed(false);
      await client().setup(setSetupStatus, harnessOn, floorFor(paramsBy[scen ?? "A"]));
      setDeployed(true); setSetupStatus(""); await refresh();
      ok = true;
    } catch (e: any) { fail(e); }
    finally { setSetupBusy(false); }
    if (ok && scen) runnersRef.current[scen]?.();
  }, [paramsBy, refresh, fail]);

  /** Replay the gates originate() applies — before the scenario spends any gas — and explain a
   *  failure instead of reverting mid-run. Both gates are measured against a loan's *debt*
   *  (principal + net interest) and the book's existing debt, not against the principal in the
   *  form, so a check written in terms of the principal quietly disagrees with the contract.
   *  @param crmSetPct the CoverRateMinimum in force at origination, or null to use the chain's.
   *  @returns the snapshot it read, or null if the scenario must not start. */
  const precheck = useCallback(async (cover: number, crmSetPct: number | null, loans: LoanPlan[], scen?: Scen): Promise<Snapshot | null> => {
    let s: Snapshot;
    try { s = await client().readState(); } catch (e: any) { fail(e); return null; }
    setSnap(s);
    const issue = checkOriginations(s, cover, crmSetPct ?? s.crmSetPct, loans);
    if (!issue) return s;
    const action = redeployWouldHelp(s, paramsBy[scen ?? "A"])
      ? { label: "재배포하고 실행", run: () => { void redeployAndRun(s.harnessOn, scen); } }
      : undefined;
    if (issue.kind === "cover") {
      setResult({ tone: "bad", title: "cover 부족",
        action, body: `신규 부채 ${r0(issue.debt)} (원금 ${issue.loan.principal.toLocaleString()} + 순이자)를 실행하려면 (기존 부채 + 신규 부채) × 유효 CoverRateMinimum = ${r0(issue.need)} 이상의 cover가 필요합니다 (현재 ${r0(issue.have)}).`,
        note: `cover를 올리거나 CoverRateMinimum을 낮추세요. 요구치는 원금이 아니라 부채 기준이라 이자만큼 큽니다.` });
    } else if (issue.limit === "borrower") {
      setResult({ tone: "bad", title: "하네스 ① 차입자 집중도 한도 초과",
        action, body: `이 차입자에게 이미 ${r0(issue.existing)}의 미상환 부채가 있어, 신규 ${r0(issue.debt)}을 더한 ${r0(issue.need)}이 차입자 한도 ${r0(issue.have)}을 넘습니다 (borrowerCap = α_borrower × max(총부채, D_floor)).`,
        note: `이전 시나리오의 대출이 아직 상환되지 않았습니다. 「forget」 후 다시 배포하면 초기화됩니다.` });
    } else {
      setResult({ tone: "bad", title: "하네스 ① 단일대출 집중도 한도 초과",
        action, body: `이 대출의 부채 ${r0(issue.debt)} (원금 ${issue.loan.principal.toLocaleString()} + 순이자)가 단일대출 한도 ${r0(issue.have)}을 넘습니다 (loanCap = α × max(총부채, D_floor)). 원금을 낮추면 실행됩니다.`,
        note: `하네스 설정(D_floor 포함)은 배포 시 1회만 기록됩니다(initHarness는 write-once). 지금 파라미터에 맞춘 한도로 바꾸려면 「forget」 후 다시 배포하세요.` });
    }
    return null;
  }, [fail, paramsBy, redeployAndRun]);

  const raw = {
    interest: (p: Params) => tenthBps(p.interestPct),
    covMin: (p: Params) => tenthBps(p.covMinPct),
    covLiq: (p: Params) => tenthBps(p.covLiqPct),
  };

  const runA = useCallback(async () => {
    const p = paramsBy.A, c = client();
    setResult(null); setScenario("A");
    const loan = planA(p);
    // The header, steps and progress belong to the scenario just picked — set them before the
    // precheck, or a scenario that cannot start leaves the previous one's title on screen.
    setScenarioSub("정상 렌딩 — 예금자가 이자를 법니다");
    setSteps(SCEN_A(p)); setStep(0);
    setRunning(true); setDefaulted(false);
    if (!(await precheck(p.cover, p.covMinPct, [loan], "A"))) { setRunning(false); return; }
    try {
      await c.setCoverRates(raw.covMin(p), raw.covLiq(p));
      const dep0 = (await c.readState()).balDep;
      setStep(0); await doFlow("dep", "vault", `－${p.deposit.toLocaleString()}`, "", `＋${p.deposit.toLocaleString()}`); await c.deposit(p.deposit); await refresh();
      setStep(1); await doFlow("broker", "vault", `cover ${p.cover.toLocaleString()}`); await c.cover(p.cover); await refresh();
      setStep(2); await doFlow("vault", "bor", `실행 ${p.principal.toLocaleString()}`, "", `＋${p.principal.toLocaleString()}`, "gain"); await c.originate(loan.principal, loan.interval, 30, loan.payments, loan.interestRaw); await refresh();
      setStep(3);
      for (let i = 0; i < p.payments; i++) { await doFlow("bor", "vault", `상환 ${i + 1}/${p.payments}`); await c.pay(); await refresh(); }
      setStep(4); await doFlow("vault", "broker", `cover ${p.cover.toLocaleString()}`); await c.coverWithdraw(p.cover); await refresh();
      setStep(5); await doFlow("vault", "dep", "인출", "gain", "＋인출"); await c.withdraw(); await refresh();
      const dep1 = (await c.readState()).balDep; const profit = dep1 - dep0;
      setResult({ tone: "ok", title: "완료 · 손실 0",
        body: `예금자 지갑 ${dep1.toLocaleString(undefined, { maximumFractionDigits: 2 })} dUSD (예치금 전액 회수 + 이자 ${profit >= 0 ? "+" : ""}${profit.toLocaleString(undefined, { maximumFractionDigits: 2 })}). 브로커는 cover를 온전히 회수했습니다.`,
        note: `한 지갑이 3역을 겸하지 않고 역할별 별도 계정이라, 예금자의 이자 수익이 잔액 증가로 그대로 보입니다.` });
    } catch (e: any) { fail(e); }
    finally { setRunning(false); }
  }, [paramsBy, refresh, doFlow, setStep, precheck, fail]);

  const runB = useCallback(async () => {
    const p = paramsBy.B, c = client();
    setResult(null); setScenario("B");
    const loan = planB(p);
    setScenarioSub("채무불이행 — 예금자가 손실을 봅니다");
    setSteps(SCEN_B(p)); setStep(0);
    setRunning(true); setDefaulted(false);
    if (!(await precheck(p.cover, p.covMinPct, [loan], "B"))) { setRunning(false); return; }
    try {
      await c.setCoverRates(raw.covMin(p), raw.covLiq(p));
      setStep(0); await doFlow("dep", "vault", `－${p.deposit.toLocaleString()}`, "", `＋${p.deposit.toLocaleString()}`); await c.deposit(p.deposit); await refresh();
      setStep(1); await doFlow("broker", "vault", `cover ${p.cover.toLocaleString()}`); await c.cover(p.cover); await refresh();
      setStep(2); await doFlow("vault", "bor", `실행 ${p.principal.toLocaleString()}`, "", `＋${p.principal.toLocaleString()}`, "gain"); await c.originate(loan.principal, loan.interval, p.grace, loan.payments, loan.interestRaw); await refresh();
      const s0 = await c.readState(); const cov0 = s0.cover, tot0 = s0.vaultTotal;
      setStep(3); await countdownUntil(() => c.secondsUntil("impair"), "연체까지"); await doFlow("bor", "vault", "미상환", "loss"); await c.impair(); await refresh();
      setStep(4); await countdownUntil(() => c.secondsUntil("default"), "default 가능까지"); setDefaulted(true);
      await doFlow("broker", "vault", "cover 흡수", "gain"); await c.default_(); await refresh();
      const s1 = await c.readState();
      const covUsed = Math.max(0, cov0 - s1.cover), depLoss = Math.max(0, tot0 - s1.vaultTotal);
      setStep(5); await doFlow("vault", "dep", "인출", "loss", "인출 (예치금 미만)"); await c.withdraw(); await refresh();
      const zeroLoss = depLoss < 1;
      setResult({ tone: zeroLoss ? "ok" : "bad",
        title: zeroLoss ? "cover가 손실 전액 흡수 · 예금자 손실 0" : "손실 발생 · 차입자 채무불이행",
        body: `차입자 지갑에는 빌린 ${p.principal.toLocaleString()}이 미상환 상태로 남아 있습니다. 대출 원금 ${p.principal.toLocaleString()}은 cover가 ${r0(covUsed)} 흡수, 예금자가 ${r0(depLoss)} 부담. ${r0(covUsed)} + ${r0(depLoss)} = ${p.principal.toLocaleString()} — first-loss waterfall이 손실을 정확히 배분합니다.`,
        note: `CoverRateMinimum ${p.covMinPct}% · CoverRateLiquidation ${p.covLiqPct}% 적용. 비율을 올리면 cover가 더 많이 흡수합니다.` });
    } catch (e: any) { fail(e); }
    finally { setRunning(false); }
  }, [paramsBy, refresh, doFlow, setStep, precheck, fail]);

  // Scenario C — harness ① concentration limit demo
  const runC = useCallback(async () => {
    const p = paramsBy.C, c = client();
    setResult(null); setScenario("C");
    // Only the fallback loan has to be admissible; the oversized one is meant to be refused.
    const loan = planC(p, p.principal);
    setScenarioSub("집중도 한도 — 하네스 ①");
    setSteps(SCEN_C(p, bigLoanPrincipal(snap, p))); setStep(0);
    setRunning(true); setDefaulted(false);
    const s0 = await precheck(p.cover, null, [loan], "C");
    if (!s0) { setRunning(false); return; }
    // now that a fresh snapshot is in hand, restate the attempt with the exact cap
    const big = bigLoanPrincipal(s0, p);
    setSteps(SCEN_C(p, big));
    try {
      setStep(0); await doFlow("dep", "vault", `－${p.deposit.toLocaleString()}`, "", `＋${p.deposit.toLocaleString()}`); await c.deposit(p.deposit); await refresh();
      setStep(1); await doFlow("broker", "vault", `cover ${p.cover.toLocaleString()}`); await c.cover(p.cover); await refresh();
      setStep(2);
      // Zero-interest loans so newDebt == principal (concentration demo; interest irrelevant).
      const res = await c.tryOriginate(big, loan.interval, 20, loan.payments, 0);
      const s = await c.readState();
      // ① is the only thing that raises these. Any other revert is a different problem, and
      // reporting it as the harness at work would contradict this card's own ON/OFF badge.
      const blockedByHarness = /^(Borrower)?ConcentrationExceeded\(/.test(res.error ?? "");
      if (res.ok) {
        await doFlow("vault", "bor", `실행 ${big.toLocaleString()}`, "", `＋${big.toLocaleString()}`, "gain"); await refresh();
        setStep(3);
        setResult(s.harnessOn
          ? { tone: "bad", title: "하네스 ON · 한도가 이 대출보다 큽니다",
              body: `단일 대출 ${big.toLocaleString()}이 집중도 한도 ${r0(harnessLoanCap(s0))} 이내라 그대로 실행됐습니다.`,
              note: `D_floor는 배포 시점 파라미터로 고정됩니다(write-once). 원금을 키우거나 「forget」 후 재배포하면 ①이 차단하는 것을 볼 수 있습니다.` }
          : { tone: "bad", title: "하네스 없음 · 집중 리스크 노출",
              body: `단일 대출 ${big.toLocaleString()}이 그대로 실행됐습니다 — 한 대출이 풀 전체를 지배할 수 있습니다(Orthogonal 80% 유형).`,
              note: `하네스를 켜고 배포하면 이 대출은 집중도 한도(α)로 차단됩니다.` });
      } else if (!blockedByHarness) {
        setStep(3);
        setResult({ tone: "bad", title: "대형 대출이 집중도 한도와 무관한 이유로 실패",
          body: res.error ?? "알 수 없는 오류",
          note: `현재 하네스 ${s.harnessOn ? "ON" : "OFF"} — 이 실패는 §4.2 ①이 아닙니다.` });
      } else {
        setStep(3); await doFlow("vault", "bor", `실행 ${p.principal.toLocaleString()}`, "", `＋${p.principal.toLocaleString()}`, "gain");
        await c.originate(loan.principal, loan.interval, 20, loan.payments, loan.interestRaw); await refresh();
        setResult({ tone: "ok", title: "하네스 ①이 대형 단일대출 차단",
          body: `${big.toLocaleString()} 단일대출은 집중도 한도(부채 대비 α)를 넘어 거부됐고, 한도 내 ${p.principal.toLocaleString()} 대출만 실행됐습니다.`,
          note: `거부 사유 ${res.error} · 유효 CRM ${s.effCrmPct.toFixed(0)}% · 디폴트율 ${s.defaultRatePct.toFixed(0)}%. 디폴트가 쌓이면 ③에 의해 요구 cover가 자동 상향됩니다.` });
      }
    } catch (e: any) { fail(e); }
    finally { setRunning(false); }
  }, [paramsBy, snap, refresh, doFlow, setStep, precheck, fail]);

  // Scenario D — harness ③ history-linked cover rate
  const runD = useCallback(async () => {
    const c = client();
    setResult(null); setScenario("D");
    const loans = Array.from({ length: D_CFG.loans }, planD);
    setScenarioSub("이력 연동 공탁 비율 — 하네스 ③");
    setSteps(SCEN_D()); setStep(0);
    setRunning(true); setDefaulted(false);
    if (!(await precheck(D_CFG.cover, null, loans, "D"))) { setRunning(false); return; }
    try {
      const each = D_CFG.each.toLocaleString();
      const lend = async (l: typeof loans[number]) => {
        await doFlow("vault", "bor", `실행 ${each}`, "", `＋${each}`, "gain");
        await c.originate(l.principal, l.interval, D_CFG.grace, l.payments, l.interestRaw);
        await refresh();
      };
      setStep(0); await doFlow("dep", "vault", `－${D_CFG.deposit.toLocaleString()}`, "", `＋${D_CFG.deposit.toLocaleString()}`); await c.deposit(D_CFG.deposit); await refresh();
      setStep(1); await doFlow("broker", "vault", `cover ${D_CFG.cover.toLocaleString()}`); await c.cover(D_CFG.cover); await refresh();
      setStep(2);
      await lend(loans[0]);
      const before = (await c.readState()).effCrmPct;
      for (const l of loans.slice(1)) await lend(l);
      setStep(3);
      await countdownUntil(() => c.secondsUntil("default"), "default 가능까지"); setDefaulted(true);
      await doFlow("bor", "vault", "default", "loss"); await c.default_(); await refresh();
      const s = await c.readState();
      setResult({ tone: "ok", title: "이력 연동으로 요구 cover 자동 상향 (③)",
        body: `대출 ${D_CFG.loans}건 중 1건 디폴트 → 디폴트율 ${s.defaultRatePct.toFixed(0)}%. 유효 CoverRateMinimum이 ${before.toFixed(0)}% → ${s.effCrmPct.toFixed(0)}%로 자동 상향됐습니다.`,
        note: `CRM_eff = max(CRM_set, CRM_floor + λ×디폴트율). 심사를 소홀히 해 디폴트가 쌓인 기관일수록 다음 대출에 더 많은 cover를 요구받습니다 — 예금자 투표 없이 온체인 이력만으로 결정론적으로.` });
    } catch (e: any) { fail(e); }
    finally { setRunning(false); }
  }, [refresh, doFlow, setStep, precheck, fail]);

  useEffect(() => {
    runnersRef.current = { A: () => void runA(), B: () => void runB(), C: () => void runC(), D: () => void runD() };
  }, [runA, runB, runC, runD]);

  /** Leaving the runner drops everything that belongs to the finished run — header, steps,
   *  progress, result and the transaction log — so picking a scenario again starts from a
   *  clean screen instead of reading as a continuation of the last one. */
  const backToPicker = useCallback(() => {
    setScenario(null); setSelected(null); setResult(null); setScenarioSub("");
    setSteps([]); setStep(0); setDefaulted(false); setFlow(null); setLog([]);
  }, [setStep]);

  return {
    phase, account, deployed, setupBusy, setupStatus,
    params: paramsBy[selected ?? "A"], setParam, resetParams, selected, selectScenario,
    harnessToggle, setHarnessToggle,
    snap, scenario, scenarioSub, steps, stepIndex, running, flow, defaulted, result, log, countdownMsg,
    connect, setup, forget, runA, runB, runC, runD, backToPicker,
    bigLoan: bigLoanPrincipal(snap, paramsBy.C),
    sweep, sweeping, sweepMsg,
    addrs: () => client().addrs(),
  };
}

// --- step definitions with explanations ---
function SCEN_A(p: Params): Step[] {
  return [
    { title: `예금자가 Vault에 ${p.deposit.toLocaleString()} 예치`, desc: "예금자가 유동성을 공급합니다. 예치액만큼 지갑에서 빠져 Vault 총자산이 되고, 그 지분(share)을 받습니다." },
    { title: `브로커가 first-loss cover ${p.cover.toLocaleString()} 적립`, desc: "브로커가 자기 자본을 완충용으로 넣습니다. 손실이 나면 이 돈이 예금자보다 먼저 소진됩니다(skin in the game)." },
    { title: `차입자가 ${p.principal.toLocaleString()} 대출`, desc: "차입자가 EIP-712로 대출 조건에 서명하고 브로커가 제출합니다(양자 합의). 원금이 Vault 유동자산에서 차입자로 이동하고 '대출중'으로 잡힙니다." },
    { title: `차입자가 ${p.payments}회에 걸쳐 원리금 상환`, desc: "원리금균등상환. 매 회차 원금 일부 + 이자를 갚습니다. 원금은 Vault로 돌아오고, 이자(수수료 제외)는 예금자 몫으로 쌓입니다." },
    { title: `브로커가 cover ${p.cover.toLocaleString()} 회수`, desc: "정상 완납이라 손실이 없어, 브로커가 넣었던 완충자본을 그대로 회수합니다." },
    { title: "예금자가 원금+이자 전액 인출", desc: "예금자가 share를 반납하고 예치금 + 쌓인 이자를 인출합니다. 지갑 잔액이 예치 전보다 늘어납니다." },
  ];
}
function SCEN_B(p: Params): Step[] {
  return [
    { title: `예금자가 Vault에 ${p.deposit.toLocaleString()} 예치`, desc: "예금자가 유동성을 공급합니다. 이 돈이 대출 재원이 됩니다." },
    { title: `브로커가 cover ${p.cover.toLocaleString()} 적립`, desc: "완충자본을 넣지만, 이 시나리오에서는 손실보다 작게 설정되어 예금자도 손실을 나눠 집니다." },
    { title: `차입자가 ${p.principal.toLocaleString()} 대출 — 그리고 갚지 않습니다`, desc: "원금이 차입자 지갑으로 이동합니다. 이후 차입자는 상환하지 않아 그 돈이 지갑에 그대로 남습니다." },
    { title: "연체 → 브로커가 부실 표시(impair)", desc: "납기가 지나면 브로커가 부실을 표시합니다. Vault에 '미실현 손실'이 잡혀 예금자의 상환 가치가 즉시 낮아집니다." },
    { title: "유예기간 경과 → default (first-loss waterfall)", desc: "유예기간까지 지나면 채무불이행이 확정됩니다. cover가 먼저 소진되고(부채×CoverRateMinimum×CoverRateLiquidation 상한), 초과 손실은 예금자가 부담합니다." },
    { title: "예금자가 남은 금액만 인출 (손실 확정)", desc: "예금자는 줄어든 Vault 가치만큼만 돌려받습니다. 차입자 지갑에는 빌린 돈이 그대로 남아 있습니다(미상환)." },
  ];
}
function SCEN_C(p: Params, big: number): Step[] {
  return [
    { title: `예금자가 Vault에 ${p.deposit.toLocaleString()} 예치`, desc: "대출 재원을 공급합니다." },
    { title: `브로커가 cover ${p.cover.toLocaleString()} 적립`, desc: "완충자본을 넣습니다." },
    { title: `대형 단일대출 ${big.toLocaleString()} 시도`, desc: "한 건이 부채 총액의 α(집중도 한도)를 넘는 대출입니다. 하네스 ①이 있으면 LoanSet 앞단에서 차단합니다(Maple Orthogonal이 풀의 80%를 차지한 유형 방지)." },
    { title: "결과", desc: "하네스 ON: 대형대출 차단 → 한도 내 대출만 실행. OFF: 대형대출이 그대로 실행되어 한 대출이 풀을 지배(집중 리스크)." },
  ];
}
function SCEN_D(): Step[] {
  return [
    { title: `예금자가 Vault에 ${D_CFG.deposit.toLocaleString()} 예치`, desc: "대출 재원을 공급합니다." },
    { title: `브로커가 cover ${D_CFG.cover.toLocaleString()} 적립`, desc: "요구 비율이 올라가도 견딜 수 있도록 완충자본을 넉넉히 넣습니다." },
    { title: `같은 기관이 대출 ${D_CFG.loans}건 실행 (각 ${D_CFG.each.toLocaleString()})`, desc: `실행 원금 누계 ${(D_CFG.each * D_CFG.loans).toLocaleString()}. 아직 디폴트가 없어 요구 CoverRateMinimum은 설정값 그대로입니다.` },
    { title: "1건 디폴트 → 요구 cover 비율(③) 자동 상향", desc: `디폴트율 = 디폴트/실행원금 = ${Math.round(100 / D_CFG.loans)}%. CRM_eff = max(CRM_set, CRM_floor + λ×디폴트율). 심사를 소홀히 한 기관일수록 다음 대출에 더 많은 cover를 요구받습니다.` },
  ];
}
