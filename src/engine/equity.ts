// 에퀴티 계산: 레인지 vs 레인지(보드 샘플링 + 핸드 완전 열거), 핸드 vs 핸드
import { COMBO_CARDS, mulberry32 } from "./cards";
import { evaluate } from "./evaluator";
import type { RangeWeights } from "./range";
import { buildHandSet } from "./solver";

export interface EquityResult {
  equity0: number; // 레인지 0의 에퀴티 (0~1, 동점은 반씩)
  equity1: number;
  win0: number;
  win1: number;
  tie: number;
  boards: number; // 평가한 보드 수
  perCombo0: Float32Array; // 1326, 레인지0 콤보별 에퀴티 (가중 없음, 미포함은 0)
  perCombo1: Float32Array;
  exact: boolean;
}

function* runouts(dead: Set<number>, need: number): Generator<number[]> {
  const live: number[] = [];
  for (let c = 0; c < 52; c++) if (!dead.has(c)) live.push(c);
  if (need === 0) {
    yield [];
    return;
  }
  if (need === 1) {
    for (const c of live) yield [c];
    return;
  }
  if (need === 2) {
    for (let i = 0; i < live.length; i++) for (let j = i + 1; j < live.length; j++) yield [live[i], live[j]];
    return;
  }
  throw new Error("3장 이상 런아웃은 샘플링을 사용합니다");
}

/**
 * 레인지 vs 레인지 에퀴티. 보드 3~5장이면 정확 열거, 0장(프리플랍)이면 보드를 samples개 샘플링.
 */
export function rangeVsRange(w0: RangeWeights, w1: RangeWeights, board: number[], samples = 400, seed = 1): EquityResult {
  const hs = buildHandSet(board, w0, w1);
  const n = hs.n;
  const sw0 = new Float64Array(n);
  const sw1 = new Float64Array(n);
  for (let s = 0; s < n; s++) {
    sw0[s] = w0[hs.combo[s]];
    sw1[s] = w1[hs.combo[s]];
  }
  const num0 = new Float64Array(n); // 콤보별 (승+0.5무) 가중합 (레인지0 관점)
  const den0 = new Float64Array(n);
  const num1 = new Float64Array(n);
  const den1 = new Float64Array(n);
  let W0 = 0;
  let W1 = 0;
  let T = 0;
  let boards = 0;
  const strength = new Int32Array(n);
  const order = new Int32Array(n);
  const cards = new Array<number>(7);
  const totalCard = new Float64Array(52);
  const cumCard0 = new Float64Array(52);
  const groupCard0 = new Float64Array(52);
  const cumCard1 = new Float64Array(52);
  const groupCard1 = new Float64Array(52);

  function evalBoard(b: number[]) {
    boards++;
    const dead = new Set(b);
    for (let i = 0; i < 5; i++) cards[i] = b[i];
    let live = 0;
    for (let s = 0; s < n; s++) {
      if (dead.has(hs.a[s]) || dead.has(hs.b[s])) {
        strength[s] = -1;
        continue;
      }
      cards[5] = hs.a[s];
      cards[6] = hs.b[s];
      strength[s] = evaluate(cards, 7);
      order[live++] = s;
    }
    const ord = order.subarray(0, live);
    ord.sort((x, y) => strength[x] - strength[y]);
    // 양쪽 reach 총합과 카드별 합
    // 레인지1(상대) 기준 스윕 → 레인지0 콤보의 승률; 그리고 반대
    sweep(ord, live, sw1, sw0, num0, den0, cumCard0, groupCard0);
    sweep(ord, live, sw0, sw1, num1, den1, cumCard1, groupCard1);
  }

  function sweep(ord: Int32Array, live: number, ro: Float64Array, rp: Float64Array, num: Float64Array, den: Float64Array, cum: Float64Array, gc: Float64Array) {
    totalCard.fill(0);
    let total = 0;
    for (let k = 0; k < live; k++) {
      const h = ord[k];
      const v = ro[h];
      if (v === 0) continue;
      total += v;
      totalCard[hs.a[h]] += v;
      totalCard[hs.b[h]] += v;
    }
    cum.fill(0);
    let cumAll = 0;
    let i = 0;
    while (i < live) {
      let j = i;
      const st = strength[ord[i]];
      let groupSum = 0;
      gc.fill(0);
      while (j < live && strength[ord[j]] === st) {
        const h = ord[j];
        const v = ro[h];
        groupSum += v;
        gc[hs.a[h]] += v;
        gc[hs.b[h]] += v;
        j++;
      }
      for (let k = i; k < j; k++) {
        const h = ord[k];
        if (rp[h] === 0) continue;
        const a = hs.a[h];
        const b = hs.b[h];
        const weaker = cumAll - cum[a] - cum[b];
        const tie = groupSum - gc[a] - gc[b] + ro[h];
        const S = total - totalCard[a] - totalCard[b] + ro[h];
        num[h] += weaker + 0.5 * tie;
        den[h] += S;
        // 전체 집계 (rp 가중)
        if (ro === sw1) {
          W0 += rp[h] * weaker;
          T += rp[h] * tie;
          W1 += rp[h] * (S - weaker - tie);
        }
      }
      for (let k = i; k < j; k++) {
        const h = ord[k];
        const v = ro[h];
        cumAll += v;
        cum[hs.a[h]] += v;
        cum[hs.b[h]] += v;
      }
      i = j;
    }
  }

  let exact = true;
  if (board.length >= 3) {
    const dead = new Set(board);
    for (const r of runouts(dead, 5 - board.length)) evalBoard(board.concat(r));
  } else {
    exact = false;
    const rng = mulberry32(seed);
    const dead = new Set(board);
    const live: number[] = [];
    for (let c = 0; c < 52; c++) if (!dead.has(c)) live.push(c);
    for (let s = 0; s < samples; s++) {
      // 부분 셔플로 5-board.length 장 뽑기
      const need = 5 - board.length;
      for (let i = 0; i < need; i++) {
        const j = i + Math.floor(rng() * (live.length - i));
        const t = live[i];
        live[i] = live[j];
        live[j] = t;
      }
      evalBoard(board.concat(live.slice(0, need)));
    }
  }
  const tot = W0 + W1 + T;
  const perCombo0 = new Float32Array(1326);
  const perCombo1 = new Float32Array(1326);
  for (let s = 0; s < n; s++) {
    if (den0[s] > 0) perCombo0[hs.combo[s]] = num0[s] / den0[s];
    if (den1[s] > 0) perCombo1[hs.combo[s]] = num1[s] / den1[s];
  }
  return {
    equity0: tot > 0 ? (W0 + 0.5 * T) / tot : 0,
    equity1: tot > 0 ? (W1 + 0.5 * T) / tot : 0,
    win0: tot > 0 ? W0 / tot : 0,
    win1: tot > 0 ? W1 / tot : 0,
    tie: tot > 0 ? T / tot : 0,
    boards,
    perCombo0,
    perCombo1,
    exact
  };
}

