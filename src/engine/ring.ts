// N-max(6~9인) 프리플랍 근사 솔버. 169 핸드 클래스 벡터 CFR(DCFR).
// 플랍을 보는 터미널은 "에퀴티 × 실현계수" 모델로 팟을 나눈다 (포스트플랍 플레이를 직접 풀지 않음).
// 3인 팟은 쌍별 에퀴티 곱으로 근사하고 팟 총량을 맞추도록 정규화한다. 카드 제거는 클래스 단위로 반영.
import { CLASS_COMBOS, COMBO_CARDS, NUM_CLASSES, classInfo } from "./cards";

export interface RingConfig {
  id: string;
  name: string;
  positions: string[]; // 프리플랍 액션 순서 (마지막 두 자리 = SB, BB)
  stack: number; // 시작 스택 (bb)
  sb: number;
  bb: number;
  ante: number; // 1인당 앤티 (bb)
  openTo: number[]; // 자리별 오픈 "to" 금액 (bb)
  threeBetIP: number; // 오프너 대비 배수 (포스트플랍 IP가 될 때)
  threeBetOOP: number; // 블라인드 등 OOP일 때
  squeezeAdd: number; // 콜러 1명당 추가 배수
  fourBet: number; // 3벳 대비 배수
  allinThresholdPct: number; // 레이즈가 스택의 이 % 이상이면 올인
  maxPlayersInPot: number; // 자발적 참여 인원 상한 (콜 허용 기준)
  coldCall3bet: boolean; // 3벳에 콜드콜 허용
  sbLimp: boolean;
  openJam: boolean; // 오픈 올인 허용 (숏스택)
  rakePct: number;
  rakeCap: number; // bb, 0=없음
  realization: { ip: number; oop: number; mwIp: number; mwOop: number };
}

export type RingActType = "fold" | "check" | "call" | "raise" | "allin";
export interface RingAction {
  type: RingActType;
  to: number; // 이 액션 후 해당 플레이어의 총 투자 (bb)
  label: string;
  code: string;
}
export interface RingDecision {
  kind: "decision";
  id: number;
  player: number;
  pot: number;
  invested: number[];
  folded: boolean[];
  toCall: number;
  raiseLevel: number; // 0 미오픈, 1 오픈, 2 3벳, 3 4벳, 4 5벳
  actions: RingAction[];
  children: RingNode[];
  line: string; // 사람이 읽는 액션 라인 (예: "UTG 2.5 · HJ F · CO C")
}
export interface RingTerminal {
  kind: "terminal";
  id: number;
  type: "fold" | "flop" | "allin";
  pot: number;
  invested: number[];
  folded: boolean[];
  allin: boolean[];
  winner: number; // fold일 때
}
export type RingNode = RingDecision | RingTerminal;

export interface RingTree {
  config: RingConfig;
  root: RingNode;
  decisions: RingDecision[];
  terminals: RingTerminal[];
}

const r2 = (x: number) => Math.round(x * 100) / 100;

/** 포스트플랍 행동 순서상 위치 (작을수록 먼저 행동 = OOP). 프리플랍 순서에서 SB, BB가 가장 먼저 */
export function postflopOrder(cfg: RingConfig, p: number): number {
  const N = cfg.positions.length;
  // 프리플랍 순서 0..N-3 = UTG..BTN, N-2 = SB, N-1 = BB → 포스트플랍: SB(0), BB(1), UTG(2)...
  if (p === N - 2) return 0;
  if (p === N - 1) return 1;
  return p + 2;
}

