// 닫힌 올인 판단: 내가 콜하면 더 이상 베팅이 없는 상황(남은 상대가 모두 올인이거나 칩이 있는 사람이 1명뿐).
// 이때 선택지는 폴드·콜뿐이고, 상대 범위가 주어지면 콜 EV(폴드 = 0)가 정확히 정해진다 — 사이드팟·환급·카드 충돌 포함.
// 상대 1명 + 보드 3장 이상: 상대 콤보 × 남은 런아웃 전부 열거. 그 밖(프리플랍, 다인): 시드 고정 표본(표준오차 표시).
import { COMBO_CARDS, NUM_COMBOS, mulberry32 } from "../engine/cards";
import { evaluate } from "../engine/evaluator";
import { potLayersMilli } from "./replay-state";
import type { PotLayer, StateView } from "./types";

export interface Entry {
  seat: number;
  totalIn: number;
  stack: number;
  folded: boolean;
  /** BB 앤티 같은 죽은 돈 (totalIn 에 포함) */
  deadIn?: number;
}
export interface ClosedInput {
  heroSeat: number;
  heroCards: number[];
  board: number[];
  /** 내 판단 직전 상태 (milli) */
  entries: Entry[];
  callAdd: number;
  /** 살아 있는 상대 (내 카드·보드를 뺀 가중치) */
  opponents: Array<{ seat: number; weights: Float32Array }>;
}
export interface Outcome {
  prob: number;
  stacks: number[];
}
export interface ClosedResult {
  method: "enumeration" | "monte-carlo";
  samples: number;
  acceptRate: number;
  /** 콜 EV (milli, 이 시점에서 폴드 = 0) */
  evCall: number;
  se: number;
  /** 내가 자격 있는 팟을 전부 / 일부 / 하나도 못 가져가는 확률 */
  win: number;
  split: number;
  lose: number;
  heroEligiblePot: number;
  requiredEquity: number;
  callOutcomes: Outcome[];
  foldOutcomes: Outcome[];
  callLayers: PotLayer[];
}
export interface RunOptions {
  samples: number;
  seed: number;
  signal?: { cancelled: boolean };
  tick?: () => Promise<void>;
}
export class Cancelled extends Error {
  constructor() {
    super("취소됨");
  }
}

/** 내가 콜하면 이 핸드에 더 이상 베팅 결정이 남지 않는지 (StateView 기준, 단위 그대로) */
export function isClosedAfterCall(state: StateView, heroSeat: number, callAdd: number): boolean {
  const hero = state.seats.find((s) => s.seat === heroSeat);
  if (!hero || hero.folded || !(callAdd > 0)) return false;
  const others = state.seats.filter((s) => s.seat !== heroSeat && !s.folded && !s.allIn);
  if (others.some((s) => s.streetIn < state.currentBet - 1e-9)) return false; // 아직 행동할 자리
  const heroLeft = hero.stack - callAdd > 1e-9;
  return others.length + (heroLeft ? 1 : 0) <= 1;
}

/** 리버에서 내 콜로 베팅이 끝나는지 (뒤에 행동할 자리가 없음). 이때도 레이즈는 가능할 수 있어 콜·폴드만 비교한다 */
export function isRiverCallClosing(state: StateView, heroSeat: number, callAdd: number): boolean {
  if (state.street !== "river" || !(callAdd > 0)) return false;
  const hero = state.seats.find((s) => s.seat === heroSeat);
  if (!hero || hero.folded) return false;
  return !state.seats.some((s) => s.seat !== heroSeat && !s.folded && !s.allIn && s.streetIn < state.currentBet - 1e-9);
}

/** 폴드했을 때: 맞춰지지 않은 최고 투자액의 초과분은 돌려준다 */
function foldEntries(entries: Entry[], heroSeat: number): Entry[] {
  const e = entries.map((x) => (x.seat === heroSeat ? { ...x, folded: true } : { ...x }));
  const live = (x: Entry) => x.totalIn - (x.deadIn ?? 0);
  const sorted = [...e].sort((a, b) => live(b) - live(a));
  const diff = live(sorted[0]) - (sorted[1] ? live(sorted[1]) : 0);
  if (diff > 0 && !sorted[0].folded) {
    sorted[0].totalIn -= diff;
    sorted[0].stack += diff;
  }
  return e;
}

