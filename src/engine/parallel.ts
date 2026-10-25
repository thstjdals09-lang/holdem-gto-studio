// 병렬 포스트플랍 솔버
// 첫 스트리트(플랍) 결정 노드는 조정자가, 첫 런아웃 카드(턴)별 하위 트리는 여러 하위 솔버가 나눠 맡는다.
// 반복마다 플레이어별로 (1) 조정자가 찬스 노드에 도달하는 reach 를 모으고 (2) 하위 솔버들이 카드별 CFV 를 계산·학습하고
// (3) 조정자가 그 값으로 플랍 후회를 갱신한다. 계산은 단일 스레드 PostflopSolver 와 같다 (부동소수 합 순서만 다름).
import { buildTree, type GameTree, type TreeConfig, type TreeNode, type Action } from "./tree";
import { PostflopSolver, type PathStep, type SolverMetrics } from "./solver";
import type { RangeWeights } from "./range";

export type ChanceMode = "train" | "avg" | "br";
export interface ChanceItem {
  ch: number;
  rP: Float32Array | null;
  rO: Float32Array;
}
export interface SubInit {
  config: TreeConfig;
  w0: Float32Array;
  w1: Float32Array;
  cards: number[];
}

export type SubRequest =
  | { op: "init"; init: SubInit }
  | { op: "chance"; p: 0 | 1; mode: ChanceMode; t: number; items: ChanceItem[] }
  | { op: "view"; ch: number; card: number; r0: Float32Array; r1: Float32Array; rest: PathStep[] }
  | { op: "lock"; ch: number; card: number; rest: PathStep[]; strategy: Float32Array | null; allRunouts: boolean; unlock: boolean }
  | { op: "clearLocks" }
  | { op: "export" }
  | { op: "import"; data: Float32Array; iterations: number };

/** 노드 요약 (자식 트리는 빼고 주고받는다) */
export interface NodeInfo {
  kind: "decision" | "chance" | "terminal";
  id: number;
  street: number;
  pot: number;
  invested: [number, number];
  player?: 0 | 1;
  toCall?: number;
  actions?: Action[];
  type?: "fold" | "showdown";
  folder?: -1 | 0 | 1;
  board: number[];
}

/** 결정 노드 분석 (DecisionAnalysis 에서 노드 객체를 뺀 것) */
export interface NodeAnalysis {
  strategy: Float32Array;
  ev: Float32Array;
  handEv: Float32Array;
  equity: Float32Array;
  eqr: Float32Array;
  reachP: Float32Array;
  reachO: Float32Array;
  S: Float32Array;
  actionFreq: number[];
  actionEv: number[];
  rangeEv: number;
  rangeEquity: number;
}

export interface ParallelView {
  node: NodeInfo;
  reach: [Float32Array, Float32Array];
  analysis?: NodeAnalysis;
}

/** 하위 솔버와의 통신 통로 */
export interface SubPort {
  call(req: SubRequest): Promise<unknown>;
  close(): void;
}

export function nodeInfo(node: TreeNode, board: number[]): NodeInfo {
  if (node.kind === "decision") return { kind: "decision", id: node.id, street: node.street, pot: node.pot, invested: [node.invested[0], node.invested[1]], player: node.player, toCall: node.toCall, actions: node.actions.map((a) => ({ ...a })), board: board.slice() };
  if (node.kind === "chance") return { kind: "chance", id: node.id, street: node.street, pot: node.pot, invested: [node.invested[0], node.invested[1]], board: board.slice() };
  return { kind: "terminal", id: node.id, street: 0, pot: node.pot, invested: [node.invested[0], node.invested[1]], type: node.type, folder: node.folder, board: board.slice() };
}

function stripAnalysis(a: ReturnType<PostflopSolver["analyzeDecision"]>): NodeAnalysis {
  return { strategy: a.strategy, ev: a.ev, handEv: a.handEv, equity: a.equity, eqr: a.eqr, reachP: a.reachP, reachO: a.reachO, S: a.S, actionFreq: a.actionFreq, actionEv: a.actionEv, rangeEv: a.rangeEv, rangeEquity: a.rangeEquity };
}