export function buildRingTree(cfg: RingConfig): RingTree {
  const N = cfg.positions.length;
  const decisions: RingDecision[] = [];
  const terminals: RingTerminal[] = [];
  const P = cfg.positions;

  interface St {
    invested: number[];
    folded: boolean[];
    allin: boolean[];
    voluntary: boolean[]; // 자발적으로 콜/레이즈 했는지 (블라인드 포스팅 제외)
    pending: boolean[]; // 아직 현재 베팅에 대해 행동해야 하는지
    current: number; // 현재 최고 투자액
    raiseLevel: number;
    lastRaiseTo: number;
    opener: number;
    callersSinceRaise: number;
    toAct: number;
    line: string[];
  }
  const potOf = (st: St) => r2(st.invested.reduce((a, b) => a + b, 0) + cfg.ante * N);
  const stackLeft = (st: St, p: number) => r2(cfg.stack - st.invested[p]);

  function nextToAct(st: St, from: number): number {
    for (let k = 1; k <= N; k++) {
      const q = (from + k) % N;
      if (st.pending[q] && !st.folded[q] && !st.allin[q]) return q;
    }
    return -1;
  }
  function terminal(st: St, type: RingTerminal["type"], winner: number): RingTerminal {
    const t: RingTerminal = { kind: "terminal", id: terminals.length, type, pot: potOf(st), invested: st.invested.slice(), folded: st.folded.slice(), allin: st.allin.slice(), winner };
    terminals.push(t);
    return t;
  }
  function clone(st: St): St {
    return { ...st, invested: st.invested.slice(), folded: st.folded.slice(), allin: st.allin.slice(), voluntary: st.voluntary.slice(), pending: st.pending.slice(), line: st.line.slice() };
  }
  function closeOrNext(st: St, actor: number): RingNode {
    const alive = st.folded.map((f, i) => (!f ? i : -1)).filter((i) => i >= 0);
    if (alive.length === 1) return terminal(st, "fold", alive[0]);
    const nx = nextToAct(st, actor);
    if (nx >= 0) {
      st.toAct = nx;
      return decision(st);
    }
    // 베팅 종료
    const canAct = alive.filter((i) => !st.allin[i]);
    if (canAct.length <= 1 && alive.some((i) => st.allin[i])) return terminal(st, "allin", -1);
    return terminal(st, "flop", -1);
  }
  function isOOPvs(p: number, q: number): boolean {
    return postflopOrder(cfg, p) < postflopOrder(cfg, q);
  }
  function decision(st: St): RingNode {
    const p = st.toAct;
    const toCall = r2(st.current - st.invested[p]);
    const node: RingDecision = { kind: "decision", id: decisions.length, player: p, pot: potOf(st), invested: st.invested.slice(), folded: st.folded.slice(), toCall, raiseLevel: st.raiseLevel, actions: [], children: [], line: st.line.join(" · ") || "시작" };
    decisions.push(node);
    const voluntaryCount = st.voluntary.filter((v, i) => v && !st.folded[i]).length;
    const add = (a: RingAction, child: RingNode) => {
      node.actions.push(a);
      node.children.push(child);
    };
    // 폴드 / 체크
    if (toCall > 0) {
      const s2 = clone(st);
      s2.folded[p] = true;
      s2.pending[p] = false;
      s2.line.push(`${P[p]} F`);
      add({ type: "fold", to: st.invested[p], label: "폴드", code: "F" }, closeOrNext(s2, p));
    } else {
      const s2 = clone(st);
      s2.pending[p] = false;
      s2.line.push(`${P[p]} X`);
      add({ type: "check", to: st.invested[p], label: "체크", code: "X" }, closeOrNext(s2, p));
    }
    // 콜
    if (toCall > 0) {
      const cold = !st.voluntary[p];
      let allowCall = true;
      if (st.raiseLevel >= 1 && cold && !(p === N - 1 && st.raiseLevel === 0)) {
        // 자발적 참여 인원 상한
        if (voluntaryCount + 1 > cfg.maxPlayersInPot) allowCall = false;
        if (st.raiseLevel >= 2 && !cfg.coldCall3bet) allowCall = false;
      }
      if (st.raiseLevel >= 2) {
        // 3벳 이후에는 헤즈업으로만 진행: 나 외에 살아있는 자발적 참여자가 1명일 때만 콜
        const others = st.voluntary.filter((v, i) => v && !st.folded[i] && i !== p).length;
        if (others !== 1) allowCall = false;
      }
      if (st.raiseLevel === 0) {
        // 림프: SB만 허용
        allowCall = cfg.sbLimp && p === N - 2;
      }
      if (allowCall) {
        const s2 = clone(st);
        const amt = Math.min(toCall, stackLeft(st, p));
        s2.invested[p] = r2(s2.invested[p] + amt);
        if (stackLeft(s2, p) <= 1e-9) s2.allin[p] = true;
        s2.pending[p] = false;
        s2.voluntary[p] = true;
        s2.callersSinceRaise++;
        if (st.raiseLevel === 0) {
          // SB 림프: BB는 체크/레이즈
          s2.pending[N - 1] = true;
        }
        s2.line.push(`${P[p]} ${st.raiseLevel === 0 ? "L" : "C"}`);
        add({ type: "call", to: s2.invested[p], label: st.raiseLevel === 0 ? "림프" : `콜 ${r2(amt)}`, code: st.raiseLevel === 0 ? "L" : "C" }, closeOrNext(s2, p));
      }
    }
    // 레이즈
    const stack = stackLeft(st, p);
    const maxTo = r2(st.invested[p] + stack);
    const candidates: Array<{ to: number; label: string }> = [];
    if (stack > toCall) {
      if (st.raiseLevel === 0) {
        const limped = st.voluntary.some((v, i) => v && i !== p);
        if (limped) {
          // BB가 SB 림프에 아이소 레이즈
          candidates.push({ to: r2(cfg.bb * 4), label: "레이즈" });
        } else {
          candidates.push({ to: cfg.openTo[p], label: "오픈" });
        }
        if (cfg.openJam) candidates.push({ to: maxTo, label: "올인" });
      } else if (st.raiseLevel === 1) {
        const oop = isOOPvs(p, st.opener);
        const mult = (oop ? cfg.threeBetOOP : cfg.threeBetIP) + cfg.squeezeAdd * st.callersSinceRaise;
        candidates.push({ to: r2(st.lastRaiseTo * mult), label: "3벳" });
      } else if (st.raiseLevel === 2) {
        candidates.push({ to: r2(st.lastRaiseTo * cfg.fourBet), label: "4벳" });
      } else if (st.raiseLevel === 3) {
        candidates.push({ to: maxTo, label: "올인" });
      }
    }
    const seen = new Set<number>();
    for (const c of candidates) {
      let to = c.to;
      let type: RingActType = "raise";
      if (to >= maxTo || to - st.invested[p] >= (cfg.allinThresholdPct / 100) * (cfg.stack - st.invested[p])) {
        to = maxTo;
        type = "allin";
      }
      if (to <= st.current || seen.has(to)) continue;
      seen.add(to);
      const s2 = clone(st);
      s2.invested[p] = to;
      if (type === "allin") s2.allin[p] = true;
      s2.voluntary[p] = true;
      s2.current = to;
      s2.lastRaiseTo = to;
      s2.raiseLevel = st.raiseLevel + 1;
      if (st.raiseLevel === 0) s2.opener = p;
      s2.callersSinceRaise = 0;
      for (let q = 0; q < N; q++) s2.pending[q] = q !== p && !s2.folded[q] && !s2.allin[q];
      s2.line.push(`${P[p]} ${type === "allin" ? "A" : to}`);
      add({ type, to, label: type === "allin" ? `올인 ${to}` : `${c.label} ${to}`, code: type === "allin" ? "A" : `R${to}` }, closeOrNext(s2, p));
    }
    return node;
  }

  const invested = new Array(N).fill(0);
  invested[N - 2] = cfg.sb;
  invested[N - 1] = cfg.bb;
  const st0: St = {
    invested,
    folded: new Array(N).fill(false),
    allin: new Array(N).fill(false),
    voluntary: new Array(N).fill(false),
    pending: new Array(N).fill(true),
    current: cfg.bb,
    raiseLevel: 0,
    lastRaiseTo: cfg.bb,
    opener: -1,
    callersSinceRaise: 0,
    toAct: 0,
    line: []
  };
  const root = decision(st0);
  return { config: cfg, root, decisions, terminals };
}

