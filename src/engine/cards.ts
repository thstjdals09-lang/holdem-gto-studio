// 카드 표현: 0..51 정수. rank = id >> 2 (0=2 … 12=A), suit = id & 3 (0=c 1=d 2=h 3=s)

export const RANKS = "23456789TJQKA";
export const SUITS = "cdhs";
export const SUIT_SYMBOLS = ["♣", "♦", "♥", "♠"];

export function makeCard(rank: number, suit: number): number {
  return (rank << 2) | suit;
}
export function rankOf(card: number): number {
  return card >> 2;
}
export function suitOf(card: number): number {
  return card & 3;
}
export function cardToString(card: number): string {
  return RANKS[rankOf(card)] + SUITS[suitOf(card)];
}
export function cardToPretty(card: number): string {
  return RANKS[rankOf(card)] + SUIT_SYMBOLS[suitOf(card)];
}
export function parseCard(s: string): number {
  const r = RANKS.indexOf(s[0].toUpperCase());
  const su = SUITS.indexOf(s[1].toLowerCase());
  if (r < 0 || su < 0) throw new Error(`잘못된 카드: ${s}`);
  return makeCard(r, su);
}
/** "AhKd2c" 또는 "Ah Kd 2c" 또는 "Ah,Kd" */
export function parseCards(s: string): number[] {
  const clean = s.replace(/[\s,]+/g, "");
  if (clean.length % 2 !== 0) throw new Error(`카드 문자열 길이가 맞지 않습니다: ${s}`);
  const out: number[] = [];
  for (let i = 0; i < clean.length; i += 2) out.push(parseCard(clean.slice(i, i + 2)));
  const seen = new Set<number>();
  for (const c of out) {
    if (seen.has(c)) throw new Error(`중복 카드: ${cardToString(c)}`);
    seen.add(c);
  }
  return out;
}
export function cardsToString(cards: ArrayLike<number>): string {
  let s = "";
  for (let i = 0; i < cards.length; i++) s += cardToString(cards[i]);
  return s;
}

// ---- 1326 콤보 ----
export const NUM_COMBOS = 1326;
/** COMBO_CARDS[i] = [lo, hi] with lo < hi */
export const COMBO_CARDS: Array<[number, number]> = [];
const comboIndexTable = new Int16Array(52 * 52).fill(-1);
{
  let idx = 0;
  for (let a = 0; a < 52; a++) {
    for (let b = a + 1; b < 52; b++) {
      COMBO_CARDS.push([a, b]);
      comboIndexTable[a * 52 + b] = idx;
      comboIndexTable[b * 52 + a] = idx;
      idx++;
    }
  }
}
export function comboIndex(c1: number, c2: number): number {
  return comboIndexTable[c1 * 52 + c2];
}
export function comboToString(idx: number): string {
  const [a, b] = COMBO_CARDS[idx];
  // 높은 카드를 먼저 표기
  return rankOf(a) >= rankOf(b) ? cardToString(a) + cardToString(b) : cardToString(b) + cardToString(a);
}

// ---- 169 핸드 클래스 (13x13 그리드) ----
// 그리드 row/col: 0=A … 12=2. 대각선 = 페어, 오른쪽 위 = 수딧, 왼콽 아래 = 오프수트
export const NUM_CLASSES = 169;
export function classIndexFromRanks(r1: number, r2: number, suited: boolean): number {
  const hi = Math.max(r1, r2);
  const lo = Math.min(r1, r2);
  if (hi === lo) return (12 - hi) * 13 + (12 - hi);
  if (suited) return (12 - hi) * 13 + (12 - lo);
  return (12 - lo) * 13 + (12 - hi);
}
export function classOfCombo(idx: number): number {
  const [a, b] = COMBO_CARDS[idx];
  return classIndexFromRanks(rankOf(a), rankOf(b), suitOf(a) === suitOf(b));
}
export const COMBO_CLASS = new Uint8Array(NUM_COMBOS);
export const CLASS_COMBOS: number[][] = Array.from({ length: NUM_CLASSES }, () => []);
for (let i = 0; i < NUM_COMBOS; i++) {
  const c = classOfCombo(i);
  COMBO_CLASS[i] = c;
  CLASS_COMBOS[c].push(i);
}
export function classLabel(cls: number): string {
  const row = Math.floor(cls / 13);
  const col = cls % 13;
  const rHi = 12 - Math.min(row, col);
  const rLo = 12 - Math.max(row, col);
  if (row === col) return RANKS[rHi] + RANKS[rHi];
  return RANKS[rHi] + RANKS[rLo] + (row < col ? "s" : "o");
}
export function classInfo(cls: number): { hi: number; lo: number; kind: "pair" | "suited" | "offsuit" } {
  const row = Math.floor(cls / 13);
  const col = cls % 13;
  const hi = 12 - Math.min(row, col);
  const lo = 12 - Math.max(row, col);
  return { hi, lo, kind: row === col ? "pair" : row < col ? "suited" : "offsuit" };
}

export function shuffledDeck(exclude: Iterable<number>, rng: () => number = Math.random): number[] {
  const ex = new Set(exclude);
  const deck: number[] = [];
  for (let c = 0; c < 52; c++) if (!ex.has(c)) deck.push(c);
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const t = deck[i];
    deck[i] = deck[j];
    deck[j] = t;
  }
  return deck;
}

/** 결정적 난수 (테스트·재현용) */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