/** 하위 솔버 쪽 요청 처리 (같은 스레드 포트와 워커가 공용) */
export function handleSubRequest(state: { solver: PostflopSolver | null }, req: SubRequest): unknown {
  if (req.op === "init") {
    const { config, w0, w1, cards } = req.init;
    state.solver = new PostflopSolver(buildTree(config), w0, w1, { firstCards: cards });
    return { hands: state.solver.hands.n, cards: cards.length };
  }
  const s = state.solver;
  if (!s) throw new Error("하위 솔버가 초기화되지 않았습니다");
  switch (req.op) {
    case "chance":
      return req.items.map((it) => s.chancePartial(it.ch, req.p, it.rP, it.rO, req.mode, req.t));
    case "view": {
      const { node, ctx, reach } = s.walkFrom(req.ch, req.card, req.r0, req.r1, req.rest);
      const v: ParallelView = { node: nodeInfo(node, ctx.board), reach };
      if (node.kind === "decision") v.analysis = stripAnalysis(s.analyzeDecision(node, ctx, reach));
      return v;
    }
    case "lock":
      return s.lockAt(req.ch, req.card, req.rest, req.strategy, req.allRunouts, req.unlock);
    case "clearLocks":
      s.clearLocks();
      return true;
    case "export":
      return s.serializeStrategy();
    case "import":
      s.loadStrategy(req.data, req.iterations);
      return true;
  }
}

/** 같은 스레드에서 도는 하위 솔버 (테스트, 워커가 없는 환경) */
export class LocalSubPort implements SubPort {
  private state: { solver: PostflopSolver | null } = { solver: null };
  async call(req: SubRequest): Promise<unknown> {
    return handleSubRequest(this.state, req);
  }
  close(): void {
    this.state.solver = null;
  }
}

/** postMessage 계열 통로(브라우저 Worker, Node worker_threads)를 SubPort 로 감싼다 */
export interface MessageEndpoint {
  postMessage(msg: unknown): void;
  /** 응답 핸들러 등록 */
  listen(handler: (msg: unknown) => void): void;
  terminate(): void;
}
export class MessageSubPort implements SubPort {
  private seq = 0;
  private waiting = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  constructor(private ep: MessageEndpoint) {
    ep.listen((m) => {
      const msg = m as { id: number; ok: boolean; result?: unknown; error?: string };
      const w = this.waiting.get(msg.id);
      if (!w) return;
      this.waiting.delete(msg.id);
      if (msg.ok) w.resolve(msg.result);
      else w.reject(new Error(msg.error ?? "하위 솔버 오류"));
    });
  }
  call(req: SubRequest): Promise<unknown> {
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      this.waiting.set(id, { resolve, reject });
      this.ep.postMessage({ id, req });
    });
  }
  close(): void {
    for (const w of this.waiting.values()) w.reject(new Error("하위 솔버가 닫혔습니다"));
    this.waiting.clear();
    this.ep.terminate();
  }
}

/** 워커 스크립트 쪽: 메시지를 받아 처리하고 응답한다 */
export function serveSubRequests(post: (msg: unknown) => void, listen: (handler: (msg: unknown) => void) => void): void {
  const state: { solver: PostflopSolver | null } = { solver: null };
  listen((m) => {
    const { id, req } = m as { id: number; req: SubRequest };
    try {
      post({ id, ok: true, result: handleSubRequest(state, req) });
    } catch (e) {
      post({ id, ok: false, error: e instanceof Error ? e.message : String(e) });
    }
  });
}

export class ParallelPostflopSolver {
  readonly tree: GameTree;
  readonly config: TreeConfig;
  readonly coord: PostflopSolver;
  private ports: SubPort[];
  private cardsOf: number[][];
  private owner = new Int8Array(52).fill(-1);
  private elapsed = 0;