// ---------------- 에퀴티 / 카드 제거 / 실현계수 ----------------
export const CLASS_COUNT = new Float64Array(NUM_CLASSES);
for (let c = 0; c < NUM_CLASSES; c++) CLASS_COUNT[c] = CLASS_COMBOS[c].length;

/** compat[i*169+j] = 클래스 i의 대표 콤보와 충돌하지 않는 클래스 j 콤보 비율 (0~1) */
export function buildCompat(): Float64Array {
  const out = new Float64Array(NUM_CLASSES * NUM_CLASSES);
  for (let i = 0; i < NUM_CLASSES; i++) {
    // 클래스 내 모든 콤보 평균
    for (let j = 0; j < NUM_CLASSES; j++) {
      let tot = 0;
      for (const ci of CLASS_COMBOS[i]) {
        const [a, b] = COMBO_CARDS[ci];
        let cnt = 0;
        for (const cj of CLASS_COMBOS[j]) {
          const [x, y] = COMBO_CARDS[cj];
          if (x !== a && x !== b && y !== a && y !== b) cnt++;
        }
        tot += cnt;
      }
      out[i * NUM_CLASSES + j] = tot / CLASS_COMBOS[i].length / CLASS_COMBOS[j].length;
    }
  }
  return out;
}

/** 핸드 클래스의 플레이어빌리티 (실현계수 보정): 수딧·커넥터·페어 +, 오프수트 갭/로우 − */
export function playability(cls: number): number {
  const { hi, lo, kind } = classInfo(cls);
  if (kind === "pair") return 1.0 + (lo <= 6 ? 0.03 : lo >= 8 ? 0.02 : 0.01);
  let v = 1.0;
  const gap = hi - lo - 1;
  if (kind === "suited") {
    v += 0.06;
    if (gap === 0) v += 0.05;
    else if (gap === 1) v += 0.03;
    else if (gap === 2) v += 0.01;
  } else v -= 0.04;
  v -= 0.015 * Math.min(gap, 4);
  if (hi === 12) v += 0.02; // 에이스 하이
  if (hi <= 7 && kind === "offsuit") v -= 0.04;
  return v;
}

