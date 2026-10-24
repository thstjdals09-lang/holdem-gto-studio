// 멀티웨이(2~6인) 포스트플랍 트리 + 벡터화 DCFR 솔버.
// 플레이어 인덱스 = 포스트플랍 액션 순서 (0이 가장 먼저, P-1이 마지막=IP).
// 터미널 질량: 상대 2명까지는 카드 충돌을 포함-배제로 정확히 계산, 3명 이상은 상대 간 겹침을 무시(근사).
// 폴드한 플레이어의 카드 제거(번칭)는 반영하지 않는다. 모든 플레이어의 유효 스택은 동일하다고 가정한다.
import { COMBO_CARDS, NUM_COMBOS, comboIndex } from "./cards";
import { evaluate } from "./evaluator";
import type { RangeWeights } from "./range";
import type { Action, SizingSet, Street, StreetSizings } from "./tree";

export interface MultiTreeConfig {
  board: number[];
  pot: number;
  effStack: number;
  rakePct: number;
  rakeCap: number;
  players: number; // 2..6
  sizes: StreetSizings; // 모든 플레이어 공통
  allinThresholdPct: number;
  maxRaisesPerStreet: number;
  includeAllin: boolean;
}

export interface MDecision {
  kind: "decision";
  id: number;
  player: number;
  street: Street;
  pot: number;
  invested: number[];
  toCall: number;
  active: boolean[];
  allin: boolean[];
  actions: Action[];
  children: MNode[];
}
export interface MChance {
  kind: "chance";
  id: number;
  street: Street;
  pot: number;
  invested: number[];
  active: boolean[];
  children: (MNode | null)[];
  allin: boolean;
}
export interface MTerminal {
  kind: "terminal";
  id: number;
  type: "fold" | "showdown";
  pot: number;
  invested: number[];
  active: boolean[];
  winner: number; // fold 터미널의 승자, showdown이면 -1
}
export type MNode = MDecision | MChance | MTerminal;

export interface MultiTree {
  root: MNode;
  config: MultiTreeConfig;
  startStreet: Street;
  decisionNodes: MDecision[];
  chanceNodes: MChance[];
  terminals: MTerminal[];
}

const r2 = (x: number) => Math.round(x * 100) / 100;

export function streetOfBoard(n: number): Street {
  if (n === 3) return 1;
  if (n === 4) return 2;
  if (n === 5) return 3;
  throw new Error(`보드는 3~5장이어야 합니다 (현재 ${n}장)`);
}

interface St {
  street: Street;
  pot: number;
  invested: number[];
  streetBet: number[];
  active: boolean[];
  allin: boolean[];
  needToAct: boolean[];
  toAct: number;
  currentBet: number;
  raises: number;
}

