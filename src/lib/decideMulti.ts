// 결정 모델의 3명 이상 포스트플랍 (decide.ts 가 부른다): 남은 사람을 모두 넣어 MultiSolver 로 푼다.
// 예전에는 나와 주 상대 한 명의 승부로 줄여 풀어 셋째 사람의 레인지가 플랍·턴 액션으로 좁혀지지도 않았다.
//  - 리버: 끝까지 (벳 33·75%, 레이즈 60%)
//  - 턴: 턴 베팅(66%, 레이즈 60%)을 풀고 리버 8장을 딜해 체크다운
//  - 플랍: 플랍 베팅(33%, 레이즈 60%)을 풀고 (턴, 리버) 10쌍을 딜해 체크다운
// 3인 쇼다운은 상대끼리의 카드 겹침을 무시한 근사(approx)다. 정확한 포함-배제는 수십 배 느려 2초에 몇 번밖에 못 돈다.
import { mulberry32 } from "../engine/cards";
import { buildMultiTree, MultiSolver, type MNode, type MultiTreeConfig } from "../engine/multi";
import type { Action, SizingSet } from "../engine/tree";

/** 3명 이상 포스트플랍을 이 풀이로 푸는 최대 인원. 그보다 많으면 예전처럼 둘의 승부로 줄인다 */
export const MULTI_MAX = 4;
/** 지금 스트리트 크기 (모두 같음). 멀티웨이는 트리가 인원 수만큼 커져 한 크기로 줄인다 (리버만 두 크기) */
const NOW: SizingSet[] = [
  { bet: [33], raise: [60] },
  { bet: [66], raise: [60] },
  { bet: [33, 75], raise: [60] }
];
const NONE: SizingSet = { bet: [], raise: [] };
/**
 * 잎 뒤에 딜할 표본: 플랍은 (턴, 리버) 쌍, 턴은 리버 장수. 뒤는 체크다운.
 * 3인 턴을 리버 베팅까지 2분 푼 해와 비교(4.5초): 체크다운·리버 8장 0.40%, 16장 0.42%,
 * 리버 베팅 75%·리버 4장 0.78%·6장 0.68% (반복이 20~35회로 줄어 오히려 나빴다). 2초면 체크다운 8장이 1.04%
 */
const RUNOUTS = [10, 8];
/** 실제 액션이 풀이에서 레인지의 이 비율보다 적게 나오면 레인지 전체로 그렇게 했다고 본다 (decide.ts 와 같은 값) */
const RARE = 0.05;
/** 이보다 적게 돌았으면 notes 에 알린다 */
const NEED = [12, 15, 60];
const r2 = (x: number) => Math.round(x * 100) / 100;
const r3 = (x: number) => Math.round(x * 1000) / 1000;

export interface MultiAct {
  pos: string;
  type: "fold" | "check" | "call" | "bet" | "raise";
  to?: number;
  allin?: boolean;
}
export interface MultiStreetInput {
  /** 0 플랍, 1 턴, 2 리버 */
  street: 0 | 1 | 2;
  /** 이 스트리트의 보드 (3~5장) */
  board: number[];
  pot: number;
  left: number;
  /** 남은 사람의 자리 이름, 포스트플랍 행동 순서 (0 이 먼저) */
  names: string[];
  /** 자리별 1326 콤보 가중치 */
  ranges: Float32Array[];
  hero: number;
  combo: number;
  actions: MultiAct[];
  /** 지금 결정할 스트리트인지 (아니면 레인지만 좁혀 다음 스트리트로) */
  current: boolean;
  /** 반복을 멈출 시각 (Date.now 기준) */
  until: number;
  /** 실제로 나온 첫 벳 크기(팟 대비 %)가 기본과 많이 다르면 그 값 (0 = 없음) */
  extra: number;
  /** 이 스트리트에 올인이 나왔는지 */
  jam: boolean;
  /** 같은 핸드의 앞 결정에서 푼 것을 다시 쓰기 위한 키 */
  key: string;
}
export interface MultiOption {
  type: string;
  label: string;
  amount: number;
  freq: number;
  ev: number;
}
export interface MultiStreetResult {
  notes: string[];
  iterations: number;
  /** current 일 때: 내 차례의 액션별 빈도·EV */
  options?: MultiOption[];
  exploitabilityPct?: number;
  /** current 가 아닐 때: 다음 스트리트로 넘길 팟·스택·폴드한 자리(names 번호)·좁혀진 레인지 */
  pot: number;
  left: number;
  folded: number[];
  ranges: Float32Array[];
}