// ---------------- 솔버 ----------------
const ALPHA = 1.5;
const GAMMA = 2;

export interface RingMetrics {
  iterations: number;
  ev: number[]; // 자리별 EV (bb, 시작 대비 순이익: -투자 + 지분)
}

export class RingSolver {
  readonly tree: RingTree;
  readonly N: number;
  readonly eq: Float64Array; // 169x169
  readonly compat: Float64Array; // 169x169
  regret: Float64Array[];
  stratSum: Float64Array[];
  iterations = 0;
  private t = 1;
  private play: Float64Array;
  // 클래스 i와 랭크를 공유하는 j 목록 (compat < 1)
  private sparseJ: Int32Array[];
  private sparseD: Float64Array[];

  constructor(tree: RingTree, eqMatrix: Float64Array | Float32Array, compat: Float64Array) {
    this.tree = tree;
    this.N = tree.config.positions.length;
    this.eq = Float64Array.from(eqMatrix);
    this.compat = compat;
    this.regret = tree.decisions.map((d) => new Float64Array(d.actions.length * NUM_CLASSES));
    this.stratSum = tree.decisions.map((d) => new Float64Array(d.actions.length * NUM_CLASSES));
    this.play = new Float64Array(NUM_CLASSES);
    for (let c = 0; c < NUM_CLASSES; c++) this.play[c] = playability(c);
    this.sparseJ = [];
    this.sparseD = [];
    for (let i = 0; i < NUM_CLASSES; i++) {
      const js: number[] = [];
      const ds: number[] = [];
      for (let j = 0; j < NUM_CLASSES; j++) {
        const d = 1 - compat[i * NUM_CLASSES + j];
        if (d > 1e-12) {
          js.push(j);
          ds.push(d);
        }
      }
      this.sparseJ.push(Int32Array.from(js));
      this.sparseD.push(Float64Array.from(ds));
    }
  }