  private constructor(tree: GameTree, coord: PostflopSolver, ports: SubPort[], cardsOf: number[][]) {
    this.tree = tree;
    this.config = tree.config;
    this.coord = coord;
    this.ports = ports;
    this.cardsOf = cardsOf;
    cardsOf.forEach((cs, k) => cs.forEach((c) => (this.owner[c] = k)));
  }

  /** ports 수만큼 첫 런아웃 카드를 나눠 하위 솔버를 준비한다 */
  static async create(config: TreeConfig, w0: RangeWeights, w1: RangeWeights, ports: SubPort[]): Promise<ParallelPostflopSolver> {
    if (ports.length === 0) throw new Error("하위 솔버가 하나 이상 필요합니다");
    const tree = buildTree(config);
    const coord = new PostflopSolver(tree, w0, w1, { firstCards: [] });
    const cardsOf: number[][] = ports.map(() => []);
    coord.remaining.forEach((c, i) => cardsOf[i % ports.length].push(c));
    const a0 = Float32Array.from(w0);
    const a1 = Float32Array.from(w1);
    await Promise.all(ports.map((pt, k) => pt.call({ op: "init", init: { config, w0: a0, w1: a1, cards: cardsOf[k] } })));
    return new ParallelPostflopSolver(tree, coord, ports, cardsOf);
  }

  get hands() {
    return this.coord.hands;
  }
  get iterationCount(): number {
    return this.coord.iterationCount;
  }
  get threads(): number {
    return this.ports.length;
  }

  private isFirstChance(node: TreeNode): boolean {
    return node.kind === "chance" && node.street - this.tree.startStreet === 1;
  }

  /** 조정자 순회를 두 단계로: 찬스 입력 수집 → 하위 솔버 계산 → 값을 넣어 다시 순회 */
  private async twoPass<T>(p: 0 | 1, mode: ChanceMode, t: number, run: () => T): Promise<T> {
    const c = this.coord;
    const items: ChanceItem[] = [];
    const index = new Map<number, number>();
    c.dry = mode === "train";
    c.chanceHook = (ch, _p, rP, rO, out) => {
      index.set(ch.id, items.length);
      items.push({ ch: ch.id, rP: rP ? rP.slice() : null, rO: rO.slice() });
      out.fill(0);
    };
    try {
      run();
    } finally {
      c.chanceHook = null;
      c.dry = false;
    }
    if (items.length === 0) return run();
    const parts = (await Promise.all(this.ports.map((pt) => pt.call({ op: "chance", p, mode, t, items })))) as Float32Array[][];
    const n = c.hands.n;
    const sums = items.map((it, k) => {
      const out = new Float32Array(n);
      for (const part of parts) {
        const v = part[k];
        for (let h = 0; h < n; h++) out[h] += v[h];
      }
      const inv = 1 / c.chanceDenominator(this.tree.chanceNodes[it.ch]);
      for (let h = 0; h < n; h++) out[h] *= inv;
      return out;
    });
    c.chanceHook = (ch, _p, _rP, _rO, out) => {
      const k = index.get(ch.id);
      if (k === undefined) throw new Error("수집되지 않은 찬스 노드");
      out.set(sums[k]);
    };
    try {
      return run();
    } finally {
      c.chanceHook = null;
    }
  }

  /** 반복 iters 회 (각 반복 = 양 플레이어 교대) */
  async step(iters: number): Promise<void> {
    for (let i = 0; i < iters; i++) {
      const t0 = performance.now();
      const t = this.coord.iterationCount + 1;
      for (const p of [0, 1] as const) await this.twoPass(p, "train", t, () => this.coord.trainRoot(p, t));
      const ms = performance.now() - t0;
      this.elapsed += ms;
      this.coord.finishIteration(ms);
    }
  }

