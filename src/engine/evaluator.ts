// 5~7장 핸드 평가기. 값이 클수록 강함. 비트마스크 기반, 외부 테이블 없음.
// 점수 = category<<20 | k1<<16 | k2<<12 | k3<<8 | k4<<4 | k5

export const CATEGORY_NAMES = [
  "하이카드",
  "원페어",
  "투페어",
  "트립스",
  "스트레이트",
  "플러시",
  "풀하우스",
  "포카드",
  "스트레이트 플러시"
];

const rankCount = new Uint8Array(13);
const suitMask = new Uint16Array(4);

function popcount13(x: number): number {
  let c = 0;
  while (x) {
    x &= x - 1;
    c++;
  }
  return c;
}

/** 13비트 마스크에서 가장 높은 k개의 랭크를 4비트씩 묶어 반환 */
function topRanks(mask: number, k: number): number {
  let v = 0;
  let got = 0;
  for (let r = 12; r >= 0 && got < k; r--) {
    if (mask & (1 << r)) {
      v = (v << 4) | r;
      got++;
    }
  }
  while (got < k) {
    v <<= 4;
    got++;
  }
  return v;
}

function straightHigh(mask: number): number {
  for (let top = 12; top >= 4; top--) {
    const need = 0x1f << (top - 4);
    if ((mask & need) === need) return top;
  }
  // 휠 A-2-3-4-5
  if ((mask & 0x100f) === 0x100f) return 3;
  return -1;
}

export function evaluate(cards: ArrayLike<number>, n: number = cards.length): number {
  rankCount.fill(0);
  suitMask.fill(0);
  let rankMask = 0;
  for (let i = 0; i < n; i++) {
    const c = cards[i];
    const r = c >> 2;
    const s = c & 3;
    rankCount[r]++;
    suitMask[s] |= 1 << r;
    rankMask |= 1 << r;
  }

  // 플러시 / 스트레이트 플러시
  for (let s = 0; s < 4; s++) {
    const m = suitMask[s];
    if (popcount13(m) >= 5) {
      const sh = straightHigh(m);
      if (sh >= 0) return (8 << 20) | (sh << 16);
      return (5 << 20) | topRanks(m, 5);
    }
  }

  let quad = -1;
  let trips1 = -1;
  let trips2 = -1;
  let pair1 = -1;
  let pair2 = -1;
  let pair3 = -1;
  for (let r = 12; r >= 0; r--) {
    const c = rankCount[r];
    if (c === 4) quad = r;
    else if (c === 3) {
      if (trips1 < 0) trips1 = r;
      else if (trips2 < 0) trips2 = r;
    } else if (c === 2) {
      if (pair1 < 0) pair1 = r;
      else if (pair2 < 0) pair2 = r;
      else if (pair3 < 0) pair3 = r;
    }
  }

  if (quad >= 0) {
    const rest = rankMask & ~(1 << quad);
    return (7 << 20) | (quad << 16) | (topRanks(rest, 1) << 12);
  }
  if (trips1 >= 0 && (pair1 >= 0 || trips2 >= 0)) {
    const pr = Math.max(pair1, trips2);
    return (6 << 20) | (trips1 << 16) | (pr << 12);
  }
  const sh = straightHigh(rankMask);
  if (sh >= 0) return (4 << 20) | (sh << 16);
  if (trips1 >= 0) {
    const rest = rankMask & ~(1 << trips1);
    return (3 << 20) | (trips1 << 16) | (topRanks(rest, 2) << 8);
  }
  if (pair1 >= 0 && pair2 >= 0) {
    let rest = rankMask & ~(1 << pair1) & ~(1 << pair2);
    // 세 번째 페어 랭크도 킥커 후보
    return (2 << 20) | (pair1 << 16) | (pair2 << 12) | (topRanks(rest, 1) << 8);
  }
  if (pair1 >= 0) {
    const rest = rankMask & ~(1 << pair1);
    return (1 << 20) | (pair1 << 16) | (topRanks(rest, 3) << 4);
  }
  return topRanks(rankMask, 5);
}

export function categoryOf(score: number): number {
  return score >>> 20;
}

export function describe(score: number): string {
  return CATEGORY_NAMES[categoryOf(score)];
}

// 5장 조합용 느린 참조 구현 (테스트용)
export function evaluateSlow7(cards: number[]): number {
  let best = -1;
  const n = cards.length;
  const buf = new Array<number>(5);
  for (let a = 0; a < n; a++)
    for (let b = a + 1; b < n; b++)
      for (let c = b + 1; c < n; c++)
        for (let d = c + 1; d < n; d++)
          for (let e = d + 1; e < n; e++) {
            buf[0] = cards[a];
            buf[1] = cards[b];
            buf[2] = cards[c];
            buf[3] = cards[d];
            buf[4] = cards[e];
            const v = evaluate(buf, 5);
            if (v > best) best = v;
          }
  return best;
}
