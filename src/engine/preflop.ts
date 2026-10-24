// HU 프리플랍 근사 솔버: 169 클래스, 쇼다운은 클래스 간 에퀴티 행렬(몬테카를로)로 평가.
// 포스트플랍 플레이는 모델링하지 않는다(에퀴티 실현 = 1). 결과는 "근사"로 표시해야 한다.
import { CLASS_COMBOS, COMBO_CARDS, NUM_CLASSES, classLabel, mulberry32 } from "./cards";
import { evaluate } from "./evaluator";

export interface PreflopConfig {
  stackBb: number; // 유효 스택 (bb)
  sbPosts: number; // 0.5
  bbPosts: number; // 1
  openSizes: number[]; // SB 오픈 레이즈 "to" 금액 (bb), 예 [2.5, 3]
  threeBetMult: number[]; // 오픈 대비 배수, 예 [3]
  fourBetMult: number[]; // 3벳 대비 배수, 예 [2.2]
  maxRaises: number; // 레이즈 횟수 상한 (이후 올인만)
  allowLimp: boolean;
  includeAllin: boolean;
}

export interface PfAction {
  type: "fold" | "call" | "check" | "raise" | "allin";
  amount: number; // 추가로 넣는 금액
  label: string;
  code: string;
}
export interface PfDecision {
  kind: "decision";
  id: number;
  player: 0 | 1; // 0 = SB, 1 = BB
  pot: number;
  invested: [number, number];
  toCall: number;
  actions: PfAction[];
  children: PfNode[];
}
export interface PfTerminal {
  kind: "terminal";
  type: "fold" | "showdown";
  pot: number;
  invested: [number, number];
  folder: -1 | 0 | 1;
}
export type PfNode = PfDecision | PfTerminal;

export interface PfTree {
  root: PfNode;
  decisions: PfDecision[];
  config: PreflopConfig;
}

const r2 = (x: number) => Math.round(x * 100) / 100;

