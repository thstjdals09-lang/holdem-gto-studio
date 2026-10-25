// 포스트플랍 라이브러리 정의와 바이너리 포맷. 브라우저와 생성 스크립트 공용.
import type { TreeConfig } from "../engine/tree";

export interface Matchup {
  id: string;
  name: string;
  format: string; // 프리플랍 포맷 id
  codes: string[]; // 프리플랍 액션 코드 경로
  oop: string;
  ip: string;
  kind: "srp" | "3bp";
}

export const MATCHUPS: Matchup[] = [
  { id: "btn-bb-srp", name: "BTN 오픈 vs BB 콜 (SRP)", format: "cash6-100", codes: ["F", "F", "F", "R2.5", "F", "C"], oop: "BB", ip: "BTN", kind: "srp" },
  { id: "co-bb-srp", name: "CO 오픈 vs BB 콜 (SRP)", format: "cash6-100", codes: ["F", "F", "R2.5", "F", "F", "C"], oop: "BB", ip: "CO", kind: "srp" },
  { id: "sb-bb-srp", name: "SB 오픈 vs BB 콜 (블라인드 배틀)", format: "cash6-100", codes: ["F", "F", "F", "F", "R3", "C"], oop: "SB", ip: "BB", kind: "srp" },
  { id: "bb-btn-3bp", name: "BTN 오픈 · BB 3벳 · BTN 콜 (3BP)", format: "cash6-100", codes: ["F", "F", "F", "R2.5", "F", "R10", "C"], oop: "BB", ip: "BTN", kind: "3bp" }
];

/** 대표 플랍 24개 (높이·연결성·수트 구성·페어 분포를 고르게) */
export const FLOPS = [
  "As7d2c", "AhKd4c", "AsJh9h", "AhTh5h",
  "Ks7d2c", "KhQs6d", "Kd9d4s", "KsKd7c",
  "QhJd8c", "Qs6h3d", "QdTd2c",
  "JsTd7c", "Jh8h4c", "Th6c2d", "Ts9s6d",
  "9h7d2c", "9s9d5h", "8s6d5c", "8c7c4c", "8d8c3s",
  "7h5h3d", "6s4d2c", "5h4d3c", "AsAh9d"
];

/** 보조 매치업용 대표 플랍 12개 */
export const FLOPS_SMALL = ["As7d2c", "AhKd4c", "AhTh5h", "Ks7d2c", "Kd9d4s", "QhJd8c", "JsTd7c", "Ts9s6d", "9h7d2c", "8s6d5c", "7h5h3d", "8d8c3s"];

export function flopsFor(matchupId: string): string[] {
  return matchupId === "co-bb-srp" || matchupId === "sb-bb-srp" ? FLOPS_SMALL : FLOPS;
}

export function treeConfigFor(kind: "srp" | "3bp", board: number[], pot: number, effStack: number): TreeConfig {
  if (kind === "srp") {
    return {
      board,
      pot,
      effStack,
      rakePct: 0,
      rakeCap: 0,
      oop: { flop: { bet: [], raise: [60] }, turn: { bet: [66], raise: [] }, river: { bet: [75], raise: [] } },
      ip: { flop: { bet: [33], raise: [60] }, turn: { bet: [66], raise: [] }, river: { bet: [75], raise: [] } },
      allinThresholdPct: 67,
      maxRaisesPerStreet: 2,
      maxRaisesByStreet: [2, 1, 1],
      allowDonk: true,
      includeAllin: false
    };
  }
  return {
    board,
    pot,
    effStack,
    rakePct: 0,
    rakeCap: 0,
    oop: { flop: { bet: [33], raise: [60] }, turn: { bet: [66], raise: [] }, river: { bet: [75], raise: [] } },
    ip: { flop: { bet: [33], raise: [60] }, turn: { bet: [66], raise: [] }, river: { bet: [75], raise: [] } },
    allinThresholdPct: 67,
    maxRaisesPerStreet: 2,
    maxRaisesByStreet: [2, 1, 1],
    allowDonk: true,
    includeAllin: false
  };
}

export interface FlopMeta {
  matchup: string;
  flop: string;
  config: TreeConfig;
  hands: number[]; // 슬롯 → 1326 콤보
  w0: number[]; // OOP 가중치 (슬롯별, 0~1, 3자리)
  w1: number[];
  iterations: number;
  exploitabilityPct: number;
  evOop: number;
  evIp: number;
  eqOop: number;
  root: { oop: Array<{ label: string; freq: number; ev: number }>; ipVsCheck: Array<{ label: string; freq: number; ev: number }> };
}

export interface MatchupIndex {
  matchup: Matchup;
  pot: number;
  effStack: number;
  flops: Array<{ flop: string; iterations: number; exploitabilityPct: number; evOop: number; evIp: number; eqOop: number; root: FlopMeta["root"] }>;
}
