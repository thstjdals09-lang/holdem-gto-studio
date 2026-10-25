// 벡터화 Discounted CFR 포스트플랍 솔버 (HU). 핸드 단위 reach 벡터, 카드 제거를 정확히 반영한 쇼다운 스윕.
import { COMBO_CARDS, NUM_COMBOS } from "./cards";
import { evaluate } from "./evaluator";
import type { RangeWeights } from "./range";
import type { ChanceNode, DecisionNode, GameTree, TerminalNode, TreeNode } from "./tree";

export interface HandSet {
  n: number;
  combo: Int32Array; // 슬롯 → 1326 콤보 인덱스
  a: Uint8Array; // 카드 1
  b: Uint8Array; // 카드 2
  slotOfCombo: Int32Array; // 1326 → 슬롯 (-1 없음)
  handsWithCard: Int32Array[]; // 카드별 슬롯 목록
}

export function buildHandSet(board: number[], w0: RangeWeights, w1: RangeWeights): HandSet {
  const dead = new Set(board);
  const combo: number[] = [];
  const slotOfCombo = new Int32Array(NUM_COMBOS).fill(-1);
  for (let i = 0; i < NUM_COMBOS; i++) {
    if (w0[i] <= 0 && w1[i] <= 0) continue;
    const [a, b] = COMBO_CARDS[i];
    if (dead.has(a) || dead.has(b)) continue;
    slotOfCombo[i] = combo.length;
    combo.push(i);
  }
  const n = combo.length;
  const ca = new Uint8Array(n);
  const cb = new Uint8Array(n);
  const lists: number[][] = Array.from({ length: 52 }, () => []);
  for (let s = 0; s < n; s++) {
    const [a, b] = COMBO_CARDS[combo[s]];
    ca[s] = a;
    cb[s] = b;
    lists[a].push(s);
    lists[b].push(s);
  }
  return {
    n,
    combo: Int32Array.from(combo),
    a: ca,
    b: cb,
    slotOfCombo,
    handsWithCard: lists.map((l) => Int32Array.from(l))
  };
}

interface BoardEval {
  strength: Int32Array; // 슬롯별 강도 (-1 = 보드와 충돌)
  order: Int32Array; // 살아있는 슬롯을 강도 오름차순 정렬
  bounds: Int32Array; // 같은 강도 그룹의 시작 위치들 + 끝(m)
}

export type PathStep = { kind: "action"; index: number } | { kind: "card"; card: number };

export interface Ctx {
  board: number[]; // 현재 보드 (시작 보드 + 런아웃)
  tIdx: number; // 첫 번째 런아웃 카드 인덱스 (시작 스트리트 다음 카드, -1 없음)
  rIdx: number; // 두 번째 런아웃 카드 인덱스
}

export interface SolverMetrics {
  iterations: number;
  exploitabilityPct: number; // 팟 대비 %
  evOop: number; // 평균 전략 기대값 (칩, 루트 기준 순이익)
  evIp: number;
  brOop: number;
  brIp: number;
  elapsedMs: number;
}

export interface DecisionAnalysis {
  node: DecisionNode;
  strategy: Float32Array; // A*nH 평균 전략
  ev: Float32Array; // A*nH 액션별 EV (여기서부터의 순이익, 칩)
  handEv: Float32Array; // nH 전략 가중 EV
  equity: Float32Array; // nH 상대 레인지 대비 에퀴티 (0~1)
  eqr: Float32Array; // nH 에퀴티 실현 (EV 팟지분 / (eq * pot))
  reachP: Float32Array; // 행동하는 플레이어의 reach (가중치)
  reachO: Float32Array; // 상대 reach
  S: Float32Array; // 슬롯별 충돌 제외 상대 reach 합
  actionFreq: number[]; // 레인지 전체 액션 빈도
  actionEv: number[]; // 레인지 전체 액션 EV
  rangeEv: number; // 레인지 전체 EV (여기서부터)
  rangeEquity: number;
}

const ALPHA = 1.5;
const BETA = 0;
const GAMMA = 2;

export class PostflopSolver {
  readonly tree: GameTree;
  readonly hands: HandSet;
  readonly w: [Float32Array, Float32Array]; // 슬롯별 초기 가중치
  readonly remaining: number[]; // 시작 보드에 없는 카드
  readonly cardIdx: Int8Array; // 카드 → 런아웃 인덱스
  readonly R: number;
  readonly mult: Int32Array; // 결정 노드별 런아웃 배수 (1, R1, R1*R)
  /** 병렬용: 첫 런아웃 카드 인덱스 → 이 솔버의 로컬 슬롯 (-1 = 맡지 않음). null 이면 전부 맡음 */
  readonly firstLocal: Int16Array | null;
  /** 첫 런아웃 단계에서 이 솔버가 맡은 카드 수 (전부면 R) */
  readonly R1: number;
  private level: Int8Array; // 결정 노드의 런아웃 단계 0/1/2
  /** 병렬 조정자용: 첫 찬스 단계에서 하위 트리 대신 호출된다 */
  chanceHook: ((ch: ChanceNode, p: 0 | 1, rP: Float32Array | null, rO: Float32Array, out: Float32Array, mode: "train" | "avg" | "br") => void) | null = null;
  /** true 면 학습 순회에서 후회·전략 누적을 갱신하지 않는다 (병렬 조정자의 수집 단계) */
  dry = false;
  regret: Float32Array[];
  stratSum: Float32Array[];
  private pool: Float32Array[][] = [];
  private iterations = 0;
  private elapsedMs = 0;
  private Z: number; // Σ_{h,o 비충돌} w0[h] w1[o]
  private totalCard = new Float64Array(52);
  private groupCard = new Float64Array(52);
  private cumCard = new Float64Array(52);
  private sortBuf: Int32Array;

