// 메인 스레드 ↔ 솔버 워커 메시지 타입
import type { TreeConfig } from "../engine/tree";
import type { MultiTreeConfig } from "../engine/multi";
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
  weights: number[]; // 플레이어별 reach
  strategy: number[]; // A
  ev: number[]; // A
  equity: number;
  eqr: number;
  handEv: number;
}

export interface DecisionView {
  kind: "decision";
  players: number;
  player: number;
  active: boolean[];
  allin: boolean[];
  street: number;
  board: number[];
  pot: number;
  invested: number[];
  toCall: number;
  actions: ActionView[];
  classFreq: Float32Array; // 169*A
  classEv: Float32Array; // 169*A
  classWeightNorm: Float32Array; // 169 행동 플레이어 (0~1)
  seatWeightNorm: Float32Array[]; // 플레이어별 169 (0~1)
  classEquity: Float32Array; // 169
  classEqr: Float32Array;
  classHandEv: Float32Array;
  combos: ComboView[];
  rangeEv: number;
  rangeEquity: number;
}
export interface ChanceView {
  kind: "chance";
  players: number;
  street: number;
  board: number[];
  pot: number;
  invested: number[];
  active: boolean[];
  liveCards: number[];
  allin: boolean;
}
export interface TerminalView {
  kind: "terminal";
  players: number;
  type: "fold" | "showdown";
  board: number[];
  pot: number;
  invested: number[];
  active: boolean[];
  winner: number; // fold 터미널 승자, 아니면 -1
  shares: number[]; // 플레이어별 기대 팟 지분
}
export type NodeView = DecisionView | ChanceView | TerminalView;

export interface SolveProgress {
  iterations: number;
  exploitabilityPct: number;
  elapsedMs: number;
  ev: number[];
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

export interface SpotInput {
  players: number;
  config?: TreeConfig; // players === 2
  mconfig?: MultiTreeConfig; // players > 2
  ranges: Float32Array[];
}

export type PathStep = { kind: "action"; index: number } | { kind: "card"; card: number };

export type Req =
  | ({ type: "estimate" } & SpotInput)
  | ({ type: "solve.start"; targetExploitPct: number; maxIters: number; maxMs: number; batch: number } & SpotInput)
  | { type: "solve.continue"; targetExploitPct: number; maxIters: number; maxMs: number; batch: number }
  | { type: "solve.stop" }
  | ({ type: "spot.load"; strategy: Float32Array; iterations: number } & SpotInput)
  | { type: "spot.export" }
  | { type: "node.view"; path: PathStep[] }
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
  classFreq: Float32Array;
  classEv: Float32Array;
  classWeightNorm: Float32Array;
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
