import { useCallback, useRef, useState } from "react";
import { LendingClient, type Snapshot } from "./lib/lending";
import { DEFAULT_PARAMS, type FlowEvent, type LogLine, type Params, type ResultBox, type Step } from "./types";

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
const r0 = (v: number) => Math.round(v).toLocaleString();

export function useLending() {
  const [phase, setPhase] = useState<"connect" | "ready">("connect");
  const [account, setAccount] = useState("");
  const [deployed, setDeployed] = useState(false);
  const [setupBusy, setSetupBusy] = useState(false);
  const [setupStatus, setSetupStatus] = useState("");
  const [params, setParams] = useState<Params>(DEFAULT_PARAMS);
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [scenario, setScenario] = useState<"A" | "B" | "C" | "D" | null>(null);
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
    try { setSnap(await client().readState()); } catch (e: any) { logRef.current(`✗ ${e.shortMessage || e.message}`); }
  }, []);

  const doFlow = useCallback(async (from: FlowEvent["from"], to: FlowEvent["to"], text: string, cls: FlowEvent["cls"] = "") => {
    setFlow({ from, to, text, cls, key: Date.now() + Math.random() });
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
    } catch (e: any) { logRef.current(`✗ ${e.shortMessage || e.message}`); }
  }, [refresh]);

  const [harnessToggle, setHarnessToggle] = useState(false);
  const setup = useCallback(async () => {
    setSetupBusy(true);
    try { await client().setup(setSetupStatus, harnessToggle); setDeployed(true); setSetupStatus(""); await refresh(); }
    catch (e: any) { logRef.current(`✗ ${e.shortMessage || e.message}`); }
    finally { setSetupBusy(false); }
  }, [refresh, harnessToggle]);

  const [sweeping, setSweeping] = useState(false);
  const [sweepMsg, setSweepMsg] = useState("");
  const sweep = useCallback(async () => {
    setSweeping(true); setSweepMsg("");
    try {
      const got = await client().sweepGas();
      const m = got > 0 ? `✓ ${got.toFixed(4)} ETH를 내 지갑으로 회수했습니다.` : "회수할 잔여 ETH가 없습니다.";
      setSweepMsg(m); logRef.current(m);
    } catch (e: any) { const m = `✗ ${e.shortMessage || e.message}`; setSweepMsg(m); logRef.current(m); }
    finally { setSweeping(false); }
  }, []);

  const forget = useCallback(() => { client().reset(); localStorage.clear(); location.reload(); }, []);
  const resetParams = useCallback(() => setParams(DEFAULT_PARAMS), []);
  const setParam = useCallback((k: keyof Params, v: number) => setParams((p) => ({ ...p, [k]: v })), []);

  async function countdown(sec: number, label: string) {
    for (let s = sec; s > 0; s--) { setCountdownMsg(`${label} ${s}초…`); await wait(1000); }
    setCountdownMsg("");
  }

  function checkCover(p: Params): boolean {
    const req = p.principal * (p.covMinPct / 100);
    if (p.cover < req) {
      setResult({ tone: "bad", title: "cover 부족", body: `CoverRateMinimum ${p.covMinPct}%에서는 cover ≥ ${r0(req)} 필요 (현재 ${p.cover.toLocaleString()}). cover를 올리거나 CoverRateMinimum을 낮추세요.` });
      return false;
    }
    return true;
  }

  const raw = {
    interest: (p: Params) => Math.round(clamp(p.interestPct, 0, 100) * 1000),
    covMin: (p: Params) => Math.round(clamp(p.covMinPct, 0, 100) * 1000),
    covLiq: (p: Params) => Math.round(clamp(p.covLiqPct, 0, 100) * 1000),
  };

  const runA = useCallback(async () => {
    const p = params, c = client();
    setResult(null);
    if (!checkCover(p)) { setScenario("A"); return; }
    setRunning(true); setDefaulted(false); setScenario("A");
    setScenarioSub("정상 렌딩 — 예금자가 이자를 법니다");
    setSteps(SCEN_A(p)); await refresh();
    try {
      await c.setCoverRates(raw.covMin(p), raw.covLiq(p));
      const dep0 = (await c.readState()).balDep;
      setStep(0); await doFlow("dep", "vault", `－${p.deposit.toLocaleString()}`); await c.deposit(p.deposit); await refresh();
      setStep(1); await doFlow("broker", "vault", `cover ${p.cover.toLocaleString()}`); await c.cover(p.cover); await refresh();
      setStep(2); await doFlow("vault", "bor", `＋${p.principal.toLocaleString()}`, "gain"); await c.originate(p.principal, 2592000, 30, p.payments, raw.interest(p)); await refresh();
      setStep(3);
      for (let i = 0; i < p.payments; i++) { await doFlow("bor", "vault", `상환 ${i + 1}/${p.payments}`); await c.pay(); await refresh(); }
      setStep(4); await doFlow("vault", "broker", `cover ${p.cover.toLocaleString()}`); await c.coverWithdraw(p.cover); await refresh();
      setStep(5); await doFlow("vault", "dep", "＋인출", "gain"); await c.withdraw(); await refresh();
      const dep1 = (await c.readState()).balDep; const profit = dep1 - dep0;
      setResult({ tone: "ok", title: "완료 · 손실 0",
        body: `예금자 지갑 ${dep1.toLocaleString(undefined, { maximumFractionDigits: 2 })} dUSD (예치금 전액 회수 + 이자 ${profit >= 0 ? "+" : ""}${profit.toLocaleString(undefined, { maximumFractionDigits: 2 })}). 브로커는 cover를 온전히 회수했습니다.`,
        note: `한 지갑이 3역을 겸하지 않고 역할별 별도 계정이라, 예금자의 이자 수익이 잔액 증가로 그대로 보입니다.` });
    } catch (e: any) { logRef.current(`✗ ${e.shortMessage || e.message}`); }
    finally { setRunning(false); }
  }, [params, refresh, doFlow, setStep]);

  const runB = useCallback(async () => {
    const p = params, c = client();
    setResult(null);
    if (!checkCover(p)) { setScenario("B"); return; }
    setRunning(true); setDefaulted(false); setScenario("B");
    setScenarioSub("채무불이행 — 예금자가 손실을 봅니다");
    setSteps(SCEN_B(p)); await refresh();
    try {
      await c.setCoverRates(raw.covMin(p), raw.covLiq(p));
      setStep(0); await doFlow("dep", "vault", `－${p.deposit.toLocaleString()}`); await c.deposit(p.deposit); await refresh();
      setStep(1); await doFlow("broker", "vault", `cover ${p.cover.toLocaleString()}`); await c.cover(p.cover); await refresh();
      setStep(2); await doFlow("vault", "bor", `＋${p.principal.toLocaleString()}`, "gain"); await c.originate(p.principal, p.interval, p.grace, p.payments, raw.interest(p)); await refresh();
      const s0 = await c.readState(); const cov0 = s0.cover, tot0 = s0.vaultTotal;
      setStep(3); await countdown(p.interval + 5, "연체까지"); await doFlow("bor", "vault", "미상환", "loss"); await c.impair(); await refresh();
      setStep(4); await countdown(p.grace + 5, "default 가능까지"); setDefaulted(true);
      await doFlow("broker", "vault", "cover 흡수", "gain"); await c.default_(); await refresh();
      const s1 = await c.readState();
      const covUsed = Math.max(0, cov0 - s1.cover), depLoss = Math.max(0, tot0 - s1.vaultTotal);
      setStep(5); await doFlow("vault", "dep", "－인출", "loss"); await c.withdraw(); await refresh();
      const zeroLoss = depLoss < 1;
      setResult({ tone: zeroLoss ? "ok" : "bad",
        title: zeroLoss ? "cover가 손실 전액 흡수 · 예금자 손실 0" : "손실 발생 · 차입자 채무불이행",
        body: `차입자 지갑에는 빌린 ${p.principal.toLocaleString()}이 미상환 상태로 남아 있습니다. 대출 원금 ${p.principal.toLocaleString()}은 cover가 ${r0(covUsed)} 흡수, 예금자가 ${r0(depLoss)} 부담. ${r0(covUsed)} + ${r0(depLoss)} = ${p.principal.toLocaleString()} — first-loss waterfall이 손실을 정확히 배분합니다.`,
        note: `CoverRateMinimum ${p.covMinPct}% · CoverRateLiquidation ${p.covLiqPct}% 적용. 비율을 올리면 cover가 더 많이 흡수합니다.` });
    } catch (e: any) { logRef.current(`✗ ${e.shortMessage || e.message}`); }
    finally { setRunning(false); }
  }, [params, refresh, doFlow, setStep]);

  // Scenario C — harness ① concentration limit demo
  const runC = useCallback(async () => {
    const p = params, c = client();
    setResult(null);
    if (!checkCover(p)) { setScenario("C"); return; }
    setRunning(true); setDefaulted(false); setScenario("C");
    setScenarioSub("집중도 한도 — 하네스 ①");
    setSteps(SCEN_C(p)); await refresh();
    try {
      const big = Math.round(p.principal * 1.5);
      setStep(0); await doFlow("dep", "vault", `－${p.deposit.toLocaleString()}`); await c.deposit(p.deposit); await refresh();
      setStep(1); await doFlow("broker", "vault", `cover ${p.cover.toLocaleString()}`); await c.cover(p.cover); await refresh();
      setStep(2);
      // Zero-interest loans so newDebt == principal (concentration demo; interest irrelevant).
      const res = await c.tryOriginate(big, 40, 20, p.payments, 0);
      const s = await c.readState();
      if (res.ok) {
        await doFlow("vault", "bor", `＋${big.toLocaleString()}`, "gain"); await refresh();
        setStep(3);
        setResult({ tone: "bad", title: "하네스 없음 · 집중 리스크 노출",
          body: `단일 대출 ${big.toLocaleString()}이 그대로 실행됐습니다 — 한 대출이 풀 전체를 지배할 수 있습니다(Orthogonal 80% 유형).`,
          note: `하네스를 켜고 배포하면 이 대출은 집중도 한도(α)로 차단됩니다.` });
      } else {
        setStep(3); await doFlow("vault", "bor", `＋${p.principal.toLocaleString()}`, "gain");
        await c.originate(p.principal, 40, 20, p.payments, 0); await refresh();
        setResult({ tone: "ok", title: "하네스 ①이 대형 단일대출 차단",
          body: `${big.toLocaleString()} 단일대출은 집중도 한도(부채 대비 α)를 넘어 거부됐고, 한도 내 ${p.principal.toLocaleString()} 대출만 실행됐습니다.`,
          note: `유효 CRM ${s.effCrmPct.toFixed(0)}% · 디폴트율 ${s.defaultRatePct.toFixed(0)}%. 디폴트가 쌓이면 ③에 의해 요구 cover가 자동 상향됩니다.` });
      }
    } catch (e: any) { logRef.current(`✗ ${e.shortMessage || e.message}`); }
    finally { setRunning(false); }
  }, [params, refresh, doFlow, setStep]);

  // Scenario D — harness ③ history-linked cover rate
  const runD = useCallback(async () => {
    const c = client();
    setResult(null); setRunning(true); setDefaulted(false); setScenario("D");
    setScenarioSub("이력 연동 공탁 비율 — 하네스 ③");
    setSteps(SCEN_D()); await refresh();
    try {
      setStep(0); await doFlow("dep", "vault", "－50,000"); await c.deposit(50000); await refresh();
      setStep(1); await doFlow("broker", "vault", "cover 30,000"); await c.cover(30000); await refresh();
      setStep(2);
      await doFlow("vault", "bor", "＋10,000", "gain"); await c.originate(10000, 40, 20, 2, 0); await refresh();
      const before = (await c.readState()).effCrmPct;
      await doFlow("vault", "bor", "＋10,000", "gain"); await c.originate(10000, 40, 20, 2, 0); await refresh();
      setStep(3);
      await countdown(70, "default 가능까지"); setDefaulted(true);
      await doFlow("bor", "vault", "default", "loss"); await c.default_(); await refresh();
      const s = await c.readState();
      setResult({ tone: "ok", title: "이력 연동으로 요구 cover 자동 상향 (③)",
        body: `대출 2건 중 1건 디폴트 → 디폴트율 ${s.defaultRatePct.toFixed(0)}%. 유효 CoverRateMinimum이 ${before.toFixed(0)}% → ${s.effCrmPct.toFixed(0)}%로 자동 상향됐습니다.`,
        note: `CRM_eff = max(CRM_set, CRM_floor + λ×디폴트율). 심사를 소홀히 해 디폴트가 쌓인 기관일수록 다음 대출에 더 많은 cover를 요구받습니다 — 예금자 투표 없이 온체인 이력만으로 결정론적으로.` });
    } catch (e: any) { logRef.current(`✗ ${e.shortMessage || e.message}`); }
    finally { setRunning(false); }
  }, [refresh, doFlow, setStep]);

  const backToPicker = useCallback(() => { setScenario(null); setResult(null); }, []);

  return {
    phase, account, deployed, setupBusy, setupStatus,
    params, setParam, resetParams,
    harnessToggle, setHarnessToggle,
    snap, scenario, scenarioSub, steps, stepIndex, running, flow, defaulted, result, log, countdownMsg,
    connect, setup, forget, runA, runB, runC, runD, backToPicker,
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
function SCEN_C(p: Params): Step[] {
  const big = Math.round(p.principal * 1.5);
  return [
    { title: `예금자가 Vault에 ${p.deposit.toLocaleString()} 예치`, desc: "대출 재원을 공급합니다." },
    { title: `브로커가 cover ${p.cover.toLocaleString()} 적립`, desc: "완충자본을 넣습니다." },
    { title: `대형 단일대출 ${big.toLocaleString()} 시도`, desc: "한 건이 부채 총액의 α(집중도 한도)를 넘는 대출입니다. 하네스 ①이 있으면 LoanSet 앞단에서 차단합니다(Maple Orthogonal이 풀의 80%를 차지한 유형 방지)." },
    { title: "결과", desc: "하네스 ON: 대형대출 차단 → 한도 내 대출만 실행. OFF: 대형대출이 그대로 실행되어 한 대출이 풀을 지배(집중 리스크)." },
  ];
}
function SCEN_D(): Step[] {
  return [
    { title: "예금자가 Vault에 50,000 예치", desc: "대출 재원을 공급합니다." },
    { title: "브로커가 cover 30,000 적립", desc: "요구 비율이 올라가도 견딜 수 있도록 완충자본을 넉넉히 넣습니다." },
    { title: "같은 기관이 대출 2건 실행 (각 10,000)", desc: "실행 원금 누계 20,000. 아직 디폴트가 없어 요구 CoverRateMinimum은 설정값(10%) 그대로입니다." },
    { title: "1건 디폴트 → 요구 cover 비율(③) 자동 상향", desc: "디폴트율 = 디폴트/실행원금 = 50%. CRM_eff = max(설정 10%, 하한 10% + λ×50%) = 60%. 심사를 소홀히 한 기관일수록 다음 대출에 더 많은 cover를 요구받습니다." },
  ];
}