export function buildPreflopTree(cfg: PreflopConfig): PfTree {
  const decisions: PfDecision[] = [];
  interface St {
    pot: number;
    invested: [number, number];
    toAct: 0 | 1;
    toCall: number;
    raises: number;
    limped: boolean;
    lastRaiseTo: number;
  }
  const stack = (st: St, p: 0 | 1) => cfg.stackBb - st.invested[p];
  const term = (st: St, type: "fold" | "showdown", folder: -1 | 0 | 1): PfTerminal => ({ kind: "terminal", type, pot: st.pot, invested: [st.invested[0], st.invested[1]], folder });

  function node(st: St): PfNode {
    const p = st.toAct;
    const o: 0 | 1 = p === 0 ? 1 : 0;
    const d: PfDecision = { kind: "decision", id: decisions.length, player: p, pot: st.pot, invested: [st.invested[0], st.invested[1]], toCall: st.toCall, actions: [], children: [] };
    decisions.push(d);
    const myStack = stack(st, p);
    const oppStack = stack(st, o);
    const push = (a: PfAction, child: PfNode) => {
      d.actions.push(a);
      d.children.push(child);
    };
    if (st.toCall > 0) {
      push({ type: "fold", amount: 0, label: "폴드", code: "F" }, term(st, "fold", p));
      const call = r2(Math.min(st.toCall, myStack));
      const inv: [number, number] = [st.invested[0], st.invested[1]];
      inv[p] = r2(inv[p] + call);
      const st2: St = { ...st, invested: inv, pot: r2(st.pot + call), toCall: 0 };
      push({ type: "call", amount: call, label: `콜 ${call}`, code: "C" }, term(st2, "showdown", -1));
    } else {
      // 체크 (BB가 림프에 체크) 또는 SB 첫 액션에서 "폴드"
      if (p === 0 && st.raises === 0 && !st.limped) {
        push({ type: "fold", amount: 0, label: "폴드", code: "F" }, term(st, "fold", 0));
        if (cfg.allowLimp) {
          const call = r2(cfg.bbPosts - cfg.sbPosts);
          const inv: [number, number] = [r2(st.invested[0] + call), st.invested[1]];
          push({ type: "call", amount: call, label: "림프", code: "L" }, node({ ...st, invested: inv, pot: r2(st.pot + call), toAct: 1, toCall: 0, limped: true }));
        }
      } else {
        push({ type: "check", amount: 0, label: "체크", code: "X" }, term(st, "showdown", -1));
      }
    }
    // 레이즈/올인
    const canRaise = st.raises < cfg.maxRaises && myStack > st.toCall;
    const maxTo = r2(Math.min(st.invested[p] + myStack, st.invested[o] + oppStack)); // 상대가 콜 가능한 최대 "to"
    const seen = new Set<number>();
    const addRaise = (to: number, label: string, code: string) => {
      let type: "raise" | "allin" = "raise";
      if (to >= maxTo) {
        to = maxTo;
        type = "allin";
      }
      to = r2(to);
      if (to <= st.invested[o] || to <= st.invested[p] + st.toCall) return;
      if (seen.has(to)) return;
      seen.add(to);
      const amt = r2(to - st.invested[p]);
      const inv: [number, number] = [st.invested[0], st.invested[1]];
      inv[p] = to;
      push(
        { type, amount: amt, label: type === "allin" ? `올인 ${to}` : `${label} ${to}`, code: type === "allin" ? "A" : code },
        node({ ...st, invested: inv, pot: r2(st.pot + amt), toAct: o, toCall: r2(to - inv[o]), raises: st.raises + 1, lastRaiseTo: to })
      );
    };
    if (canRaise) {
      if (st.raises === 0) {
        for (const sz of cfg.openSizes) addRaise(sz, p === 0 ? "오픈" : "레이즈", `R${sz}`);
      } else if (st.raises === 1) {
        for (const m of cfg.threeBetMult) addRaise(st.lastRaiseTo * m, "3벳", `R${m}x`);
      } else {
        for (const m of cfg.fourBetMult) addRaise(st.lastRaiseTo * m, st.raises === 2 ? "4벳" : "리레이즈", `R${m}x`);
      }
      if (cfg.includeAllin) addRaise(maxTo, "올인", "A");
    }
    return d;
  }
  const root = node({ pot: r2(cfg.sbPosts + cfg.bbPosts), invested: [cfg.sbPosts, cfg.bbPosts], toAct: 0, toCall: r2(cfg.bbPosts - cfg.sbPosts), raises: 0, limped: false, lastRaiseTo: cfg.bbPosts });
  // SB 첫 노드는 toCall>0 이므로 위 분기에서 폴드/콜(=림프→showdown)이 생성된다. 림프 후 BB 액션을 위해 수정:
  fixLimp(root as PfDecision, cfg, decisions);
  return { root, decisions, config: cfg };
}