  /**
   * @param opts.firstCards 병렬 하위 솔버용: 첫 런아웃(플랍 시작이면 턴) 카드 중 이 솔버가 맡을 카드.
   *   주면 그 카드의 하위 트리만 메모리를 잡고 chancePartial 로만 순회한다. 빈 배열이면 첫 스트리트만 (조정자).
   */
  constructor(tree: GameTree, w0: RangeWeights, w1: RangeWeights, opts?: { firstCards?: number[] }) {
    this.tree = tree;
    const board = tree.config.board;
    this.hands = buildHandSet(board, w0, w1);
    const n = this.hands.n;
    if (n === 0) throw new Error("레인지에 보드와 충돌하지 않는 콤보가 없습니다");
    const sw0 = new Float32Array(n);
    const sw1 = new Float32Array(n);
    for (let s = 0; s < n; s++) {
      sw0[s] = w0[this.hands.combo[s]];
      sw1[s] = w1[this.hands.combo[s]];
    }
    this.w = [sw0, sw1];
    const dead = new Set(board);
    this.remaining = [];
    this.cardIdx = new Int8Array(52).fill(-1);
    for (let c = 0; c < 52; c++) {
      if (!dead.has(c)) {
        this.cardIdx[c] = this.remaining.length;
        this.remaining.push(c);
      }
    }
    this.R = this.remaining.length;
    const start = tree.startStreet;
    if (opts?.firstCards) {
      const fl = new Int16Array(this.R).fill(-1);
      opts.firstCards.forEach((c, k) => {
        if (this.cardIdx[c] < 0) throw new Error("보드에 있는 카드는 맡을 수 없습니다");
        fl[this.cardIdx[c]] = k;
      });
      this.firstLocal = fl;
      this.R1 = opts.firstCards.length;
    } else {
      this.firstLocal = null;
      this.R1 = this.R;
    }
    this.mult = new Int32Array(tree.decisionNodes.length);
    this.level = new Int8Array(tree.decisionNodes.length);
    this.regret = [];
    this.stratSum = [];
    for (const d of tree.decisionNodes) {
      const lv = Math.max(0, Math.min(2, d.street - start));
      this.level[d.id] = lv;
      const m = lv === 0 ? 1 : lv === 1 ? this.R1 : this.R1 * this.R;
      this.mult[d.id] = m;
      const size = m * d.actions.length * n;
      this.regret.push(new Float32Array(size));
      this.stratSum.push(new Float32Array(size));
    }
    this.sortBuf = new Int32Array(n);
    // Z 계산
    this.computeTotals(sw1);
    let Z = 0;
    const S = new Float32Array(n);
    this.fillS(sw1, S);
    for (let h = 0; h < n; h++) Z += sw0[h] * S[h];
    this.Z = Z;
  }

  static estimateBytes(tree: GameTree, nH: number): number {
    const R = 52 - tree.config.board.length;
    let slots = 0;
    for (const d of tree.decisionNodes) {
      let m = 1;
      if (d.street > tree.startStreet) m *= R;
      if (d.street > tree.startStreet + 1) m *= R;
      slots += m * d.actions.length;
    }
    return slots * nH * 8;
  }

  get iterationCount(): number {
    return this.iterations;
  }

  // ---------- 버퍼 풀 ----------
  private buf(depth: number, slot: number): Float32Array {
    let d = this.pool[depth];
    if (!d) {
      d = [];
      this.pool[depth] = d;
    }
    let b = d[slot];
    if (!b) {
      b = new Float32Array(this.hands.n);
      d[slot] = b;
    }
    return b;
  }

  // ---------- 보드 평가 캐시 ----------
  // 시작 보드 이후 런아웃 카드(최대 2장)의 인덱스로 배열 캐시 (정렬해 순서 무관)
  private evalCache: (BoardEval | undefined)[] = [];
  private evalKey(board: number[]): number {
    const start = this.tree.config.board.length;
    const R1 = this.R + 1;
    if (board.length === start) return 0;
    const i1 = this.cardIdx[board[start]] + 1;
    if (board.length === start + 1) return i1;
    const i2 = this.cardIdx[board[start + 1]] + 1;
    return i1 < i2 ? i1 * R1 + i2 : i2 * R1 + i1;
  }
  private evalBoard(board: number[]): BoardEval {
    const key = this.evalKey(board);
    let e = this.evalCache[key];
    if (e) return e;
    const n = this.hands.n;
    const strength = new Int32Array(n);
    const dead = new Set(board);
    const cards = new Array<number>(7);
    for (let i = 0; i < 5; i++) cards[i] = board[i];
    let live = 0;
    for (let s = 0; s < n; s++) {
      const a = this.hands.a[s];
      const b = this.hands.b[s];
      if (dead.has(a) || dead.has(b)) {
        strength[s] = -1;
        continue;
      }
      cards[5] = a;
      cards[6] = b;
      strength[s] = evaluate(cards, 7);
      this.sortBuf[live++] = s;
    }
    const order = this.sortBuf.slice(0, live);
    order.sort((x, y) => strength[x] - strength[y]);
    const b: number[] = [];
    for (let i = 0; i < live; i++) if (i === 0 || strength[order[i]] !== strength[order[i - 1]]) b.push(i);
    b.push(live);
    e = { strength, order, bounds: Int32Array.from(b) };
    this.evalCache[key] = e;
    return e;
  }

  // ---------- 터미널 ----------
  private computeTotals(ro: Float32Array): number {
    const tc = this.totalCard;
    tc.fill(0);
    let total = 0;
    const n = this.hands.n;
    for (let h = 0; h < n; h++) {
      const v = ro[h];
      if (v === 0) continue;
      total += v;
      tc[this.hands.a[h]] += v;
      tc[this.hands.b[h]] += v;
    }
    return total;
  }
  /** S[h] = 충돌 없는 상대 reach 합 */
  private fillS(ro: Float32Array, out: Float32Array): void {
    const total = this.computeTotals(ro);
    const tc = this.totalCard;
    const n = this.hands.n;
    for (let h = 0; h < n; h++) out[h] = total - tc[this.hands.a[h]] - tc[this.hands.b[h]] + ro[h];
  }

