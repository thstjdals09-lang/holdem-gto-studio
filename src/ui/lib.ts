// 라이브러리 파일 로더 (브라우저)
import type { PfLib } from "../lib/preflopLib";
import { MATCHUPS, type Matchup, type MatchupIndex } from "../lib/postflopLib";

export function libBase(): string {
  return new URL("lib/", document.baseURI).href;
}

const pfCache = new Map<string, Promise<PfLib>>();
export function loadPreflop(fmt: string): Promise<PfLib> {
  let p = pfCache.get(fmt);
  if (!p) {
    p = fetch(`${libBase()}preflop/${fmt}.json`).then((r) => {
      if (!r.ok) throw new Error(`프리플랍 라이브러리(${fmt})를 불러오지 못했습니다`);
      return r.json() as Promise<PfLib>;
    });
    pfCache.set(fmt, p);
    p.catch(() => pfCache.delete(fmt));
  }
  return p;
}

const idxCache = new Map<string, Promise<MatchupIndex | null>>();
export function loadMatchupIndex(id: string): Promise<MatchupIndex | null> {
  let p = idxCache.get(id);
  if (!p) {
    p = fetch(`${libBase()}postflop/${id}/index.json`).then((r) => (r.ok ? (r.json() as Promise<MatchupIndex>) : null)).catch(() => null);
    idxCache.set(id, p);
  }
  return p;
}

export function findMatchup(fmt: string, codes: string[]): Matchup | null {
  return MATCHUPS.find((m) => m.format === fmt && m.codes.length === codes.length && m.codes.every((c, i) => c === codes[i])) ?? null;
}

export const FORMAT_LIST = [
  { id: "cash6-100", name: "캐시 6맥스 100bb" },
  { id: "mtt8-40", name: "토너먼트 8맥스 40bb (앤티)" }
];

export function encodeIdx(a: number[]): string {
  return a.join(".");
}
export function decodeIdx(s: string | null): number[] {
  if (!s) return [];
  return s
    .split(".")
    .filter((x) => x !== "")
    .map(Number);
}

/** 보드 텍스처 분류 (리포트용) */
export function flopTexture(flop: string): { high: string; suits: "레인보우" | "투톤" | "모노톤"; paired: boolean; connected: boolean } {
  const ranks = [flop[0], flop[2], flop[4]];
  const suits = [flop[1], flop[3], flop[5]];
  const R = "23456789TJQKA";
  const rv = ranks.map((r) => R.indexOf(r)).sort((a, b) => b - a);
  const su = new Set(suits).size;
  const paired = new Set(ranks).size < 3;
  const span = rv[0] - rv[2];
  const high = rv[0] >= 9 ? R[rv[0]] + " 하이" : "9 이하";
  return { high, suits: su === 3 ? "레인보우" : su === 2 ? "투톤" : "모노톤", paired, connected: !paired && span <= 4 };
}
