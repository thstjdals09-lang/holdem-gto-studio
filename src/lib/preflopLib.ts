// 프리플랍 라이브러리(JSON) 타입과 탐색 유틸. 브라우저와 생성 스크립트가 함께 사용.
import { CLASS_COMBOS, NUM_CLASSES } from "../engine/cards";
import type { RingConfig } from "../engine/ring";

export interface PfLibNode {
  id: number;
  p: number;
  pot: number;
  inv: number[];
  fold: number[];
  call: number;
  lv: number;
  line: string;
  a: Array<[string, number, string, string]>; // [type, to, label, code]
  c: Array<number | string>; // 자식: 결정 노드 id 또는 "t<터미널 id>"
  s: number[]; // A*169, 0~1000
  e: number[]; // A*169, 0.01bb
}
export interface PfLibTerminal {
  id: number;
  type: "fold" | "flop" | "allin";
  pot: number;
  inv: number[];
  fold: number[];
  w: number;
}
export interface PfLib {
  format: RingConfig;
  iterations: number;
  exploitabilityBb: number;
  ev: number[];
  nodes: PfLibNode[];
  terminals: PfLibTerminal[];
  generatedAt: string;
}

export const CLASS_N = Float64Array.from({ length: NUM_CLASSES }, (_, c) => CLASS_COMBOS[c].length);

export interface PfWalk {
  node: PfLibNode | null;
  terminal: PfLibTerminal | null;
  reach: Float64Array[]; // 자리별 169 (콤보 수 단위)
  steps: Array<{ node: PfLibNode; action: number }>;
}

export function strategyOf(node: PfLibNode, a: number, cls: number): number {
  return node.s[a * NUM_CLASSES + cls] / 1000;
}

/** 액션 인덱스 경로로 이동하며 reach 계산 */
export function walkIdx(lib: PfLib, path: number[]): PfWalk {
  const N = lib.format.positions.length;
  const reach = Array.from({ length: N }, () => Float64Array.from(CLASS_N));
  let node: PfLibNode | null = lib.nodes[0];
  let terminal: PfLibTerminal | null = null;
  const steps: PfWalk["steps"] = [];
  for (const a of path) {
    if (!node) throw new Error("경로가 터미널을 지났습니다");
    const r = reach[node.p];
    for (let i = 0; i < NUM_CLASSES; i++) r[i] *= strategyOf(node, a, i);
    steps.push({ node, action: a });
    const c: number | string = node.c[a];
    if (typeof c === "string") {
      terminal = lib.terminals[Number(c.slice(1))];
      node = null;
    } else node = lib.nodes[c];
  }
  return { node, terminal, reach, steps };
}

/** 액션 코드 경로("F","R2.5","C"...)로 이동 */
export function walkCodes(lib: PfLib, codes: string[]): PfWalk {
  const idx: number[] = [];
  let node: PfLibNode | null = lib.nodes[0];
  for (const code of codes) {
    if (!node) throw new Error("경로가 터미널을 지났습니다");
    const a = node.a.findIndex((x) => x[3] === code);
    if (a < 0) throw new Error(`액션 ${code} 없음 (노드 ${node.line}: ${node.a.map((x) => x[3]).join(",")})`);
    idx.push(a);
    const c: number | string = node.c[a];
    node = typeof c === "string" ? null : lib.nodes[c];
  }
  return walkIdx(lib, idx);
}

/** 169 reach → 1326 콤보 가중치 (0~1) */
export function reachToCombos(reach: Float64Array, minWeight = 0): Float32Array {
  const w = new Float32Array(1326);
  for (let c = 0; c < NUM_CLASSES; c++) {
    const v = reach[c] / CLASS_N[c];
    if (v <= minWeight) continue;
    for (const i of CLASS_COMBOS[c]) w[i] = Math.min(1, v);
  }
  return w;
}

/** 자리 이름 → 인덱스 */
export function seatIndex(lib: PfLib, name: string): number {
  return lib.format.positions.indexOf(name);
}
