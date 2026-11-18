// 깊이 제한 HU 솔버 — 결정 모델의 플랍·턴용 (몇 초 안에 답한다).
// 지금 스트리트는 실제 트리로 풀고, 스트리트가 끝나는 잎에서 남은 카드를 실제로 딜해 한 라운드 더 베팅한 뒤 정확한 쇼다운으로 끝낸다.
//  - 턴: 리버 카드를 딜하고 리버 베팅까지 푼다 (리버 크기만 줄인 실제 게임).
//  - 플랍: (턴, 리버) 두 장을 표본으로 함께 딜하고 턴·리버 베팅을 한 라운드로 합쳐 푼다.
// StreetSolver 의 "에퀴티 × 실현 모델" 잎은 상대 레인지 모양(넛 우위·양극화)을 못 봐서 만든 패를 레이즈 쪽으로 치우치게 했다.
// 잎의 런아웃 계산은 워커에 나눠 맡길 수 있다 (hook, shard): 지금 스트리트를 한 번 훑어 잎의 reach 를 모으고(dry),
// 워커가 런아웃별 값을 더해 돌려주면 같은 전략으로 다시 훑어 후회를 갱신한다. 계산은 한 스레드와 같다(합 순서만 다름).
import { mulberry32 } from "./cards";
import { oppMass } from "./handeq";
import type { RangeWeights } from "./range";
import { boardEval, buildHandSet, showdownSweep, type BoardEval, type HandSet } from "./solver";
import { pairEquity } from "./street";
import { buildTree, type ChanceNode, type DecisionNode, type GameTree, type SizingSet, type TerminalNode, type TreeConfig, type TreeNode } from "./tree";

export interface LookaheadOptions {
  /** 플랍에서 뽑을 (턴, 리버) 쌍의 수. 턴이면 뽑을 리버 수 (없으면 리버 전부) */
  runouts?: number;
  /** 잎 뒤 라운드의 크기. 기본: 턴이면 설정의 리버 크기, 플랍이면 FLOP_FUTURE */
  future?: SizingSet;
  /**
   * 대조 변량: 런아웃마다 체크다운 쇼다운 값을 빼고, 그 정확한 평균(핸드 쌍 승률 행렬)을 더한다.
   * 표본 런아웃이 운 좋게(나쁘게) 나온 몫이 상쇄된다. 값은 행렬 계산의 쌍 비교 한도 (0 = 끔). 런아웃을 표본으로 뽑을 때만 쓴다
   */
  cv?: number;
  seed?: number;
  /** 워커용: 런아웃 표본 중 j % count === index 인 것과, 대조 변량 행렬의 그 몫의 행만 맡는다 */
  shard?: { index: number; count: number };
  /** 조정자용: 런아웃 계산을 전부 워커에 맡기므로 보드 평가·승률 행렬을 만들지 않는다 (hook 과 함께) */
  coordinator?: boolean;
}

/** 플랍 잎 뒤의 합친 라운드 크기 (측정상 70~150% 사이는 차이가 없었다) */
export const FLOP_FUTURE: SizingSet = { bet: [100], raise: [] };
const FLOP_RUNOUTS = 40;

/**
 * 잎 하나의 런아웃 합: acc = Σ (뒤 라운드 값 − 체크다운 값), msum = Σ 만난 상대 reach. 정규화 전 값이라 워커끼리 더할 수 있다.
 * exact = 체크다운 값의 정확한 평균 (대조 변량, 맡은 행만. 정규화하지 않고 그대로 더한다)
 */
export interface LeafSums {
  acc: Float32Array;
  msum: Float32Array;
  exact?: Float32Array;
}
export interface LeafRequest {
  /** 찬스 노드 번호 (tree.chanceNodes) */
  ch: number;
  rP: Float32Array | null;
  rO: Float32Array;
}
export type LeafMode = "train" | "avg" | "br";
export type LeafHook = (items: LeafRequest[], p: 0 | 1, mode: LeafMode, t: number) => Promise<LeafSums[]>;