  /** S[i] = Σ_j r[j]·compat(i,j) (클래스 i와 양립 가능한 상대 질량) */
  private mass(r: Float64Array, out: Float64Array): void {
    let T = 0;
    for (let j = 0; j < NUM_CLASSES; j++) T += r[j];
    for (let i = 0; i < NUM_CLASSES; i++) {
      const js = this.sparseJ[i];
      const ds = this.sparseD[i];
      let s = T;
      for (let k = 0; k < js.length; k++) s -= r[js[k]] * ds[k];
      out[i] = s;
    }
  }

  private rakedPot(pot: number, sawFlop: boolean): number {
    const c = this.tree.config;
    if (!sawFlop || c.rakePct <= 0) return pot;
    let rake = (pot * c.rakePct) / 100;
    if (c.rakeCap > 0 && rake > c.rakeCap) rake = c.rakeCap;
    return pot - rake;
  }

  private realization(p: number, opps: number[], allin: boolean): (i: number) => number {
    if (allin) return () => 1;
    const c = this.tree.config;
    const isIP = opps.every((q) => postflopOrder(c, p) > postflopOrder(c, q));
    const multi = opps.length >= 2;
    const base = multi ? (isIP ? c.realization.mwIp : c.realization.mwOop) : isIP ? c.realization.ip : c.realization.oop;
    // 플레이어빌리티 효과는 OOP·멀티웨이에서 더 크게
    const k = isIP ? 0.6 : 1.0;
    return (i: number) => base * (1 + k * (this.play[i] - 1));
  }