  async metrics(): Promise<SolverMetrics> {
    const brOop = await this.twoPass(0, "br", 0, () => this.coord.evalRoot(0, "br"));
    const brIp = await this.twoPass(1, "br", 0, () => this.coord.evalRoot(1, "br"));
    const evOop = await this.twoPass(0, "avg", 0, () => this.coord.evalRoot(0, "avg"));
    const evIp = await this.twoPass(1, "avg", 0, () => this.coord.evalRoot(1, "avg"));
    const pot = this.config.pot;
    const expl = ((brOop - evOop + (brIp - evIp)) / 2 / pot) * 100;
    return { iterations: this.iterationCount, exploitabilityPct: expl, evOop, evIp, brOop, brIp, elapsedMs: this.elapsed };
  }

  /** 경로를 첫 런아웃 카드 앞뒤로 나눈다 */
  private split(path: PathStep[]): { prefix: PathStep[]; card: number; rest: PathStep[] } | null {
    let node: TreeNode = this.tree.root;
    for (let i = 0; i < path.length; i++) {
      const st = path[i];
      if (this.isFirstChance(node)) {
        if (st.kind !== "card") throw new Error("경로가 트리와 맞지 않습니다");
        return { prefix: path.slice(0, i), card: st.card, rest: path.slice(i + 1) };
      }
      if (node.kind === "decision" && st.kind === "action") node = node.children[st.index];
      else if (node.kind === "chance" && st.kind === "card") {
        const nx = node.children[st.card];
        if (!nx) throw new Error("사용할 수 없는 카드");
        node = nx;
      } else throw new Error("경로가 트리와 맞지 않습니다");
    }
    return null;
  }

  /** 경로의 노드 요약·reach·(결정 노드면) 분석 */
  async view(path: PathStep[]): Promise<ParallelView> {
    const sp = this.split(path);
    if (!sp) {
      const { node, ctx, reach } = this.coord.walk(path);
      const v: ParallelView = { node: nodeInfo(node, ctx.board), reach };
      if (node.kind === "decision") {
        const a = await this.twoPass(node.player, "avg", 0, () => this.coord.analyzeDecision(node, ctx, reach));
        v.analysis = stripAnalysis(a);
      }
      return v;
    }
    const { node, reach } = this.coord.walk(sp.prefix);
    const k = this.owner[sp.card];
    if (k < 0) throw new Error("사용할 수 없는 카드");
    return (await this.ports[k].call({ op: "view", ch: node.id, card: sp.card, r0: reach[0], r1: reach[1], rest: sp.rest })) as ParallelView;
  }

  /** 노드 잠금 (전략은 슬롯 기준 A·n). allRunouts 면 같은 노드의 모든 런아웃 카드에 적용 */
  async lockNode(path: PathStep[], strategy: Float32Array, allRunouts = false): Promise<void> {
    await this.lockOp(path, strategy, allRunouts, false);
  }
  async unlockNode(path: PathStep[], allRunouts = false): Promise<boolean> {
    return this.lockOp(path, null, allRunouts, true);
  }
  async clearLocks(): Promise<void> {
    this.coord.clearLocks();
    await Promise.all(this.ports.map((pt) => pt.call({ op: "clearLocks" })));
  }

  private async lockOp(path: PathStep[], strategy: Float32Array | null, allRunouts: boolean, unlock: boolean): Promise<boolean> {
    const sp = this.split(path);
    if (!sp) {
      if (unlock) return this.coord.unlockNode(path, allRunouts);
      this.coord.lockNode(path, strategy!, allRunouts);
      return true;
    }
    const chId = this.coord.walk(sp.prefix).node.id;
    if (!allRunouts) {
      const k = this.owner[sp.card];
      return (await this.ports[k].call({ op: "lock", ch: chId, card: sp.card, rest: sp.rest, strategy, allRunouts: false, unlock })) as boolean;
    }
    // 모든 런아웃: 하위 솔버마다 자기 카드 하나로 노드를 찾아 같은 잠금을 건다
    const used = new Set(sp.rest.filter((s) => s.kind === "card").map((s) => (s as { card: number }).card));
    const res = await Promise.all(
      this.ports.map((pt, k) => {
        const card = this.cardsOf[k].find((c) => !used.has(c));
        if (card === undefined) return Promise.resolve(false);
        return pt.call({ op: "lock", ch: chId, card, rest: sp.rest, strategy, allRunouts: true, unlock });
      })
    );
    return res.some(Boolean);
  }