  private rakedPot(pot: number): number {
    const cfg = this.tree.config;
    if (cfg.rakePct <= 0) return pot;
    let rake = (pot * cfg.rakePct) / 100;
    if (cfg.rakeCap > 0 && rake > cfg.rakeCap) rake = cfg.rakeCap;
    return pot - rake;
  }

  private foldCFV(t: TerminalNode, p: 0 | 1, ro: Float32Array, out: Float32Array): void {
    // 레이크는 콜된 부분에만: 콜되지 않은 벳은 그대로 돌려받는다
    const unc = Math.abs(t.invested[0] - t.invested[1]);
    const potPrime = this.rakedPot(t.pot - unc) + unc;
    const u = t.folder === p ? -t.invested[p] : potPrime - t.invested[p];
    this.fillS(ro, out);
    const n = this.hands.n;
    for (let h = 0; h < n; h++) out[h] *= u;
  }

  /** 쇼다운: out[h] = potPrime*(약한 상대 reach + 0.5*동점) - I*S_h */
  private showdownCFV(board: number[], ro: Float32Array, potPrime: number, I: number, out: Float32Array): void {
    const { order, bounds } = this.evalBoard(board);
    const total = this.computeTotals(ro);
    const tc = this.totalCard;
    const cum = this.cumCard;
    const gc = this.groupCard; // 항상 0으로 유지 (그룹 처리 후 건드린 칸만 되돌림)
    cum.fill(0);
    let cumAll = 0;
    const ha = this.hands.a;
    const hb = this.hands.b;
    out.fill(0);
    const G = bounds.length - 1;
    for (let g = 0; g < G; g++) {
      const i = bounds[g];
      const j = bounds[g + 1];
      let groupSum = 0;
      for (let k = i; k < j; k++) {
        const h = order[k];
        const v = ro[h];
        groupSum += v;
        gc[ha[h]] += v;
        gc[hb[h]] += v;
      }
      for (let k = i; k < j; k++) {
        const h = order[k];
        const a = ha[h];
        const b = hb[h];
        const rv = ro[h];
        const weaker = cumAll - cum[a] - cum[b];
        const tie = groupSum - gc[a] - gc[b] + rv;
        const S = total - tc[a] - tc[b] + rv;
        out[h] = potPrime * (weaker + 0.5 * tie) - I * S;
      }
      for (let k = i; k < j; k++) {
        const h = order[k];
        const v = ro[h];
        const a = ha[h];
        const b = hb[h];
        cumAll += v;
        cum[a] += v;
        cum[b] += v;
        gc[a] = 0;
        gc[b] = 0;
      }
    }
  }

  // ---------- 런아웃 오프셋 ----------
  private offset(d: DecisionNode, ctx: Ctx): number {
    const lv = this.level[d.id];
    if (lv === 0) return 0;
    const A = d.actions.length * this.hands.n;
    const t = this.firstLocal ? this.firstLocal[ctx.tIdx] : ctx.tIdx;
    if (t < 0) throw new Error("이 솔버가 맡지 않은 런아웃입니다");
    if (lv === 1) return t * A;
    return (t * this.R + ctx.rIdx) * A;
  }

  private sumBuf: Float64Array | null = null;
  /** 후회 매칭. 액션 바깥·핸드 안쪽 순서로 연속 메모리를 읽는다 (핸드별 덧셈 순서는 액션 0..A−1 로 동일) */
  private regretMatch(reg: Float32Array, off: number, A: number, sigma: Float32Array): void {
    const n = this.hands.n;
    let sum = this.sumBuf;
    if (!sum || sum.length < n) sum = this.sumBuf = new Float64Array(n);
    // 원래 구현은 float64 누산 (let sum = 0) 이므로 Float64Array 로 같은 결과를 낸다
    sum.fill(0, 0, n);
    for (let a = 0; a < A; a++) {
      const base = off + a * n;
      for (let h = 0; h < n; h++) {
        const r = reg[base + h];
        if (r > 0) sum[h] += r;
      }
    }
    const u = 1 / A;
    for (let a = 0; a < A; a++) {
      const base = off + a * n;
      const sb = a * n;
      for (let h = 0; h < n; h++) {
        const sm = sum[h];
        if (sm > 0) {
          const r = reg[base + h];
          sigma[sb + h] = r > 0 ? r / sm : 0;
        } else sigma[sb + h] = u;
      }
    }
  }

  // ---------- 노드 잠금 ----------
  /** 결정 노드 id → (런아웃 인덱스, -1 = 모든 런아웃) → 슬롯 기준 전략 A·n */
  private locks = new Map<number, Map<number, Float32Array>>();

  private lockOf(d: DecisionNode, off: number): Float32Array | null {
    const m = this.locks.get(d.id);
    if (!m) return null;
    const k = off / (d.actions.length * this.hands.n);
    return m.get(k) ?? m.get(-1) ?? null;
  }

  /**
   * 경로가 가리키는 결정 노드의 전략을 고정한다 (노드 잠금).
   * strategy: 슬롯 기준 A·n (액션 a, 핸드 h → a·n + h), 핸드마다 합이 1이 되도록 정규화된다.
   * allRunouts: true면 같은 결정 노드의 모든 턴·리버 카드에 적용, false면 경로의 카드에만.
   * 잠금 뒤에는 step()을 더 돌려야 나머지 전략이 잠금에 맞춰 바뀐다.
   */
  lockNode(path: PathStep[], strategy: Float32Array, allRunouts = false): void {
    const { node, ctx } = this.walk(path);
    if (node.kind !== "decision") throw new Error("결정 노드만 잠글 수 있습니다");
    const A = node.actions.length;
    const n = this.hands.n;
    if (strategy.length !== A * n) throw new Error(`전략 길이는 액션 수×핸드 수(${A * n})여야 합니다`);
    const s = new Float32Array(A * n);
    for (let h = 0; h < n; h++) {
      let sum = 0;
      for (let a = 0; a < A; a++) sum += Math.max(0, strategy[a * n + h]);
      for (let a = 0; a < A; a++) s[a * n + h] = sum > 0 ? Math.max(0, strategy[a * n + h]) / sum : 1 / A;
    }
    const key = allRunouts ? -1 : this.offset(node, ctx) / (A * n);
    let m = this.locks.get(node.id);
    if (!m) {
      m = new Map();
      this.locks.set(node.id, m);
    }
    m.set(key, s);
  }