interface Future {
  tree: GameTree;
  /** 잎까지 각자 넣은 돈 */
  base: [number, number];
  /** 더 칠 돈이 없으면 쇼다운만 */
  showdownOnly: boolean;
  regret: Map<number, Float32Array>;
  sum: Map<number, Float32Array>;
}

const ALPHA = 1.5;
const GAMMA = 2;

export class LookaheadSolver {
  readonly tree: GameTree;
  readonly hands: HandSet;
  readonly n: number;
  readonly w: [Float32Array, Float32Array];
  /** 잎 뒤에 딜한 런아웃 수와, 전부가 아니라 표본인지 */
  readonly runouts: number;
  readonly sampled: boolean;
  iterations = 0;
  /** 런아웃 계산을 워커에 맡기는 함수. 있으면 stepAsync·metricsAsync·analyzeAsync 를 쓴다 */
  hook: LeafHook | null = null;
  private evals: BoardEval[];
  /** 런아웃별 살아 있는 슬롯 (1 = 런아웃 카드와 겹치지 않음) */
  private live: Uint8Array[];
  /** 이 인스턴스가 맡은 런아웃 번호 */
  private mine: number[];
  private cvOn: boolean;
  /** 리버 시작이면 지금 보드의 쇼다운 */
  private riverEval: BoardEval | null = null;
  private futures = new Map<ChanceNode, Future>();
  private regret = new Map<number, Float32Array>();
  private sum = new Map<number, Float32Array>();
  private pool: Float32Array[][] = [];
  private tc = new Float64Array(52);
  private cum = new Float64Array(52);
  private gc = new Float64Array(52);
  private t = 0;
  private opts: LookaheadOptions;
  /** 대조 변량용 핸드 쌍 승률 행렬의 [eLo, eHi) 행 (워커는 자기 몫의 행만) */
  private E: Float32Array | null = null;
  private eLo = 0;
  private eHi = 0;
  private nz: Int32Array;
  /** 두 번 훑기: dry 면 잎 요청만 모으고, pre 가 있으면 워커가 준 값을 쓴다 */
  private dry = false;
  private requests: Array<{ ch: ChanceNode; rP: Float32Array | null; rO: Float32Array }> = [];
  private pre: Map<ChanceNode, LeafSums> | null = null;

  constructor(
    readonly config: TreeConfig,
    w0: RangeWeights,
    w1: RangeWeights,
    opts: LookaheadOptions = {}
  ) {
    const board = config.board;
    this.opts = opts;
    this.tree = buildTree(config);
    this.hands = buildHandSet(board, w0, w1);
    const n = (this.n = this.hands.n);
    if (n === 0) throw new Error("레인지에 보드와 겹치지 않는 핸드가 없습니다");
    this.w = [Float32Array.from(this.hands.combo, (c) => w0[c]), Float32Array.from(this.hands.combo, (c) => w1[c])];
    this.nz = new Int32Array(n);

    const deck: number[] = [];
    for (let c = 0; c < 52; c++) if (!board.includes(c)) deck.push(c);
    const rnd = mulberry32(opts.seed ?? 1);
    const d = deck.slice();
    for (let i = d.length - 1; i > 0; i--) {
      const j = Math.floor(rnd() * (i + 1));
      [d[i], d[j]] = [d[j], d[i]];
    }
    const m = d.length;
    let runs: number[][] = [];
    if (board.length === 4) runs = (opts.runouts && opts.runouts < m ? d.slice(0, opts.runouts) : deck).map((c) => [c]);
    if (board.length === 3) {
      // 두 장을 함께 보므로 순서 없는 쌍이다. 섞은 덱에서 (i, i+s) 쌍을 차례로 뽑아 모든 카드가 거의 같은 횟수로 나오게 한다
      const want = Math.min(opts.runouts ?? FLOP_RUNOUTS, (m * (m - 1)) / 2);
      for (let s = 1; runs.length < want; s++) for (let i = 0; i < m && runs.length < want; i++) runs.push([d[i], d[(i + s) % m]]);
    }
    this.runouts = runs.length;
    this.sampled = runs.length > 0 && runs.length < (board.length === 4 ? m : (m * (m - 1)) / 2);
    const sh = opts.shard;
    this.mine = opts.coordinator ? [] : runs.map((_, j) => j).filter((j) => !sh || j % sh.count === sh.index);
    this.evals = runs.map((run, j) => (this.mine.includes(j) ? boardEval(board.concat(run), this.hands) : (null as never)));
    this.live = runs.map((run) => Uint8Array.from({ length: n }, (_, h) => (run.includes(this.hands.a[h]) || run.includes(this.hands.b[h]) ? 0 : 1)));
    if (board.length === 5) this.riverEval = boardEval(board, this.hands);
    this.cvOn = this.sampled && (opts.cv ?? 0) > 0;
    if (this.cvOn && !opts.coordinator) {
      [this.eLo, this.eHi] = sh ? [Math.floor((n * sh.index) / sh.count), Math.floor((n * (sh.index + 1)) / sh.count)] : [0, n];
      this.E = pairEquity(this.hands, board, opts.cv, (opts.seed ?? 1) + 1, sh ? [this.eLo, this.eHi] : undefined).E;
    }
  }