export function buildMultiTree(cfg: MultiTreeConfig): MultiTree {
  const P = cfg.players;
  if (P < 2 || P > 6) throw new Error("플레이어 수는 2~6명이어야 합니다");
  const decisionNodes: MDecision[] = [];
  const chanceNodes: MChance[] = [];
  const terminals: MTerminal[] = [];
  const startStreet = streetOfBoard(cfg.board.length);
  const dead = new Set(cfg.board);

  const sizesFor = (street: Street): SizingSet => (street === 1 ? cfg.sizes.flop : street === 2 ? cfg.sizes.turn : cfg.sizes.river);
  const stackOf = (st: St, p: number) => r2(cfg.effStack - st.invested[p]);
  const activeCount = (st: St) => st.active.filter(Boolean).length;
  const canActCount = (st: St) => st.active.filter((a, i) => a && !st.allin[i]).length;

  function terminal(st: St, type: "fold" | "showdown", winner: number): MTerminal {
    const t: MTerminal = { kind: "terminal", id: terminals.length, type, pot: st.pot, invested: st.invested.slice(), active: st.active.slice(), winner };
    terminals.push(t);
    return t;
  }

  function nextActor(st: St, from: number): number {
    for (let k = 1; k <= P; k++) {
      const q = (from + k) % P;
      if (st.needToAct[q] && st.active[q] && !st.allin[q]) return q;
    }
    return -1;
  }

  function endStreet(st: St): MNode {
    if (st.street === 3) return terminal(st, "showdown", -1);
    const next = (st.street + 1) as Street;
    const allinRunout = canActCount(st) <= 1;
    const node: MChance = { kind: "chance", id: chanceNodes.length, street: next, pot: st.pot, invested: st.invested.slice(), active: st.active.slice(), children: new Array(52).fill(null), allin: allinRunout };
    chanceNodes.push(node);
    const st2: St = {
      street: next,
      pot: st.pot,
      invested: st.invested.slice(),
      streetBet: new Array(P).fill(0),
      active: st.active.slice(),
      allin: st.allin.slice(),
      needToAct: st.active.map((a, i) => a && !st.allin[i]),
      toAct: -1,
      currentBet: 0,
      raises: 0
    };
    let child: MNode;
    if (allinRunout) child = endStreet(st2);
    else {
      st2.toAct = nextActor(st2, P - 1);
      child = decision(st2);
    }
    for (let c = 0; c < 52; c++) if (!dead.has(c)) node.children[c] = child;
    return node;
  }

  function afterPassive(st: St, p: number): MNode {
    // 체크/콜 뒤: 더 행동할 사람이 없으면 스트리트 종료
    st.needToAct[p] = false;
    const nx = nextActor(st, p);
    if (nx < 0) return endStreet(st);
    st.toAct = nx;
    return decision(st);
  }

  function sizeActions(st: St, p: number): Array<{ action: Action; put: number }> {
    const out: Array<{ action: Action; put: number }> = [];
    const stack = stackOf(st, p);
    if (stack <= 0 || st.raises >= cfg.maxRaisesPerStreet) return out;
    const toCall = st.currentBet - st.streetBet[p];
    if (stack <= toCall) return out;
    const siz = sizesFor(st.street);
    const cand: Array<{ put: number; type: "bet" | "raise"; pct: number }> = [];
    if (st.currentBet === 0) {
      for (const pct of siz.bet) cand.push({ put: Math.max(1, r2((pct / 100) * st.pot)), type: "bet", pct });
    } else {
      for (const pct of siz.raise) {
        let raiseBy = r2((pct / 100) * (st.pot + toCall));
        if (raiseBy < toCall) raiseBy = toCall;
        cand.push({ put: r2(toCall + raiseBy), type: "raise", pct });
      }
    }
    const seen = new Set<number>();
    let hasAllin = false;
    for (const c of cand) {
      let put = c.put;
      let type: Action["type"] = c.type;
      if (put >= stack || (cfg.allinThresholdPct > 0 && put >= (cfg.allinThresholdPct / 100) * stack)) {
        put = stack;
        type = "allin";
      }
      put = r2(put);
      if (put <= toCall || seen.has(put)) continue;
      seen.add(put);
      if (type === "allin") hasAllin = true;
      const label = type === "allin" ? `올인 ${put}` : c.type === "bet" ? `벳 ${c.pct}% (${put})` : `레이즈 ${c.pct}% (${put})`;
      out.push({ action: { type, amount: put, label, code: type === "allin" ? "A" : c.type === "bet" ? `B${c.pct}` : `R${c.pct}` }, put });
    }
    if (cfg.includeAllin && !hasAllin && !seen.has(stack)) out.push({ action: { type: "allin", amount: stack, label: `올인 ${stack}`, code: "A" }, put: stack });
    out.sort((x, y) => x.put - y.put);
    return out;
  }

  function decision(st: St): MNode {
    const p = st.toAct;
    const toCall = r2(st.currentBet - st.streetBet[p]);
    const node: MDecision = { kind: "decision", id: decisionNodes.length, player: p, street: st.street, pot: st.pot, invested: st.invested.slice(), toCall, active: st.active.slice(), allin: st.allin.slice(), actions: [], children: [] };
    decisionNodes.push(node);
    const clone = (s: St): St => ({ ...s, invested: s.invested.slice(), streetBet: s.streetBet.slice(), active: s.active.slice(), allin: s.allin.slice(), needToAct: s.needToAct.slice() });
    if (toCall > 0) {
      // 폴드
      {
        const s2 = clone(st);
        s2.active[p] = false;
        s2.needToAct[p] = false;
        node.actions.push({ type: "fold", amount: 0, label: "폴드", code: "F" });
        if (activeCount(s2) === 1) node.children.push(terminal(s2, "fold", s2.active.indexOf(true)));
        else {
          const nx = nextActor(s2, p);
          if (nx < 0) node.children.push(endStreet(s2));
          else {
            s2.toAct = nx;
            node.children.push(decision(s2));
          }
        }
      }
      // 콜
      {
        const s2 = clone(st);
        const stack = stackOf(s2, p);
        const amt = r2(Math.min(toCall, stack));
        s2.invested[p] = r2(s2.invested[p] + amt);
        s2.streetBet[p] = r2(s2.streetBet[p] + amt);
        s2.pot = r2(s2.pot + amt);
        if (stack - amt <= 1e-9) s2.allin[p] = true;
        node.actions.push({ type: "call", amount: amt, label: `콜 ${amt}`, code: "C" });
        node.children.push(afterPassive(s2, p));
      }
    } else {
      const s2 = clone(st);
      node.actions.push({ type: "check", amount: 0, label: "체크", code: "X" });
      node.children.push(afterPassive(s2, p));
    }
    for (const { action, put } of sizeActions(st, p)) {
      const s2 = clone(st);
      s2.invested[p] = r2(s2.invested[p] + put);
      s2.streetBet[p] = r2(s2.streetBet[p] + put);
      s2.pot = r2(s2.pot + put);
      s2.currentBet = s2.streetBet[p];
      s2.raises++;
      if (stackOf(s2, p) <= 1e-9) s2.allin[p] = true;
      for (let q = 0; q < P; q++) s2.needToAct[q] = q !== p && s2.active[q] && !s2.allin[q];
      node.actions.push(action);
      const nx = nextActor(s2, p);
      if (nx < 0) node.children.push(endStreet(s2));
      else {
        s2.toAct = nx;
        node.children.push(decision(s2));
      }
    }
    return node;
  }

  const st0: St = {
    street: startStreet,
    pot: cfg.pot,
    invested: new Array(P).fill(0),
    streetBet: new Array(P).fill(0),
    active: new Array(P).fill(true),
    allin: new Array(P).fill(false),
    needToAct: new Array(P).fill(true),
    toAct: 0,
    currentBet: 0,
    raises: 0
  };
  const root = decision(st0);
  return { root, config: cfg, startStreet, decisionNodes, chanceNodes, terminals };
}

export function estimateMultiTree(cfg: MultiTreeConfig): { decision: number; actionSlots: number } {
  const t = buildMultiTree(cfg);
  const R = 52 - cfg.board.length;
  let decision = 0;
  let actionSlots = 0;
  for (const n of t.decisionNodes) {
    let m = 1;
    if (n.street > t.startStreet) m *= R;
    if (n.street > t.startStreet + 1) m *= R;
    decision += m;
    actionSlots += m * n.actions.length;
  }
  return { decision, actionSlots };
}