  /** 잠금 해제. allRunouts는 lockNode 때와 같은 값을 준다 */
  unlockNode(path: PathStep[], allRunouts = false): boolean {
    const { node, ctx } = this.walk(path);
    if (node.kind !== "decision") return false;
    const m = this.locks.get(node.id);
    if (!m) return false;
    const ok = m.delete(allRunouts ? -1 : this.offset(node, ctx) / (node.actions.length * this.hands.n));
    if (m.size === 0) this.locks.delete(node.id);
    return ok;
  }

  clearLocks(): void {
    this.locks.clear();
  }

  /** 잠긴 노드 수 (런아웃별 잠금 포함) */
  get lockCount(): number {
    let c = 0;
    for (const m of this.locks.values()) c += m.size;
    return c;
  }

  /** 평균 전략 (정규화). 잠긴 노드는 고정 전략 */
  avgStrategy(d: DecisionNode, ctx: Ctx, out?: Float32Array): Float32Array {
    const n = this.hands.n;
    const A = d.actions.length;
    const off = this.offset(d, ctx);
    if (this.locks.size) {
      const lk = this.lockOf(d, off);
      if (lk) {
        const res = out ?? new Float32Array(A * n);
        res.set(lk);
        return res;
      }
    }
    const ss = this.stratSum[d.id];
    const res = out ?? new Float32Array(A * n);
    for (let h = 0; h < n; h++) {
      let sum = 0;
      for (let a = 0; a < A; a++) sum += ss[off + a * n + h];
      if (sum > 0) for (let a = 0; a < A; a++) res[a * n + h] = ss[off + a * n + h] / sum;
      else for (let a = 0; a < A; a++) res[a * n + h] = 1 / A;
    }
    return res;
  }

  // ---------- CFR 순회 ----------
  private t = 0; // 현재 반복 (1부터)

  private traverse(node: TreeNode, depth: number, ctx: Ctx, p: 0 | 1, rP: Float32Array, rO: Float32Array, out: Float32Array): void {
    const n = this.hands.n;
    if (node.kind === "terminal") {
      if (node.type === "fold") this.foldCFV(node, p, rO, out);
      else this.showdownCFV(ctx.board, rO, this.rakedPot(node.pot), node.invested[p], out);
      return;
    }
    if (node.kind === "chance") {
      if (this.chanceHook && node.street - this.tree.startStreet === 1) {
        this.chanceHook(node, p, rP, rO, out, "train");
        return;
      }
      out.fill(0);
      const tmp = this.buf(depth, 0);
      const rP2 = this.buf(depth, 1);
      const rO2 = this.buf(depth, 2);
      const inBoard = new Set(ctx.board);
      let count = 0;
      for (const c of this.remaining) {
        if (inBoard.has(c)) continue;
        const child = node.children[c];
        if (!child) continue;
        count++;
        rP2.set(rP);
        rO2.set(rO);
        const hw = this.hands.handsWithCard[c];
        for (let k = 0; k < hw.length; k++) {
          rP2[hw[k]] = 0;
          rO2[hw[k]] = 0;
        }
        const ctx2 = this.nextCtx(ctx, node, c);
        this.traverse(child, depth + 1, ctx2, p, rP2, rO2, tmp);
        for (let h = 0; h < n; h++) out[h] += tmp[h];
        for (let k = 0; k < hw.length; k++) out[hw[k]] -= tmp[hw[k]];
      }
      if (count > 4) {
        // 양쪽 핸드 4장은 딜될 수 없으므로 (h,o) 쌍마다 유효한 다음 카드 수는 count-4
        const inv = 1 / (count - 4);
        for (let h = 0; h < n; h++) out[h] *= inv;
      }
      return;
    }
    // decision
    const d = node;
    const A = d.actions.length;
    const off = this.offset(d, ctx);
    const sigma = this.buf(depth, 0);
    const sigmaFull = this.sigmaBuf(depth, A);
    this.regretMatch(this.regret[d.id], off, A, sigmaFull);
    void sigma;
    const locked = this.locks.size ? this.lockOf(d, off) : null;
    if (locked) sigmaFull.set(locked);
    if (d.player === p) {
      const outs: Float32Array[] = [];
      const rP2 = this.buf(depth, 1);
      for (let a = 0; a < A; a++) {
        const oa = this.buf(depth, 3 + a);
        outs.push(oa);
        for (let h = 0; h < n; h++) rP2[h] = rP[h] * sigmaFull[a * n + h];
        this.traverse(d.children[a], depth + 1, ctx, p, rP2, rO, oa);
      }
      out.fill(0);
      for (let a = 0; a < A; a++) {
        const oa = outs[a];
        for (let h = 0; h < n; h++) out[h] += sigmaFull[a * n + h] * oa[h];
      }
      if (locked || this.dry) return; // 잠긴 노드·수집 단계는 후회·전략 누적을 갱신하지 않는다
      // DCFR 업데이트
      const t = this.t;
      const posD = Math.pow(t, ALPHA) / (Math.pow(t, ALPHA) + 1);
      const negD = BETA === 0 ? 0.5 : Math.pow(t, BETA) / (Math.pow(t, BETA) + 1);
      const stratD = Math.pow(t / (t + 1), GAMMA);
      const reg = this.regret[d.id];
      const ss = this.stratSum[d.id];
      for (let a = 0; a < A; a++) {
        const oa = outs[a];
        const base = off + a * n;
        for (let h = 0; h < n; h++) {
          let r = reg[base + h];
          r = r > 0 ? r * posD : r * negD;
          reg[base + h] = r + (oa[h] - out[h]);
          ss[base + h] = ss[base + h] * stratD + rP[h] * sigmaFull[a * n + h];
        }
      }
    } else {
      out.fill(0);
      const rO2 = this.buf(depth, 1);
      const tmp = this.buf(depth, 2);
      for (let a = 0; a < A; a++) {
        for (let h = 0; h < n; h++) rO2[h] = rO[h] * sigmaFull[a * n + h];
        this.traverse(d.children[a], depth + 1, ctx, p, rP, rO2, tmp);
        for (let h = 0; h < n; h++) out[h] += tmp[h];
      }
    }
  }