  // ---------- 버퍼 ----------
  private buf(depth: number, slot: number): Float32Array {
    const d = (this.pool[depth] ??= []);
    return (d[slot] ??= new Float32Array(this.n));
  }
  private sigma(depth: number, A: number): Float32Array {
    const d = (this.pool[depth] ??= []);
    return (d[100 + A] ??= new Float32Array(A * this.n));
  }

  private futureOf(ch: ChanceNode): Future {
    let f = this.futures.get(ch);
    if (f) return f;
    const cfg = this.config;
    const left = Math.max(0, Math.round((cfg.effStack - ch.invested[0]) * 100) / 100);
    const s = this.opts.future ?? (cfg.board.length === 4 ? null : FLOP_FUTURE);
    const side = (x: TreeConfig["oop"]) => {
      const r = s ?? x.river;
      return { flop: r, turn: r, river: r };
    };
    // 보드 카드는 트리 모양에 영향이 없어 아무 리버 보드로 만든다. 올인은 실제로 나온 스트리트에만 넣는다
    const board = cfg.board.concat([0, 1, 2, 3, 4, 5].filter((c) => !cfg.board.includes(c)).slice(0, 5 - cfg.board.length));
    const tree = buildTree({ ...cfg, board, pot: ch.pot, effStack: left, oop: side(cfg.oop), ip: side(cfg.ip), maxRaisesPerStreet: 2, maxRaisesByStreet: undefined, includeAllin: false });
    f = { tree, base: [ch.invested[0], ch.invested[1]], showdownOnly: ch.allin || left <= 0.01, regret: new Map(), sum: new Map() };
    this.futures.set(ch, f);
    return f;
  }

  private table(map: Map<number, Float32Array>, d: DecisionNode, copies: number): Float32Array {
    let t = map.get(d.id);
    if (!t) map.set(d.id, (t = new Float32Array(copies * d.actions.length * this.n)));
    return t;
  }

  /** 후회 매칭 (양수만, 합이 0 이면 고르게) */
  private match(R: Float32Array, off: number, A: number, out: Float32Array): void {
    const { n } = this;
    for (let h = 0; h < n; h++) {
      let tot = 0;
      for (let a = 0; a < A; a++) {
        const x = R[off + a * n + h];
        if (x > 0) tot += x;
      }
      for (let a = 0; a < A; a++) {
        const x = R[off + a * n + h];
        out[a * n + h] = tot > 0 ? (x > 0 ? x / tot : 0) : 1 / A;
      }
    }
  }

