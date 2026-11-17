// 행동 결정 모델: 지금 상황(자리·카드·액션·보드)을 주면 내 차례의 액션별 빈도·EV와 추천 액션을 돌려준다.
// 프리플랍은 미리 푼 8맥스 라이브러리 조회. 포스트플랍은 그 자리에서 푼다 — 리버는 끝까지(PostflopSolver),
// 플랍·턴은 지금 스트리트만(StreetSolver). 시간 예산 안에서 멈추므로 3초 안에 답한다.
import { COMBO_CLASS, NUM_CLASSES, comboIndex, parseCards } from "../engine/cards";
import { postflopOrder } from "../engine/ring";
import { PostflopSolver, type HandSet } from "../engine/solver";
import { StreetSolver } from "../engine/street";
import { buildTree, type DecisionNode, type GameTree, type TreeConfig, type TreeNode } from "../engine/tree";
import { mapPreflopAction } from "./analyze";
import { CLASS_N, reachToCombos, type PfLib, type PfLibNode } from "./preflopLib";

export interface Act {
  /** 자리 이름 (UTG, UTG1, LJ, HJ, CO, BTN, SB, BB) */
  pos: string;
  type: "fold" | "check" | "call" | "bet" | "raise";
  /** 벳·레이즈: 이 스트리트에서 그 자리가 넣은 총액 (bb). 올인이면 생략 가능 */
  to?: number;
  allin?: boolean;
}
export interface Spot {
  /** 앉은 인원 2~8. 8명보다 적으면 앞자리(UTG 쪽)부터 비어 있는 것으로 본다. 2명이면 SB(버튼)·BB */
  players: number;
  hero: string;
  /** 내 카드 "AsKd" */
  cards: string;
  /** 유효 스택 (bb, 핸드 시작 기준) */
  stack: number;
  /** 지금까지의 액션. 내 차례 직전까지만 넣는다 */
  preflop: Act[];
  /** 보드 "Ks7d2c" (3~5장). 없으면 프리플랍 결정 */
  board?: string;
  flop?: Act[];
  turn?: Act[];
  river?: Act[];
  /** 프리플랍 라이브러리 포맷. 없으면 스택에 가장 가까운 mtt8-6/10/15/25/40/60 */
  format?: string;
}
export interface Option {
  type: string;
  label: string;
  /** 프리플랍은 이 액션 뒤 내 총 투자(to), 포스트플랍은 추가로 넣는 금액 (bb) */
  amount: number;
  /** 내 핸드의 GTO 빈도 (0~1) */
  freq: number;
  /** 지금 폴드하는 것을 0으로 둔 기대값 (bb) */
  ev: number;
}
export interface Decision {
  street: "preflop" | "flop" | "turn" | "river";
  options: Option[];
  /** 추천 액션 (options 의 번호). rng 를 주면 빈도대로 뽑고, 없으면 빈도가 가장 높은 것 */
  pick: number;
  /** library = 미리 푼 표 조회, street-solve = 그 자리에서 한 스트리트 솔브 */
  source: "library" | "street-solve";
  format: string;
  iterations?: number;
  exploitabilityPct?: number;
  ms: number;
  /** 근사·가정 등 결과를 읽을 때 알아야 할 것 */
  notes: string[];
}
export interface DecideOptions {
  /** 프리플랍 라이브러리(JSON)를 주는 함수 */
  preflop: (formatId: string) => Promise<PfLib>;
  /** 한 번의 결정에 쓸 시간 (ms, 기본 2500) */
  budgetMs?: number;
  rng?: () => number;
}

const DEPTHS = [6, 10, 15, 25, 40, 60];
const MIN_ITER = 10;
const MAX_ITER = 1000;
const STREETS = ["flop", "turn", "river"] as const;
/** 지나온 스트리트를 처음 풀 때 쓰는 시간 (ms). 순서대로 물으면 기억해 둔 것을 쓰므로 들지 않는다 */
const REPLAY_MS = [400, 400];
/** 실제 액션이 풀이에서 레인지의 이 비율보다 적게 나오면 "GTO 라인에 거의 없는 액션"으로 본다 */
const RARE = 0.05;
const r2 = (x: number) => Math.round(x * 100) / 100;
const r3 = (x: number) => Math.round(x * 1000) / 1000;