  private sigmaPool: Float32Array[][] = [];
  private sigmaBuf(depth: number, A: number): Float32Array {
    let d = this.sigmaPool[depth];
    if (!d) {
      d = [];
      this.sigmaPool[depth] = d;
    }
    let b = d[A];
    if (!b) {
      b = new Float32Array(A * this.hands.n);
      d[A] = b;
    }
    return b;
  }

  private rootCtx(): Ctx {
    return { board: this.tree.config.board.slice(), tIdx: -1, rIdx: -1 };
  }

  /** 찬스 노드에서 카드 c를 딜한 뒤의 컨텍스트. 시작 스트리트 기준 1번째/2번째 런아웃으로 인덱싱 */
  nextCtx(ctx: Ctx, node: ChanceNode, c: number): Ctx {
    const level = node.street - this.tree.startStreet; // 1 또는 2
    return {
      board: ctx.board.concat([c]),
      tIdx: level === 1 ? this.cardIdx[c] : ctx.tIdx,
      rIdx: level === 2 ? this.cardIdx[c] : ctx.rIdx
    };
  }

  /** n회 반복 (각 반복 = 양 플레이어 교대 업데이트) */
  step(iters: number): void {
    if (this.firstLocal) throw new Error("부분 솔버는 병렬 조정자를 통해서만 반복합니다");
    const t0 = performance.now();
    const n = this.hands.n;
    const out = new Float32Array(n);
    for (let i = 0; i < iters; i++) {
      this.t = this.iterations + 1;
      for (const p of [0, 1] as const) {
        const rP = this.w[p];
        const rO = this.w[p === 0 ? 1 : 0];
        this.traverse(this.tree.root, 0, this.rootCtx(), p, rP, rO, out);
      }
      this.iterations++;
    }
    this.elapsedMs += performance.now() - t0;
  }

  // ---------- 평가 (평균 전략) ----------
  /** mode 'br': p가 최적 응답, 'avg': p도 평균 전략 */
  private evalTraverse(node: TreeNode, depth: number, ctx: Ctx, p: 0 | 1, rO: Float32Array, mode: "br" | "avg", out: Float32Array): void {
    const n = this.hands.n;
    if (node.kind === "terminal") {
      if (node.type === "fold") this.foldCFV(node, p, rO, out);
      else this.showdownCFV(ctx.board, rO, this.rakedPot(node.pot), node.invested[p], out);
      return;
    }
    if (node.kind === "chance") {
      if (this.chanceHook && node.street - this.tree.startStreet === 1) {
        this.chanceHook(node, p, null, rO, out, mode);
        return;
      }
      out.fill(0);
      const tmp = this.buf(depth, 0);
      const rO2 = this.buf(depth, 2);
      const inBoard = new Set(ctx.board);
      let count = 0;
      for (const c of this.remaining) {
        if (inBoard.has(c)) continue;
        const child = node.children[c];
        if (!child) continue;
        count++;
        rO2.set(rO);
        const hw = this.hands.handsWithCard[c];
        for (let k = 0; k < hw.length; k++) rO2[hw[k]] = 0;
        const ctx2 = this.nextCtx(ctx, node, c);
        this.evalTraverse(child, depth + 1, ctx2, p, rO2, mode, tmp);
        for (let h = 0; h < n; h++) out[h] += tmp[h];
        for (let k = 0; k < hw.length; k++) out[hw[k]] -= tmp[hw[k]];
      }
      if (count > 4) {
        // 양쪽 핸드 4장은 딜될 수 없으므로 (h,o) 쌍마다 유효한 다음 카드 수는 count-4
        const inv = 1 / (count - 4);
        for (let h = 0; h < n; h++) out[h] *= inv;
      }
      return;
    }
    const d = node;
    const A = d.actions.length;
    const sigma = this.sigmaBuf(depth, A);
    this.avgStrategy(d, ctx, sigma);
    if (d.player === p) {
      const tmp = this.buf(depth, 2);
      const brHere = mode === "br" && !(this.locks.size && this.lockOf(d, this.offset(d, ctx)));
      if (brHere) out.fill(-Infinity);
      else out.fill(0);
      const rec = mode === "avg" && this.evRec && d.street <= this.evMaxStreet ? this.evRec[d.id] : null;
      let Sx: Float32Array | null = null;
      let recOff = 0;
      if (rec) {
        Sx = new Float32Array(n);
        this.fillS(rO, Sx);
        recOff = this.offset(d, ctx);
      }
      for (let a = 0; a < A; a++) {
        this.evalTraverse(d.children[a], depth + 1, ctx, p, rO, mode, tmp);
        if (rec && Sx) {
          const base = recOff + a * n;
          for (let h = 0; h < n; h++) rec[base + h] = Sx[h] > 0 ? tmp[h] / Sx[h] + d.invested[p] : 0;
        }
        if (brHere) {
          for (let h = 0; h < n; h++) if (tmp[h] > out[h]) out[h] = tmp[h];
        } else {
          for (let h = 0; h < n; h++) out[h] += sigma[a * n + h] * tmp[h];
        }
      }
    } else {
      out.fill(0);
      const rO2 = this.buf(depth, 1);
      const tmp = this.buf(depth, 2);
      for (let a = 0; a < A; a++) {
        for (let h = 0; h < n; h++) rO2[h] = rO[h] * sigma[a * n + h];
        this.evalTraverse(d.children[a], depth + 1, ctx, p, rO2, mode, tmp);
        for (let h = 0; h < n; h++) out[h] += tmp[h];
      }
    }
  }