/** 핸드 vs 핸드 (보드 0~5장). 보드 3장 미만이면 샘플링 */
export function handVsHand(h0: [number, number], h1: [number, number], board: number[], samples = 20000, seed = 7): { equity0: number; equity1: number; tie: number; exact: boolean } {
  const dead = new Set([...h0, ...h1, ...board]);
  const live: number[] = [];
  for (let c = 0; c < 52; c++) if (!dead.has(c)) live.push(c);
  const need = 5 - board.length;
  let w0 = 0;
  let w1 = 0;
  let t = 0;
  const c0 = new Array<number>(7);
  const c1 = new Array<number>(7);
  c0[5] = h0[0];
  c0[6] = h0[1];
  c1[5] = h1[0];
  c1[6] = h1[1];
  const judge = (b: number[]) => {
    for (let i = 0; i < 5; i++) {
      c0[i] = b[i];
      c1[i] = b[i];
    }
    const s0 = evaluate(c0, 7);
    const s1 = evaluate(c1, 7);
    if (s0 > s1) w0++;
    else if (s1 > s0) w1++;
    else t++;
  };
  let exact = true;
  if (need <= 2) {
    for (const r of runouts(dead, need)) judge(board.concat(r));
  } else {
    exact = false;
    const rng = mulberry32(seed);
    for (let s = 0; s < samples; s++) {
      for (let i = 0; i < need; i++) {
        const j = i + Math.floor(rng() * (live.length - i));
        const tmp = live[i];
        live[i] = live[j];
        live[j] = tmp;
      }
      judge(board.concat(live.slice(0, need)));
    }
  }
  const tot = w0 + w1 + t;
  return { equity0: (w0 + 0.5 * t) / tot, equity1: (w1 + 0.5 * t) / tot, tie: t / tot, exact };
}

export { COMBO_CARDS };