/** SB 루트의 "콜"(림프)은 쇼다운이 아니라 BB의 체크/레이즈 결정으로 이어져야 한다. */
function fixLimp(root: PfDecision, cfg: PreflopConfig, decisions: PfDecision[]) {
  const idx = root.actions.findIndex((a) => a.type === "call");
  if (idx < 0) return;
  if (!cfg.allowLimp) {
    root.actions.splice(idx, 1);
    root.children.splice(idx, 1);
    return;
  }
  root.actions[idx].label = "림프";
  root.actions[idx].code = "L";
  const t = root.children[idx] as PfTerminal;
  const bb: PfDecision = { kind: "decision", id: decisions.length, player: 1, pot: t.pot, invested: [t.invested[0], t.invested[1]], toCall: 0, actions: [], children: [] };
  decisions.push(bb);
  bb.actions.push({ type: "check", amount: 0, label: "체크", code: "X" });
  bb.children.push({ kind: "terminal", type: "showdown", pot: t.pot, invested: [t.invested[0], t.invested[1]], folder: -1 });
  // BB 림프 레이즈(ISO): 오픈 사이즈 사용
  const maxTo = cfg.stackBb;
  for (const sz of [...cfg.openSizes, ...(cfg.includeAllin ? [maxTo] : [])]) {
    let to = Math.min(sz, maxTo);
    const type: "raise" | "allin" = to >= maxTo ? "allin" : "raise";
    to = r2(to);
    if (to <= t.invested[1]) continue;
    const amt = r2(to - t.invested[1]);
    const sb: PfDecision = { kind: "decision", id: decisions.length, player: 0, pot: r2(t.pot + amt), invested: [t.invested[0], to], toCall: r2(to - t.invested[0]), actions: [], children: [] };
    decisions.push(sb);
    bb.actions.push({ type, amount: amt, label: type === "allin" ? `올인 ${to}` : `레이즈 ${to}`, code: type === "allin" ? "A" : `R${sz}` });
    bb.children.push(sb);
    sb.actions.push({ type: "fold", amount: 0, label: "폴드", code: "F" });
    sb.children.push({ kind: "terminal", type: "fold", pot: sb.pot, invested: sb.invested, folder: 0 });
    const call = r2(Math.min(sb.toCall, cfg.stackBb - sb.invested[0]));
    sb.actions.push({ type: "call", amount: call, label: `콜 ${call}`, code: "C" });
    sb.children.push({ kind: "terminal", type: "showdown", pot: r2(sb.pot + call), invested: [r2(sb.invested[0] + call), sb.invested[1]], folder: -1 });
    if (type !== "allin") {
      const amtA = r2(maxTo - sb.invested[0]);
      sb.actions.push({ type: "allin", amount: amtA, label: `올인 ${maxTo}`, code: "A" });
      const bb2: PfDecision = { kind: "decision", id: decisions.length, player: 1, pot: r2(sb.pot + amtA), invested: [maxTo, to], toCall: r2(maxTo - to), actions: [], children: [] };
      decisions.push(bb2);
      bb2.actions.push({ type: "fold", amount: 0, label: "폴드", code: "F" });
      bb2.children.push({ kind: "terminal", type: "fold", pot: bb2.pot, invested: bb2.invested, folder: 1 });
      const c2 = r2(maxTo - to);
      bb2.actions.push({ type: "call", amount: c2, label: `콜 ${c2}`, code: "C" });
      bb2.children.push({ kind: "terminal", type: "showdown", pot: r2(bb2.pot + c2), invested: [maxTo, maxTo], folder: -1 });
      sb.children.push(bb2);
    }
  }
  root.children[idx] = bb;
}

// ---------- 클래스 간 에퀴티 / 비충돌 콤보 수 ----------
export const CLASS_COMBO_COUNT = new Float32Array(NUM_CLASSES);
for (let c = 0; c < NUM_CLASSES; c++) CLASS_COMBO_COUNT[c] = CLASS_COMBOS[c].length;

/** nonConflict[i*169+j] = 클래스 i의 특정 콤보 하나와 충돌하지 않는 클래스 j 콤보 수 */
export function buildNonConflict(): Float32Array {
  const out = new Float32Array(NUM_CLASSES * NUM_CLASSES);
  for (let i = 0; i < NUM_CLASSES; i++) {
    const [a, b] = COMBO_CARDS[CLASS_COMBOS[i][0]];
    for (let j = 0; j < NUM_CLASSES; j++) {
      let cnt = 0;
      for (const cj of CLASS_COMBOS[j]) {
        const [x, y] = COMBO_CARDS[cj];
        if (x !== a && x !== b && y !== a && y !== b) cnt++;
      }
      out[i * NUM_CLASSES + j] = cnt;
    }
  }
  return out;
}

