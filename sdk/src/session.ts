// 커스텀 포스트플랍 솔브 세션 (헤즈업). 단일 스레드와 병렬(하위 워커)을 같은 인터페이스로 쓴다.
import { COMBO_CARDS, COMBO_CLASS, NUM_CLASSES, classLabel, comboToString, parseCards } from "../../src/engine/cards";
import { parseRange, type RangeWeights } from "../../src/engine/range";
import { buildTree, type SizingSet, type StreetSizings, type TreeConfig } from "../../src/engine/tree";
import { PostflopSolver, type PathStep, type SolverMetrics } from "../../src/engine/solver";
import { ParallelPostflopSolver, nodeInfo, type ParallelView, type SubPort } from "../../src/engine/parallel";

export type SizePreset = "simple" | "standard" | "complex";

/**
 * 프리셋 사이즈 (팟 대비 %).
 * - simple: 공개 라이브러리 트리와 같다 (플랍 33%, 턴 66%, 리버 75%). 플랍 1000핸드 기준 약 1.4GB
 * - standard: 플랍 IP 33·75%, 턴 66%, 리버 75%. 플랍 1000핸드 기준 약 2GB
 * - complex: 스트리트마다 2~3사이즈 + 레이즈. 턴·리버 스팟용 (플랍 전체는 수십 GB)
 */
export function presetSizings(preset: SizePreset): { oop: StreetSizings; ip: StreetSizings; maxRaisesByStreet: [number, number, number] } {
  const s = (bet: number[], raise: number[], donk?: number[]): SizingSet => ({ bet, raise, donk });
  if (preset === "simple")
    return {
      oop: { flop: s([], [60]), turn: s([66], []), river: s([75], []) },
      ip: { flop: s([33], [60]), turn: s([66], []), river: s([75], []) },
      maxRaisesByStreet: [2, 1, 1]
    };
  if (preset === "standard")
    return {
      oop: { flop: s([], [60]), turn: s([66], []), river: s([75], []) },
      ip: { flop: s([33, 75], [60]), turn: s([66], []), river: s([75], []) },
      maxRaisesByStreet: [2, 1, 1]
    };
  return {
    oop: { flop: s([25, 50], [50, 100]), turn: s([33, 66, 125], [60]), river: s([33, 75, 150], [60]) },
    ip: { flop: s([25, 50, 100], [50, 100]), turn: s([33, 66, 125], [60]), river: s([33, 75, 150], [60]) },
    maxRaisesByStreet: [3, 2, 2]
  };
}

export interface SolveSpec {
  /** 보드 3~5장 ("Ks7d2c" 또는 카드 번호 배열) */
  board: string | number[];
  /** 시작 팟 (bb) */
  pot: number;
  /** 유효 스택 (bb, 이 스트리트부터 더 넣을 수 있는 금액) */
  stack: number;
  /** OOP·IP 레인지 ("AA,KK,AKs,..." 또는 1326 가중치) */
  oopRange: string | RangeWeights;
  ipRange: string | RangeWeights;
  /** 사이즈 프리셋 (기본 simple). sizes 를 주면 그 값이 우선 */
  preset?: SizePreset;
  sizes?: { oop?: StreetSizings; ip?: StreetSizings };
  maxRaisesByStreet?: [number, number, number];
  /** 남은 스택의 이 % 이상인 벳은 올인으로 (기본 67) */
  allinThresholdPct?: number;
  /** 사이즈 목록에 올인을 항상 추가 (기본 false) */
  includeAllin?: boolean;
  /** OOP 동크 벳 허용 (기본 true, OOP 플랍 bet 이 비어 있으면 동크 없음) */
  allowDonk?: boolean;
  rakePct?: number;
  rakeCap?: number;
  /** 병렬 하위 솔버 통로 (browserSubPorts / nodeSubPorts). 없으면 단일 스레드 */
  ports?: SubPort[];
  /** 추정 메모리가 이 값(MB)을 넘으면 솔브 전에 오류 (기본 2048). Node·서버에서는 늘려도 된다 */
  memoryLimitMb?: number;
}

export interface RunOptions {
  /** 목표 익스플로잇어빌리티 (팟 대비 %, 기본 0.3) */
  targetExploitability?: number;
  /** 최대 반복 (기본 300) */
  maxIterations?: number;
  /** 최대 시간 (ms) */
  maxMs?: number;
  /** 지표를 재는 간격 (반복, 기본 10) */
  checkEvery?: number;
  onProgress?: (m: SolverMetrics) => void;
  signal?: AbortSignal;
}

