import { D_CFG, useLending } from "./useLending";
import { FlowDiagram } from "./components/FlowDiagram";
import type { Snapshot } from "./lib/lending";
import { DEFAULT_PARAMS, type Params } from "./types";

const f2 = (v: number) => v.toLocaleString(undefined, { maximumFractionDigits: 2 });

/** Vault/broker figures, in as few rows as divide evenly: eight tiles read better as 4 × 2
 *  than as a row of seven and an orphan. */
export function StatGrid({ snap }: { snap: Snapshot }) {
  const tiles: [string, string][] = [
    ["Vault 총자산", f2(snap.vaultTotal)], ["대출중", f2(snap.onLoan)], ["미실현 손실", f2(snap.loss)],
    ["Broker cover", f2(snap.cover)], ["예금자 인출가능", f2(snap.maxWithdraw)],
    ...(snap.harnessOn ? [
      ["유효 CRM (③)", `${snap.effCrmPct.toFixed(0)}%`],
      ["디폴트율", `${snap.defaultRatePct.toFixed(0)}%`],
      ["cover 회수가능 (②)", f2(snap.coverWithdrawable)],
    ] as [string, string][] : []),
  ];
  const cols = tiles.length > 5 ? Math.ceil(tiles.length / 2) : tiles.length;
  return (
    <div className="grid" style={{ "--cols": cols } as React.CSSProperties}>
      {tiles.map(([k, v]) => (
        <div className="stat" key={k}><div className="k">{k}</div><div className="v">{v}</div></div>
      ))}
    </div>
  );
}

const FIELD: Record<keyof Params, { label: string; hint: string }> = {
  deposit: { label: "예치 (dUSD)", hint: "예금자가 Vault에" },
  principal: { label: "대출 원금 (dUSD)", hint: "차입자가 빌림" },
  cover: { label: "first-loss cover (dUSD)", hint: "브로커 완충자본" },
  interestPct: { label: "이자율 (연 %)", hint: "0~100" },
  payments: { label: "상환 횟수", hint: "분할상환 횟수" },
  interval: { label: "연체 주기 (초)", hint: "이 시간 지나면 연체" },
  grace: { label: "유예 기간 (초)", hint: "이후 default 가능" },
  covMinPct: { label: "CoverRateMinimum (%)", hint: "부채 대비 최소 cover" },
  covLiqPct: { label: "CoverRateLiquidation (%)", hint: "default 시 흡수 비율" },
};

type Lending = ReturnType<typeof useLending>;
type Rows = [string, string][];
const n = (v: number) => v.toLocaleString();
const P = DEFAULT_PARAMS;

/** What each scenario lets you tune, and what it runs with regardless. A field is listed only if
 *  the runner actually reads it; everything the runner hardcodes is shown as fixed, so the
 *  screen never displays a value the scenario ignores. */