/** 클래스 i vs j 에퀴티 (i 관점, 동점 0.5). 몬테카를로. onProgress(0~1) */
export function buildEquityMatrix(samplesPerPair = 300, seed = 12345, onProgress?: (p: number) => void): Float32Array {
  const rng = mulberry32(seed);
  const eq = new Float32Array(NUM_CLASSES * NUM_CLASSES);
  const cards = new Array<number>(7);
  const cards2 = new Array<number>(7);
  const deck: number[] = [];
  let pairIdx = 0;
  const totalPairs = (NUM_CLASSES * (NUM_CLASSES + 1)) / 2;
  for (let i = 0; i < NUM_CLASSES; i++) {
    for (let j = i; j < NUM_CLASSES; j++) {
      let wins = 0;
      let games = 0;
      const ci = CLASS_COMBOS[i];
      const cj = CLASS_COMBOS[j];
      for (let s = 0; s < samplesPerPair; s++) {
        const [a, b] = COMBO_CARDS[ci[Math.floor(rng() * ci.length)]];
        const [x, y] = COMBO_CARDS[cj[Math.floor(rng() * cj.length)]];
        if (x === a || x === b || y === a || y === b) continue;
        deck.length = 0;
        for (let c = 0; c < 52; c++) if (c !== a && c !== b && c !== x && c !== y) deck.push(c);
        for (let k = 0; k < 5; k++) {
          const t = k + Math.floor(rng() * (deck.length - k));
          const tmp = deck[k];
          deck[k] = deck[t];
          deck[t] = tmp;
          cards[k] = deck[k];
          cards2[k] = deck[k];
        }
        cards[5] = a;
        cards[6] = b;
        cards2[5] = x;
        cards2[6] = y;
        const s1 = evaluate(cards, 7);
        const s2 = evaluate(cards2, 7);
        if (s1 > s2) wins += 1;
        else if (s1 === s2) wins += 0.5;
        games++;
      }
      const e = games > 0 ? wins / games : 0.5;
      eq[i * NUM_CLASSES + j] = e;
      eq[j * NUM_CLASSES + i] = 1 - e;
      pairIdx++;
      if (onProgress && pairIdx % 500 === 0) onProgress(pairIdx / totalPairs);
    }
  }
  return eq;
}

// ---------- DCFR (169 클래스) ----------
const ALPHA = 1.5;
const GAMMA = 2;

export interface PfAnalysis {
  node: PfDecision;
  strategy: Float32Array; // A*169
  ev: Float32Array; // A*169 (여기서부터 순이익 bb)
  freq: number[];
  actionEv: number[];
  reach: [Float32Array, Float32Array];
}

export class PreflopSolver {
  readonly tree: PfTree;
  readonly eq: Float32Array;
  readonly nc: Float32Array;
  regret: Float32Array[];
  stratSum: Float32Array[];
  iterations = 0;
  private roAdj = new Float32Array(NUM_CLASSES);
  private t = 1;

  constructor(tree: PfTree, eqMatrix: Float32Array, nonConflict: Float32Array) {
    this.tree = tree;
    this.eq = eqMatrix;
    this.nc = nonConflict;
    this.regret = tree.decisions.map((d) => new Float32Array(d.actions.length * NUM_CLASSES));
    this.stratSum = tree.decisions.map((d) => new Float32Array(d.actions.length * NUM_CLASSES));
  }

  /** 상대 reach를 클래스 i 기준 비충돌 콤보 수로 보정 */
  private adjust(i: number, ro: Float32Array): Float32Array {
    const out = this.roAdj;
    const N = NUM_CLASSES;
    for (let j = 0; j < N; j++) out[j] = ro[j] * (this.nc[i * N + j] / CLASS_COMBO_COUNT[j]);
    return out;
  }