  /** 터미널 CFV (p의 클래스별) */
  private terminal(t: RingTerminal, p: number, r: Float64Array[], S: Float64Array[], out: Float64Array): void {
    const N = this.N;
    const n = NUM_CLASSES;
    // 폴드한 다른 플레이어들의 질량 곱
    const base = new Float64Array(n).fill(1);
    const activeOpps: number[] = [];
    for (let q = 0; q < N; q++) {
      if (q === p) continue;
      if (t.folded[q] || t.type === "fold") {
        const s = S[q];
        for (let i = 0; i < n; i++) base[i] *= s[i];
      } else activeOpps.push(q);
    }
    const I = t.invested[p];
    if (t.type === "fold") {
      const u = t.winner === p ? t.pot - I : -I;
      for (let i = 0; i < n; i++) out[i] = u * base[i];
      return;
    }
    if (t.folded[p]) {
      // p는 이미 폴드: 활성 상대 질량만 곱함
      for (const q of activeOpps) {
        const s = S[q];
        for (let i = 0; i < n; i++) base[i] *= s[i];
      }
      for (let i = 0; i < n; i++) out[i] = -I * base[i];
      return;
    }
    const sawFlop = t.type === "flop";
    const pot = this.rakedPot(t.pot, sawFlop);
    const allinT = t.type === "allin";
    const eq = this.eq;
    const cp = this.compat;
    if (activeOpps.length === 1) {
      const q = activeOpps[0];
      const Rp = this.realization(p, [q], allinT);
      const Rq = this.realization(q, [p], allinT);
      const rq = r[q];
      for (let i = 0; i < n; i++) {
        let v = 0;
        let m = 0;
        const rpi = Rp(i);
        for (let j = 0; j < n; j++) {
          const w = rq[j];
          if (w === 0) continue;
          const c = cp[i * n + j];
          if (c === 0) continue;
          const e = eq[i * n + j];
          const a = e * rpi;
          const b = (1 - e) * Rq(j);
          const share = a + b > 0 ? a / (a + b) : 0.5;
          v += w * c * share;
          m += w * c;
        }
        out[i] = base[i] * (pot * v - I * m);
      }
      return;
    }
    // 멀티웨이 (2명 이상 상대): 쌍별 에퀴티 곱, 팟 총량 정규화
    const players = [p, ...activeOpps];
    // 각 플레이어 x에 대해 상대 y별 평균 승률 벡터 A_xy[i] = Σ_j r_y[j] c(i,j) e(i,j) / Σ_j r_y[j] c(i,j)
    const winVs = (x: number, y: number): Float64Array => {
      const ry = r[y];
      const o = new Float64Array(n);
      for (let i = 0; i < n; i++) {
        let v = 0;
        let m = 0;
        for (let j = 0; j < n; j++) {
          const w = ry[j];
          if (w === 0) continue;
          const c = cp[i * n + j] * w;
          v += c * eq[i * n + j];
          m += c;
        }
        o[i] = m > 0 ? v / m : 0;
      }
      return o;
    };
    const wp = new Float64Array(n).fill(1);
    const Rp = this.realization(p, activeOpps, allinT);
    for (const q of activeOpps) {
      const a = winVs(p, q);
      for (let i = 0; i < n; i++) wp[i] *= a[i];
    }
    for (let i = 0; i < n; i++) wp[i] *= Rp(i);
    // 정규화 상수: 모든 활성 플레이어의 기대 가중치 합
    let D = 0;
    for (const x of players) {
      const others = players.filter((y) => y !== x);
      const Rx = this.realization(x, others, allinT);
      const wx = new Float64Array(n).fill(1);
      for (const y of others) {
        const a = winVs(x, y);
        for (let i = 0; i < n; i++) wx[i] *= a[i];
      }
      let num = 0;
      let den = 0;
      const rx = r[x];
      for (let i = 0; i < n; i++) {
        num += rx[i] * wx[i] * Rx(i);
        den += rx[i];
      }
      D += den > 0 ? num / den : 0;
    }
    if (D <= 0) D = 1;
    let m = new Float64Array(n).fill(1);
    for (const q of activeOpps) {
      const s = S[q];
      for (let i = 0; i < n; i++) m[i] *= s[i];
    }
    for (let i = 0; i < n; i++) out[i] = base[i] * m[i] * (pot * (wp[i] / D) - I);
  }

  private sigma(d: RingDecision, avg: boolean, out: Float64Array): void {
    const n = NUM_CLASSES;
    const A = d.actions.length;
    const src = avg ? this.stratSum[d.id] : this.regret[d.id];
    for (let i = 0; i < n; i++) {
      let sum = 0;
      for (let a = 0; a < A; a++) {
        const v = src[a * n + i];
        if (v > 0) sum += v;
      }
      for (let a = 0; a < A; a++) out[a * n + i] = sum > 0 ? Math.max(src[a * n + i], 0) / sum : 1 / A;
    }
  }

  private record: Map<number, Float64Array> | null = null;

