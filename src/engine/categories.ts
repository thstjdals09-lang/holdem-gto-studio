// 포스트플랍 핸드 분류 (브레이크다운): 완성 핸드 등급 + 드로우
import { rankOf, suitOf } from "./cards";
import { evaluate, categoryOf } from "./evaluator";

export const MADE_ORDER = [
  "스트레이트 플러시",
  "포카드",
  "풀하우스",
  "플러시",
  "스트레이트",
  "셋",
  "트립스",
  "투페어",
  "오버페어",
  "탑페어",
  "언더 오버페어",
  "미들페어",
  "약한 페어",
  "에이스 하이",
  "노메이드"
] as const;
export type Made = (typeof MADE_ORDER)[number];
export const DRAW_ORDER = ["플러시 드로우", "양방 스트레이트 드로우", "거셧", "백도어 플러시", "드로우 없음"] as const;
export type Draw = (typeof DRAW_ORDER)[number];

function straightMask(mask: number): boolean {
  for (let top = 12; top >= 4; top--) {
    const need = 0x1f << (top - 4);
    if ((mask & need) === need) return true;
  }
  return (mask & 0x100f) === 0x100f;
}

/** 랭크 마스크에 카드 하나를 더해 스트레이트가 되는 랭크 수 (아웃 랭크 수) */
function straightOutRanks(mask: number): number {
  if (straightMask(mask)) return 0;
  let outs = 0;
  for (let r = 0; r < 13; r++) {
    if (mask & (1 << r)) continue;
    if (straightMask(mask | (1 << r))) outs++;
  }
  return outs;
}

export function classifyMade(hole: [number, number], board: number[]): Made {
  const cards = [...board, hole[0], hole[1]];
  const score = evaluate(cards, cards.length);
  const cat = categoryOf(score);
  const boardScore = board.length >= 5 ? evaluate(board, 5) : -1;
  const br = board.map(rankOf).sort((a, b) => b - a);
  const h1 = rankOf(hole[0]);
  const h2 = rankOf(hole[1]);
  const highCard: Made = h1 === 12 || h2 === 12 ? "에이스 하이" : "노메이드";
  // 보드만으로 된 족보는 히어로 핸드로 치지 않는다
  if (board.length >= 5 && score === boardScore) return "노메이드"; // 보드 플레이
  if (cat === 3 || cat === 7) {
    const cnt = new Map<number, number>();
    for (const r of br) cnt.set(r, (cnt.get(r) ?? 0) + 1);
    let trip = -1;
    for (const [r, c] of cnt) if (c >= 3) trip = r;
    if (trip >= 0 && h1 !== trip && h2 !== trip) return highCard; // 보드 트립스·포카드 + 키커
  }
  if (cat === 8) return "스트레이트 플러시";
  if (cat === 7) return "포카드";
  if (cat === 6) return "풀하우스";
  if (cat === 5) return "플러시";
  if (cat === 4) return "스트레이트";
  if (cat === 3) {
    if (h1 === h2 && br.includes(h1)) return "셋";
    return "트립스";
  }
  if (cat === 2) {
    // 보드 페어 + 내 페어 = 투페어처럼 보이지만 실제 기여 확인
    const boardPaired = new Set(br).size < br.length;
    const holeHits = br.includes(h1) || br.includes(h2) || h1 === h2;
    if (boardPaired && !holeHits) return highCard; // 보드 투페어
    if (boardPaired && h1 !== h2) {
      // 보드 페어 + 내가 맞춘 페어 하나: 실질적으로 원페어 등급
      return pairKind(h1, h2, br);
    }
    if (boardPaired && h1 === h2) return h1 > br[0] ? "오버페어" : "약한 페어";
    return "투페어";
  }
  if (cat === 1) {
    const boardPaired = new Set(br).size < br.length;
    if (boardPaired && h1 !== h2 && !br.includes(h1) && !br.includes(h2)) return h1 === 12 || h2 === 12 ? "에이스 하이" : "노메이드";
    return pairKind(h1, h2, br);
  }
  return highCard;
}

function pairKind(h1: number, h2: number, br: number[]): Made {
  const uniq = Array.from(new Set(br)).sort((a, b) => b - a);
  if (h1 === h2) {
    if (h1 > uniq[0]) return "오버페어";
    if (uniq.length >= 2 && h1 > uniq[1]) return "언더 오버페어";
    return uniq.length >= 3 && h1 > uniq[uniq.length - 1] ? "미들페어" : "약한 페어";
  }
  const hit = br.includes(h1) ? h1 : h2;
  if (hit === uniq[0]) return "탑페어";
  if (uniq.length >= 3 && hit === uniq[1]) return "미들페어";
  return "약한 페어";
}

export function classifyDraw(hole: [number, number], board: number[]): Draw {
  if (board.length >= 5) return "드로우 없음";
  const cards = [...board, hole[0], hole[1]];
  const made = categoryOf(evaluate(cards, cards.length));
  if (made >= 4) return "드로우 없음";
  // 플러시 드로우: 같은 수트 4장 (홀카드 최소 1장 포함)
  for (let s = 0; s < 4; s++) {
    const n = cards.filter((c) => suitOf(c) === s).length;
    const holeN = hole.filter((c) => suitOf(c) === s).length;
    if (n === 4 && holeN >= 1) return "플러시 드로우";
  }
  let mask = 0;
  for (const c of cards) mask |= 1 << rankOf(c);
  let holeMask = 0;
  for (const c of hole) holeMask |= 1 << rankOf(c);
  const outs = straightOutRanks(mask);
  if (outs > 0) {
    // 홀카드가 기여하는지 확인: 보드만으로도 같은 드로우면 제외
    let bm = 0;
    for (const c of board) bm |= 1 << rankOf(c);
    const boardOuts = straightOutRanks(bm);
    if (outs > boardOuts && (holeMask & ~bm) !== 0) return outs >= 2 ? "양방 스트레이트 드로우" : "거셧";
  }
  if (board.length === 3) {
    for (let s = 0; s < 4; s++) {
      const n = cards.filter((c) => suitOf(c) === s).length;
      const holeN = hole.filter((c) => suitOf(c) === s).length;
      if (n === 3 && holeN === 2) return "백도어 플러시";
    }
  }
  return "드로우 없음";
}