// ---------------- 솔버 ----------------
export interface MCtx {
  board: number[];
  tIdx: number;
  rIdx: number;
}
export type MPathStep = { kind: "action"; index: number } | { kind: "card"; card: number };

export interface MDecisionAnalysis {
  node: MDecision;
  strategy: Float32Array; // A*nH
  ev: Float32Array; // A*nH
  handEv: Float32Array;
  equity: Float32Array;
  reach: Float32Array[]; // P
  M: Float32Array; // 상대 조합 질량
  actionFreq: number[];
  actionEv: number[];
  rangeEv: number;
  rangeEquity: number;
}

const ALPHA = 1.5;
const GAMMA = 2;

interface BoardEval {
  strength: Int32Array;
  order: Int32Array;
}

export class MultiSolver {
  readonly tree: MultiTree;
  readonly P: number;
  readonly n: number;
  readonly combo: Int32Array;
  readonly ha: Uint8Array;
  readonly hb: Uint8Array;
  readonly slotOfCombo: Int32Array;
  readonly handsWithCard: Int32Array[];
  readonly w: Float32Array[]; // P
  readonly inRange: Uint8Array[]; // P, 슬롯이 플레이어 레인지에 있는지
  readonly remaining: number[];
  readonly cardIdx: Int8Array;
  readonly R: number;
  readonly mult: Int32Array;
  regret: Float32Array[];
  stratSum: Float32Array[];
  private boardCache = new Map<number, BoardEval>();
  private pool: Float32Array[][] = [];
  private iterations = 0;
  private elapsedMs = 0;
  private t = 1;
  private Z: number[]; // 플레이어별 정규화 상수
  // 작업 버퍼
  private tot: Float64Array[]; // 상대별 총 reach
  private totc: Float64Array[]; // 상대별 카드별 reach (52)
  private cumAll: Float64Array;
  private cumc: Float64Array[];
  private grpAll: Float64Array;
  private grpc: Float64Array[];
  private slotPair = new Int32Array(52 * 52);

  constructor(tree: MultiTree, ranges: RangeWeights[]) {
    this.tree = tree;
    this.P = tree.config.players;
    if (ranges.length !== this.P) throw new Error("레인지 수가 플레이어 수와 다릅니다");
    const dead = new Set(tree.config.board);
    const combos: number[] = [];
    this.slotOfCombo = new Int32Array(NUM_COMBOS).fill(-1);
    for (let i = 0; i < NUM_COMBOS; i++) {
      let any = false;
      for (const r of ranges) if (r[i] > 0) any = true;
      if (!any) continue;
      const [a, b] = COMBO_CARDS[i];
      if (dead.has(a) || dead.has(b)) continue;
      this.slotOfCombo[i] = combos.length;
      combos.push(i);
    }
    this.n = combos.length;
    if (this.n === 0) throw new Error("레인지에 보드와 충돌하지 않는 콤보가 없습니다");
    this.combo = Int32Array.from(combos);
    this.ha = new Uint8Array(this.n);
    this.hb = new Uint8Array(this.n);
    const lists: number[][] = Array.from({ length: 52 }, () => []);
    for (let s = 0; s < this.n; s++) {
      const [a, b] = COMBO_CARDS[combos[s]];
      this.ha[s] = a;
      this.hb[s] = b;
      lists[a].push(s);
      lists[b].push(s);
    }
    this.handsWithCard = lists.map((l) => Int32Array.from(l));
    for (let a = 0; a < 52; a++) for (let b = 0; b < 52; b++) this.slotPair[a * 52 + b] = a === b ? -1 : this.slotOfCombo[comboIndex(a, b)];
    this.w = ranges.map((r) => {
      const v = new Float32Array(this.n);
      for (let s = 0; s < this.n; s++) v[s] = r[combos[s]];
      return v;
    });
    this.inRange = this.w.map((v) => Uint8Array.from(v, (x) => (x > 0 ? 1 : 0)));
    this.remaining = [];
    this.cardIdx = new Int8Array(52).fill(-1);
    for (let c = 0; c < 52; c++) if (!dead.has(c)) {
      this.cardIdx[c] = this.remaining.length;
      this.remaining.push(c);
    }
    this.R = this.remaining.length;
    this.mult = new Int32Array(tree.decisionNodes.length);
    this.regret = [];
    this.stratSum = [];
    for (const d of tree.decisionNodes) {
      let m = 1;
      if (d.street > tree.startStreet) m *= this.R;
      if (d.street > tree.startStreet + 1) m *= this.R;
      this.mult[d.id] = m;
      this.regret.push(new Float32Array(m * d.actions.length * this.n));
      this.stratSum.push(new Float32Array(m * d.actions.length * this.n));
    }
    this.tot = Array.from({ length: this.P }, () => new Float64Array(1));
    this.totc = Array.from({ length: this.P }, () => new Float64Array(52));
    this.cumAll = new Float64Array(this.P);
    this.cumc = Array.from({ length: this.P }, () => new Float64Array(52));
    this.grpAll = new Float64Array(this.P);
    this.grpc = Array.from({ length: this.P }, () => new Float64Array(52));
    // Z_p = Σ_h w_p[h] · M_h(초기 상대 reach)
    this.Z = [];
    const M = new Float32Array(this.n);
    for (let p = 0; p < this.P; p++) {
      this.massVector(p, this.w, M);
      let z = 0;
      for (let h = 0; h < this.n; h++) z += this.w[p][h] * M[h];
      this.Z.push(z);
    }
  }