  /** 평균 전략 (합이 0 이면 고르게) */
  private avg(S: Float32Array, off: number, A: number, out: Float32Array): void {
    const { n } = this;
    for (let h = 0; h < n; h++) {
      let tot = 0;
      for (let a = 0; a < A; a++) tot += S[off + a * n + h];
      for (let a = 0; a < A; a++) out[a * n + h] = tot > 0 ? S[off + a * n + h] / tot : 1 / A;
    }
  }

  /** 지금 스트리트 결정 노드의 평균 전략 (A×n) */
  average(d: DecisionNode): Float32Array {
    const out = new Float32Array(d.actions.length * this.n);
    this.avg(this.table(this.sum, d, 1), 0, d.actions.length, out);
    return out;
  }

  /** 잎 값: 폴드는 넣은 돈, 쇼다운은 강도 순 스윕. 뒤 라운드(f)면 잎까지 넣은 돈을 더하고 k 번째 런아웃 보드로 쇼다운 */
  private terminal(type: TerminalNode["type"], folder: number, pot: number, invested: number, p: 0 | 1, rO: Float32Array, out: Float32Array, f: Future | null, k: number): void {
    const inv = invested + (f ? f.base[p] : 0);
    if (type === "fold") {
      const u = folder === p ? -inv : pot - inv;
      oppMass(this.hands, rO, out);
      for (let h = 0; h < this.n; h++) out[h] *= u;
      return;
    }
    const e = f ? this.evals[k] : this.riverEval;
    if (!e) throw new Error("리버 전에 쇼다운 잎이 있습니다");
    showdownSweep(e, this.hands, rO, pot, inv, out, this.tc, this.cum, this.gc);
  }

  /**
   * 잎의 런아웃 합 (정규화 전): 맡은 런아웃마다 그 카드와 겹치는 핸드를 빼고 뒤 라운드를 풀어 더한다.
   * 대조 변량을 켰으면 런아웃마다 체크다운 값을 뺀다 (정확한 평균은 finish 에서 더한다)
   */
  private sums(ch: ChanceNode, depth: number, p: 0 | 1, rP: Float32Array | null, rO: Float32Array, mode: LeafMode): LeafSums {
    const { n } = this;
    const f = this.futureOf(ch);
    const acc = new Float32Array(n);
    const msum = new Float32Array(n);
    const rPk = this.buf(depth, 0);
    const rOk = this.buf(depth, 1);
    const tmp = this.buf(depth, 2);
    const mk = this.buf(depth, 3);
    const sd = this.buf(depth, 4);
    // 쇼다운만 남았고 대조 변량을 켰으면 체크다운 값이 곧 답이라 정확한 평균만 쓴다
    for (const k of f.showdownOnly && this.cvOn ? [] : this.mine) {
      const live = this.live[k];
      for (let h = 0; h < n; h++) {
        rOk[h] = live[h] ? rO[h] : 0;
        if (rP) rPk[h] = live[h] ? rP[h] : 0;
      }
      if (f.showdownOnly) this.terminal("showdown", -1, ch.pot, 0, p, rOk, tmp, f, k);
      else if (mode === "train") this.cfr(f.tree.root, depth + 1, p, rPk, rOk, tmp, f, k);
      else this.evaluate(f.tree.root, depth + 1, p, rOk, mode === "br", tmp, f, k);
      if (this.cvOn) this.terminal("showdown", -1, ch.pot, 0, p, rOk, sd, f, k);
      oppMass(this.hands, rOk, mk);
      for (let h = 0; h < n; h++) {
        if (!live[h]) continue;
        acc[h] += this.cvOn ? tmp[h] - sd[h] : tmp[h];
        msum[h] += mk[h];
      }
    }
    const E = this.E;
    if (!E) return { acc, msum };
    // 체크다운 값의 정확한 평균 (맡은 행): 팟 × Σ 상대 reach × 승률 − 넣은 돈 × 상대 reach 합
    const exact = new Float32Array(n);
    oppMass(this.hands, rO, mk);
    const nz = this.nz;
    let m = 0;
    for (let o = 0; o < n; o++) if (rO[o] !== 0) nz[m++] = o;
    const inv = ch.invested[p];
    for (let h = this.eLo; h < this.eHi; h++) {
      const row = (h - this.eLo) * n;
      let s = 0;
      for (let q = 0; q < m; q++) s += rO[nz[q]] * E[row + nz[q]];
      exact[h] = ch.pot * s - inv * mk[h];
    }
    return { acc, msum, exact };
  }

