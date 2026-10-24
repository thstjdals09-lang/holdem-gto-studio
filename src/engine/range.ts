// 레인지 문법 파서 / 직렬화. 지원: AA, KK+, 77-55, AKs, AKo, AK, A5s+, A5s-A2s, T9s+, AhKh, 토큰:가중치(0~1 또는 %)
import {
  CLASS_COMBOS,
  COMBO_CARDS,
  COMBO_CLASS,
  NUM_CLASSES,
  NUM_COMBOS,
  RANKS,
  classIndexFromRanks,
  classLabel,
  comboIndex,
  parseCard,
  rankOf,
  suitOf,
  comboToString
} from "./cards";

export type RangeWeights = Float32Array; // length 1326, 0..1

export function emptyRange(): RangeWeights {
  return new Float32Array(NUM_COMBOS);
}

function parseWeight(s: string | undefined): number {
  if (s === undefined || s === "") return 1;
  let v = parseFloat(s.replace("%", ""));
  if (!isFinite(v)) throw new Error(`가중치 형식 오류: ${s}`);
  if (s.includes("%") || v > 1) v = v / 100;
  return Math.max(0, Math.min(1, v));
}

function rankIdx(ch: string): number {
  const r = RANKS.indexOf(ch.toUpperCase());
  if (r < 0) throw new Error(`랭크 오류: ${ch}`);
  return r;
}

function setClass(w: RangeWeights, cls: number, weight: number) {
  for (const i of CLASS_COMBOS[cls]) w[i] = weight;
}

function expandToken(tok: string, weight: number, w: RangeWeights) {
  // 특정 콤보: AhKh
  if (/^[2-9TJQKA][cdhs][2-9TJQKA][cdhs]$/i.test(tok)) {
    const c1 = parseCard(tok.slice(0, 2));
    const c2 = parseCard(tok.slice(2, 4));
    if (c1 === c2) throw new Error(`중복 카드: ${tok}`);
    w[comboIndex(c1, c2)] = weight;
    return;
  }
  // 범위: X-Y
  const dash = tok.indexOf("-");
  if (dash > 0) {
    const a = tok.slice(0, dash);
    const b = tok.slice(dash + 1);
    const ca = parseSimple(a);
    const cb = parseSimple(b);
    if (ca.kind !== cb.kind) throw new Error(`범위 양끝의 종류가 다릅니다: ${tok}`);
    if (ca.kind === "pair") {
      const lo = Math.min(ca.hi, cb.hi);
      const hi = Math.max(ca.hi, cb.hi);
      for (let r = lo; r <= hi; r++) setClassKinds(w, r, r, ca.kinds, weight);
    } else {
      if (ca.hi !== cb.hi) {
        // 커넥터 범위 (T9s-54s): 간격 동일
        const gap = ca.hi - ca.lo;
        if (cb.hi - cb.lo !== gap) throw new Error(`범위 해석 불가: ${tok}`);
        const lo = Math.min(ca.hi, cb.hi);
        const hi = Math.max(ca.hi, cb.hi);
        for (let h = lo; h <= hi; h++) setClassKinds(w, h, h - gap, ca.kinds, weight);
      } else {
        const lo = Math.min(ca.lo, cb.lo);
        const hi = Math.max(ca.lo, cb.lo);
        for (let l = lo; l <= hi; l++) setClassKinds(w, ca.hi, l, ca.kinds, weight);
      }
    }
    return;
  }
  // 플러스: XX+, AXs+, T9s+
  if (tok.endsWith("+")) {
    const base = parseSimple(tok.slice(0, -1));
    if (base.kind === "pair") {
      for (let r = base.hi; r <= 12; r++) setClassKinds(w, r, r, base.kinds, weight);
    } else if (base.hi - base.lo === 1 || (base.hi - base.lo <= 4 && base.lo < base.hi - 1 && false)) {
      // 커넥터 플러스: 같은 간격 유지하며 위로
      const gap = base.hi - base.lo;
      for (let h = base.hi; h <= 12; h++) setClassKinds(w, h, h - gap, base.kinds, weight);
    } else {
      // 킥커 플러스: 같은 하이카드, 킥커를 위로
      for (let l = base.lo; l < base.hi; l++) setClassKinds(w, base.hi, l, base.kinds, weight);
    }
    return;
  }
  const s = parseSimple(tok);
  setClassKinds(w, s.hi, s.lo, s.kinds, weight);
}