  static estimateBytes(tree: MultiTree, nH: number): number {
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

  get iterationCount() {
    return this.iterations;
  }

  private buf(depth: number, slot: number): Float32Array {
    let d = this.pool[depth];
    if (!d) this.pool[depth] = d = [];
    let b = d[slot];
    if (!b) d[slot] = b = new Float32Array(this.n);
    return b;
  }

  private boardKey(board: number[]): number {
    const s = board.slice().sort((x, y) => x - y);
    let k = 0;
    for (const c of s) k = k * 52 + c;
    return k;
  }
  private evalBoard(board: number[]): BoardEval {
    const key = this.boardKey(board);
    let e = this.boardCache.get(key);
    if (e) return e;
    const strength = new Int32Array(this.n);
    const dead = new Set(board);
    const cards = new Array<number>(7);
    for (let i = 0; i < 5; i++) cards[i] = board[i];
    const live: number[] = [];
    for (let s = 0; s < this.n; s++) {
      if (dead.has(this.ha[s]) || dead.has(this.hb[s])) {
        strength[s] = -1;
        continue;
      }
      cards[5] = this.ha[s];
      cards[6] = this.hb[s];
      strength[s] = evaluate(cards, 7);
      live.push(s);
    }
    const order = Int32Array.from(live);
    order.sort((x, y) => strength[x] - strength[y]);
    e = { strength, order };
    this.boardCache.set(key, e);
    return e;
  }

  private rakedPot(pot: number): number {
    const cfg = this.tree.config;
    if (cfg.rakePct <= 0) return pot;
    let rake = (pot * cfg.rakePct) / 100;
    if (cfg.rakeCap > 0 && rake > cfg.rakeCap) rake = cfg.rakeCap;
    return pot - rake;
  }

  /** 상대(p 제외 전원)의 비충돌 조합 질량 M[h] */
  private massVector(p: number, r: Float32Array[], out: Float32Array): void {
    const opps: number[] = [];
    for (let q = 0; q < this.P; q++) if (q !== p) opps.push(q);
    this.computeTotals(opps, r);
    const n = this.n;
    if (opps.length === 1) {
      const j = opps[0];
      const tc = this.totc[j];
      const T = this.tot[j][0];
      for (let h = 0; h < n; h++) out[h] = T - tc[this.ha[h]] - tc[this.hb[h]] + r[j][h];
      return;
    }
    if (opps.length === 2) {
      const [j1, j2] = opps;
      const r1 = r[j1];
      const r2v = r[j2];
      const t1c = this.totc[j1];
      const t2c = this.totc[j2];
      const T1 = this.tot[j1][0];
      const T2 = this.tot[j2][0];
      // 동일 콤보 항
      let totI = 0;
      const totIc = new Float64Array(52);
      for (let h = 0; h < n; h++) {
        const v = r1[h] * r2v[h];
        if (v === 0) continue;
        totI += v;
        totIc[this.ha[h]] += v;
        totIc[this.hb[h]] += v;
      }
      for (let h = 0; h < n; h++) {
        const a = this.ha[h];
        const b = this.hb[h];
        const T1h = T1 - t1c[a] - t1c[b] + r1[h];
        const T2h = T2 - t2c[a] - t2c[b] + r2v[h];
        let cross = 0;
        for (let c = 0; c < 52; c++) {
          if (c === a || c === b) continue;
          const sa = this.slotPair[c * 52 + a];
          const sb = this.slotPair[c * 52 + b];
          const x1 = t1c[c] - (sa >= 0 ? r1[sa] : 0) - (sb >= 0 ? r1[sb] : 0);
          const x2 = t2c[c] - (sa >= 0 ? r2v[sa] : 0) - (sb >= 0 ? r2v[sb] : 0);
          cross += x1 * x2;
        }
        const I = totI - totIc[a] - totIc[b] + r1[h] * r2v[h];
        out[h] = T1h * T2h - cross + I;
      }
      return;
    }
    // 3명 이상: 독립 근사
    for (let h = 0; h < n; h++) {
      let m = 1;
      for (const j of opps) m *= this.tot[j][0] - this.totc[j][this.ha[h]] - this.totc[j][this.hb[h]] + r[j][h];
      out[h] = m;
    }
  }

  private computeTotals(opps: number[], r: Float32Array[]): void {
    for (const j of opps) {
      const tc = this.totc[j];
      tc.fill(0);
      let t = 0;
      const rj = r[j];
      for (let h = 0; h < this.n; h++) {
        const v = rj[h];
        if (v === 0) continue;
        t += v;
        tc[this.ha[h]] += v;
        tc[this.hb[h]] += v;
      }
      this.tot[j][0] = t;
    }
  }

  /** 폴드 터미널 */
  private foldCFV(t: MTerminal, p: number, r: Float32Array[], out: Float32Array): void {
    const potPrime = this.rakedPot(t.pot);
    const u = t.winner === p ? potPrime - t.invested[p] : -t.invested[p];
    this.massVector(p, r, out);
    for (let h = 0; h < this.n; h++) out[h] *= u;
  }

  /**
   * 쇼다운. active 상대와 강도를 비교하고, 폴드한 상대는 질량만 기여.
   * out[h] = potPrime * share(h) - I * M(h)
   */
  private showdownCFV(board: number[], p: number, active: boolean[], r: Float32Array[], potPrime: number, I: number, out: Float32Array): void {
    const n = this.n;
    if (!active[p]) {
      this.massVector(p, r, out);
      for (let h = 0; h < n; h++) out[h] *= -I;
      return;
    }
    const opps: number[] = [];
    for (let q = 0; q < this.P; q++) if (q !== p) opps.push(q);
    const ev = this.evalBoard(board);
    const { strength, order } = ev;
    this.computeTotals(opps, r);
    // 누적 배열 초기화
    for (const j of opps) {
      this.cumc[j].fill(0);
      this.cumAll[j] = 0;
    }
    out.fill(0);
    const k = opps.length;
    const m = order.length;
    const ha = this.ha;
    const hb = this.hb;
    if (k === 1) {
      const j = opps[0];
      const rj = r[j];
      const tc = this.totc[j];
      const T = this.tot[j][0];
      const cum = this.cumc[j];
      const gc = this.grpc[j];
      const actJ = active[j];
      let cumAll = 0;
      let i = 0;
      while (i < m) {
        let e = i;
        const s = strength[order[i]];
        let gAll = 0;
        gc.fill(0);
        while (e < m && strength[order[e]] === s) {
          const h = order[e];
          const v = rj[h];
          gAll += v;
          gc[ha[h]] += v;
          gc[hb[h]] += v;
          e++;
        }
        for (let q = i; q < e; q++) {
          const h = order[q];
          const a = ha[h];
          const b = hb[h];
          const Th = T - tc[a] - tc[b] + rj[h];
          let share: number;
          if (actJ) {
            const W = cumAll - cum[a] - cum[b];
            const E = gAll - gc[a] - gc[b] + rj[h];
            share = W + 0.5 * E;
          } else share = Th; // 상대가 폴드: 항상 이김
          out[h] = potPrime * share - I * Th;
        }
        for (let q = i; q < e; q++) {
          const h = order[q];
          const v = rj[h];
          cumAll += v;
          cum[ha[h]] += v;
          cum[hb[h]] += v;
        }
        i = e;
      }
      return;
    }
    if (k === 2) {
      const [j1, j2] = opps;
      const r1 = r[j1];
      const r2v = r[j2];
      const act1 = active[j1];
      const act2 = active[j2];
      const t1c = this.totc[j1];
      const t2c = this.totc[j2];
      const T1 = this.tot[j1][0];
      const T2 = this.tot[j2][0];
      const cum1 = this.cumc[j1];
      const cum2 = this.cumc[j2];
      const g1 = this.grpc[j1];
      const g2 = this.grpc[j2];
      // 동일 콤보 누적
      let totI = 0;
      const totIc = new Float64Array(52);
      for (let h = 0; h < n; h++) {
        const v = r1[h] * r2v[h];
        if (v === 0) continue;
        totI += v;
        totIc[ha[h]] += v;
        totIc[hb[h]] += v;
      }
      let cumI = 0;
      const cumIc = new Float64Array(52);
      let cum1All = 0;
      let cum2All = 0;
      let i = 0;
      while (i < m) {
        let e = i;
        const s = strength[order[i]];
        let g1All = 0;
        let g2All = 0;
        let gI = 0;
        g1.fill(0);
        g2.fill(0);
        const gIc = this.grpc[p]; // p의 grp 버퍼를 임시로 사용
        gIc.fill(0);
        while (e < m && strength[order[e]] === s) {
          const h = order[e];
          const v1 = r1[h];
          const v2 = r2v[h];
          g1All += v1;
          g2All += v2;
          g1[ha[h]] += v1;
          g1[hb[h]] += v1;
          g2[ha[h]] += v2;
          g2[hb[h]] += v2;
          const vi = v1 * v2;
          gI += vi;
          gIc[ha[h]] += vi;
          gIc[hb[h]] += vi;
          e++;
        }
        for (let q = i; q < e; q++) {
          const h = order[q];
          if (this.w[p][h] === 0) continue; // p의 레인지 밖이면 계산 불필요
          const a = ha[h];
          const b = hb[h];
          // 상대별 카테고리 값: W(약함), E(동점), T(전체)
          const W1 = cum1All - cum1[a] - cum1[b];
          const W2 = cum2All - cum2[a] - cum2[b];
          const E1 = g1All - g1[a] - g1[b] + r1[h];
          const E2 = g2All - g2[a] - g2[b] + r2v[h];
          const T1h = T1 - t1c[a] - t1c[b] + r1[h];
          const T2h = T2 - t2c[a] - t2c[b] + r2v[h];
          // 교차항: Σ_c X1c(h)·X2c(h)
          let xWW = 0;
          let xEW = 0;
          let xWE = 0;
          let xEE = 0;
          let xTW = 0;
          let xWT = 0;
          let xTE = 0;
          let xET = 0;
          let xTT = 0;
          for (let c = 0; c < 52; c++) {
            if (c === a || c === b) continue;
            const sa = this.slotPair[c * 52 + a];
            const sb = this.slotPair[c * 52 + b];
            let w1 = cum1[c];
            let w2 = cum2[c];
            let e1 = g1[c];
            let e2 = g2[c];
            let t1 = t1c[c];
            let t2 = t2c[c];
            if (sa >= 0) {
              const st = strength[sa];
              if (st >= 0) {
                t1 -= r1[sa];
                t2 -= r2v[sa];
                if (st < s) {
                  w1 -= r1[sa];
                  w2 -= r2v[sa];
                } else if (st === s) {
                  e1 -= r1[sa];
                  e2 -= r2v[sa];
                }
              }
            }
            if (sb >= 0) {
              const st = strength[sb];
              if (st >= 0) {
                t1 -= r1[sb];
                t2 -= r2v[sb];
                if (st < s) {
                  w1 -= r1[sb];
                  w2 -= r2v[sb];
                } else if (st === s) {
                  e1 -= r1[sb];
                  e2 -= r2v[sb];
                }
              }
            }
            xWW += w1 * w2;
            xEW += e1 * w2;
            xWE += w1 * e2;
            xEE += e1 * e2;
            xTW += t1 * w2;
            xWT += w1 * t2;
            xTE += t1 * e2;
            xET += e1 * t2;
            xTT += t1 * t2;
          }
          const IW = cumI - cumIc[a] - cumIc[b]; // 둘 다 약한 동일 콤보
          const IE = gI - gIc[a] - gIc[b] + r1[h] * r2v[h]; // 둘 다 동점 동일 콤보 (h 자신 제외)
          const IT = totI - totIc[a] - totIc[b] + r1[h] * r2v[h];
          let share: number;
          if (act1 && act2) {
            const ww = W1 * W2 - xWW + IW;
            const ew = E1 * W2 - xEW;
            const we = W1 * E2 - xWE;
            const ee = E1 * E2 - xEE + IE;
            share = ww + 0.5 * (ew + we) + ee / 3;
          } else if (act1) {
            const wt = W1 * T2h - xWT + IW;
            const et = E1 * T2h - xET + IE;
            share = wt + 0.5 * et;
          } else if (act2) {
            const tw = T1h * W2 - xTW + IW;
            const te = T1h * E2 - xTE + IE;
            share = tw + 0.5 * te;
          } else share = T1h * T2h - xTT + IT;
          const M = T1h * T2h - xTT + IT;
          out[h] = potPrime * share - I * M;
        }
        for (let q = i; q < e; q++) {
          const h = order[q];
          const v1 = r1[h];
          const v2 = r2v[h];
          cum1All += v1;
          cum2All += v2;
          cum1[ha[h]] += v1;
          cum1[hb[h]] += v1;
          cum2[ha[h]] += v2;
          cum2[hb[h]] += v2;
          const vi = v1 * v2;
          cumI += vi;
          cumIc[ha[h]] += vi;
          cumIc[hb[h]] += vi;
        }
        i = e;
      }
      return;
    }
    // k >= 3: 독립 근사 (상대 간 카드 겹침 무시)
    const Wv: Float64Array[] = opps.map(() => new Float64Array(n));
    const Ev: Float64Array[] = opps.map(() => new Float64Array(n));
    for (let oi = 0; oi < k; oi++) {
      const j = opps[oi];
      const rj = r[j];
      const cum = this.cumc[j];
      const gc = this.grpc[j];
      let cumAll = 0;
      let i = 0;
      while (i < m) {
        let e = i;
        const s = strength[order[i]];
        let gAll = 0;
        gc.fill(0);
        while (e < m && strength[order[e]] === s) {
          const h = order[e];
          const v = rj[h];
          gAll += v;
          gc[ha[h]] += v;
          gc[hb[h]] += v;
          e++;
        }
        for (let q = i; q < e; q++) {
          const h = order[q];
          Wv[oi][h] = cumAll - cum[ha[h]] - cum[hb[h]];
          Ev[oi][h] = gAll - gc[ha[h]] - gc[hb[h]] + rj[h];
        }
        for (let q = i; q < e; q++) {
          const h = order[q];
          const v = rj[h];
          cumAll += v;
          cum[ha[h]] += v;
          cum[hb[h]] += v;
        }
        i = e;
      }
    }
    for (let q = 0; q < m; q++) {
      const h = order[q];
      if (this.w[p][h] === 0) continue;
      let share = 1;
      let M = 1;
      for (let oi = 0; oi < k; oi++) {
        const j = opps[oi];
        const Th = this.tot[j][0] - this.totc[j][ha[h]] - this.totc[j][hb[h]] + r[j][h];
        M *= Th;
        share *= active[j] ? Wv[oi][h] + 0.5 * Ev[oi][h] : Th;
      }
      out[h] = potPrime * share - I * M;
    }
  }

  private offset(d: MDecision, ctx: MCtx): number {
    const m = this.mult[d.id];
    if (m === 1) return 0;
    const A = d.actions.length * this.n;
    if (m === this.R) return ctx.tIdx * A;
    return (ctx.tIdx * this.R + ctx.rIdx) * A;
  }

  private sigmaPool: Float32Array[][] = [];
  private sigmaBuf(depth: number, A: number): Float32Array {
    let d = this.sigmaPool[depth];
    if (!d) this.sigmaPool[depth] = d = [];
    let b = d[A];
    if (!b) d[A] = b = new Float32Array(A * this.n);
    return b;
  }

  private regretMatch(reg: Float32Array, off: number, A: number, sigma: Float32Array): void {
    const n = this.n;
    for (let h = 0; h < n; h++) {
      let sum = 0;
      for (let a = 0; a < A; a++) {
        const v = reg[off + a * n + h];
        if (v > 0) sum += v;
      }
      if (sum > 0) for (let a = 0; a < A; a++) sigma[a * n + h] = Math.max(reg[off + a * n + h], 0) / sum;
      else for (let a = 0; a < A; a++) sigma[a * n + h] = 1 / A;
    }
  }

  avgStrategy(d: MDecision, ctx: MCtx, out?: Float32Array): Float32Array {
    const n = this.n;
    const A = d.actions.length;
    const off = this.offset(d, ctx);
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

  nextCtx(ctx: MCtx, node: MChance, c: number): MCtx {
    const level = node.street - this.tree.startStreet;
    return { board: ctx.board.concat([c]), tIdx: level === 1 ? this.cardIdx[c] : ctx.tIdx, rIdx: level === 2 ? this.cardIdx[c] : ctx.rIdx };
  }

  private activeCountOf(active: boolean[]): number {
    let k = 0;
    for (const a of active) if (a) k++;
    return k;
  }

  /** mode: 'train'(regret 갱신), 'avg'(평균 전략 평가), 'br'(p 최적 응답) */
  private traverse(node: MNode, depth: number, ctx: MCtx, p: number, r: Float32Array[], out: Float32Array, mode: "train" | "avg" | "br"): void {
    const n = this.n;
    if (node.kind === "terminal") {
      if (node.type === "fold") this.foldCFV(node, p, r, out);
      else this.showdownCFV(ctx.board, p, node.active, r, this.rakedPot(node.pot), node.invested[p], out);
      return;
    }
    if (node.kind === "chance") {
      out.fill(0);
      const tmp = this.buf(depth, 0);
      const r2: Float32Array[] = [];
      for (let q = 0; q < this.P; q++) r2.push(this.buf(depth, 1 + q));
      const inBoard = new Set(ctx.board);
      // 유효한 다음 카드 수: 살아있는 카드 − (모든 플레이어 핸드 2장씩; 폴드한 플레이어 카드는 무시하므로 활성 플레이어만)
      const k = this.activeCountOf(node.active);
      let count = 0;
      for (const c of this.remaining) {
        if (inBoard.has(c)) continue;
        const child = node.children[c];
        if (!child) continue;
        count++;
        for (let q = 0; q < this.P; q++) r2[q].set(r[q]);
        const hw = this.handsWithCard[c];
        for (let q = 0; q < this.P; q++) for (let x = 0; x < hw.length; x++) r2[q][hw[x]] = 0;
        this.traverse(child, depth + 1, this.nextCtx(ctx, node, c), p, r2, tmp, mode);
        for (let h = 0; h < n; h++) out[h] += tmp[h];
        for (let x = 0; x < hw.length; x++) out[hw[x]] -= tmp[hw[x]];
      }
      const valid = count - 2 * k;
      if (valid > 0) {
        const inv = 1 / valid;
        for (let h = 0; h < n; h++) out[h] *= inv;
      }
      return;
    }
    const d = node;
    const A = d.actions.length;
    const q = d.player;
    const sigma = this.sigmaBuf(depth, A);
    if (mode === "train") this.regretMatch(this.regret[d.id], this.offset(d, ctx), A, sigma);
    else this.avgStrategy(d, ctx, sigma);
    if (q === p) {
      if (mode === "br") {
        const tmp = this.buf(depth, 0);
        out.fill(-Infinity);
        for (let a = 0; a < A; a++) {
          this.traverse(d.children[a], depth + 1, ctx, p, r, tmp, mode);
          for (let h = 0; h < n; h++) if (tmp[h] > out[h]) out[h] = tmp[h];
        }
        return;
      }
      const outs: Float32Array[] = [];
      const rP2 = this.buf(depth, 1);
      const r2 = r.slice();
      r2[p] = rP2;
      for (let a = 0; a < A; a++) {
        const oa = this.buf(depth, 2 + this.P + a);
        outs.push(oa);
        for (let h = 0; h < n; h++) rP2[h] = r[p][h] * sigma[a * n + h];
        this.traverse(d.children[a], depth + 1, ctx, p, mode === "train" ? r2 : r, oa, mode);
      }
      out.fill(0);
      for (let a = 0; a < A; a++) {
        const oa = outs[a];
        for (let h = 0; h < n; h++) out[h] += sigma[a * n + h] * oa[h];
      }
      if (mode === "train") {
        const t = this.t;
        const posD = Math.pow(t, ALPHA) / (Math.pow(t, ALPHA) + 1);
        const stratD = Math.pow(t / (t + 1), GAMMA);
        const reg = this.regret[d.id];
        const ss = this.stratSum[d.id];
        const off = this.offset(d, ctx);
        const rP = r[p];
        for (let a = 0; a < A; a++) {
          const oa = outs[a];
          const base = off + a * n;
          for (let h = 0; h < n; h++) {
            let v = reg[base + h];
            v = v > 0 ? v * posD : v * 0.5;
            reg[base + h] = v + (oa[h] - out[h]);
            ss[base + h] = ss[base + h] * stratD + rP[h] * sigma[a * n + h];
          }
        }
      }
    } else {
      out.fill(0);
      const rq = this.buf(depth, 1);
      const tmp = this.buf(depth, 0);
      const r2 = r.slice();
      r2[q] = rq;
      for (let a = 0; a < A; a++) {
        for (let h = 0; h < n; h++) rq[h] = r[q][h] * sigma[a * n + h];
        this.traverse(d.children[a], depth + 1, ctx, p, r2, tmp, mode);
        for (let h = 0; h < n; h++) out[h] += tmp[h];
      }
    }
  }

  private rootCtx(): MCtx {
    return { board: this.tree.config.board.slice(), tIdx: -1, rIdx: -1 };
  }

  step(iters: number): void {
    const t0 = performance.now();
    const out = new Float32Array(this.n);
    for (let i = 0; i < iters; i++) {
      this.t = this.iterations + 1;
      for (let p = 0; p < this.P; p++) this.traverse(this.tree.root, 0, this.rootCtx(), p, this.w, out, "train");
      this.iterations++;
    }
    this.elapsedMs += performance.now() - t0;
  }

  private rootValue(p: number, mode: "avg" | "br"): number {
    const out = new Float32Array(this.n);
    this.traverse(this.tree.root, 0, this.rootCtx(), p, this.w, out, mode);
    let v = 0;
    for (let h = 0; h < this.n; h++) if (this.w[p][h] > 0 && isFinite(out[h])) v += this.w[p][h] * out[h];
    return v / this.Z[p];
  }

  metrics(): { iterations: number; exploitabilityPct: number; ev: number[]; br: number[]; elapsedMs: number } {
    const ev: number[] = [];
    const br: number[] = [];
    let gap = 0;
    for (let p = 0; p < this.P; p++) {
      ev.push(this.rootValue(p, "avg"));
      br.push(this.rootValue(p, "br"));
      gap += br[p] - ev[p];
    }
    return { iterations: this.iterations, exploitabilityPct: (gap / this.P / this.tree.config.pot) * 100, ev, br, elapsedMs: this.elapsedMs };
  }

  walk(path: MPathStep[]): { node: MNode; ctx: MCtx; reach: Float32Array[] } {
    const n = this.n;
    let node: MNode = this.tree.root;
    let ctx = this.rootCtx();
    const reach = this.w.map((v) => new Float32Array(v));
    for (const step of path) {
      if (node.kind === "decision" && step.kind === "action") {
        const sigma = this.avgStrategy(node, ctx);
        const r = reach[node.player];
        for (let h = 0; h < n; h++) r[h] *= sigma[step.index * n + h];
        node = node.children[step.index];
      } else if (node.kind === "chance" && step.kind === "card") {
        const child = node.children[step.card];
        if (!child || ctx.board.includes(step.card)) throw new Error("사용할 수 없는 카드");
        const hw = this.handsWithCard[step.card];
        for (const r of reach) for (let x = 0; x < hw.length; x++) r[hw[x]] = 0;
        ctx = this.nextCtx(ctx, node, step.card);
        node = child;
      } else throw new Error("경로가 트리와 맞지 않습니다");
    }
    return { node, ctx, reach };
  }

  /** p의 핸드별 에퀴티 (활성 상대 대비, 런아웃 평균) */
  equityVector(ctx: MCtx, p: number, active: boolean[], reach: Float32Array[]): Float32Array {
    const n = this.n;
    const num = new Float64Array(n);
    const den = new Float64Array(n);
    const tmp = new Float32Array(n);
    const M = new Float32Array(n);
    const inBoard = new Set(ctx.board);
    const need = 5 - ctx.board.length;
    const runouts: number[][] = [];
    if (need === 0) runouts.push([]);
    else if (need === 1) for (const c of this.remaining) if (!inBoard.has(c)) runouts.push([c]);
    else {
      const live = this.remaining.filter((c) => !inBoard.has(c));
      for (let i = 0; i < live.length; i++) for (let j = i + 1; j < live.length; j++) runouts.push([live[i], live[j]]);
    }
    const r2 = reach.map((r) => new Float32Array(r));
    for (const ro of runouts) {
      for (let q = 0; q < this.P; q++) r2[q].set(reach[q]);
      for (const c of ro) {
        const hw = this.handsWithCard[c];
        for (let q = 0; q < this.P; q++) for (let x = 0; x < hw.length; x++) r2[q][hw[x]] = 0;
      }
      const board = ctx.board.concat(ro);
      this.showdownCFV(board, p, active, r2, 1, 0, tmp);
      this.massVector(p, r2, M);
      const dead = new Set(ro);
      for (let h = 0; h < n; h++) {
        if (dead.has(this.ha[h]) || dead.has(this.hb[h])) continue;
        num[h] += tmp[h];
        den[h] += M[h];
      }
    }
    const out = new Float32Array(n);
    for (let h = 0; h < n; h++) out[h] = den[h] > 0 ? num[h] / den[h] : 0;
    return out;
  }

  analyzeDecision(d: MDecision, ctx: MCtx, reach: Float32Array[]): MDecisionAnalysis {
    const n = this.n;
    const A = d.actions.length;
    const p = d.player;
    const strategy = this.avgStrategy(d, ctx);
    const ev = new Float32Array(A * n);
    const M = new Float32Array(n);
    this.massVector(p, reach, M);
    const tmp = new Float32Array(n);
    for (let a = 0; a < A; a++) {
      this.traverse(d.children[a], 1, ctx, p, reach, tmp, "avg");
      for (let h = 0; h < n; h++) ev[a * n + h] = M[h] > 0 ? tmp[h] / M[h] + d.invested[p] : 0;
    }
    const handEv = new Float32Array(n);
    for (let h = 0; h < n; h++) {
      let v = 0;
      for (let a = 0; a < A; a++) v += strategy[a * n + h] * ev[a * n + h];
      handEv[h] = v;
    }
    const equity = this.equityVector(ctx, p, d.active, reach);
    const rP = reach[p];
    const actionFreq: number[] = [];
    const actionEv: number[] = [];
    let wsum = 0;
    let rangeEv = 0;
    let rangeEq = 0;
    for (let h = 0; h < n; h++) {
      const wgt = rP[h] * M[h];
      wsum += wgt;
      rangeEv += wgt * handEv[h];
      rangeEq += wgt * equity[h];
    }
    for (let a = 0; a < A; a++) {
      let f = 0;
      let e = 0;
      let ew = 0;
      for (let h = 0; h < n; h++) {
        const wgt = rP[h] * M[h];
        f += wgt * strategy[a * n + h];
        e += wgt * strategy[a * n + h] * ev[a * n + h];
        ew += wgt * strategy[a * n + h];
      }
      actionFreq.push(wsum > 0 ? f / wsum : 0);
      actionEv.push(ew > 0 ? e / ew : 0);
    }
    return { node: d, strategy, ev, handEv, equity, reach, M, actionFreq, actionEv, rangeEv: wsum > 0 ? rangeEv / wsum : 0, rangeEquity: wsum > 0 ? rangeEq / wsum : 0 };
  }

  serializeStrategy(): Float32Array {
    let total = 0;
    for (const s of this.stratSum) total += s.length;
    const out = new Float32Array(total);
    let off = 0;
    const n = this.n;
    for (const d of this.tree.decisionNodes) {
      const ss = this.stratSum[d.id];
      const A = d.actions.length;
      const m = this.mult[d.id];
      for (let r = 0; r < m; r++) {
        const base = r * A * n;
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