/** 실제 액션을 트리 액션 번호로 (금액이 가장 가까운 벳·레이즈, 올인이면 올인을 우선) */
export function mapAction(node: { actions: Action[] }, type: MultiAct["type"], amount: number, allin: boolean): number {
  const find = (t: string) => node.actions.findIndex((x) => x.type === t);
  if (type === "fold" || type === "check") return find(type);
  if (type === "call") return find("call") >= 0 ? find("call") : find("check");
  let best = -1;
  let bd = Infinity;
  node.actions.forEach((x, k) => {
    if (x.type !== "bet" && x.type !== "raise" && x.type !== "allin") return;
    const d = Math.abs(x.amount - amount) + (allin && x.type !== "allin" ? 1000 : 0);
    if (d < bd) {
      bd = d;
      best = k;
    }
  });
  return best;
}

const cache = new Map<string, MultiSolver>();

function solverFor(inp: MultiStreetInput): MultiSolver {
  const hit = cache.get(inp.key);
  if (hit) return hit;
  const si = inp.street;
  const now: SizingSet = { ...NOW[si], bet: inp.extra ? [...NOW[si].bet, inp.extra] : NOW[si].bet };
  const sizes = si === 0 ? { flop: now, turn: NONE, river: NONE } : si === 1 ? { flop: NONE, turn: now, river: NONE } : { flop: NONE, turn: NONE, river: now };
  const cfg: MultiTreeConfig = { board: inp.board, pot: inp.pot, effStack: inp.left, rakePct: 0, rakeCap: 0, players: inp.names.length, sizes, allinThresholdPct: 67, maxRaisesPerStreet: 2, includeAllin: inp.jam };
  // 섞은 덱 앞에서 표본을 고른다. 플랍은 (i, i+1) 쌍이라 모든 카드가 고르게 나온다
  const deck: number[] = [];
  for (let c = 0; c < 52; c++) if (!inp.board.includes(c)) deck.push(c);
  const rnd = mulberry32(1);
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  const runouts = si === 0 ? Array.from({ length: RUNOUTS[0] }, (_, i) => [deck[i], deck[(i + 1) % deck.length]]) : si === 1 ? deck.slice(0, RUNOUTS[1]).map((c) => [c]) : undefined;
  const s = new MultiSolver(buildMultiTree(cfg), inp.ranges, { runouts, approx: true });
  if (cache.size >= 8) cache.clear();
  cache.set(inp.key, s);
  return s;
}