  /** 워커용: 찬스 노드 번호의 잎에서 맡은 런아웃의 합. mode 가 train 이면 반복 t 로 뒤 라운드를 학습한다 */
  leafSums(ch: number, p: 0 | 1, rP: Float32Array | null, rO: Float32Array, mode: LeafMode, t: number): LeafSums {
    if (mode === "train") this.t = t;
    return this.sums(this.tree.chanceNodes[ch], 1, p, rP, rO, mode);
  }

  /** 지금 스트리트의 잎: 런아웃 합을 핸드마다 만난 상대 reach 로 나눠 폴드 같은 잎과 같은 단위로 맞추고, 대조 변량의 정확한 평균을 더한다 */
  private leaf(ch: ChanceNode, depth: number, p: 0 | 1, rP: Float32Array | null, rO: Float32Array, out: Float32Array, mode: LeafMode): void {
    if (this.dry) {
      this.requests.push({ ch, rP: rP ? rP.slice() : null, rO: rO.slice() });
      out.fill(0);
      return;
    }
    const { acc, msum, exact } = this.pre?.get(ch) ?? this.sums(ch, depth, p, rP, rO, mode);
    const { n } = this;
    const mk = oppMass(this.hands, rO, this.buf(depth, 3));
    for (let h = 0; h < n; h++) out[h] = (msum[h] > 0 ? (acc[h] * mk[h]) / msum[h] : 0) + (exact ? exact[h] : 0);
  }

  private cfr(node: TreeNode, depth: number, p: 0 | 1, rP: Float32Array, rO: Float32Array, out: Float32Array, f: Future | null, k: number): void {
    if (node.kind === "terminal") return this.terminal(node.type, node.folder, node.pot, node.invested[p], p, rO, out, f, k);
    if (node.kind === "chance") return this.leaf(node, depth, p, rP, rO, out, "train");
    const { n } = this;
    const A = node.actions.length;
    const copies = f ? this.evals.length : 1;
    const R = this.table(f ? f.regret : this.regret, node, copies);
    const off = f ? k * A * n : 0;
    const s = this.sigma(depth, A);
    this.match(R, off, A, s);
    const r2 = this.buf(depth, 5);
    out.fill(0);
    if (node.player !== p) {
      const tmp = this.buf(depth, 6);
      for (let a = 0; a < A; a++) {
        for (let h = 0; h < n; h++) r2[h] = rO[h] * s[a * n + h];
        this.cfr(node.children[a], depth + 1, p, rP, r2, tmp, f, k);
        for (let h = 0; h < n; h++) out[h] += tmp[h];
      }
      return;
    }
    for (let a = 0; a < A; a++) {
      const v = this.buf(depth, 7 + a);
      for (let h = 0; h < n; h++) r2[h] = rP[h] * s[a * n + h];
      this.cfr(node.children[a], depth + 1, p, r2, rO, v, f, k);
      for (let h = 0; h < n; h++) out[h] += s[a * n + h] * v[h];
    }
    if (this.dry) return; // 잎 요청만 모으는 훑기는 갱신하지 않는다
    // DCFR (α 1.5, β 0, γ 2) — 다른 솔버와 같은 값
    const t = this.t;
    const pos = Math.pow(t, ALPHA) / (Math.pow(t, ALPHA) + 1);
    const g = Math.pow(t / (t + 1), GAMMA);
    const S = this.table(f ? f.sum : this.sum, node, copies);
    for (let a = 0; a < A; a++) {
      const v = this.buf(depth, 7 + a);
      const base = off + a * n;
      for (let h = 0; h < n; h++) {
        const x = R[base + h];
        R[base + h] = x * (x > 0 ? pos : 0.5) + v[h] - out[h];
        S[base + h] = S[base + h] * g + rP[h] * s[a * n + h];
      }
    }
  }