const SCENARIOS: Array<{
  id: "A" | "B" | "C" | "D"; title: string; blurb: React.ReactNode; steps: number; harness: boolean;
  summary: (L: Lending) => Rows; fields: (keyof Params)[]; fixed: (L: Lending) => Rows;
  fixedWhy?: string; coverHint: boolean; harnessOffWarning?: string;
}> = [
  {
    id: "A", title: "정상 렌딩", steps: 6, harness: false, coverHint: true,
    blurb: <>차입자가 원리금을 분할 상환합니다. 예금자는 이자가 붙은 몫을 전액 인출합니다.</>,
    summary: () => [["예치", `${n(P.deposit)} dUSD`], ["대출 · 이자", `${n(P.principal)} · 연 ${P.interestPct}%`], ["first-loss cover", n(P.cover)]],
    fields: ["deposit", "principal", "cover", "interestPct", "payments", "covMinPct"],
    fixed: () => [["상환 주기", "30일 (이자 계산 기준)"], ["상환 대기", "없음 — 회차를 연속으로 상환"]],
  },
  {
    id: "B", title: "채무불이행(default)", steps: 6, harness: false, coverHint: true,
    blurb: <>차입자가 빌린 뒤 <b>약정대로 상환하지 않습니다.</b> cover가 먼저 소진되고 나머지 손실은 예금자가 떠안습니다.</>,
    summary: () => [["예치 · cover", `${n(P.deposit)} · ${n(P.cover)}`], ["대출", n(P.principal)], ["연체→default 대기", `약 ${P.interval + P.grace}초`]],
    fields: ["deposit", "principal", "cover", "interestPct", "payments", "interval", "grace", "covMinPct", "covLiqPct"],
    fixed: (L) => [["연체→default 대기", `약 ${L.params.interval + L.params.grace}초`]],
  },
  {
    id: "C", title: "집중도 한도 (하네스 ①)", steps: 4, harness: true, coverHint: true,
    blurb: <>부채 대비 α를 넘는 <b>대형 단일대출</b>을 시도합니다. 하네스가 켜져 있으면 §4.2 ①이 <b>LoanSet 앞단에서 차단</b>하고, 한도 내 대출만 실행합니다.</>,
    summary: (L) => [["대형대출 시도", n(L.bigLoan)], ["한도 내 대출", n(P.principal)], ["유효 CRM", `${L.snap ? L.snap.effCrmPct.toFixed(0) : "—"}%`]],
    fields: ["deposit", "principal", "cover"],
    fixed: (L) => [
      ["대형대출 시도", `${n(L.bigLoan)} (원금 × 1.5, 또는 한도를 넘는 최소액)`],
      ["이자율", "0% (부채 = 원금)"],
      ["CoverRateMinimum", `체인 현재값 ${L.snap ? L.snap.crmSetPct.toFixed(0) : "—"}%`],
    ],
    fixedWhy: "이자를 0으로 두어 한도와 비교되는 부채가 원금과 같아지게 했습니다.",
    harnessOffWarning: "하네스 OFF로 배포되어 있습니다 — 대형대출이 차단되지 않고 그대로 실행됩니다(집중 리스크 노출). 차단 장면을 보려면 「초기화」 후 하네스를 켜고 배포하세요.",
  },
  {
    id: "D", title: "이력 연동 공탁 (하네스 ③)", steps: 4, harness: true, coverHint: false,
    blurb: <>대출 {D_CFG.loans}건 중 1건이 <b>디폴트</b>하면, 그 기관의 <b>요구 cover 비율이 자동 상향</b>됩니다(§4.2 ③). 예금자 투표 없이 온체인 이력만으로.</>,
    summary: (L) => [["현재 유효 CRM", `${L.snap ? L.snap.effCrmPct.toFixed(0) : "—"}%`], ["디폴트율", `${L.snap ? L.snap.defaultRatePct.toFixed(0) : "—"}%`], ["디폴트 대기", `약 ${D_CFG.interval + D_CFG.grace}초`]],
    fields: [],
    fixed: () => [
      ["예치", n(D_CFG.deposit)], ["cover", n(D_CFG.cover)],
      ["대출", `${n(D_CFG.each)} × ${D_CFG.loans}건`], ["이자율", "0%"], ["상환 횟수", `${D_CFG.payments}회`],
      ["연체 주기 · 유예", `${D_CFG.interval}초 · ${D_CFG.grace}초`],
    ],
    fixedWhy: `디폴트율이 정확히 ${Math.round(100 / D_CFG.loans)}%가 되고, 요구 비율이 올라가도 cover가 버티도록 금액을 고정했습니다.`,
    harnessOffWarning: "하네스 OFF로 배포되어 있습니다 — 디폴트가 나도 요구 cover 비율이 오르지 않습니다. 「초기화」 후 하네스를 켜고 배포하세요.",
  },
];

function HarnessPill({ on }: { on: boolean }) {
  return <span className={"pill " + (on ? "info" : "")} style={on ? {} : { background: "#f1f5f9", color: "var(--mut)" }}>{on ? "하네스 ON" : "하네스 OFF"}</span>;
}