/** 한 스트리트: 풀고, 실제 액션대로 모든 사람의 레인지를 좁힌다. 지금 스트리트면 내 차례의 답을 낸다 */
export function multiStreet(inp: MultiStreetInput): MultiStreetResult {
  const notes: string[] = [];
  const note = (s: string) => {
    if (!notes.includes(s)) notes.push(s);
  };
  const name = ["flop", "turn", "river"][inp.street];
  const solver = solverFor(inp);
  while (solver.iterationCount < 2 || (solver.iterationCount < 1000 && Date.now() < inp.until)) solver.step(1);
  const n = solver.n;
  const ctx = solver.walk([]).ctx;
  const reach = solver.w.map((v) => v.slice());
  const put = new Map<number, number>();
  const folded: number[] = [];
  let rare = false;
  let cur = 0;
  let at: MNode = solver.tree.root;
  for (const a of inp.actions) {
    const s = inp.names.indexOf(a.pos);
    if (s < 0 || folded.includes(s)) throw new Error(`${name}: ${a.pos} 는 이 핸드에 남아 있지 않습니다`);
    const before = put.get(s) ?? 0;
    let to = before;
    if (a.type === "call") to = Math.min(cur, inp.left);
    else if (a.type === "bet" || a.type === "raise") {
      const t = a.allin && a.to === undefined ? inp.left : a.to;
      if (!(t !== undefined && t > cur)) throw new Error(`${name}: ${a.pos} ${a.type} 의 to(이 스트리트 총액)가 필요합니다`);
      to = Math.min(t, inp.left);
    }
    put.set(s, to);
    cur = Math.max(cur, to);
    const idx = at.kind === "decision" && at.player === s ? mapAction(at, a.type, to - before, to >= inp.left - 0.01) : -1;
    if (idx < 0 || at.kind !== "decision") throw new Error(`${name}: ${a.pos} ${a.type} 를 트리에서 따라갈 수 없습니다 (순서나 금액 확인)`);
    const mapped = at.actions[idx].amount;
    if (to > before && Math.abs(mapped - (to - before)) / (to - before) > 0.35) note(`${name}: ${a.pos} 의 ${r2(to - before)}bb 를 트리의 ${mapped}bb 로 보고 계산했습니다(크기 차이 큼)`);
    const avg = solver.avgStrategy(at, ctx);
    const r = reach[s];
    const next = new Float32Array(n);
    let tot = 0;
    let was = 0;
    for (let h = 0; h < n; h++) {
      was += r[h];
      tot += next[h] = r[h] * avg[idx * n + h];
    }
    // 풀이에서 거의 안 나오는 액션은 그 노드의 전략을 믿을 수 없다 → 레인지 전체로 그렇게 했다고 본다
    if (tot / was >= RARE) reach[s] = next;
    else {
      note(`${name}: ${a.pos} ${a.type} 는 GTO 라인에 거의 없는 액션이라 레인지 전체로 그렇게 했다고 보고 계산했습니다`);
      if (s !== inp.hero) rare = true;
    }
    if (a.type === "fold") folded.push(s);
    at = at.children[idx];
  }
  const result: MultiStreetResult = { notes, iterations: solver.iterationCount, pot: inp.pot, left: inp.left, folded, ranges: [] };
  if (inp.current) {
    if (at.kind !== "decision" || at.player !== inp.hero) throw new Error("지금은 내 차례가 아닙니다");
    const an = solver.actionValues(at, ctx, reach);
    const slot = solver.slotOfCombo[inp.combo];
    const options = at.actions.map((x, k) => ({ type: x.type, label: x.label, amount: x.amount, freq: r3(an.strategy[k * n + slot]), ev: r3(an.ev[k * n + slot]) }));
    if (rare) {
      const best = options.reduce((b, o, k) => (o.ev > options[b].ev ? k : b), 0);
      options.forEach((o, k) => (o.freq = k === best ? 1 : 0));
      note("상대의 직전 액션이 GTO 라인에 드물어, 빈도 대신 EV 가 가장 높은 액션을 골랐습니다");
    }
    note(
      `${inp.names.length}명 팟을 모두 넣어 풀었습니다 (` +
        [`플랍 베팅을 풀고 턴·리버 ${RUNOUTS[0]}쌍을 딜해 체크다운한 깊이 제한`, `턴 베팅을 풀고 리버 ${RUNOUTS[1]}장을 딜해 체크다운한 깊이 제한`, "리버 끝까지"][inp.street] +
        `, 한 크기 트리). 쇼다운은 상대끼리 카드가 겹치는 경우를 무시한 근사입니다`
    );
    if (solver.iterationCount < NEED[inp.street]) note(`멀티웨이 풀이를 시간 안에 ${solver.iterationCount}회밖에 못 돌아 수렴이 덜 됐을 수 있습니다`);
    if (inp.street === 2) result.exploitabilityPct = r3(solver.metrics().exploitabilityPct);
    result.options = options;
    return result;
  }
  // 다음 스트리트로: 팟·스택과, 남은 사람마다 좁혀진 레인지
  if (at.kind === "decision" && inp.names.length - folded.length >= 2) throw new Error(`${name}: 액션이 끝나지 않았는데 다음 카드가 있습니다 (콜·체크가 빠졌는지 확인)`);
  let add = 0;
  let mx = 0;
  for (const v of put.values()) {
    add += v;
    mx = Math.max(mx, v);
  }
  result.pot = r2(inp.pot + add);
  result.left = r2(inp.left - mx);
  result.ranges = reach.map((r) => {
    const top = r.reduce((m, x) => Math.max(m, x), 0);
    const out = new Float32Array(1326);
    if (top > 0) for (let h = 0; h < n; h++) if (r[h] / top >= 0.005) out[solver.combo[h]] = r[h] / top;
    return out;
  });
  return result;
}
