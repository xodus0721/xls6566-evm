export interface Params {
  deposit: number; principal: number; cover: number; interestPct: number;
  payments: number; interval: number; grace: number; covMinPct: number; covLiqPct: number;
}

export const DEFAULT_PARAMS: Params = {
  deposit: 50000, principal: 30000, cover: 5000, interestPct: 12,
  payments: 3, interval: 40, grace: 20, covMinPct: 10, covLiqPct: 100,
};

export type NodeId = "dep" | "vault" | "bor" | "broker";

export interface FlowEvent {
  from: NodeId; to: NodeId; text: string; cls?: "gain" | "loss" | ""; key: number;
  /** Label shown once the packet reaches `to`, i.e. the same transfer seen from the
   *  receiving side (−50,000 leaving the depositor is +50,000 arriving at the Vault).
   *  Omitted for flows that carry no sign. */
  textTo?: string;
}

export interface Step { title: string; desc: string; }

export interface LogLine { text: string; hash?: string; key: number; }

export interface ResultBox { tone: "ok" | "bad"; title: string; body: string; note?: string; }