export interface SolveSession {
  readonly config: TreeConfig;
  /** 핸드 슬롯 수 (보드와 겹치지 않고 어느 한쪽 레인지에 있는 콤보) */
  readonly hands: number;
  /** 슬롯 → 1326 콤보 번호. comboToString(combos[h]) 로 카드 이름 */
  readonly combos: Int32Array;
  readonly threads: number;
  readonly iterations: number;
  /** 목표에 닿거나 상한에 걸릴 때까지 푼다. 이어서 다시 부를 수 있다 */
  run(opts?: RunOptions): Promise<SolverMetrics>;
  metrics(): Promise<SolverMetrics>;
  /** 노드 보기: 노드 요약, 양쪽 reach, (결정 노드면) 핸드별 전략·EV·에퀴티·EQR */
  view(path: PathStep[]): Promise<ParallelView>;
  /**
   * 노드 잠금. strategy 는 액션별 빈도 배열(레인지 전체에 같게) 또는 슬롯 기준 A·n 배열.
   * allRunouts: 같은 노드의 모든 턴·리버 카드에 적용. 잠근 뒤 run 을 다시 부르면 나머지가 맞춰 바뀐다
   */
  lock(path: PathStep[], strategy: number[] | Float32Array, allRunouts?: boolean): Promise<void>;
  unlock(path: PathStep[], allRunouts?: boolean): Promise<boolean>;
  clearLocks(): Promise<void>;
  /** 정규화 전략 (저장용). importStrategy 로 다시 불러 보기만 할 수 있다 */
  exportStrategy(): Promise<Float32Array>;
  importStrategy(data: Float32Array, iterations: number): Promise<void>;
  close(): void;
}

/** 스펙 → 트리 설정 */
export function treeConfigOf(spec: SolveSpec): TreeConfig {
  const board = typeof spec.board === "string" ? parseCards(spec.board) : spec.board.slice();
  const pre = presetSizings(spec.preset ?? "simple");
  return {
    board,
    pot: spec.pot,
    effStack: spec.stack,
    rakePct: spec.rakePct ?? 0,
    rakeCap: spec.rakeCap ?? 0,
    oop: spec.sizes?.oop ?? pre.oop,
    ip: spec.sizes?.ip ?? pre.ip,
    allinThresholdPct: spec.allinThresholdPct ?? 67,
    maxRaisesPerStreet: Math.max(...(spec.maxRaisesByStreet ?? pre.maxRaisesByStreet)),
    maxRaisesByStreet: spec.maxRaisesByStreet ?? pre.maxRaisesByStreet,
    allowDonk: spec.allowDonk ?? true,
    includeAllin: spec.includeAllin ?? false
  };
}

/** 메모리·크기 추정 (바이트는 후회+전략 누적 배열 합) */
export function estimateSolve(spec: SolveSpec): { decisionNodes: number; hands: number; bytes: number } {
  const cfg = treeConfigOf(spec);
  const tree = buildTree(cfg);
  const w0 = typeof spec.oopRange === "string" ? parseRange(spec.oopRange) : spec.oopRange;
  const w1 = typeof spec.ipRange === "string" ? parseRange(spec.ipRange) : spec.ipRange;
  const dead = new Set(cfg.board);
  let hands = 0;
  for (let i = 0; i < 1326; i++) if ((w0[i] > 0 || w1[i] > 0) && !comboDead(i, dead)) hands++;
  return { decisionNodes: tree.decisionNodes.length, hands, bytes: PostflopSolver.estimateBytes(tree, hands) };
}

function comboDead(i: number, dead: Set<number>): boolean {
  const [a, b] = COMBO_CARDS[i];
  return dead.has(a) || dead.has(b);
}

function toSlotStrategy(strategy: number[] | Float32Array, A: number, n: number): Float32Array {
  if (strategy instanceof Float32Array) return strategy;
  if (strategy.length !== A) throw new Error(`액션 빈도는 ${A}개여야 합니다`);
  const out = new Float32Array(A * n);
  for (let a = 0; a < A; a++) out.fill(strategy[a], a * n, (a + 1) * n);
  return out;
}