  private terminal(t: PfTerminal, p: 0 | 1, ro: Float32Array, out: Float32Array): void {
    const N = NUM_CLASSES;
    for (let i = 0; i < N; i++) {
      const adj = this.adjust(i, ro);
      let S = 0;
      let v = 0;
      if (t.type === "fold") {
        for (let j = 0; j < N; j++) S += adj[j];
        const u = t.folder === p ? -t.invested[p] : t.pot - t.invested[p];
        out[i] = u * S;
      } else {
        const I = t.invested[p];
        for (let j = 0; j < N; j++) {
          const m = adj[j];
          if (m === 0) continue;
          S += m;
          const e = p === 0 ? this.eq[i * N + j] : this.eq[j * N + i];
          // 클래스 j 관점에서 상대 클래스 i... eq[i][j]는 i(=p의 핸드) vs j(=상대). p===1이면 상대=SB 클래스 j, 내 핸드 i → eq[i][j]
          v += m * (e * t.pot - I);
        }
        out[i] = v;
        void S;
      }
    }
  }

  private sigma(d: PfDecision, out: Float32Array): void {
    const N = NUM_CLASSES;
    const A = d.actions.length;
    const reg = this.regret[d.id];
    for (let i = 0; i < N; i++) {
      let sum = 0;
      for (let a = 0; a < A; a++) if (reg[a * N + i] > 0) sum += reg[a * N + i];
      for (let a = 0; a < A; a++) out[a * N + i] = sum > 0 ? Math.max(reg[a * N + i], 0) / sum : 1 / A;
    }
  }

  avgStrategy(d: PfDecision): Float32Array {
    const N = NUM_CLASSES;
    const A = d.actions.length;
    const ss = this.stratSum[d.id];
    const out = new Float32Array(A * N);
    for (let i = 0; i < N; i++) {
      let sum = 0;
      for (let a = 0; a < A; a++) sum += ss[a * N + i];
      for (let a = 0; a < A; a++) out[a * N + i] = sum > 0 ? ss[a * N + i] / sum : 1 / A;
    }
    return out;
  }

  private traverse(node: PfNode, p: 0 | 1, rP: Float32Array, rO: Float32Array, out: Float32Array, useAvg: boolean, br: boolean): void {
    const N = NUM_CLASSES;
    if (node.kind === "terminal") {
      this.terminal(node, p, rO, out);
      return;
    }
    const d = node;
    const A = d.actions.length;
    const sig = useAvg ? this.avgStrategy(d) : new Float32Array(A * N);
    if (!useAvg) this.sigma(d, sig);
    const tmp = new Float32Array(N);
    if (d.player === p) {
      const outs: Float32Array[] = [];
      for (let a = 0; a < A; a++) {
        const rP2 = new Float32Array(N);
        for (let i = 0; i < N; i++) rP2[i] = rP[i] * sig[a * N + i];
        const oa = new Float32Array(N);
        this.traverse(d.children[a], p, rP2, rO, oa, useAvg, br);
        outs.push(oa);
      }
      if (br) {
        out.fill(-Infinity);
        for (let a = 0; a < A; a++) for (let i = 0; i < N; i++) if (outs[a][i] > out[i]) out[i] = outs[a][i];
        return;
      }
      out.fill(0);
      for (let a = 0; a < A; a++) for (let i = 0; i < N; i++) out[i] += sig[a * N + i] * outs[a][i];
      if (!useAvg) {
        const t = this.t;
        const posD = Math.pow(t, ALPHA) / (Math.pow(t, ALPHA) + 1);
        const stratD = Math.pow(t / (t + 1), GAMMA);
        const reg = this.regret[d.id];
        const ss = this.stratSum[d.id];
        for (let a = 0; a < A; a++) {
          for (let i = 0; i < N; i++) {
            let r = reg[a * N + i];
            r = r > 0 ? r * posD : r * 0.5;
            reg[a * N + i] = r + (outs[a][i] - out[i]);
            ss[a * N + i] = ss[a * N + i] * stratD + rP[i] * sig[a * N + i];
          }
        }
      }
    } else {
      out.fill(0);
      for (let a = 0; a < A; a++) {
        const rO2 = new Float32Array(N);
        for (let i = 0; i < N; i++) rO2[i] = rO[i] * sig[a * N + i];
        this.traverse(d.children[a], p, rP, rO2, tmp, useAvg, br);
        for (let i = 0; i < N; i++) out[i] += tmp[i];
      }
    }
  }