  private rootValue(p: 0 | 1, mode: "br" | "avg"): number {
    const n = this.hands.n;
    const out = new Float32Array(n);
    const rO = this.w[p === 0 ? 1 : 0];
    this.evalTraverse(this.tree.root, 0, this.rootCtx(), p, rO, mode, out);
    let v = 0;
    const w = this.w[p];
    for (let h = 0; h < n; h++) if (w[h] > 0 && isFinite(out[h])) v += w[h] * out[h];
    return this.Z > 0 ? v / this.Z : 0;
  }

  // ---------- 병렬 지원 ----------
  /** 조정자용: 반복 t 에서 플레이어 p 의 학습 순회 1회 (첫 찬스 단계는 chanceHook 으로) */
  trainRoot(p: 0 | 1, t: number): void {
    this.t = t;
    const out = new Float32Array(this.hands.n);
    this.traverse(this.tree.root, 0, this.rootCtx(), p, this.w[p], this.w[p === 0 ? 1 : 0], out);
  }

  /** 조정자용: 반복 1회가 끝났음을 기록 */
  finishIteration(ms = 0): void {
    this.iterations++;
    this.elapsedMs += ms;
  }

  /** 조정자용: 루트 가치 (rootValue 와 같은 정규화) */
  evalRoot(p: 0 | 1, mode: "br" | "avg"): number {
    return this.rootValue(p, mode);
  }

  /** 첫 찬스 노드의 정규화 분모 (유효 카드 수 − 4) */
  chanceDenominator(ch: ChanceNode): number {
    const inBoard = new Set(this.tree.config.board);
    let count = 0;
    for (const c of this.remaining) if (!inBoard.has(c) && ch.children[c]) count++;
    return count > 4 ? count - 4 : 1;
  }

  /**
   * 하위 솔버용: 첫 찬스 노드 chIdx 에서 맡은 카드들의 CFV 합 (정규화 전).
   * mode 'train' 이면 그 하위 트리를 반복 t 로 학습한다.
   */
  chancePartial(chIdx: number, p: 0 | 1, rP: Float32Array | null, rO: Float32Array, mode: "train" | "avg" | "br", t: number): Float32Array {
    const node = this.tree.chanceNodes[chIdx];
    if (!node || node.street - this.tree.startStreet !== 1) throw new Error("첫 찬스 노드가 아닙니다");
    const n = this.hands.n;
    const out = new Float32Array(n);
    const tmp = new Float32Array(n);
    const rP2 = new Float32Array(n);
    const rO2 = new Float32Array(n);
    const ctx0 = this.rootCtx();
    if (mode === "train") this.t = t;
    for (const c of this.remaining) {
      const child = node.children[c];
      if (!child) continue;
      if (this.firstLocal && this.firstLocal[this.cardIdx[c]] < 0) continue;
      rO2.set(rO);
      if (rP) rP2.set(rP);
      const hw = this.hands.handsWithCard[c];
      for (let k = 0; k < hw.length; k++) {
        rO2[hw[k]] = 0;
        rP2[hw[k]] = 0;
      }
      const ctx2 = this.nextCtx(ctx0, node, c);
      if (mode === "train") this.traverse(child, 1, ctx2, p, rP2, rO2, tmp);
      else this.evalTraverse(child, 1, ctx2, p, rO2, mode, tmp);
      for (let h = 0; h < n; h++) out[h] += tmp[h];
      for (let k = 0; k < hw.length; k++) out[hw[k]] -= tmp[hw[k]];
    }
    return out;
  }

  /** 하위 솔버용: 첫 찬스 노드에서 card 를 딜한 뒤, 주어진 reach 로 나머지 경로를 따라간다 */
  walkFrom(chIdx: number, card: number, r0in: Float32Array, r1in: Float32Array, rest: PathStep[]): { node: TreeNode; ctx: Ctx; reach: [Float32Array, Float32Array] } {
    const n = this.hands.n;
    const ch = this.tree.chanceNodes[chIdx];
    const child = ch?.children[card];
    if (!child) throw new Error("사용할 수 없는 카드");
    const r0 = new Float32Array(r0in);
    const r1 = new Float32Array(r1in);
    const hw = this.hands.handsWithCard[card];
    for (let k = 0; k < hw.length; k++) {
      r0[hw[k]] = 0;
      r1[hw[k]] = 0;
    }
    let ctx = this.nextCtx(this.rootCtx(), ch, card);
    let node: TreeNode = child;
    for (const step of rest) {
      if (node.kind === "decision" && step.kind === "action") {
        const sigma = this.avgStrategy(node, ctx);
        const r = node.player === 0 ? r0 : r1;
        for (let h = 0; h < n; h++) r[h] *= sigma[step.index * n + h];
        node = node.children[step.index];
      } else if (node.kind === "chance" && step.kind === "card") {
        const c = step.card;
        const nx = node.children[c];
        if (!nx || ctx.board.includes(c)) throw new Error("사용할 수 없는 카드");
        const hw2 = this.hands.handsWithCard[c];
        for (let k = 0; k < hw2.length; k++) {
          r0[hw2[k]] = 0;
          r1[hw2[k]] = 0;
        }
        ctx = this.nextCtx(ctx, node, c);
        node = nx;
      } else throw new Error("경로가 트리와 맞지 않습니다");
    }
    return { node, ctx, reach: [r0, r1] };
  }