  private traverse(node: RingNode, p: number, r: Float64Array[], S: Float64Array[], out: Float64Array, mode: "train" | "avg" | "br"): void {
    const n = NUM_CLASSES;
    if (node.kind === "terminal") {
      this.terminal(node, p, r, S, out);
      return;
    }
    const d = node;
    const A = d.actions.length;
    const sig = new Float64Array(A * n);
    this.sigma(d, mode !== "train", sig);
    const q = d.player;
    if (q === p) {
      const outs: Float64Array[] = [];
      for (let a = 0; a < A; a++) {
        const o = new Float64Array(n);
        if (mode === "train") {
          const r2 = r.slice();
          const rp = new Float64Array(n);
          for (let i = 0; i < n; i++) rp[i] = r[p][i] * sig[a * n + i];
          r2[p] = rp;
          this.traverse(d.children[a], p, r2, S, o, mode);
        } else this.traverse(d.children[a], p, r, S, o, mode);
        outs.push(o);
      }
      if (this.record && mode === "avg") {
        // 액션별 EV(bb, 이 노드 기준 순이익: 폴드=0) = CFV / 상대 질량 + 이미 투자한 금액
        const M = new Float64Array(n).fill(1);
        for (let x = 0; x < this.N; x++) if (x !== p) for (let i = 0; i < n; i++) M[i] *= S[x][i];
        const ev = new Float64Array(A * n);
        for (let a = 0; a < A; a++) for (let i = 0; i < n; i++) ev[a * n + i] = M[i] > 0 ? outs[a][i] / M[i] + d.invested[p] : 0;
        this.record.set(d.id, ev);
      }
      if (mode === "br") {
        for (let i = 0; i < n; i++) {
          let b = -Infinity;
          for (let a = 0; a < A; a++) if (outs[a][i] > b) b = outs[a][i];
          out[i] = b;
        }
        return;
      }
      out.fill(0);
      for (let a = 0; a < A; a++) for (let i = 0; i < n; i++) out[i] += sig[a * n + i] * outs[a][i];
      if (mode === "train") {
        const t = this.t;
        const posD = Math.pow(t, ALPHA) / (Math.pow(t, ALPHA) + 1);
        const stratD = Math.pow(t / (t + 1), GAMMA);
        const reg = this.regret[d.id];
        const ss = this.stratSum[d.id];
        const rp = r[p];
        for (let a = 0; a < A; a++) {
          for (let i = 0; i < n; i++) {
            const k = a * n + i;
            let v = reg[k];
            v = v > 0 ? v * posD : v * 0.5;
            reg[k] = v + (outs[a][i] - out[i]);
            ss[k] = ss[k] * stratD + rp[i] * sig[k];
          }
        }
      }
    } else {
      out.fill(0);
      const tmp = new Float64Array(n);
      for (let a = 0; a < A; a++) {
        const rq = new Float64Array(n);
        for (let i = 0; i < n; i++) rq[i] = r[q][i] * sig[a * n + i];
        const r2 = r.slice();
        r2[q] = rq;
        const S2 = S.slice();
        const sq = new Float64Array(n);
        this.mass(rq, sq);
        S2[q] = sq;
        this.traverse(d.children[a], p, r2, S2, tmp, mode);
        for (let i = 0; i < n; i++) out[i] += tmp[i];
      }
    }
  }

  private rootReach(): { r: Float64Array[]; S: Float64Array[] } {
    const r: Float64Array[] = [];
    const S: Float64Array[] = [];
    for (let q = 0; q < this.N; q++) {
      const v = Float64Array.from(CLASS_COUNT);
      r.push(v);
      const s = new Float64Array(NUM_CLASSES);
      this.mass(v, s);
      S.push(s);
    }
    return { r, S };
  }

  step(iters: number): void {
    const out = new Float64Array(NUM_CLASSES);
    for (let k = 0; k < iters; k++) {
      this.t = this.iterations + 1;
      for (let p = 0; p < this.N; p++) {
        const { r, S } = this.rootReach();
        this.traverse(this.tree.root, p, r, S, out, "train");
      }
      this.iterations++;
    }
  }

