import { useLending } from "./useLending";
import { FlowDiagram } from "./components/FlowDiagram";
import type { Params } from "./types";

const f2 = (v: number) => v.toLocaleString(undefined, { maximumFractionDigits: 2 });

const PARAM_FIELDS: Array<{ k: keyof Params; label: string; hint: string }> = [
  { k: "deposit", label: "예치 (dUSD)", hint: "예금자가 Vault에" },
  { k: "principal", label: "대출 원금 (dUSD)", hint: "차입자가 빌림" },
  { k: "cover", label: "first-loss cover (dUSD)", hint: "브로커 완충자본" },
  { k: "interestPct", label: "이자율 (연 %)", hint: "0~100" },
  { k: "payments", label: "상환 횟수", hint: "분할상환 횟수" },
  { k: "interval", label: "연체 주기 (초)", hint: "B: 이 시간 지나면 연체" },
  { k: "grace", label: "유예 기간 (초)", hint: "B: 이후 default 가능" },
  { k: "covMinPct", label: "CoverRateMinimum (%)", hint: "부채 대비 최소 cover" },
  { k: "covLiqPct", label: "CoverRateLiquidation (%)", hint: "default 시 흡수 비율" },
];

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

      {/* param panel */}
      {L.deployed && (
        <div className="card pad sp">
          <div className="runhead">
            <div><b>파라미터</b> <span className="mut" style={{ fontSize: 13 }}>· 값을 바꿔 시나리오를 실행할 수 있습니다</span></div>
            <div style={{ display: "flex", gap: 8 }}>
              <button onClick={L.runA} disabled={L.running}>▶ 기본값으로 실행</button>
              <button className="soft" onClick={L.resetParams} disabled={L.running}>기본값 복원</button>
            </div>
          </div>
          <div className="pgrid">
            {PARAM_FIELDS.map((f) => (
              <div className="pf" key={f.k}>
                <label>{f.label}</label>
                <input type="number" value={L.params[f.k]} disabled={L.running}
                  onChange={(e) => L.setParam(f.k, Number(e.target.value))} />
                <small>{f.hint}</small>
              </div>
            ))}
          </div>
          <p className="hint">
            💡 default 시 cover 흡수액 = <code>부채 × CoverRateMinimum × CoverRateLiquidation</code> (상한).
            CoverRateMinimum을 올리면 cover가 손실을 더 많이 흡수합니다 — 단 대출 실행에는 <code>cover ≥ 원금 × CoverRateMinimum</code>이 필요합니다.
          </p>
        </div>
      )}

      {/* scenario cards */}
      {L.deployed && !L.scenario && (
        <div className="scen sp">
          <div className="card pad">
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "start" }}>
              <h3>A · 정상 렌딩</h3><span className="pill ok">6단계</span>
            </div>
            <p className="mut" style={{ margin: 0 }}>차입자가 원리금을 분할 상환합니다. 예금자는 이자가 붙은 몫을 전액 인출합니다. (금액·횟수는 위 파라미터로 조정)</p>
            <div className="params">
              <div className="r"><span className="mut">예치</span><b>{L.params.deposit.toLocaleString()} dUSD</b></div>
              <div className="r"><span className="mut">대출 · 이자</span><b>{L.params.principal.toLocaleString()} · 연 {L.params.interestPct}%</b></div>
              <div className="r"><span className="mut">first-loss cover</span><b>{L.params.cover.toLocaleString()}</b></div>
            </div>
            <button style={{ marginTop: 14, width: "100%" }} onClick={L.runA} disabled={L.running}>시나리오 A 시작</button>
          </div>
          <div className="card pad">
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "start" }}>
              <h3>B · 채무불이행(default)</h3><span className="pill bad">6단계</span>
            </div>
            <p className="mut" style={{ margin: 0 }}>차입자가 빌린 뒤 <b>약정대로 상환하지 않습니다.</b> cover가 먼저 소진되고 나머지 손실은 예금자가 떠안습니다.</p>
            <div className="params">
              <div className="r"><span className="mut">예치 · cover</span><b>{L.params.deposit.toLocaleString()} · {L.params.cover.toLocaleString()}</b></div>
              <div className="r"><span className="mut">대출</span><b>{L.params.principal.toLocaleString()}</b></div>
              <div className="r"><span className="mut">연체→default 대기</span><b>약 {L.params.interval + L.params.grace}초</b></div>
            </div>
            <button className="soft" style={{ marginTop: 14, width: "100%", background: "#fee2e2", color: "var(--bad)" }} onClick={L.runB} disabled={L.running}>시나리오 B 시작</button>
          </div>
          <div className="card pad">
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "start" }}>
              <h3>C · 집중도 한도 (하네스 ①)</h3><span className={"pill " + (L.snap?.harnessOn ? "info" : "")} style={L.snap?.harnessOn ? {} : { background: "#f1f5f9", color: "var(--mut)" }}>{L.snap?.harnessOn ? "하네스 ON" : "하네스 OFF"}</span>
            </div>
            <p className="mut" style={{ margin: 0 }}>부채 대비 α를 넘는 <b>대형 단일대출</b>을 시도합니다. 하네스가 켜져 있으면 §4.2 ①이 <b>LoanSet 앞단에서 차단</b>합니다.</p>
            <div className="params">
              <div className="r"><span className="mut">대형대출 시도</span><b>{Math.round(L.params.principal * 1.5).toLocaleString()}</b></div>
              <div className="r"><span className="mut">유효 CRM</span><b>{L.snap ? L.snap.effCrmPct.toFixed(0) : "—"}%</b></div>
              <div className="r"><span className="mut">디폴트율</span><b>{L.snap ? L.snap.defaultRatePct.toFixed(0) : "—"}%</b></div>
            </div>
            <button className="soft" style={{ marginTop: 14, width: "100%" }} onClick={L.runC} disabled={L.running}>시나리오 C 시작</button>
          </div>
          <div className="card pad">
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "start" }}>
              <h3>D · 이력 연동 공탁 (하네스 ③)</h3><span className={"pill " + (L.snap?.harnessOn ? "info" : "")} style={L.snap?.harnessOn ? {} : { background: "#f1f5f9", color: "var(--mut)" }}>{L.snap?.harnessOn ? "하네스 ON" : "하네스 OFF"}</span>
            </div>
            <p className="mut" style={{ margin: 0 }}>대출 2건 중 1건이 <b>디폴트</b>하면, 그 기관의 <b>요구 cover 비율이 자동 상향</b>됩니다(§4.2 ③). 예금자 투표 없이 온체인 이력만으로.</p>
            <div className="params">
              <div className="r"><span className="mut">현재 유효 CRM</span><b>{L.snap ? L.snap.effCrmPct.toFixed(0) : "—"}%</b></div>
              <div className="r"><span className="mut">디폴트율</span><b>{L.snap ? L.snap.defaultRatePct.toFixed(0) : "—"}%</b></div>
              <div className="r"><span className="mut">디폴트 대기</span><b>약 60초</b></div>
            </div>
            <button className="soft" style={{ marginTop: 14, width: "100%" }} onClick={L.runD} disabled={L.running}>시나리오 D 시작</button>
          </div>
        </div>
      )}

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

          <div className="grid">
            {L.snap && ([
              ["Vault 총자산", f2(L.snap.vaultTotal)], ["대출중", f2(L.snap.onLoan)], ["미실현 손실", f2(L.snap.loss)],
              ["Broker cover", f2(L.snap.cover)], ["예금자 인출가능", f2(L.snap.maxWithdraw)],
              ...(L.snap.harnessOn ? [
                ["유효 CRM (③)", `${L.snap.effCrmPct.toFixed(0)}%`],
                ["디폴트율", `${L.snap.defaultRatePct.toFixed(0)}%`],
                ["cover 회수가능 (②)", f2(L.snap.coverWithdrawable)],
              ] : []),
            ] as [string, string][]).map(([k, v]) => (
              <div className="stat" key={k}><div className="k">{k}</div><div className="v">{v}</div></div>
            ))}
          </div>

          {L.result && (
            <div className={"result " + L.result.tone}>
              <div className="rt">{L.result.title}</div>
              <div>{L.result.body}</div>
              {L.result.note && <div className="rn">{L.result.note}</div>}
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