  /** 하위 솔버용: walkFrom 위치의 결정 노드를 잠그거나(unlock=false) 푼다 */
  lockAt(chIdx: number, card: number, rest: PathStep[], strategy: Float32Array | null, allRunouts: boolean, unlock = false): boolean {
    const z = new Float32Array(this.hands.n);
    const { node, ctx } = this.walkFrom(chIdx, card, z, z, rest);
    if (node.kind !== "decision") throw new Error("결정 노드만 잠글 수 있습니다");
    const A = node.actions.length;
    const n = this.hands.n;
    const key = allRunouts ? -1 : this.offset(node, ctx) / (A * n);
    let m = this.locks.get(node.id);
    if (unlock) {
      if (!m) return false;
      const ok = m.delete(key);
      if (m.size === 0) this.locks.delete(node.id);
      return ok;
    }
    if (!strategy || strategy.length !== A * n) throw new Error(`전략 길이는 액션 수×핸드 수(${A * n})여야 합니다`);
    const s2 = new Float32Array(A * n);
    for (let h = 0; h < n; h++) {
      let sum = 0;
      for (let a = 0; a < A; a++) sum += Math.max(0, strategy[a * n + h]);
      for (let a = 0; a < A; a++) s2[a * n + h] = sum > 0 ? Math.max(0, strategy[a * n + h]) / sum : 1 / A;
    }
    if (!m) {
      m = new Map();
      this.locks.set(node.id, m);
    }
    m.set(key, s2);
    return true;
  }

  /** 맡은 첫 런아웃 카드 목록 (전부면 null) */
  get ownedFirstCards(): number[] | null {
    if (!this.firstLocal) return null;
    const out: number[] = new Array(this.R1);
    for (let t = 0; t < this.R; t++) if (this.firstLocal[t] >= 0) out[this.firstLocal[t]] = this.remaining[t];
    return out;
  }

  /** 루트에서 플레이어 p의 핸드별 EV(평균 전략, 루트 기준 순이익)와 에퀴티 — 실현율 측정용 */
  rootHandStats(p: 0 | 1): { ev: Float32Array; S: Float32Array; equity: Float32Array } {
    const n = this.hands.n;
    const out = new Float32Array(n);
    const rO = this.w[p === 0 ? 1 : 0];
    const ctx = this.rootCtx();
    this.evalTraverse(this.tree.root, 0, ctx, p, rO, "avg", out);
    this.computeTotals(rO);
    const S = new Float32Array(n);
    this.fillS(rO, S);
    const ev = new Float32Array(n);
    for (let h = 0; h < n; h++) ev[h] = S[h] > 0 ? out[h] / S[h] : 0;
    return { ev, S, equity: this.equityVector(ctx, rO) };
  }

  metrics(): SolverMetrics {
    const brOop = this.rootValue(0, "br");
    const brIp = this.rootValue(1, "br");
    const evOop = this.rootValue(0, "avg");
    const evIp = this.rootValue(1, "avg");
    const pot = this.tree.config.pot;
    const expl = ((brOop - evOop + (brIp - evIp)) / 2 / pot) * 100;
    return { iterations: this.iterations, exploitabilityPct: expl, evOop, evIp, brOop, brIp, elapsedMs: this.elapsedMs };
  }

  // ---------- 탐색/분석 ----------
  /** 경로를 따라가며 노드·컨텍스트·양쪽 reach(평균 전략 반영) 계산 */
  walk(path: PathStep[]): { node: TreeNode; ctx: Ctx; reach: [Float32Array, Float32Array]; history: Array<{ node: TreeNode; step: PathStep }> } {
    const n = this.hands.n;
    let node: TreeNode = this.tree.root;
    let ctx = this.rootCtx();
    const r0 = new Float32Array(this.w[0]);
    const r1 = new Float32Array(this.w[1]);
    const history: Array<{ node: TreeNode; step: PathStep }> = [];
    for (const step of path) {
      history.push({ node, step });
      if (node.kind === "decision" && step.kind === "action") {
        const d = node;
        const sigma = this.avgStrategy(d, ctx);
        const r = d.player === 0 ? r0 : r1;
        for (let h = 0; h < n; h++) r[h] *= sigma[step.index * n + h];
        node = d.children[step.index];
      } else if (node.kind === "chance" && step.kind === "card") {
        const c = step.card;
        const child = node.children[c];
        if (!child || ctx.board.includes(c)) throw new Error("사용할 수 없는 카드");
        const hw = this.hands.handsWithCard[c];
        for (let k = 0; k < hw.length; k++) {
          r0[hw[k]] = 0;
          r1[hw[k]] = 0;
        }
        ctx = this.nextCtx(ctx, node, c);
        node = child;
      } else {
        throw new Error("경로가 트리와 맞지 않습니다");
      }
    }
    return { node, ctx, reach: [r0, r1], history };
  }

  /** 노드에서 상대 reach 대비 각 핸드의 에퀴티 (런아웃 평균) */
  equityVector(ctx: Ctx, rO: Float32Array): Float32Array {
    const n = this.hands.n;
    const num = new Float64Array(n);
    const den = new Float64Array(n);
    const tmp = new Float32Array(n);
    const S = new Float32Array(n);
    const inBoard = new Set(ctx.board);
    const rO2 = new Float32Array(n);
    const rO3 = new Float32Array(n);
    const runouts: number[][] = [];
    const need = 5 - ctx.board.length;
    if (need === 0) runouts.push([]);
    else if (need === 1) {
      for (const c of this.remaining) if (!inBoard.has(c)) runouts.push([c]);
    } else {
      const live = this.remaining.filter((c) => !inBoard.has(c));
      for (let i = 0; i < live.length; i++) for (let j = i + 1; j < live.length; j++) runouts.push([live[i], live[j]]);
    }
    for (const ro of runouts) {
      rO2.set(rO);
      for (const c of ro) {
        const hw = this.hands.handsWithCard[c];
        for (let k = 0; k < hw.length; k++) rO2[hw[k]] = 0;
      }
      const board = ctx.board.concat(ro);
      this.showdownCFV(board, rO2, 1, 0, tmp);
      this.fillS(rO2, S);
      const dead = new Set(ro);
      for (let h = 0; h < n; h++) {
        if (dead.has(this.hands.a[h]) || dead.has(this.hands.b[h])) continue;
        num[h] += tmp[h];
        den[h] += S[h];
      }
    }
    void rO3;
    const out = new Float32Array(n);
    for (let h = 0; h < n; h++) out[h] = den[h] > 0 ? num[h] / den[h] : 0;
    return out;
  }