  step(k = 1): void {
    if (this.hook) throw new Error("워커를 쓰면 stepAsync 로 반복합니다");
    const out = new Float32Array(this.n);
    for (; k > 0; k--) {
      this.t = ++this.iterations;
      this.cfr(this.tree.root, 0, 0, this.w[0], this.w[1], out, null, 0);
      this.cfr(this.tree.root, 0, 1, this.w[1], this.w[0], out, null, 0);
    }
  }

  /** 잎을 워커에 맡겨 두 번 훑는다: 요청을 모으고(dry) → 워커 합 → 같은 전략으로 다시 */
  private async twoPass<T>(run: () => T, p: 0 | 1, mode: LeafMode): Promise<T> {
    if (!this.hook) return run();
    this.dry = true;
    this.requests = [];
    try {
      run();
    } finally {
      this.dry = false;
    }
    const reqs = this.requests;
    const res = await this.hook(
      reqs.map((r) => ({ ch: r.ch.id, rP: r.rP, rO: r.rO })),
      p,
      mode,
      this.t
    );
    this.pre = new Map(reqs.map((r, i) => [r.ch, res[i]]));
    try {
      return run();
    } finally {
      this.pre = null;
    }
  }

  async stepAsync(k = 1): Promise<void> {
    if (!this.hook) return this.step(k);
    const out = new Float32Array(this.n);
    for (; k > 0; k--) {
      this.t = ++this.iterations;
      for (const p of [0, 1] as const) await this.twoPass(() => this.cfr(this.tree.root, 0, p, this.w[p], this.w[p === 0 ? 1 : 0], out, null, 0), p, "train");
    }
  }

  /** 평균 전략으로 둘 때 p 의 반사실 값. best 면 p 만 핸드마다 최선 액션 (최선 대응) */
  private evaluate(node: TreeNode, depth: number, p: 0 | 1, rO: Float32Array, best: boolean, out: Float32Array, f: Future | null, k: number): void {
    if (node.kind === "terminal") return this.terminal(node.type, node.folder, node.pot, node.invested[p], p, rO, out, f, k);
    if (node.kind === "chance") return this.leaf(node, depth, p, null, rO, out, best ? "br" : "avg");
    const { n } = this;
    const A = node.actions.length;
    const s = new Float32Array(A * n);
    this.avg(this.table(f ? f.sum : this.sum, node, f ? this.evals.length : 1), f ? k * A * n : 0, A, s);
    const r2 = new Float32Array(n);
    const tmp = new Float32Array(n);
    out.fill(node.player === p && best ? -Infinity : 0);
    for (let a = 0; a < A; a++) {
      if (node.player !== p) {
        for (let h = 0; h < n; h++) r2[h] = rO[h] * s[a * n + h];
        this.evaluate(node.children[a], depth + 1, p, r2, best, tmp, f, k);
        for (let h = 0; h < n; h++) out[h] += tmp[h];
      } else {
        this.evaluate(node.children[a], depth + 1, p, rO, best, tmp, f, k);
        for (let h = 0; h < n; h++) out[h] = best ? Math.max(out[h], tmp[h]) : out[h] + s[a * n + h] * tmp[h];
      }
    }
  }