/** 플랍용 StreetSolver 와 턴·리버용 PostflopSolver 를 같은 모양으로 쓴다 */
interface Sub {
  hands: HandSet;
  tree: GameTree;
  w: [Float32Array, Float32Array];
  iterations: number;
  step(k: number): void;
  analyze(node: DecisionNode, reach: [Float32Array, Float32Array]): { strategy: Float32Array; ev: Float32Array };
  metrics(): { exploitabilityPct: number };
  sampled?: boolean;
  runouts?: number;
}
function fullSolver(tree: GameTree, w0: Float32Array, w1: Float32Array): Sub {
  const s = new PostflopSolver(tree, w0, w1);
  const ctx = s.walk([]).ctx;
  return {
    hands: s.hands,
    tree,
    w: s.w,
    get iterations() {
      return s.iterationCount;
    },
    step: (k) => s.step(k),
    analyze: (node, reach) => s.analyzeDecision(node, ctx, reach),
    metrics: () => s.metrics()
  };
}

// 같은 핸드의 앞 스트리트를 다시 풀지 않도록 기억해 둔다
const cache = new Map<string, Sub>();

function choose(options: Option[], rng?: () => number): number {
  if (!rng) return options.reduce((b, o, i) => (o.freq > options[b].freq ? i : b), 0);
  let x = rng();
  for (let i = 0; i < options.length; i++) if ((x -= options[i].freq) <= 0) return i;
  return options.length - 1;
}

const BETS = [33, 75];
/** 실제로 나온 첫 벳 크기(팟 대비 %)가 기본 크기와 많이 다르면 트리에 넣을 값, 아니면 0 */
function extraBet(pct: number): number {
  return pct >= 10 && pct <= 300 && !BETS.some((b) => Math.abs(b - pct) / pct < 0.2) ? pct : 0;
}
function streetTree(board: number[], pot: number, left: number, extra: number, jam: boolean): TreeConfig {
  // shortcut: 레이즈는 팟의 60% 한 가지. 실제 레이즈는 가장 가까운 크기로 본다(차이가 크면 notes 에 적음). 레이즈 크기가 중요해지면 목록을 늘릴 것.
  const s = { bet: extra ? [...BETS, extra] : BETS, raise: [60] };
  const all = { flop: s, turn: s, river: s };
  // 실제로 올인이 나왔으면 올인 액션을 트리에 넣는다 (없으면 작은 벳으로 잘못 맞춰진다)
  return { board, pot, effStack: left, rakePct: 0, rakeCap: 0, oop: all, ip: all, allinThresholdPct: 67, maxRaisesPerStreet: 4, allowDonk: true, includeAllin: jam };
}

