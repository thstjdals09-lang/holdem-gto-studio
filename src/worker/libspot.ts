// 라이브러리(미리 푼) 포스트플랍 스팟: 플랍·턴은 파일에서 읽고, 리버는 그 지점 레인지로 즉석 재솔브한다.
import { COMBO_CARDS, cardToString } from "../engine/cards";
import { buildTree, type DecisionNode, type GameTree, type TreeNode, type TreeConfig } from "../engine/tree";
import { buildHandSet, PostflopSolver, type HandSet, type PathStep as SPath } from "../engine/solver";
import { EquityCalc, oppMass } from "../engine/handeq";
import type { FlopMeta } from "../lib/postflopLib";
import type { ActionView, NodeView, PathStep } from "./protocol";
import { buildDecisionView } from "./views";

export type AnalyzeItem = { kind: "card"; card: number } | { kind: "action"; actor: 0 | 1; type: "fold" | "check" | "call" | "bet" | "raise"; amount: number; allin: boolean };
export interface PostGrade {
  street: "flop" | "turn" | "river";
  board: number[];
  pot: number;
  chosen: string;
  best: string;
  freq: number;
  evLoss: number;
  options: Array<{ label: string; freq: number; ev: number }>;
  path: PathStep[];
}

export interface RunoutRow {
  card: number;
  player: number;
  labels: string[];
  types: string[];
  freqs: number[];
  evs: number[];
  rangeEv: number;
  equity: number;
}

interface NodeData {
  strat: Float32Array; // A*n
  ev: Float32Array; // A*n
}

function decode(buf: ArrayBuffer, nodes: DecisionNode[], n: number): Map<number, NodeData> {
  const dv = new DataView(buf);
  const out = new Map<number, NodeData>();
  let p = 0;
  for (const d of nodes) {
    const A = d.actions.length;
    const strat = new Float32Array(A * n);
    for (let k = 0; k < A * n; k++) strat[k] = dv.getUint8(p++) / 255;
    // 핸드별 정규화 (양자화 오차 보정)
    for (let h = 0; h < n; h++) {
      let s = 0;
      for (let a = 0; a < A; a++) s += strat[a * n + h];
      if (s > 0) for (let a = 0; a < A; a++) strat[a * n + h] /= s;
      else for (let a = 0; a < A; a++) strat[a * n + h] = 1 / A;
    }
    const ev = new Float32Array(A * n);
    for (let k = 0; k < A * n; k++) {
      ev[k] = dv.getInt16(p, true) / 100;
      p += 2;
    }
    out.set(d.id, { strat, ev });
  }
  return out;
}

export interface RiverSolve {
  solver: PostflopSolver;
  tree: GameTree;
  exploitabilityPct: number;
  iterations: number;
}

export class LibSpot {
  readonly tree: GameTree;
  readonly hands: HandSet;
  readonly w: [Float32Array, Float32Array];
  readonly eq: EquityCalc;
  private flop: Map<number, NodeData>;
  private turns = new Map<number, Map<number, NodeData>>();
  private rivers = new Map<string, RiverSolve>();
  private turnNodes: DecisionNode[];

  constructor(
    readonly meta: FlopMeta,
    flopBuf: ArrayBuffer,
    private readonly baseUrl: string
  ) {
    this.tree = buildTree(meta.config);
    const w0 = new Float32Array(1326);
    const w1 = new Float32Array(1326);
    meta.hands.forEach((c, s) => {
      w0[c] = meta.w0[s];
      w1[c] = meta.w1[s];
    });
    this.hands = buildHandSet(meta.config.board, w0, w1);
    if (this.hands.n !== meta.hands.length) throw new Error("핸드 수가 메타데이터와 다릅니다");
    this.w = [new Float32Array(this.hands.n), new Float32Array(this.hands.n)];
    for (let s = 0; s < this.hands.n; s++) {
      this.w[0][s] = meta.w0[s];
      this.w[1][s] = meta.w1[s];
    }
    this.eq = new EquityCalc(this.hands);
    const flopNodes = this.tree.decisionNodes.filter((d) => d.street === this.tree.startStreet);
    this.turnNodes = this.tree.decisionNodes.filter((d) => d.street === this.tree.startStreet + 1);
    this.flop = decode(flopBuf, flopNodes, this.hands.n);
  }