  analyzeDecision(d: DecisionNode, ctx: Ctx, reach: [Float32Array, Float32Array]): DecisionAnalysis {
    const n = this.hands.n;
    const A = d.actions.length;
    const p = d.player;
    const rP = reach[p];
    const rO = reach[p === 0 ? 1 : 0];
    const strategy = this.avgStrategy(d, ctx);
    const ev = new Float32Array(A * n);
    const S = new Float32Array(n);
    this.fillS(rO, S);
    const tmp = new Float32Array(n);
    for (let a = 0; a < A; a++) {
      this.evalTraverse(d.children[a], 1, ctx, p, rO, "avg", tmp);
      for (let h = 0; h < n; h++) ev[a * n + h] = S[h] > 0 ? tmp[h] / S[h] + d.invested[p] : 0;
    }
    const handEv = new Float32Array(n);
    for (let h = 0; h < n; h++) {
      let v = 0;
      for (let a = 0; a < A; a++) v += strategy[a * n + h] * ev[a * n + h];
      handEv[h] = v;
    }
    const equity = this.equityVector(ctx, rO);
    const eqr = new Float32Array(n);
    const pot = d.pot;
    for (let h = 0; h < n; h++) {
      // handEv는 "여기서부터" EV(폴드=0, 체크다운 승리=팟)이므로 EQR = EV / (에퀴티 × 팟)
      eqr[h] = equity[h] > 1e-6 && pot > 0 ? handEv[h] / (equity[h] * pot) : 0;
    }
    const actionFreq: number[] = [];
    const actionEv: number[] = [];
    let wsum = 0;
    let rangeEv = 0;
    let rangeEq = 0;
    for (let h = 0; h < n; h++) {
      const wgt = rP[h] * S[h];
      wsum += wgt;
      rangeEv += wgt * handEv[h];
      rangeEq += wgt * equity[h];
    }
    for (let a = 0; a < A; a++) {
      let f = 0;
      let e = 0;
      let ew = 0;
      for (let h = 0; h < n; h++) {
        const wgt = rP[h] * S[h];
        f += wgt * strategy[a * n + h];
        e += wgt * strategy[a * n + h] * ev[a * n + h];
        ew += wgt * strategy[a * n + h];
      }
      actionFreq.push(wsum > 0 ? f / wsum : 0);
      actionEv.push(ew > 0 ? e / ew : 0);
    }
    return {
      node: d,
      strategy,
      ev,
      handEv,
      equity,
      eqr,
      reachP: rP,
      reachO: rO,
      S,
      actionFreq,
      actionEv,
      rangeEv: wsum > 0 ? rangeEv / wsum : 0,
      rangeEquity: wsum > 0 ? rangeEq / wsum : 0
    };
  }

  // ---------- 노드별 EV 기록 ----------
  private evRec: Float32Array[] | null = null;
  private evMaxStreet = 2;
  /** maxStreet 이하 스트리트의 모든 결정 노드(런아웃별)에 대해 액션별 EV(bb, 노드 기준 순이익)를 기록 */
  recordEVs(maxStreet = 2): Float32Array[] {
    const n = this.hands.n;
    this.evMaxStreet = maxStreet;
    this.evRec = this.tree.decisionNodes.map((d) => (d.street <= maxStreet ? new Float32Array(this.mult[d.id] * d.actions.length * n) : new Float32Array(0)));
    const out = new Float32Array(n);
    for (const p of [0, 1] as const) this.evalTraverse(this.tree.root, 0, this.rootCtx(), p, this.w[p === 0 ? 1 : 0], "avg", out);
    const r = this.evRec;
    this.evRec = null;
    return r;
  }
  /** 런아웃 오프셋 계산 (외부용) */
  runoutOffset(d: DecisionNode, ctx: Ctx): number {
    return this.offset(d, ctx);
  }

  // ---------- 저장/복원 ----------
  /** 평균 전략을 정규화해 한 배열로 직렬화 (노드 순서 = decisionNodes) */
  serializeStrategy(): Float32Array {
    let total = 0;
    for (const s of this.stratSum) total += s.length;
    const out = new Float32Array(total);
    let off = 0;
    const n = this.hands.n;
    for (const d of this.tree.decisionNodes) {
      const ss = this.stratSum[d.id];
      const A = d.actions.length;
      const m = this.mult[d.id];
      for (let r = 0; r < m; r++) {
        const base = r * A * n;
        // 잠긴 노드는 실제로 적용되는 고정 전략을 내보낸다
        const lk = this.locks.size ? this.lockOf(d, base) : null;
        if (lk) {
          out.set(lk, off + base);
          continue;
        }
        for (let h = 0; h < n; h++) {
          let sum = 0;
          for (let a = 0; a < A; a++) sum += ss[base + a * n + h];
          for (let a = 0; a < A; a++) out[off + base + a * n + h] = sum > 0 ? ss[base + a * n + h] / sum : 1 / A;
        }
      }
      off += ss.length;
    }
    return out;
  }
  loadStrategy(data: Float32Array, iterations: number): void {
    let off = 0;
    for (const d of this.tree.decisionNodes) {
      const ss = this.stratSum[d.id];
      ss.set(data.subarray(off, off + ss.length));
      off += ss.length;
    }
    this.iterations = iterations;
  }
}