function mapAction(node: DecisionNode, type: Act["type"], amount: number, allin: boolean): number {
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

export async function decide(spot: Spot, opts: DecideOptions): Promise<Decision> {
  const t0 = Date.now();
  const deadline = t0 + (opts.budgetMs ?? 2500);
  const notes: string[] = [];
  const note = (s: string) => {
    if (!notes.includes(s)) notes.push(s);
  };
  if (!(spot.players >= 2 && spot.players <= 8)) throw new Error("인원은 2~8명이어야 합니다");
  if (!(spot.stack > 0)) throw new Error("유효 스택(bb)이 필요합니다");
  const hc = parseCards(spot.cards);
  if (hc.length !== 2 || hc[0] === hc[1]) throw new Error("내 카드는 두 장이어야 합니다 (예: AsKd)");
  const combo = comboIndex(hc[0], hc[1]);
  const cls = COMBO_CLASS[combo];
  const format = spot.format ?? `mtt8-${DEPTHS.reduce((b, d) => (Math.abs(Math.log(spot.stack / d)) < Math.abs(Math.log(spot.stack / b)) ? d : b))}`;
  const lib = await opts.preflop(format);
  const cfg = lib.format;
  const P = cfg.positions;
  const N = P.length;
  const first = N - spot.players;
  if (first < 0) throw new Error(`${format} 은 ${N}명까지입니다`);
  const hero = P.indexOf(spot.hero);
  if (hero < first) throw new Error(`내 자리는 ${P.slice(first).join(", ")} 중 하나여야 합니다`);
  if (spot.stack < cfg.stack * 0.6 || spot.stack > cfg.stack * 1.5) note(`스택 ${spot.stack}bb 를 가장 가까운 ${cfg.stack}bb 표로 계산했습니다`);
  if (spot.players === 2) note("헤즈업 프리플랍은 8맥스 SB 대 BB 표로 근사했습니다");

  // ---- 프리플랍: 라이브러리 트리를 실제 액션대로 따라간다 ----
  const acts = spot.preflop.slice();
  const inv = P.map((_, i) => (i === N - 2 ? cfg.sb : i === N - 1 ? cfg.bb : 0));
  const reach = P.map(() => Float64Array.from(CLASS_N));
  let node: PfLibNode | null = lib.nodes[0];
  let end = "";
  for (let guard = 0; node && guard < 80; guard++) {
    const nd: PfLibNode = node;
    const i = nd.p;
    const pass = () => Math.max(nd.a.findIndex((x) => x[0] === "fold"), nd.a.findIndex((x) => x[0] === "check"));
    let ai: number;
    const k = acts.findIndex((a) => a.pos === P[i]);
    if (i < first) ai = pass();
    else if (k < 0) {
      if (i !== hero) throw new Error(`${P[i]} 의 프리플랍 액션이 빠졌습니다`);
      if (reach[hero][cls] / CLASS_N[cls] < 0.01) note("이 핸드는 GTO 라인이라면 여기까지 오지 않습니다");
      // 표의 스택과 내 스택이 다를 수 있으니 올인·콜 금액은 실제 스택과 실제로 걸린 돈으로 보여 준다
      const options = nd.a.map((x, a) => {
        const amount = x[0] === "allin" ? spot.stack : x[0] === "call" ? Math.min(spot.stack, Math.max(...inv)) : Math.min(x[1], spot.stack);
        const label = x[0] === "allin" ? `올인 ${amount}` : x[2].startsWith("콜") ? `콜 ${r2(Math.max(0, amount - inv[hero]))}` : x[2];
        return { type: x[0], label, amount, freq: nd.s[a * NUM_CLASSES + cls] / 1000, ev: nd.e[a * NUM_CLASSES + cls] / 100 };
      });
      return { street: "preflop", options, pick: choose(options, opts.rng), source: "library", format, ms: Date.now() - t0, notes };
    } else {
      const a = acts.splice(k, 1)[0];
      if (a.type === "call") inv[i] = Math.min(spot.stack, Math.max(...inv));
      else if (a.type === "bet" || a.type === "raise") {
        const to = a.allin && a.to === undefined ? spot.stack : a.to;
        if (!(to !== undefined && to > inv[i])) throw new Error(`${a.pos} ${a.type} 의 to(총액)가 필요합니다`);
        inv[i] = Math.min(to, spot.stack);
      }
      ai = mapPreflopAction(nd, { player: a.pos, type: a.type, amount: 0, to: inv[i], allin: !!a.allin }, spot.stack);
      if (ai < 0) {
        if (a.type !== "call") throw new Error(`${a.pos} ${a.type} 는 프리플랍 트리에 없는 액션입니다`);
        // 림프·콜드콜처럼 GTO 트리에 없는 콜은 죽은 돈으로만 본다
        note(`${a.pos} 콜은 GTO 트리에 없어 폴드한 것으로 두고 계산했습니다(넣은 돈은 팟에 반영)`);
        ai = pass();
      }
    }
    const r = reach[i];
    for (let c = 0; c < NUM_CLASSES; c++) r[c] *= nd.s[ai * NUM_CLASSES + c] / 1000;
    const child: number | string = nd.c[ai];
    if (typeof child === "string") {
      end = child;
      node = null;
    } else node = lib.nodes[child];
  }
  const term = lib.terminals[Number(end.slice(1))];
  if (!term || term.type !== "flop") throw new Error("프리플랍에서 핸드가 끝났습니다 (결정할 것이 없습니다)");
  if (term.fold[hero]) throw new Error("내 자리는 이미 폴드했습니다 (GTO 트리에 없는 콜로 들어간 경우 포함)");
  if (acts.length) note(`프리플랍 액션 ${acts.length}개는 트리에서 따라가지 못해 반영하지 않았습니다 (${acts.map((a) => `${a.pos} ${a.type}`).join(", ")})`);

  // ---- 포스트플랍 ----
  const board = parseCards(spot.board ?? "");
  if (board.length < 3) throw new Error("플랍 보드가 필요합니다");
  if (board.includes(hc[0]) || board.includes(hc[1])) throw new Error("내 카드가 보드와 겹칩니다");
  let live = P.map((_, i) => i)
    .filter((i) => i >= first && !term.fold[i])
    .sort((x, y) => postflopOrder(cfg, x) - postflopOrder(cfg, y));
  if (spot.players === 2) live.reverse(); // 헤즈업은 SB(버튼)가 포스트플랍에서 나중에 행동한다
  const range = new Map<number, Float32Array>();
  for (const i of live) range.set(i, reachToCombos(reach[i], 0.02));
  let pot = r2(inv.reduce((s, x) => s + x, 0) + cfg.ante * spot.players);
  let left = r2(spot.stack - Math.max(...live.map((i) => inv[i])));

  for (let si = 0; si < 3; si++) {
    const name = STREETS[si];
    const nb = si + 3;
    if (board.length < nb || live.length < 2 || !live.includes(hero)) break;
    if (left <= 0.01) throw new Error("이미 올인이라 결정할 것이 없습니다");
    const list = spot[name] ?? [];
    const current = board.length === nb;
    const others = live.filter((i) => i !== hero);
    // shortcut: 3명 이상이면 나와 "마지막에 벳·레이즈한 상대(없으면 가장 뒤에 행동하는 상대)" 둘의 승부로 줄여 푼다. 멀티웨이 정확도가 필요하면 MultiSolver 로 바꿀 것.
    const aggr = [...list].reverse().find((a) => (a.type === "bet" || a.type === "raise") && others.includes(P.indexOf(a.pos)));
    const vill = aggr ? P.indexOf(aggr.pos) : others[others.length - 1];
    if (others.length > 1) note("3명 이상 팟은 나와 주 상대 한 명의 승부로 줄여 푼 근사입니다");
    const pair = live.filter((i) => i === hero || i === vill);
    const w = pair.map((i) => range.get(i)!);
    w[pair.indexOf(hero)][combo] = Math.max(w[pair.indexOf(hero)][combo], 0.05); // 내 핸드가 GTO 레인지 밖이어도 답이 나오게
    const firstBet = list.find((a) => (a.type === "bet" || a.type === "raise") && a.to !== undefined);
    const extra = extraBet(firstBet ? Math.round((firstBet.to! / pot) * 100) : 0);
    const jam = list.some((a) => (a.type === "bet" || a.type === "raise") && (a.allin || (a.to ?? 0) >= left - 0.01));
    const sb = board.slice(0, nb);
    const key = JSON.stringify([format, spot.players, spot.hero, combo, spot.stack, spot.preflop, sb, STREETS.slice(0, si).map((s) => spot[s]), vill, extra, jam]);
    let solver = cache.get(key);
    const fresh = !solver;
    if (!solver) {
      const tree = buildTree(streetTree(sb, pot, left, extra, jam));
      // 턴을 리버까지 풀면 작은 트리로도 반복 한 번에 0.12초라 2초에 12번(익스플로잇 4.5%)밖에 못 돈다(2026-11-17 측정). 그래서 리버만 끝까지 푼다
      solver = si === 2 ? fullSolver(tree, w[0], w[1]) : new StreetSolver(tree, w[0], w[1]);
      if (cache.size >= 8) cache.clear();
      cache.set(key, solver);
    }
    if (fresh || current) {
      const limit = current ? deadline - 250 : Math.min(deadline, Date.now() + REPLAY_MS[si]);
      while (solver.iterations < MIN_ITER || (solver.iterations < MAX_ITER && Date.now() < limit)) solver.step(2);
    }

    // 이 스트리트의 실제 액션대로 트리를 따라가며 두 사람의 레인지를 좁힌다
    const n = solver.hands.n;
    const rs: [Float32Array, Float32Array] = [solver.w[0].slice(), solver.w[1].slice()];
    const put = new Map<number, number>();
    let rare = false;
    let cur = 0;
    let at: TreeNode = solver.tree.root;
    for (const a of list) {
      const i = P.indexOf(a.pos);
      if (!live.includes(i)) throw new Error(`${name}: ${a.pos} 는 이 핸드에 남아 있지 않습니다`);
      const before = put.get(i) ?? 0;
      let to = before;
      if (a.type === "call") to = Math.min(cur, left);
      else if (a.type === "bet" || a.type === "raise") {
        const t = a.allin && a.to === undefined ? left : a.to;
        if (!(t !== undefined && t > cur)) throw new Error(`${name}: ${a.pos} ${a.type} 의 to(이 스트리트 총액)가 필요합니다`);
        to = Math.min(t, left);
      }
      put.set(i, to);
      cur = Math.max(cur, to);
      if (a.type === "fold") live = live.filter((x) => x !== i);
      if (i !== hero && i !== vill) continue;
      const idx: number = at.kind === "decision" && at.player === pair.indexOf(i) ? mapAction(at, a.type, to - before, to >= left - 0.01) : -1;
      if (idx < 0 || at.kind !== "decision") {
        if (a.type === "fold" && others.length > 1) continue; // 줄여 푼 멀티웨이에서 트리 밖 자리의 벳에 폴드한 경우
        throw new Error(`${name}: ${a.pos} ${a.type} 를 트리에서 따라갈 수 없습니다 (순서나 금액 확인)`);
      }
      const mapped = at.actions[idx].amount;
      if (to > before && Math.abs(mapped - (to - before)) / (to - before) > 0.35) note(`${name}: ${a.pos} 의 ${r2(to - before)}bb 를 트리의 ${mapped}bb 로 보고 계산했습니다(크기 차이 큼)`);
      const avg = solver.analyze(at, rs).strategy;
      const r = rs[at.player];
      const next = new Float32Array(n);
      let tot = 0;
      let was = 0;
      for (let h = 0; h < n; h++) {
        was += r[h];
        tot += next[h] = r[h] * avg[idx * n + h];
      }
      // 풀이에서 거의 안 나오는 액션은 그 노드의 전략이 수렴하지 않아 믿을 수 없다 → 레인지 전체로 그렇게 했다고 본다
      if (tot / was >= RARE) rs[at.player] = next;
      else {
        note(`${name}: ${a.pos} ${a.type} 는 GTO 라인에 거의 없는 액션이라 레인지 전체로 그렇게 했다고 보고 계산했습니다`);
        if (i !== hero) rare = true;
      }
      at = at.children[idx];
    }

    if (current) {
      if (at.kind !== "decision" || at.player !== pair.indexOf(hero) || !live.includes(hero)) throw new Error("지금은 내 차례가 아닙니다");
      const an = solver.analyze(at, rs);
      const slot = solver.hands.slotOfCombo[combo];
      const options = at.actions.map((x, k) => ({ type: x.type, label: x.label, amount: x.amount, freq: r3(an.strategy[k * n + slot]), ev: r3(an.ev[k * n + slot]) }));
      if (rare) {
        // 이 노드의 빈도는 수렴하지 않았으니 EV 가 가장 높은 액션 하나로 답한다
        const best = options.reduce((b, o, k) => (o.ev > options[b].ev ? k : b), 0);
        options.forEach((o, k) => (o.freq = k === best ? 1 : 0));
        note("상대의 직전 액션이 GTO 라인에 드물어, 빈도 대신 EV 가 가장 높은 액션을 골랐습니다");
      }
      // 측정(2026-11-17, K72 플랍 BTN 대 BB): 페어를 콜 대신 레이즈하는 쪽으로 치우친다 → 뒤 스트리트 레인지도 약해진다
      if (name !== "river") note("플랍·턴은 지금 스트리트만 푸는 근사라 GTO 와 차이가 납니다(만든 패를 레이즈 쪽으로 과하게 고르는 편향 확인됨)");
      else note("리버는 끝까지 푼 값이지만, 상대 레인지는 근사인 플랍·턴 풀이에서 넘어온 것입니다");
      if (solver.sampled) note(`승률은 런아웃 ${solver.runouts}개 표본으로 계산했습니다`);
      return { street: name, options, pick: choose(options, opts.rng), source: "street-solve", format, iterations: solver.iterations, exploitabilityPct: r3(solver.metrics().exploitabilityPct), ms: Date.now() - t0, notes };
    }

    // 다음 스트리트로 팟·스택·레인지를 넘긴다
    if (at.kind === "decision" && others.length === 1) throw new Error(`${name}: 액션이 끝나지 않았는데 다음 카드가 있습니다 (콜·체크가 빠졌는지 확인)`);
    let add = 0;
    let mx = 0;
    for (const v of put.values()) {
      add += v;
      mx = Math.max(mx, v);
    }
    pot = r2(pot + add);
    left = r2(left - mx);
    const hands = solver.hands;
    pair.forEach((seat, p) => {
      const r = rs[p];
      const top = r.reduce((m, x) => Math.max(m, x), 0);
      const out = new Float32Array(1326);
      for (let h = 0; h < n; h++) if (r[h] / top >= 0.005) out[hands.combo[h]] = r[h] / top;
      range.set(seat, out);
    });
  }
  throw new Error("지금은 내 차례가 아닙니다 (핸드가 끝났거나 다음 카드를 기다리는 중)");
}