  static async load(baseUrl: string, matchup: string, flop: string): Promise<LibSpot> {
    const dir = `${baseUrl}postflop/${matchup}/${flop}/`;
    const [metaRes, flopRes] = await Promise.all([fetch(dir + "meta.json"), fetch(dir + "flop.bin")]);
    const isHtml = (r: Response) => (r.headers.get("content-type") ?? "").includes("text/html");
    if (!metaRes.ok || !flopRes.ok || isHtml(metaRes) || isHtml(flopRes)) throw new Error(`이 플랍(${flop})의 라이브러리 파일이 없습니다`);
    const meta = (await metaRes.json()) as FlopMeta;
    return new LibSpot(meta, await flopRes.arrayBuffer(), dir);
  }

  private async turnData(card: number): Promise<Map<number, NodeData>> {
    let t = this.turns.get(card);
    if (t) return t;
    const res = await fetch(`${this.baseUrl}t/${cardToString(card)}.bin`);
    if (!res.ok || (res.headers.get("content-type") ?? "").includes("text/html")) throw new Error("턴 데이터를 불러오지 못했습니다");
    t = decode(await res.arrayBuffer(), this.turnNodes, this.hands.n);
    this.turns.set(card, t);
    return t;
  }

  private riverConfig(board: number[], pot: number, invested: number): TreeConfig {
    const c = this.meta.config;
    return { ...c, board, pot, effStack: Math.round((c.effStack - invested) * 100) / 100 };
  }

  private riverSolve(key: string, board: number[], pot: number, invested: number, reach: Float32Array[], onProgress?: (it: number, expl: number) => void): RiverSolve {
    let rs = this.rivers.get(key);
    if (rs) return rs;
    const cfg = this.riverConfig(board, pot, invested);
    const tree = buildTree(cfg);
    const w0 = new Float32Array(1326);
    const w1 = new Float32Array(1326);
    let z0 = 0;
    let z1 = 0;
    for (let s = 0; s < this.hands.n; s++) {
      w0[this.hands.combo[s]] = reach[0][s];
      w1[this.hands.combo[s]] = reach[1][s];
      z0 += reach[0][s];
      z1 += reach[1][s];
    }
    const unreached = !(z0 > 1e-9) || !(z1 > 1e-9);
    if (unreached) {
      for (let s = 0; s < this.hands.n; s++) {
        if (!(z0 > 1e-9)) w0[this.hands.combo[s]] = 1;
        if (!(z1 > 1e-9)) w1[this.hands.combo[s]] = 1;
      }
    }
    const solver = new PostflopSolver(tree, w0, w1);
    let m = solver.metrics();
    while (solver.iterationCount < 400) {
      solver.step(25);
      m = solver.metrics();
      onProgress?.(solver.iterationCount, m.exploitabilityPct);
      if (m.exploitabilityPct < 0.15) break;
    }
    rs = { solver, tree, exploitabilityPct: m.exploitabilityPct, iterations: solver.iterationCount };
    if (this.rivers.size > 30) this.rivers.clear();
    this.rivers.set(key, rs);
    return rs;
  }