  step(iters: number): void {
    const out = new Float32Array(NUM_CLASSES);
    for (let k = 0; k < iters; k++) {
      this.t = this.iterations + 1;
      for (const p of [0, 1] as const) this.traverse(this.tree.root, p, CLASS_COMBO_COUNT, CLASS_COMBO_COUNT, out, false, false);
      this.iterations++;
    }
  }

  private Z(): number {
    const N = NUM_CLASSES;
    let z = 0;
    for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) z += CLASS_COMBO_COUNT[i] * this.nc[i * N + j];
    return z;
  }

  metrics(): { iterations: number; exploitabilityPct: number; evSb: number; evBb: number } {
    const N = NUM_CLASSES;
    const Z = this.Z();
    const val = (p: 0 | 1, br: boolean) => {
      const out = new Float32Array(N);
      this.traverse(this.tree.root, p, CLASS_COMBO_COUNT, CLASS_COMBO_COUNT, out, true, br);
      let v = 0;
      for (let i = 0; i < N; i++) if (isFinite(out[i])) v += CLASS_COMBO_COUNT[i] * out[i];
      return v / Z;
    };
    const ev0 = val(0, false);
    const ev1 = val(1, false);
    const br0 = val(0, true);
    const br1 = val(1, true);
    const pot = this.tree.config.sbPosts + this.tree.config.bbPosts;
    return { iterations: this.iterations, exploitabilityPct: ((br0 - ev0 + (br1 - ev1)) / 2 / pot) * 100, evSb: ev0, evBb: ev1 };
  }

  /** 경로(액션 인덱스)로 노드 이동 + reach */
  walk(path: number[]): { node: PfNode; reach: [Float32Array, Float32Array] } {
    const N = NUM_CLASSES;
    let node: PfNode = this.tree.root;
    const r0 = new Float32Array(CLASS_COMBO_COUNT);
    const r1 = new Float32Array(CLASS_COMBO_COUNT);
    for (const idx of path) {
      if (node.kind !== "decision") throw new Error("경로 오류");
      const sig = this.avgStrategy(node);
      const r = node.player === 0 ? r0 : r1;
      for (let i = 0; i < N; i++) r[i] *= sig[idx * N + i];
      node = node.children[idx];
    }
    return { node, reach: [r0, r1] };
  }

  analyze(d: PfDecision, reach: [Float32Array, Float32Array]): PfAnalysis {
    const N = NUM_CLASSES;
    const A = d.actions.length;
    const p = d.player;
    const rO = reach[p === 0 ? 1 : 0];
    const rP = reach[p];
    const strategy = this.avgStrategy(d);
    const ev = new Float32Array(A * N);
    const tmp = new Float32Array(N);
    const S = new Float32Array(N);
    for (let i = 0; i < N; i++) {
      const adj = this.adjust(i, rO);
      let s = 0;
      for (let j = 0; j < N; j++) s += adj[j];
      S[i] = s;
    }
    for (let a = 0; a < A; a++) {
      this.traverse(d.children[a], p, rP, rO, tmp, true, false);
      for (let i = 0; i < N; i++) ev[a * N + i] = S[i] > 0 ? tmp[i] / S[i] + d.invested[p] : 0;
    }
    const freq: number[] = [];
    const actionEv: number[] = [];
    let wsum = 0;
    for (let i = 0; i < N; i++) wsum += rP[i] * S[i];
    for (let a = 0; a < A; a++) {
      let f = 0;
      let e = 0;
      let ew = 0;
      for (let i = 0; i < N; i++) {
        const wgt = rP[i] * S[i];
        f += wgt * strategy[a * N + i];
        e += wgt * strategy[a * N + i] * ev[a * N + i];
        ew += wgt * strategy[a * N + i];
      }
      freq.push(wsum > 0 ? f / wsum : 0);
      actionEv.push(ew > 0 ? e / ew : 0);
    }
    return { node: d, strategy, ev, freq, actionEv, reach };
  }
}

export { classLabel };