export default function App() {
  const L = useLending();
  const noMM = typeof window !== "undefined" && !window.ethereum;

  return (
    <div className="wrap">
      <header>
        <div className="brand">
          <div className="logo">X</div>
          <div>
            <h1>XLS-65/66 렌딩 데모</h1>
            <div className="mut" style={{ fontSize: 13 }}>Single Asset Vault · Lending Protocol — EVM 이식본</div>
          </div>
        </div>
        <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
          {L.phase === "ready" && <span className="pill info"><span className="dot" /> Sepolia</span>}
          {L.account && <span className="mut" style={{ fontSize: 13 }}>{L.account.slice(0, 6)}…{L.account.slice(-4)}</span>}
          <button onClick={L.connect} disabled={L.phase === "ready"}>{L.phase === "ready" ? "연결됨" : "지갑 연결"}</button>
        </div>
      </header>

      {noMM && (
        <div className="banner sp">
          MetaMask가 없습니다. <a href="https://metamask.io" target="_blank" rel="noopener noreferrer">MetaMask</a>를 설치하고 새로고침하세요.
        </div>
      )}

      <div className="hero">
        <div className="eyebrow">XLS-65 SINGLE ASSET VAULT · XLS-66 LENDING PROTOCOL</div>
        <h2>Vault 렌딩에서 돈이 어떻게 흐르는가</h2>
        <p className="mut" style={{ maxWidth: 660, margin: "0 auto" }}>
          예금자·브로커·차입자가 <b>각자 별도 계정</b>으로 실제 Sepolia 트랜잭션을 주고받습니다.
          숫자는 온체인에서 읽어온 실제 잔액입니다. 세 역할 지갑은 앱이 만들어 자동 서명(AUTO)하고,
          가스 충전만 당신 MetaMask가 한 번 처리합니다. (실제 자금 아님)
        </p>
      </div>

      {/* setup */}
      {L.phase === "ready" && (
        <div className="card pad sp">
          <div className="runhead">
            <div><b>준비</b> · 역할 계정 생성 &amp; 컨트랙트 배포</div>
            <div style={{ display: "flex", gap: 8 }}>
              <button onClick={L.setup} disabled={L.deployed || L.setupBusy}>{L.setupBusy ? "진행 중…" : "계정 만들고 배포"}</button>
              <button className="soft" onClick={L.sweep} disabled={L.sweeping || L.running}>{L.sweeping ? "회수 중…" : "남은 가스 회수"}</button>
              <button className="soft" onClick={L.forget}>초기화</button>
            </div>
          </div>
          {!L.deployed && (
            <label style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 10, fontSize: 14, fontWeight: 600, cursor: "pointer" }}>
              <input type="checkbox" checked={L.harnessToggle} onChange={(e) => L.setHarnessToggle(e.target.checked)} disabled={L.setupBusy} />
              LoanBroker 하네스 적용 (§4.2 · ①집중도 ②타임락 ③이력연동)
            </label>
          )}
          <div className="mut" style={{ marginTop: 8, fontSize: 13 }}>
            {L.deployed
              ? <><span className="pill ok">준비됨</span> {L.snap?.harnessOn ? <span className="pill info" style={{ marginRight: 4 }}>하네스 ON</span> : <span className="pill" style={{ marginRight: 4, background: "#f1f5f9", color: "var(--mut)" }}>하네스 OFF</span>} 역할 지갑 3개 생성 완료 · 시나리오를 선택하세요. 데모가 끝나면 <b>남은 가스 회수</b>로 임시지갑에 남은 ETH를 되돌릴 수 있습니다.</>
              : (L.setupStatus || "브로커 지갑에 가스 ETH 약 0.06을 충전(MetaMask 서명 1회)한 뒤 컨트랙트를 배포하고 각 역할 지갑에 테스트 dUSD를 지급합니다. 하네스를 켜면 배포 시 함께 활성화됩니다.")}
          </div>
          {L.sweepMsg && <div className="mut" style={{ marginTop: 6, fontSize: 13, color: L.sweepMsg.startsWith("✗") ? "var(--bad)" : "var(--good)" }}>{L.sweepMsg}</div>}
        </div>
      )}

      {/* scenario picker */}
      {L.deployed && !L.selected && !L.scenario && (
        <div className="scen sp">
          {SCENARIOS.map((sc) => (
            <div className="card pad" key={sc.id}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "start" }}>
                <h3>{sc.id} · {sc.title}</h3>
                {sc.harness
                  ? <HarnessPill on={!!L.snap?.harnessOn} />
                  : <span className={"pill " + (sc.id === "B" ? "bad" : "ok")}>{sc.steps}단계</span>}
              </div>
              <p className="mut" style={{ margin: 0 }}>{sc.blurb}</p>
              <div className="params">
                {sc.summary(L).map(([k, v]) => (
                  <div className="r" key={k}><span className="mut">{k}</span><b>{v}</b></div>
                ))}
              </div>
              <button className={sc.id === "A" ? "" : "soft"} style={{ marginTop: 14, width: "100%" }}
                onClick={() => L.selectScenario(sc.id)} disabled={L.running}>시나리오 {sc.id} 선택</button>
            </div>
          ))}
        </div>
      )}

      {/* parameters for the selected scenario */}
      {L.deployed && L.selected && !L.scenario && (() => {
        const sc = SCENARIOS.find((x) => x.id === L.selected)!;
        const run = { A: L.runA, B: L.runB, C: L.runC, D: L.runD }[sc.id];
        const fixed = sc.fixed(L);
        const warn = sc.harness && !L.snap?.harnessOn ? sc.harnessOffWarning : null;
        return (
          <div className="card pad sp">
            <div className="runhead">
              <div><span className={"pill " + (sc.id === "B" ? "bad" : "info")}>시나리오 {sc.id}</span> <b>{sc.title}</b></div>
              <div style={{ display: "flex", gap: 8 }}>
                <button onClick={run} disabled={L.running}>▶ 시작</button>
                {sc.fields.length > 0 && <button className="soft" onClick={L.resetParams} disabled={L.running}>기본값 복원</button>}
                <button className="soft" onClick={L.backToPicker} disabled={L.running}>◀ 시나리오 선택</button>
              </div>
            </div>
            <p className="mut" style={{ margin: "8px 0 0", fontSize: 14 }}>{sc.blurb}</p>

            {warn && <div className="banner" style={{ marginTop: 12, fontSize: 14 }}>{warn}</div>}

            {sc.fields.length > 0 && (
              <div className="pgrid">
                {sc.fields.map((k) => (
                  <div className="pf" key={k}>
                    <label>{FIELD[k].label}</label>
                    <input type="number" value={L.params[k]} disabled={L.running}
                      onChange={(e) => L.setParam(k, Number(e.target.value))} />
                    <small>{FIELD[k].hint}</small>
                  </div>
                ))}
              </div>
            )}

            {fixed.length > 0 && (
              <div className="params">
                <div className="mut" style={{ fontSize: 12, fontWeight: 700 }}>
                  {sc.fields.length > 0 ? "고정값 · 참고" : "이 시나리오는 아래 값으로 고정 실행됩니다"}
                </div>
                {fixed.map(([k, v]) => (
                  <div className="r" key={k}><span className="mut">{k}</span><b>{v}</b></div>
                ))}
                {sc.fixedWhy && <div className="mut" style={{ fontSize: 12 }}>{sc.fixedWhy}</div>}
              </div>
            )}

            {sc.coverHint && (
              <p className="hint">
                💡 default 시 cover 흡수액 = <code>부채 × CoverRateMinimum × CoverRateLiquidation</code> (상한).
                CoverRateMinimum을 올리면 cover가 손실을 더 많이 흡수합니다 — 단 대출 실행에는
                <code>cover ≥ (기존 부채 + 신규 부채) × CoverRateMinimum</code>이 필요합니다. 신규 부채는 원금이 아니라 <b>원금 + 순이자</b>라, 요구 cover는 원금 기준보다 이자만큼 큽니다.
              </p>
            )}
          </div>
        );
      })()}

      {/* run view */}
      {L.deployed && L.scenario && (
        <div className="card pad">
          <div className="runhead">
            <div><span className={"pill " + (L.scenario === "B" ? "bad" : "info")}>시나리오 {L.scenario}</span> <b>{L.scenarioSub}</b></div>
            <button className="soft" onClick={L.backToPicker} disabled={L.running}>◀ 시나리오 선택</button>
          </div>

          <div className="steps">
            {L.steps.map((_, i) => (
              <div key={i} className={"s" + (i < L.stepIndex ? " done" : i === L.stepIndex ? " cur" : "")} />
            ))}
          </div>

          {L.steps[L.stepIndex] && (
            <div className="stepbox">
              <div className="t">{L.stepIndex + 1}. {L.steps[L.stepIndex].title}</div>
              <div className="d">{L.steps[L.stepIndex].desc}</div>
              {L.countdownMsg && <div className="cd">⏳ {L.countdownMsg}</div>}
            </div>
          )}

          <FlowDiagram snap={L.snap} flow={L.flow} defaulted={L.defaulted} />

          <p className="hint">
            각 역할 지갑은 데모용 테스트 dUSD를 미리 지급받습니다(예금자·브로커 10만, 차입자 2만).
            큰 숫자는 <b>지갑 총잔액</b>이고, 예치·대출·상환은 그 일부가 오가는 것입니다.
          </p>

          {L.snap && <StatGrid snap={L.snap} />}

          {L.result && (
            <div className={"result " + L.result.tone}>
              <div className="rt">{L.result.title}</div>
              <div>{L.result.body}</div>
              {L.result.note && <div className="rn">{L.result.note}</div>}
              {L.result.action && (
                <button style={{ marginTop: 10 }} onClick={L.result.action.run} disabled={L.running || L.setupBusy}>
                  {L.setupBusy ? (L.setupStatus || "재배포 중…") : L.result.action.label}
                </button>
              )}
            </div>
          )}

          <div className="log">
            {L.log.map((l) => (
              <div key={l.key}>
                {l.text}
                {l.hash && <> · <a href={`https://sepolia.etherscan.io/tx/${l.hash}`} target="_blank" rel="noopener noreferrer">tx</a></>}
              </div>
            ))}
          </div>
        </div>
      )}

      <p className="mut" style={{ textAlign: "center", fontSize: 12, marginTop: 18 }}>
        가스용 Sepolia ETH는 <a href="https://sepoliafaucet.com" target="_blank" rel="noopener noreferrer">faucet</a>에서 무료로 받을 수 있습니다. dUSD는 앱에서 자동 지급됩니다.
        <br />역할 지갑의 키는 이 브라우저(localStorage)에만 저장되는 일회용 테스트 키입니다.
      </p>
    </div>
  );
}