  /** 경로를 따라 노드 화면 데이터를 만든다 */
  async view(path: PathStep[], onProgress?: (it: number, expl: number) => void): Promise<NodeView & { river?: { iterations: number; exploitabilityPct: number } }> {
    const n = this.hands.n;
    const reach: Float32Array[] = [new Float32Array(this.w[0]), new Float32Array(this.w[1])];
    let node: TreeNode = this.tree.root;
    let board = this.meta.config.board.slice();
    let turnCard = -1;
    for (let i = 0; i < path.length; i++) {
      const step = path[i];
      if (node.kind === "decision" && step.kind === "action") {
        const data = node.street === this.tree.startStreet ? this.flop.get(node.id) : (await this.turnData(turnCard)).get(node.id);
        if (!data) throw new Error("노드 데이터가 없습니다");
        const r = reach[node.player];
        for (let h = 0; h < n; h++) r[h] *= data.strat[step.index * n + h];
        node = node.children[step.index];
      } else if (node.kind === "chance" && step.kind === "card") {
        const c = step.card;
        if (board.includes(c) || !node.children[c]) throw new Error("사용할 수 없는 카드");
        const hw = this.hands.handsWithCard[c];
        for (const r of reach) for (let k = 0; k < hw.length; k++) r[hw[k]] = 0;
        board = board.concat([c]);
        if (node.street === this.tree.startStreet + 1) turnCard = c;
        const child: TreeNode = node.children[c]!;
        if (node.street === 3 && child.kind === "decision") {
          // 리버: 즉석 재솔브 후 나머지 경로는 리버 솔버에서
          const key = path.slice(0, i + 1).map((s) => (s.kind === "action" ? s.index : "c" + s.card)).join(".");
          const rs = this.riverSolve(key, board, node.pot, node.invested[0], reach, onProgress);
          const rest = path.slice(i + 1) as SPath[];
          return { ...this.riverView(rs, rest), river: { iterations: rs.iterations, exploitabilityPct: rs.exploitabilityPct } };
        }
        node = child;
      } else throw new Error("경로가 트리와 맞지 않습니다");
    }
    if (node.kind === "decision") {
      const data = node.street === this.tree.startStreet ? this.flop.get(node.id)! : (await this.turnData(turnCard)).get(node.id)!;
      return this.decisionView(node, board, reach, data);
    }
    if (node.kind === "chance") {
      return { kind: "chance", players: 2, street: node.street, board, pot: node.pot, invested: [node.invested[0], node.invested[1]], active: [true, true], liveCards: Array.from({ length: 52 }, (_, c) => c).filter((c) => !board.includes(c)), allin: node.allin };
    }
    return this.terminalView(node, board, reach);
  }

  private decisionView(d: DecisionNode, board: number[], reach: Float32Array[], data: NodeData): NodeView {
    const n = this.hands.n;
    const A = d.actions.length;
    const p = d.player;
    const rP = reach[p];
    const rO = reach[p === 0 ? 1 : 0];
    const M = oppMass(this.hands, rO);
    const equity = this.eq.equity(board, rO);
    const handEv = new Float32Array(n);
    const eqr = new Float32Array(n);
    for (let h = 0; h < n; h++) {
      let v = 0;
      for (let a = 0; a < A; a++) v += data.strat[a * n + h] * data.ev[a * n + h];
      handEv[h] = v;
      eqr[h] = equity[h] > 1e-6 && d.pot > 0 ? v / (equity[h] * d.pot) : 0;
    }
    let wsum = 0;
    let rangeEv = 0;
    let rangeEq = 0;
    for (let h = 0; h < n; h++) {
      const w = rP[h] * M[h];
      wsum += w;
      rangeEv += w * handEv[h];
      rangeEq += w * equity[h];
    }
    const actions: ActionView[] = d.actions.map((a, i) => {
      let f = 0;
      let e = 0;
      for (let h = 0; h < n; h++) {
        const w = rP[h] * M[h] * data.strat[i * n + h];
        f += w;
        e += w * data.ev[i * n + h];
      }
      return { label: a.label, code: a.code, type: a.type, amount: a.amount, freq: wsum > 0 ? f / wsum : 0, ev: f > 0 ? e / f : 0 };
    });
    return buildDecisionView(
      { n, combo: this.hands.combo, A, strategy: data.strat, ev: data.ev, handEv, equity, eqr, M, reach },
      { players: 2, player: p, active: [true, true], allin: [false, false], street: d.street, board, pot: d.pot, invested: [d.invested[0], d.invested[1]], toCall: d.toCall, actions },
      wsum > 0 ? rangeEv / wsum : 0,
      wsum > 0 ? rangeEq / wsum : 0
    );
  }

