// 상대 범위: 출처(자료 경로 조건화 / 사용자 가정 / 없음)를 기록하고, 블로커(내 카드·공개 보드)를 뺀다.
// 무작위 범위나 상위 N% 범위를 대신 넣지 않는다. 출처가 없으면 계산하지 않는다.
import { CLASS_COMBOS, COMBO_CARDS, NUM_CLASSES, NUM_COMBOS, cardToString, classLabel } from "../engine/cards";
import { parseRange } from "../engine/range";
import { CLASS_N } from "../lib/preflopLib";
import type { RangeTrace } from "./types";

/** 자료의 169 클래스 reach(콤보 수 단위) → 1326 콤보 가중치 (클래스 안에서는 같은 비율) */
export function rangeFromReach(reach: Float64Array): Float32Array {
  const w = new Float32Array(NUM_COMBOS);
  for (let c = 0; c < NUM_CLASSES; c++) {
    const v = Math.max(0, Math.min(1, reach[c] / CLASS_N[c]));
    if (v > 0) for (const i of CLASS_COMBOS[c]) w[i] = v;
  }
  return w;
}

export function parseUserRange(text: string): { weights: Float32Array } | { error: string } {
  try {
    const w = parseRange(text);
    if (!w.some((x) => x > 0)) return { error: "범위가 비어 있습니다" };
    return { weights: w };
  } catch (e) {
    return { error: (e as Error).message };
  }
}

/** 죽은 카드를 포함한 콤보를 0 으로 (새 배열). removed = 빠진 가중치 합 */
export function removeCards(w: Float32Array, dead: number[]): { w: Float32Array; removed: number } {
  const out = new Float32Array(w);
  const d = new Set(dead);
  let removed = 0;
  for (let i = 0; i < NUM_COMBOS; i++) {
    const [a, b] = COMBO_CARDS[i];
    if (out[i] > 0 && (d.has(a) || d.has(b))) {
      removed += out[i];
      out[i] = 0;
    }
  }
  return { w: out, removed };
}

export function summarizeRange(w: Float32Array): { combos: number; top: Array<{ hand: string; weight: number }> } {
  let combos = 0;
  const per: Array<{ hand: string; weight: number }> = [];
  for (let c = 0; c < NUM_CLASSES; c++) {
    let s = 0;
    for (const i of CLASS_COMBOS[c]) s += w[i];
    combos += s;
    if (s > 0) per.push({ hand: classLabel(c), weight: Math.round(s * 100) / 100 });
  }
  per.sort((a, b) => b.weight - a.weight);
  return { combos: Math.round(combos * 100) / 100, top: per.slice(0, 12) };
}

export function makeTrace(base: Omit<RangeTrace, "combos" | "top" | "blockedCards">, w: Float32Array | null, dead: number[]): RangeTrace {
  const s = w ? summarizeRange(w) : { combos: 0, top: [] };
  return { ...base, blockedCards: dead.map(cardToString), combos: s.combos, top: s.top };
}