export async function closedAllin(input: ClosedInput, opts: RunOptions): Promise<ClosedResult> {
  const { heroSeat, board } = input;
  const call = input.entries.map((x) => (x.seat === heroSeat ? { ...x, totalIn: x.totalIn + input.callAdd, stack: x.stack - input.callAdd } : { ...x }));
  const fold = foldEntries(input.entries, heroSeat);
  const callLayers = potLayersMilli(call);
  const foldLayers = potLayersMilli(fold);
  // 자격자가 나 하나인 층은 돌려받는 돈이라 다투는 팟에서 뺀다
  const contested = callLayers.filter((l) => l.eligible.includes(heroSeat) && l.eligible.length > 1);
  const heroEligiblePot = contested.reduce((a, l) => a + l.amount, 0);
  const ownBack = callLayers.filter((l) => l.eligible.length === 1 && l.eligible[0] === heroSeat).reduce((a, l) => a + l.amount, 0);
  const seatIdx = new Map(call.map((x, i) => [x.seat, i]));
  const opps = input.opponents;
  const need = 5 - board.length;
  const seven = new Int32Array(7);
  for (let i = 0; i < board.length; i++) seven[2 + i] = board[i];
  const score = (a: number, b: number, run: number[]) => {
    seven[0] = a;
    seven[1] = b;
    for (let i = 0; i < need; i++) seven[2 + board.length + i] = run[i];
    return evaluate(seven, 7);
  };
  const distribute = (layers: PotLayer[], scores: Map<number, number>, base: Entry[], out: number[]) => {
    for (let i = 0; i < base.length; i++) out[i] = base[i].stack;
    for (const l of layers) {
      let best = -Infinity;
      for (const s of l.eligible) best = Math.max(best, scores.get(s) ?? -Infinity);
      // 자격자가 한 명이면(돌려받는 초과분, 혼자 남은 팟) 카드와 상관없이 그 사람 것
      const winners = l.eligible.length === 1 ? l.eligible : l.eligible.filter((s) => scores.get(s) === best);
      if (!winners.length) throw new Error("쇼다운 점수가 없는 자격자가 있습니다");
      for (const w of winners) out[seatIdx.get(w)!] += l.amount / winners.length;
    }
  };
  const callAgg = new Map<string, Outcome>();
  const foldAgg = new Map<string, Outcome>();
  const add = (agg: Map<string, Outcome>, stacks: number[], w: number) => {
    // 키만 반올림해 같은 결과를 묶고, 값은 나눈 그대로 둔다 (반올림하면 나눈 팟에서 칩이 생길 수 있다)
    const k = stacks.map((x) => Math.round(x)).join(",");
    const o = agg.get(k);
    if (o) o.prob += w;
    else agg.set(k, { prob: w, stacks: stacks.slice() });
  };
  const heroI = seatIdx.get(heroSeat)!;
  const heroStackAfterCall = call[heroI].stack;
  let sw = 0;
  let sv = 0;
  let sv2 = 0;
  let win = 0;
  let split = 0;
  let lose = 0;
  const cs = new Array<number>(call.length);
  const fs = new Array<number>(fold.length);
  const scores = new Map<number, number>();
  const fscores = new Map<number, number>();
  const foldLive = fold.filter((x) => !x.folded).length;
  const record = (w: number) => {
    distribute(callLayers, scores, call, cs);
    const got = cs[heroI] - heroStackAfterCall;
    const v = got - input.callAdd;
    const won = got - ownBack;
    sw += w;
    sv += w * v;
    sv2 += w * v * v;
    if (won >= heroEligiblePot - 1e-6) win += w;
    else if (won <= 1e-6) lose += w;
    else split += w;
    add(callAgg, cs, w);
    distribute(foldLayers, foldLive <= 1 ? new Map() : fscores, fold, fs);
    add(foldAgg, fs, w);
  };
  const deadBase = new Set([...input.heroCards, ...board]);
  let samples = 0;
  let attempts = 0;
  let method: ClosedResult["method"];
  const tick = opts.tick ?? (() => Promise.resolve());
  const check = async (k: number) => {
    if (opts.signal?.cancelled) throw new Cancelled();
    if (k % 4096 === 0) {
      await tick();
      if (opts.signal?.cancelled) throw new Cancelled();
    }
  };

  if (opps.length === 1 && board.length >= 3) {
    method = "enumeration";
    const w = opps[0].weights;
    const os = opps[0].seat;
    let k = 0;
    for (let c = 0; c < NUM_COMBOS; c++) {
      if (!(w[c] > 0)) continue;
      const [a, b] = COMBO_CARDS[c];
      if (deadBase.has(a) || deadBase.has(b)) continue;
      const deck: number[] = [];
      for (let x = 0; x < 52; x++) if (!deadBase.has(x) && x !== a && x !== b) deck.push(x);
      const runs: number[][] = need === 0 ? [[]] : need === 1 ? deck.map((x) => [x]) : deck.flatMap((x, i) => deck.slice(i + 1).map((y) => [x, y]));
      const wr = w[c] / runs.length;
      for (const run of runs) {
        await check(++k);
        scores.set(heroSeat, score(input.heroCards[0], input.heroCards[1], run));
        scores.set(os, score(a, b, run));
        record(wr);
        samples++;
      }
    }
    attempts = samples;
  } else {
    method = "monte-carlo";
    const rng = mulberry32(opts.seed >>> 0);
    const cdfs = opps.map((o) => {
      const cdf = new Float64Array(NUM_COMBOS);
      let s = 0;
      for (let c = 0; c < NUM_COMBOS; c++) {
        const [a, b] = COMBO_CARDS[c];
        cdf[c] = s += deadBase.has(a) || deadBase.has(b) ? 0 : Math.max(0, o.weights[c]);
      }
      return cdf;
    });
    if (cdfs.some((c) => !(c[NUM_COMBOS - 1] > 0))) throw new Error("내 카드·보드를 빼면 상대 범위가 비어 있습니다");
    const pick = (cdf: Float64Array) => {
      const x = rng() * cdf[NUM_COMBOS - 1];
      let lo = 0;
      let hi = NUM_COMBOS - 1;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (cdf[mid] <= x) lo = mid + 1;
        else hi = mid;
      }
      return lo;
    };
    const maxAttempts = opts.samples * 50;
    const used = new Uint8Array(52);
    const run: number[] = [0, 0, 0, 0, 0];
    while (samples < opts.samples && attempts < maxAttempts) {
      attempts++;
      await check(attempts);
      used.fill(0);
      for (const c of deadBase) used[c] = 1;
      const hands: Array<[number, number]> = [];
      let clash = false;
      for (const cdf of cdfs) {
        const [a, b] = COMBO_CARDS[pick(cdf)];
        if (used[a] || used[b]) {
          clash = true; // 상대끼리 겹친 표본은 통째로 버린다 (부분 재추첨은 분포를 비튼다)
          break;
        }
        used[a] = used[b] = 1;
        hands.push([a, b]);
      }
      if (clash) continue;
      for (let i = 0; i < need; i++) {
        let c: number;
        do c = Math.floor(rng() * 52);
        while (used[c]);
        used[c] = 1;
        run[i] = c;
      }
      scores.clear();
      fscores.clear();
      scores.set(heroSeat, score(input.heroCards[0], input.heroCards[1], run));
      opps.forEach((o, i) => {
        const v = score(hands[i][0], hands[i][1], run);
        scores.set(o.seat, v);
        fscores.set(o.seat, v);
      });
      record(1);
      samples++;
    }
    if (samples < Math.min(200, opts.samples)) throw new Error(`상대 범위끼리 카드가 너무 많이 겹쳐 표본을 만들지 못했습니다 (수락 ${samples}/${attempts})`);
  }
  const mean = sv / sw;
  const variance = Math.max(0, sv2 / sw - mean * mean);
  const norm = (agg: Map<string, Outcome>) => [...agg.values()].map((o) => ({ prob: o.prob / sw, stacks: o.stacks })).sort((a, b) => b.prob - a.prob);
  return {
    method,
    samples,
    acceptRate: attempts ? samples / attempts : 1,
    evCall: mean,
    se: method === "enumeration" ? 0 : Math.sqrt(variance / samples),
    win: win / sw,
    split: split / sw,
    lose: lose / sw,
    heroEligiblePot,
    requiredEquity: input.callAdd / heroEligiblePot,
    callOutcomes: norm(callAgg),
    foldOutcomes: norm(foldAgg),
    callLayers
  };
}