  private terminalView(t: Extract<TreeNode, { kind: "terminal" }>, board: number[], reach: Float32Array[]): NodeView {
    let shares: number[];
    if (t.type === "fold") shares = t.folder === 0 ? [0, t.pot] : [t.pot, 0];
    else {
      const eq = this.eq.equity(board, reach[1]);
      const M = oppMass(this.hands, reach[1]);
      let num = 0;
      let den = 0;
      for (let h = 0; h < this.hands.n; h++) {
        const w = reach[0][h] * M[h];
        if (w <= 0) continue;
        num += w * eq[h];
        den += w;
      }
      const e = den > 0 ? num / den : 0.5;
      shares = [e * t.pot, (1 - e) * t.pot];
    }
    return { kind: "terminal", players: 2, type: t.type, board, pot: t.pot, invested: [t.invested[0], t.invested[1]], active: [t.folder !== 0, t.folder !== 1], winner: t.folder === -1 ? -1 : t.folder === 0 ? 1 : 0, shares };
  }

  private riverView(rs: RiverSolve, rest: SPath[]): NodeView {
    const s = rs.solver;
    const { node, ctx, reach } = s.walk(rest);
    // 리버 솔버의 핸드 슬롯 → 이 스팟 슬롯으로 매핑해 DecisionView를 만든다
    if (node.kind === "decision") {
      const an = s.analyzeDecision(node, ctx, reach);
      const actions: ActionView[] = node.actions.map((a, i) => ({ label: a.label, code: a.code, type: a.type, amount: a.amount, freq: an.actionFreq[i], ev: an.actionEv[i] }));
      const eqr = new Float32Array(s.hands.n);
      for (let h = 0; h < s.hands.n; h++) eqr[h] = an.equity[h] > 1e-6 && node.pot > 0 ? an.handEv[h] / (an.equity[h] * node.pot) : 0;
      // 화면상 투자/팟은 리버 시작 기준이 아닌 전체 기준으로 보정
      const base = (this.meta.config.effStack - rs.tree.config.effStack);
      return buildDecisionView(
        { n: s.hands.n, combo: s.hands.combo, A: node.actions.length, strategy: an.strategy, ev: an.ev, handEv: an.handEv, equity: an.equity, eqr, M: an.S, reach: [reach[0], reach[1]] },
        { players: 2, player: node.player, active: [true, true], allin: [false, false], street: 3, board: ctx.board, pot: node.pot, invested: [node.invested[0] + base, node.invested[1] + base], toCall: node.toCall, actions },
        an.rangeEv,
        an.rangeEquity
      );
    }
    if (node.kind === "terminal") {
      let shares: number[];
      if (node.type === "fold") shares = node.folder === 0 ? [0, node.pot] : [node.pot, 0];
      else {
        const eq = s.equityVector(ctx, reach[1]);
        const M = oppMass(s.hands, reach[1]);
        let num = 0;
        let den = 0;
        for (let h = 0; h < s.hands.n; h++) {
          const w = reach[0][h] * M[h];
          if (w <= 0) continue;
          num += w * eq[h];
          den += w;
        }
        const e = den > 0 ? num / den : 0.5;
        shares = [e * node.pot, (1 - e) * node.pot];
      }
      const base = this.meta.config.effStack - rs.tree.config.effStack;
      return { kind: "terminal", players: 2, type: node.type, board: ctx.board, pot: node.pot, invested: [node.invested[0] + base, node.invested[1] + base], active: [node.folder !== 0, node.folder !== 1], winner: node.folder === -1 ? -1 : node.folder === 0 ? 1 : 0, shares };
    }
    throw new Error("리버 솔브 경로 오류");
  }

