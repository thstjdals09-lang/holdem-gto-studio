// 메인 스레드 ↔ 솔버 워커 메시지 타입
import type { TreeConfig } from "../engine/tree";
import type { PreflopConfig } from "../engine/preflop";

export interface ActionView {
  label: string;
  code: string;
  type: string;
  amount: number;
  freq: number; // 레인지 전체 빈도
  ev: number; // 레인지 전체 EV (여기서부터 순이익)
}

export interface ComboView {
  combo: number; // 1326 인덱스
  weight: number; // 행동 플레이어 reach
  oppWeight: number;
  strategy: number[]; // A
  ev: number[]; // A
  equity: number;
  eqr: number;
  handEv: number;
}

export interface DecisionView {
  kind: "decision";
  player: 0 | 1;
  street: number;
  board: number[];
  pot: number;
  invested: [number, number];
  toCall: number;
  actions: ActionView[];
  classFreq: Float32Array; // 169*A, 클래스별 액션 빈도 (reach 가중)
  classEv: Float32Array; // 169*A
  classWeight: Float32Array; // 169 행동 플레이어 클래스 reach 합 (0~콤보수)
  classWeightNorm: Float32Array; // 169 0~1 (콤보수로 나눔)
  oppClassWeightNorm: Float32Array; // 169
  classEquity: Float32Array; // 169
  classEqr: Float32Array;
  classHandEv: Float32Array;
  combos: ComboView[];
  rangeEv: number;
  rangeEquity: number;
  oppRangeEquity: number;
}
export interface ChanceView {
  kind: "chance";
  street: number;
  board: number[];
  pot: number;
  invested: [number, number];
  liveCards: number[];
  allin: boolean;
}
export interface TerminalView {
  kind: "terminal";
  type: "fold" | "showdown";
  board: number[];
  pot: number;
  invested: [number, number];
  folder: -1 | 0 | 1;
  evOop: number; // 여기서의 양쪽 기대 팟 지분 (reach 기준)
  evIp: number;
}
export type NodeView = DecisionView | ChanceView | TerminalView;

export interface HistoryItem {
  kind: "action" | "card";
  label: string;
  code: string;
  player?: 0 | 1;
  street: number;
  potAfter: number;
}

export interface SolveProgress {
  iterations: number;
  exploitabilityPct: number;
  elapsedMs: number;
  evOop: number;
  evIp: number;
  done: boolean;
  reason?: string;
}

export interface EstimateResult {
  decisionNodes: number;
  actionSlots: number;
  hands: number;
  bytes: number;
  estSecondsPerIter: number;
}

export type Req =
  | { type: "estimate"; config: TreeConfig; oop: Float32Array; ip: Float32Array }
  | { type: "solve.start"; config: TreeConfig; oop: Float32Array; ip: Float32Array; targetExploitPct: number; maxIters: number; maxMs: number; batch: number }
  | { type: "solve.continue"; targetExploitPct: number; maxIters: number; maxMs: number; batch: number }
  | { type: "solve.stop" }
  | { type: "spot.load"; config: TreeConfig; oop: Float32Array; ip: Float32Array; strategy: Float32Array; iterations: number }
  | { type: "spot.export" }
  | { type: "node.view"; path: Array<{ kind: "action"; index: number } | { kind: "card"; card: number }> }
  | { type: "equity"; oop: Float32Array; ip: Float32Array; board: number[]; samples: number }
  | { type: "handVsHand"; h0: [number, number]; h1: [number, number]; board: number[]; samples: number }
  | { type: "preflop.matrix"; samplesPerPair: number }
  | { type: "preflop.solve"; config: PreflopConfig; matrix: Float32Array; iters: number; batch: number }
  | { type: "preflop.view"; path: number[] };

export interface PfView {
  player: 0 | 1;
  pot: number;
  invested: [number, number];
  toCall: number;
  actions: ActionView[];
  classFreq: Float32Array; // 169*A
  classEv: Float32Array;
  classWeightNorm: Float32Array; // 169, 행동 플레이어 reach/콤보수
  oppClassWeightNorm: Float32Array;
  isTerminal: boolean;
  terminalType?: "fold" | "showdown";
}

export type Res =
  | { type: "progress"; data: SolveProgress }
  | { type: "result"; data: unknown }
  | { type: "error"; message: string };

export interface Envelope<T> {
  id: number;
  payload: T;
}