type Simple = { kind: "pair" | "nonpair"; hi: number; lo: number; kinds: Array<"s" | "o"> };

function parseSimple(t: string): Simple {
  if (t.length < 2 || t.length > 3) throw new Error(`핸드 표기 오류: ${t}`);
  const r1 = rankIdx(t[0]);
  const r2 = rankIdx(t[1]);
  const hi = Math.max(r1, r2);
  const lo = Math.min(r1, r2);
  if (hi === lo) {
    if (t.length === 3) throw new Error(`페어에는 s/o를 붙일 수 없습니다: ${t}`);
    return { kind: "pair", hi, lo, kinds: [] };
  }
  const suf = t[2]?.toLowerCase();
  if (suf === undefined) return { kind: "nonpair", hi, lo, kinds: ["s", "o"] };
  if (suf === "s" || suf === "o") return { kind: "nonpair", hi, lo, kinds: [suf] };
  throw new Error(`접미사 오류: ${t}`);
}

function setClassKinds(w: RangeWeights, hi: number, lo: number, kinds: Array<"s" | "o">, weight: number) {
  if (hi === lo) {
    setClass(w, classIndexFromRanks(hi, lo, false), weight);
    return;
  }
  for (const k of kinds) setClass(w, classIndexFromRanks(hi, lo, k === "s"), weight);
}

export function parseRange(text: string): RangeWeights {
  const w = emptyRange();
  const tokens = text
    .split(/[\s,;]+/)
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
  for (const tok of tokens) {
    const colon = tok.indexOf(":");
    const hand = colon >= 0 ? tok.slice(0, colon) : tok;
    const weight = parseWeight(colon >= 0 ? tok.slice(colon + 1) : undefined);
    expandToken(hand, weight, w);
  }
  return w;
}

/** 169 클래스별 평균 가중치 */
export function classWeights(w: RangeWeights): Float32Array {
  const out = new Float32Array(NUM_CLASSES);
  for (let c = 0; c < NUM_CLASSES; c++) {
    let s = 0;
    for (const i of CLASS_COMBOS[c]) s += w[i];
    out[c] = s / CLASS_COMBOS[c].length;
  }
  return out;
}

export function totalCombos(w: RangeWeights): number {
  let s = 0;
  for (let i = 0; i < NUM_COMBOS; i++) s += w[i];
  return s;
}

function fmtWeight(v: number): string {
  const r = Math.round(v * 1000) / 1000;
  return String(r);
}

/** 레인지를 사람이 읽는 텍스트로 (클래스 단위, 균일하지 않으면 콤보 단위) */
export function rangeToString(w: RangeWeights): string {
  const parts: string[] = [];
  for (let c = 0; c < NUM_CLASSES; c++) {
    const combos = CLASS_COMBOS[c];
    const first = w[combos[0]];
    let uniform = true;
    let any = false;
    for (const i of combos) {
      if (w[i] > 0) any = true;
      if (Math.abs(w[i] - first) > 1e-6) uniform = false;
    }
    if (!any) continue;
    if (uniform) {
      parts.push(first >= 0.9995 ? classLabel(c) : `${classLabel(c)}:${fmtWeight(first)}`);
    } else {
      for (const i of combos) {
        if (w[i] > 0) parts.push(w[i] >= 0.9995 ? comboToString(i) : `${comboToString(i)}:${fmtWeight(w[i])}`);
      }
    }
  }
  return parts.join(",");
}

/** 보드와 충돌하는 콤보 제거 */
export function removeBoard(w: RangeWeights, board: ArrayLike<number>): RangeWeights {
  const out = new Float32Array(w);
  const dead = new Set<number>();
  for (let i = 0; i < board.length; i++) dead.add(board[i]);
  for (let i = 0; i < NUM_COMBOS; i++) {
    const [a, b] = COMBO_CARDS[i];
    if (dead.has(a) || dead.has(b)) out[i] = 0;
  }
  return out;
}

export { COMBO_CLASS, rankOf, suitOf };
