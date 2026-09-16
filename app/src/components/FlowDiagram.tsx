import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { FlowEvent, NodeId } from "../types";
import type { Snapshot } from "../lib/lending";
import { short } from "../lib/lending";

const POS: Record<NodeId, [number, number]> = {
  dep: [0.14, 0.28], vault: [0.5, 0.28], bor: [0.86, 0.28], broker: [0.5, 0.8],
};
const f2 = (v: number) => v.toLocaleString(undefined, { maximumFractionDigits: 2 });

export function FlowDiagram({ snap, flow, defaulted }: { snap: Snapshot | null; flow: FlowEvent | null; defaulted: boolean }) {
  const box = useRef<HTMLDivElement>(null);
  const refs: Record<NodeId, React.RefObject<HTMLDivElement | null>> = {
    dep: useRef(null), vault: useRef(null), bor: useRef(null), broker: useRef(null),
  };
  const [wires, setWires] = useState<Array<{ x1: number; y1: number; x2: number; y2: number }>>([]);

  const center = (id: NodeId) => {
    const b = box.current!.getBoundingClientRect();
    const r = refs[id].current!.getBoundingClientRect();
    return { x: r.left - b.left + r.width / 2, y: r.top - b.top + r.height / 2 };
  };
  const drawWires = () => {
    if (!box.current) return;
    const pairs: [NodeId, NodeId][] = [["dep", "vault"], ["vault", "bor"], ["vault", "broker"]];
    setWires(pairs.map(([a, c]) => { const p = center(a), q = center(c); return { x1: p.x, y1: p.y, x2: q.x, y2: q.y }; }));
  };

  useLayoutEffect(() => { drawWires(); }, []);
  useEffect(() => {
    const ro = new ResizeObserver(() => drawWires());
    if (box.current) ro.observe(box.current);
    return () => ro.disconnect();
  }, []);

  // packet animation on each flow event
  useEffect(() => {
    if (!flow || !box.current) return;
    const a = center(flow.from), b = center(flow.to);
    const p = document.createElement("div");
    p.className = "packet " + (flow.cls || "");
    p.textContent = flow.text;
    p.style.left = a.x + "px"; p.style.top = a.y + "px"; p.style.opacity = "0";
    box.current.appendChild(p);
    refs[flow.from].current?.classList.add("hot");
    refs[flow.to].current?.classList.add("hot");
    requestAnimationFrame(() => { p.style.opacity = "1"; p.style.left = b.x + "px"; p.style.top = b.y + "px"; });
    // Past the midpoint of the .95s travel the packet belongs to the receiver, so it flips to
    // the receiving side's sign.
    const t0 = flow.textTo ? setTimeout(() => { p.textContent = flow.textTo!; }, 520) : undefined;
    const t1 = setTimeout(() => { p.style.opacity = "0"; }, 1050);
    const t2 = setTimeout(() => {
      p.remove();
      refs[flow.from].current?.classList.remove("hot");
      refs[flow.to].current?.classList.remove("hot");
    }, 1350);
    return () => { clearTimeout(t0); clearTimeout(t1); clearTimeout(t2); p.remove(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [flow?.key]);

  const style = (id: NodeId): React.CSSProperties => ({ left: `${POS[id][0] * 100}%`, top: `${POS[id][1] * 100}%` });
  const s = snap;

  return (
    <div className="diagram" ref={box}>
      <svg>
        {wires.map((w, i) => (
          <line key={i} x1={w.x1} y1={w.y1} x2={w.x2} y2={w.y2} stroke="#cbd5e1" strokeWidth={2} strokeDasharray="5 5" />
        ))}
      </svg>

      <div className="node dep" ref={refs.dep} style={style("dep")}>
        <div className="top"><span className="role">예금자</span><span className="pill auto">AUTO</span></div>
        <div className="who">{s ? short(s.addrDep) : "—"}</div>
        <div className="bal">{s ? f2(s.balDep) : "0"} <small>지갑 dUSD</small></div>
      </div>

      <div className="node vault" ref={refs.vault} style={style("vault")}>
        <div className="top"><span className="role">VAULT 금고</span><span className="pill info">XLS-65</span></div>
        <div className="who">예금자 자산 풀</div>
        <div className="kv"><span>총자산</span><b>{s ? f2(s.vaultTotal) : "0"}</b></div>
        <div className="kv"><span>대출중</span><b>{s ? f2(s.onLoan) : "0"}</b></div>
        <div className="kv"><span>손실</span><b>{s ? f2(s.loss) : "0"}</b></div>
      </div>

      <div className={"node bor" + (defaulted ? " rug" : "")} ref={refs.bor} style={style("bor")}>
        {defaulted && <div className="xmark">✕</div>}
        <div className="top">
          <span className="role">차입자 {defaulted && <span className="pill bad" style={{ marginLeft: 4 }}>채무불이행</span>}</span>
          <span className="pill auto">AUTO</span>
        </div>
        <div className="who">{s ? short(s.addrBor) : "—"}</div>
        <div className="bal">{s ? f2(s.balBor) : "0"} <small>지갑 dUSD</small></div>
      </div>

      <div className="node broker" ref={refs.broker} style={style("broker")}>
        <div className="top"><span className="role">BROKER</span><span className="pill auto">AUTO</span></div>
        <div className="who">{s ? short(s.addrBrk) : "—"}</div>
        <div className="kv"><span>지갑</span><b>{s ? f2(s.balBrk) : "0"}</b></div>
        <div className="kv"><span>cover</span><b>{s ? f2(s.cover) : "0"}</b></div>
        <div className="kv"><span>부채</span><b>{s ? f2(s.debt) : "0"}</b></div>
      </div>
    </div>
  );
}