  /** 루트에서 p 의 평균(또는 최선 대응) 값. 핸드 가중 합을 상대 reach 로 나눈 bb */
  private rootValue(v: Float32Array, p: 0 | 1): number {
    const mass = oppMass(this.hands, this.w[1]);
    let z = 0;
    for (let h = 0; h < this.n; h++) z += this.w[0][h] * mass[h];
    let s = 0;
    for (let h = 0; h < this.n; h++) if (this.w[p][h] > 0) s += this.w[p][h] * v[h];
    return z > 0 ? s / z : 0;
  }
  private rootEval(p: 0 | 1, best: boolean, v: Float32Array): void {
    this.evaluate(this.tree.root, 0, p, this.w[p === 0 ? 1 : 0], best, v, null, 0);
  }
  private metricsOf(vals: number[]): { ev: [number, number]; exploitabilityPct: number } {
    const pot = this.tree.config.pot;
    return { ev: [vals[0], vals[1]], exploitabilityPct: ((vals[2] + vals[3] - pot) / 2 / pot) * 100 };
  }
  private static readonly CASES: Array<[0 | 1, boolean]> = [
    [0, false],
    [1, false],
    [0, true],
    [1, true]
  ];

  /** 지금 전략의 값(bb)과 익스플로잇어빌리티(시작 팟 대비 %). 깊이 제한 게임 안에서 잰 값이다 */
  metrics(): { ev: [number, number]; exploitabilityPct: number } {
    if (this.hook) throw new Error("워커를 쓰면 metricsAsync 를 씁니다");
    const v = new Float32Array(this.n);
    return this.metricsOf(
      LookaheadSolver.CASES.map(([p, best]) => {
        this.rootEval(p, best, v);
        return this.rootValue(v, p);
      })
    );
  }
  async metricsAsync(): Promise<{ ev: [number, number]; exploitabilityPct: number }> {
    const v = new Float32Array(this.n);
    const vals: number[] = [];
    for (const [p, best] of LookaheadSolver.CASES) {
      await this.twoPass(() => this.rootEval(p, best, v), p, best ? "br" : "avg");
      vals.push(this.rootValue(v, p));
    }
    return this.metricsOf(vals);
  }

  /** 노드에서 행동할 사람의 핸드별 평균 전략과 액션 EV (A×n, bb, 지금 폴드하는 것을 0으로 둔 값) */
  analyze(node: DecisionNode, reach: [Float32Array, Float32Array]): { strategy: Float32Array; ev: Float32Array } {
    if (this.hook) throw new Error("워커를 쓰면 analyzeAsync 를 씁니다");
    const p = node.player;
    const rO = reach[p === 0 ? 1 : 0];
    const vs = node.actions.map((_, a) => {
      const v = new Float32Array(this.n);
      this.evaluate(node.children[a], 1, p, rO, false, v, null, 0);
      return v;
    });
    return this.analysisOf(node, rO, vs);
  }
  async analyzeAsync(node: DecisionNode, reach: [Float32Array, Float32Array]): Promise<{ strategy: Float32Array; ev: Float32Array }> {
    const p = node.player;
    const rO = reach[p === 0 ? 1 : 0];
    const vs: Float32Array[] = [];
    for (let a = 0; a < node.actions.length; a++) {
      const v = new Float32Array(this.n);
      await this.twoPass(() => this.evaluate(node.children[a], 1, p, rO, false, v, null, 0), p, "avg");
      vs.push(v);
    }
    return this.analysisOf(node, rO, vs);
  }
  private analysisOf(node: DecisionNode, rO: Float32Array, vs: Float32Array[]): { strategy: Float32Array; ev: Float32Array } {
    const { n } = this;
    const mass = oppMass(this.hands, rO);
    const ev = new Float32Array(node.actions.length * n);
    vs.forEach((v, a) => {
      for (let h = 0; h < n; h++) ev[a * n + h] = mass[h] > 0 ? v[h] / mass[h] + node.invested[node.player] : 0;
    });
    return { strategy: this.average(node), ev };
  }
}
