// 핸드별 에퀴티 계산기: 보드(3~5장)에서 남은 런아웃을 모두 열거해 상대 reach 대비 에퀴티를 구한다.
// 보드 평가 결과를 캐시하므로 같은 스팟에서 반복 호출이 빠르다.
import { evaluate } from "./evaluator";
import type { HandSet } from "./solver";

interface Eval {
  order: Int32Array;
  bounds: Int32Array;
  dead: Uint8Array; // 슬롯이 보드와 충돌하면 1
}

export class EquityCalc {
  private cache = new Map<number, Eval>();
  private tc = new Float64Array(52);
  private cum = new Float64Array(52);
  private gc = new Float64Array(52);
  constructor(readonly hands: HandSet) {}

  private key(board: number[]): number {
    const s = board.slice().sort((a, b) => a - b);
    let k = 0;
    for (const c of s) k = k * 53 + c + 1;
    return k;
  }

  private evalBoard(board: number[]): Eval {
    const k = this.key(board);
    let e = this.cache.get(k);
    if (e) return e;
    const n = this.hands.n;
    const strength = new Int32Array(n);
    const dead = new Uint8Array(n);
    const set = new Set(board);
    const cards = board.slice(0, 5);
    const live: number[] = [];
    for (let s = 0; s < n; s++) {
      const a = this.hands.a[s];
      const b = this.hands.b[s];
      if (set.has(a) || set.has(b)) {
        dead[s] = 1;
        continue;
      }
      cards[5] = a;
      cards[6] = b;
      strength[s] = evaluate(cards, 7);
      live.push(s);
    }
    const order = Int32Array.from(live).sort((x, y) => strength[x] - strength[y]);
    const bnd: number[] = [];
    for (let i = 0; i < order.length; i++) if (i === 0 || strength[order[i]] !== strength[order[i - 1]]) bnd.push(i);
    bnd.push(order.length);
    e = { order, bounds: Int32Array.from(bnd), dead };
    if (this.cache.size > 3000) this.cache.clear();
    this.cache.set(k, e);
    return e;
  }

  /** 5장 보드에서 num[h] += (승 + 0.5무) 상대 질량, den[h] += 상대 질량 */
  private accumulate(board: number[], rO: Float32Array, num: Float64Array, den: Float64Array): void {
    const { order, bounds } = this.evalBoard(board);
    const ha = this.hands.a;
    const hb = this.hands.b;
    const tc = this.tc;
    const cum = this.cum;
    const gc = this.gc;
    tc.fill(0);
    cum.fill(0);
    let total = 0;
    for (let k = 0; k < order.length; k++) {
      const h = order[k];
      const v = rO[h];
      if (v === 0) continue;
      total += v;
      tc[ha[h]] += v;
      tc[hb[h]] += v;
    }
    let cumAll = 0;
    for (let g = 0; g < bounds.length - 1; g++) {
      const i = bounds[g];
      const j = bounds[g + 1];
      let gs = 0;
      for (let k = i; k < j; k++) {
        const h = order[k];
        const v = rO[h];
        gs += v;
        gc[ha[h]] += v;
        gc[hb[h]] += v;
      }
      for (let k = i; k < j; k++) {
        const h = order[k];
        const a = ha[h];
        const b = hb[h];
        const rv = rO[h];
        num[h] += cumAll - cum[a] - cum[b] + 0.5 * (gs - gc[a] - gc[b] + rv);
        den[h] += total - tc[a] - tc[b] + rv;
      }
      for (let k = i; k < j; k++) {
        const h = order[k];
        const v = rO[h];
        cumAll += v;
        cum[ha[h]] += v;
        cum[hb[h]] += v;
        gc[ha[h]] = 0;
        gc[hb[h]] = 0;
      }
    }
  }

  /** 핸드 슬롯별 에퀴티 (상대 reach 기준, 남은 런아웃 평균) */
  equity(board: number[], rO: Float32Array): Float32Array {
    const n = this.hands.n;
    const num = new Float64Array(n);
    const den = new Float64Array(n);
    const set = new Set(board);
    const live: number[] = [];
    for (let c = 0; c < 52; c++) if (!set.has(c)) live.push(c);
    const need = 5 - board.length;
    const rO2 = new Float32Array(n);
    const run = (extra: number[]) => {
      rO2.set(rO);
      for (const c of extra) {
        const hw = this.hands.handsWithCard[c];
        for (let k = 0; k < hw.length; k++) rO2[hw[k]] = 0;
      }
      this.accumulate(board.concat(extra), rO2, num, den);
    };
    if (need === 0) run([]);
    else if (need === 1) for (const c of live) run([c]);
    else for (let i = 0; i < live.length; i++) for (let j = i + 1; j < live.length; j++) run([live[i], live[j]]);
    const out = new Float32Array(n);
    for (let h = 0; h < n; h++) out[h] = den[h] > 0 ? num[h] / den[h] : 0;
    return out;
  }
}

/** 충돌 없는 상대 질량 S[h] */
export function oppMass(hands: HandSet, rO: Float32Array, out?: Float32Array): Float32Array {
  const n = hands.n;
  const tc = new Float64Array(52);
  let total = 0;
  for (let h = 0; h < n; h++) {
    const v = rO[h];
    if (v === 0) continue;
    total += v;
    tc[hands.a[h]] += v;
    tc[hands.b[h]] += v;
  }
  const o = out ?? new Float32Array(n);
  for (let h = 0; h < n; h++) o[h] = total - tc[hands.a[h]] - tc[hands.b[h]] + rO[h];
  return o;
}