  /** 턴 런아웃 리포트: 찬스 노드(턴)에서 카드별 첫 결정의 액션 빈도·EV·에퀴티 */
  async runouts(path: PathStep[]): Promise<RunoutRow[]> {
    const v = await this.view(path);
    if (v.kind !== "chance" || v.street !== this.tree.startStreet + 1) return [];
    const rows: RunoutRow[] = [];
    for (const c of v.liveCards) {
      const d = await this.view([...path, { kind: "card", card: c }]);
      if (d.kind !== "decision") continue;
      rows.push({ card: c, player: d.player, labels: d.actions.map((a) => a.label), types: d.actions.map((a) => a.type), freqs: d.actions.map((a) => a.freq), evs: d.actions.map((a) => a.ev), rangeEv: d.rangeEv, equity: d.rangeEquity });
    }
    return rows;
  }

  /** 실제 핸드 라인을 따라가며 히어로 결정을 채점 (분석기용) */
  async analyzeLine(heroSeat: 0 | 1, heroCombo: number, items: AnalyzeItem[]): Promise<{ grades: PostGrade[]; note: string }> {
    const grades: PostGrade[] = [];
    const path: PathStep[] = [];
    let note = "";
    const streetName = (st: number) => (st === 1 ? "flop" : st === 2 ? "turn" : "river") as PostGrade["street"];
    for (const it of items) {
      const v = await this.view(path);
      if (it.kind === "card") {
        if (v.kind !== "chance") {
          if (v.kind !== "terminal") note = "라인이 라이브러리 트리와 맞지 않습니다";
          break;
        }
        path.push({ kind: "card", card: it.card });
        continue;
      }
      if (v.kind !== "decision") {
        note = "라인이 라이브러리 트리와 맞지 않습니다";
        break;
      }
      if (v.player !== it.actor) {
        note = "행동 순서가 트리와 다릅니다";
        break;
      }
      let idx = -1;
      if (it.type === "fold") idx = v.actions.findIndex((a) => a.type === "fold");
      else if (it.type === "check") idx = v.actions.findIndex((a) => a.type === "check");
      else if (it.type === "call") idx = v.actions.findIndex((a) => a.type === "call");
      else {
        let bd = Infinity;
        v.actions.forEach((a, i) => {
          if (a.type !== "bet" && a.type !== "raise" && a.type !== "allin") return;
          const d = Math.abs(a.amount - it.amount) + (it.allin && a.type !== "allin" ? 1000 : 0);
          if (d < bd) {
            bd = d;
            idx = i;
          }
        });
      }
      if (idx < 0) {
        note = `${it.type === "bet" ? "벳" : it.type === "raise" ? "레이즈" : it.type} 액션이 라이브러리 트리에 없습니다 (단순화된 사이즈 트리)`;
        break;
      }
      if (it.actor === heroSeat) {
        const entry = v.combos.find((c) => c.combo === heroCombo);
        if (!entry || entry.weight <= 0) {
          note = "이 핸드는 이 지점의 GTO 레인지에 없습니다 (채점 불가)";
          path.push({ kind: "action", index: idx });
          break;
        }
        let best = 0;
        for (let i = 1; i < entry.ev.length; i++) if (entry.ev[i] > entry.ev[best]) best = i;
        const evLoss = Math.max(0, entry.ev[best] - entry.ev[idx]);
        grades.push({
          street: streetName(v.street),
          board: v.board.slice(),
          pot: v.pot,
          chosen: v.actions[idx].label,
          best: v.actions[best].label,
          freq: entry.strategy[idx],
          evLoss,
          options: v.actions.map((a, i) => ({ label: a.label, freq: entry.strategy[i], ev: entry.ev[i] })),
          path: path.slice()
        });
      }
      path.push({ kind: "action", index: idx });
    }
    return { grades, note };
  }

  /** 콤보의 두 카드 (트레이너용) */
  comboCards(combo: number): [number, number] {
    return COMBO_CARDS[combo];
  }
}