  /** 단일 스레드 PostflopSolver.serializeStrategy 와 같은 배치의 정규화 전략 */
  async exportStrategy(): Promise<Float32Array> {
    const n = this.hands.n;
    const R = this.coord.R;
    const parts = (await Promise.all(this.ports.map((pt) => pt.call({ op: "export" })))) as Float32Array[];
    const coordData = this.coord.serializeStrategy();
    const start = this.tree.startStreet;
    let total = 0;
    const lvOf = (st: number) => Math.max(0, Math.min(2, st - start));
    for (const d of this.tree.decisionNodes) {
      const lv = lvOf(d.street);
      total += (lv === 0 ? 1 : lv === 1 ? R : R * R) * d.actions.length * n;
    }
    const out = new Float32Array(total);
    let off = 0;
    let coff = 0;
    const poff = parts.map(() => 0);
    for (const d of this.tree.decisionNodes) {
      const An = d.actions.length * n;
      const lv = lvOf(d.street);
      if (lv === 0) {
        out.set(coordData.subarray(coff, coff + An), off);
        coff += An;
        off += An;
        // 하위 솔버도 첫 스트리트 노드 블록(쓰지 않음)을 직렬화에 포함한다
        for (let k = 0; k < poff.length; k++) poff[k] += An;
        continue;
      }
      const chunk = lv === 1 ? An : R * An;
      this.cardsOf.forEach((cards, k) => {
        cards.forEach((c, j) => {
          const t = this.coord.cardIdx[c];
          out.set(parts[k].subarray(poff[k] + j * chunk, poff[k] + (j + 1) * chunk), off + t * chunk);
        });
        poff[k] += cards.length * chunk;
      });
      off += R * chunk;
    }
    return out;
  }

  /** exportStrategy 형식의 전략을 불러온다 (보기용; 후회값은 복원되지 않음) */
  async importStrategy(data: Float32Array, iterations: number): Promise<void> {
    const n = this.hands.n;
    const R = this.coord.R;
    const start = this.tree.startStreet;
    const lvOf = (st: number) => Math.max(0, Math.min(2, st - start));
    const coordParts: Float32Array[] = [];
    const portParts: Float32Array[][] = this.ports.map(() => []);
    let off = 0;
    for (const d of this.tree.decisionNodes) {
      const An = d.actions.length * n;
      const lv = lvOf(d.street);
      if (lv === 0) {
        coordParts.push(data.subarray(off, off + An));
        for (const pp of portParts) pp.push(new Float32Array(An)); // 하위 솔버의 첫 스트리트 블록 자리
        off += An;
        continue;
      }
      const chunk = lv === 1 ? An : R * An;
      this.cardsOf.forEach((cards, k) => {
        cards.forEach((c) => {
          const t = this.coord.cardIdx[c];
          portParts[k].push(data.subarray(off + t * chunk, off + (t + 1) * chunk));
        });
      });
      off += R * chunk;
    }
    const cat = (arrs: Float32Array[]) => {
      let len = 0;
      for (const a of arrs) len += a.length;
      const o = new Float32Array(len);
      let p = 0;
      for (const a of arrs) {
        o.set(a, p);
        p += a.length;
      }
      return o;
    };
    this.coord.loadStrategy(cat(coordParts), iterations);
    await Promise.all(this.ports.map((pt, k) => pt.call({ op: "import", data: cat(portParts[k]), iterations })));
  }

  close(): void {
    for (const pt of this.ports) pt.close();
  }
}