/** 커스텀 솔브 세션을 만든다 */
export async function createSolve(spec: SolveSpec): Promise<SolveSession> {
  const est = estimateSolve(spec);
  const limit = spec.memoryLimitMb ?? 2048;
  if (est.bytes / 1048576 > limit) {
    spec.ports?.forEach((p) => p.close());
    throw new Error(`이 트리는 약 ${(est.bytes / 1048576).toFixed(0)}MB가 필요해 상한 ${limit}MB를 넘습니다 (결정 노드 ${est.decisionNodes}개, 핸드 ${est.hands}개). 프리셋을 simple 로 낮추거나, 레인지를 좁히거나, 턴·리버에서 풀거나, memoryLimitMb 를 늘리세요.`);
  }
  const cfg = treeConfigOf(spec);
  const w0 = typeof spec.oopRange === "string" ? parseRange(spec.oopRange) : spec.oopRange;
  const w1 = typeof spec.ipRange === "string" ? parseRange(spec.ipRange) : spec.ipRange;
  const hasChance = cfg.board.length < 5;
  if (spec.ports && spec.ports.length > 0 && hasChance) {
    const par = await ParallelPostflopSolver.create(cfg, w0, w1, spec.ports);
    return new ParallelSession(cfg, par);
  }
  spec.ports?.forEach((p) => p.close());
  return new LocalSession(cfg, new PostflopSolver(buildTree(cfg), w0, w1));
}

abstract class BaseSession implements SolveSession {
  constructor(readonly config: TreeConfig) {}
  abstract readonly hands: number;
  abstract readonly combos: Int32Array;
  abstract readonly threads: number;
  abstract readonly iterations: number;
  protected abstract stepN(k: number): Promise<void>;
  abstract metrics(): Promise<SolverMetrics>;
  abstract view(path: PathStep[]): Promise<ParallelView>;
  protected abstract lockRaw(path: PathStep[], s: Float32Array, allRunouts: boolean): Promise<void>;
  abstract unlock(path: PathStep[], allRunouts?: boolean): Promise<boolean>;
  abstract clearLocks(): Promise<void>;
  abstract exportStrategy(): Promise<Float32Array>;
  abstract importStrategy(data: Float32Array, iterations: number): Promise<void>;
  abstract close(): void;

  async run(opts: RunOptions = {}): Promise<SolverMetrics> {
    const target = opts.targetExploitability ?? 0.3;
    const maxIt = opts.maxIterations ?? 300;
    const every = Math.max(1, opts.checkEvery ?? 10);
    const t0 = Date.now();
    let m = await this.metrics();
    opts.onProgress?.(m);
    while (this.iterations < maxIt && m.exploitabilityPct > target) {
      if (opts.signal?.aborted) break;
      if (opts.maxMs !== undefined && Date.now() - t0 > opts.maxMs) break;
      await this.stepN(Math.min(every, maxIt - this.iterations));
      m = await this.metrics();
      opts.onProgress?.(m);
    }
    return m;
  }

  async lock(path: PathStep[], strategy: number[] | Float32Array, allRunouts = false): Promise<void> {
    const v = await this.view(path);
    if (v.node.kind !== "decision") throw new Error("결정 노드만 잠글 수 있습니다");
    await this.lockRaw(path, toSlotStrategy(strategy, v.node.actions!.length, this.hands), allRunouts);
  }
}

class LocalSession extends BaseSession {
  constructor(config: TreeConfig, private s: PostflopSolver) {
    super(config);
  }
  get hands() {
    return this.s.hands.n;
  }
  get combos() {
    return this.s.hands.combo;
  }
  get threads() {
    return 1;
  }
  get iterations() {
    return this.s.iterationCount;
  }
  protected async stepN(k: number) {
    this.s.step(k);
  }
  async metrics() {
    return this.s.metrics();
  }
  async view(path: PathStep[]): Promise<ParallelView> {
    const { node, ctx, reach } = this.s.walk(path);
    const v: ParallelView = { node: nodeInfo(node, ctx.board), reach };
    if (node.kind === "decision") {
      const a = this.s.analyzeDecision(node, ctx, reach);
      v.analysis = { strategy: a.strategy, ev: a.ev, handEv: a.handEv, equity: a.equity, eqr: a.eqr, reachP: a.reachP, reachO: a.reachO, S: a.S, actionFreq: a.actionFreq, actionEv: a.actionEv, rangeEv: a.rangeEv, rangeEquity: a.rangeEquity };
    }
    return v;
  }
  protected async lockRaw(path: PathStep[], s: Float32Array, allRunouts: boolean) {
    this.s.lockNode(path, s, allRunouts);
  }
  async unlock(path: PathStep[], allRunouts = false) {
    return this.s.unlockNode(path, allRunouts);
  }
  async clearLocks() {
    this.s.clearLocks();
  }
  async exportStrategy() {
    return this.s.serializeStrategy();
  }
  async importStrategy(data: Float32Array, iterations: number) {
    this.s.loadStrategy(data, iterations);
  }
  close() {}
}