  /** 자리별 EV와 최적응답 이득 (bb) */
  metrics(): { iterations: number; ev: number[]; br: number[]; exploitability: number } {
    const ev: number[] = [];
    const br: number[] = [];
    const n = NUM_CLASSES;
    for (let p = 0; p < this.N; p++) {
      for (const mode of ["avg", "br"] as const) {
        const { r, S } = this.rootReach();
        const out = new Float64Array(n);
        this.traverse(this.tree.root, p, r, S, out, mode);
        // 정규화: Σ_i count_i · out_i / Σ_i count_i · M_i
        let num = 0;
        let den = 0;
        const M = new Float64Array(n).fill(1);
        for (let q = 0; q < this.N; q++) if (q !== p) for (let i = 0; i < n; i++) M[i] *= S[q][i];
        for (let i = 0; i < n; i++) {
          num += CLASS_COUNT[i] * out[i];
          den += CLASS_COUNT[i] * M[i];
        }
        const v = num / den;
        if (mode === "avg") ev.push(v);
        else br.push(v);
      }
    }
    let gap = 0;
    for (let p = 0; p < this.N; p++) gap += br[p] - ev[p];
    return { iterations: this.iterations, ev, br, exploitability: gap / this.N };
  }

  /** 모든 결정 노드의 액션별 EV (평균 전략 기준) */
  actionEVs(): Map<number, Float64Array> {
    this.record = new Map();
    const out = new Float64Array(NUM_CLASSES);
    for (let p = 0; p < this.N; p++) {
      const { r, S } = this.rootReach();
      this.traverse(this.tree.root, p, r, S, out, "avg");
    }
    const res = this.record;
    this.record = null;
    return res;
  }

  avgStrategy(d: RingDecision): Float64Array {
    const o = new Float64Array(d.actions.length * NUM_CLASSES);
    this.sigma(d, true, o);
    return o;
  }

  /** 각 결정 노드에 도달하는 reach (평균 전략 기준). 노드 id → 자리별 169 벡터 */
  reachAll(): Map<number, Float64Array[]> {
    const res = new Map<number, Float64Array[]>();
    const walk = (node: RingNode, r: Float64Array[]) => {
      if (node.kind === "terminal") return;
      res.set(node.id, r);
      const sig = this.avgStrategy(node);
      const n = NUM_CLASSES;
      node.actions.forEach((_, a) => {
        const rq = new Float64Array(n);
        for (let i = 0; i < n; i++) rq[i] = r[node.player][i] * sig[a * n + i];
        const r2 = r.slice();
        r2[node.player] = rq;
        walk(node.children[a], r2);
      });
    };
    walk(this.tree.root, Array.from({ length: this.N }, () => Float64Array.from(CLASS_COUNT)));
    return res;
  }
}

// ---------------- 기본 포맷 ----------------
export const RING_FORMATS: RingConfig[] = [
  {
    id: "cash6-100",
    name: "캐시 6맥스 100bb",
    positions: ["UTG", "HJ", "CO", "BTN", "SB", "BB"],
    stack: 100,
    sb: 0.5,
    bb: 1,
    ante: 0,
    openTo: [2.5, 2.5, 2.5, 2.5, 3, 0],
    threeBetIP: 3,
    threeBetOOP: 4,
    squeezeAdd: 1,
    fourBet: 2.25,
    allinThresholdPct: 40,
    maxPlayersInPot: 3,
    coldCall3bet: false,
    sbLimp: false,
    openJam: false,
    rakePct: 0,
    rakeCap: 0,
    realization: { ip: 1.06, oop: 0.86, mwIp: 1.0, mwOop: 0.85 }
  },
  {
    id: "mtt8-40",
    name: "토너먼트 8맥스 40bb (앤티)",
    positions: ["UTG", "UTG1", "LJ", "HJ", "CO", "BTN", "SB", "BB"],
    stack: 40,
    sb: 0.5,
    bb: 1,
    ante: 0.125,
    openTo: [2.2, 2.2, 2.2, 2.2, 2.2, 2.2, 3, 0],
    threeBetIP: 2.8,
    threeBetOOP: 3.6,
    squeezeAdd: 1,
    fourBet: 2.2,
    allinThresholdPct: 40,
    maxPlayersInPot: 3,
    coldCall3bet: false,
    sbLimp: true,
    openJam: false,
    rakePct: 0,
    rakeCap: 0,
    realization: { ip: 1.04, oop: 0.88, mwIp: 1.0, mwOop: 0.86 }
  }
];