class ParallelSession extends BaseSession {
  constructor(config: TreeConfig, private p: ParallelPostflopSolver) {
    super(config);
  }
  get hands() {
    return this.p.hands.n;
  }
  get combos() {
    return this.p.hands.combo;
  }
  get threads() {
    return this.p.threads;
  }
  get iterations() {
    return this.p.iterationCount;
  }
  protected stepN(k: number) {
    return this.p.step(k);
  }
  metrics() {
    return this.p.metrics();
  }
  view(path: PathStep[]) {
    return this.p.view(path);
  }
  protected lockRaw(path: PathStep[], s: Float32Array, allRunouts: boolean) {
    return this.p.lockNode(path, s, allRunouts);
  }
  unlock(path: PathStep[], allRunouts = false) {
    return this.p.unlockNode(path, allRunouts);
  }
  clearLocks() {
    return this.p.clearLocks();
  }
  exportStrategy() {
    return this.p.exportStrategy();
  }
  importStrategy(data: Float32Array, iterations: number) {
    return this.p.importStrategy(data, iterations);
  }
  close() {
    this.p.close();
  }
}

export interface HandRow {
  /** 콤보 이름 (예: AsKd) 또는 169 클래스 이름 (byClass) */
  hand: string;
  /** 행동 플레이어의 도달 가중치 (콤보 0~1, 클래스는 평균) */
  weight: number;
  freq: number[];
  ev: number[];
  equity: number;
  eqr: number;
}

/** 결정 노드 분석을 콤보별 행으로 (행동 플레이어 레인지에 있는 콤보만) */
export function byCombo(view: ParallelView, combos: Int32Array): HandRow[] {
  const a = view.analysis;
  if (!a || !view.node.actions) return [];
  const A = view.node.actions.length;
  const n = combos.length;
  const rows: HandRow[] = [];
  for (let h = 0; h < n; h++) {
    const w = a.reachP[h];
    if (!(w > 0)) continue;
    rows.push({ hand: comboToString(combos[h]), weight: w, freq: Array.from({ length: A }, (_, k) => a.strategy[k * n + h]), ev: Array.from({ length: A }, (_, k) => a.ev[k * n + h]), equity: a.equity[h], eqr: a.eqr[h] });
  }
  return rows;
}

/** 결정 노드 분석을 169 클래스별로 묶는다 (도달 가중치·상대 질량 가중 평균) — 13×13 그리드용 */
export function byClass(view: ParallelView, combos: Int32Array): HandRow[] {
  const a = view.analysis;
  if (!a || !view.node.actions) return [];
  const A = view.node.actions.length;
  const n = combos.length;
  const W = new Float64Array(NUM_CLASSES);
  const cnt = new Float64Array(NUM_CLASSES);
  const F = new Float64Array(NUM_CLASSES * A);
  const E = new Float64Array(NUM_CLASSES * A);
  const EQ = new Float64Array(NUM_CLASSES);
  const EQR = new Float64Array(NUM_CLASSES);
  for (let h = 0; h < n; h++) {
    const c = COMBO_CLASS[combos[h]];
    const w = a.reachP[h] * a.S[h];
    cnt[c] += a.reachP[h];
    if (!(w > 0)) continue;
    W[c] += w;
    EQ[c] += w * a.equity[h];
    EQR[c] += w * a.eqr[h];
    for (let k = 0; k < A; k++) {
      F[c * A + k] += w * a.strategy[k * n + h];
      E[c * A + k] += w * a.strategy[k * n + h] * a.ev[k * n + h];
    }
  }
  const rows: HandRow[] = [];
  for (let c = 0; c < NUM_CLASSES; c++) {
    if (!(W[c] > 0)) continue;
    const comboN = classLabel(c).length === 2 ? 6 : classLabel(c).endsWith("s") ? 4 : 12;
    rows.push({
      hand: classLabel(c),
      weight: cnt[c] / comboN,
      freq: Array.from({ length: A }, (_, k) => F[c * A + k] / W[c]),
      ev: Array.from({ length: A }, (_, k) => (F[c * A + k] > 0 ? E[c * A + k] / F[c * A + k] : 0)),
      equity: EQ[c] / W[c],
      eqr: EQR[c] / W[c]
    });
  }
  return rows;
}

