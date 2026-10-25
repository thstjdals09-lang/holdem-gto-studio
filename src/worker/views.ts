// 결정 노드 → 화면용 DecisionView 변환 (HU·멀티·라이브러리 공용)
import { CLASS_COMBOS, COMBO_CLASS, NUM_CLASSES } from "../engine/cards";
import type { DecisionView } from "./protocol";

export interface ViewSource {
  n: number;
  combo: Int32Array;
  A: number;
  strategy: Float32Array;
  ev: Float32Array;
  handEv: Float32Array;
  equity: Float32Array;
  eqr?: Float32Array;
  M: Float32Array; // 상대 조합 질량 (가중치용)
  reach: Float32Array[];
}

export type DecisionMeta = Omit<
  DecisionView,
  "classFreq" | "classEv" | "classWeightNorm" | "seatWeightNorm" | "classEquity" | "classEqr" | "classHandEv" | "combos" | "rangeEv" | "rangeEquity" | "kind"
>;

export function buildDecisionView(src: ViewSource, meta: DecisionMeta, rangeEv: number, rangeEquity: number): DecisionView {
  const { n, combo, A, strategy, ev, handEv, equity, M, reach } = src;
  const P = reach.length;
  const p = meta.player;
  const rP = reach[p];
  const classFreq = new Float32Array(NUM_CLASSES * A);
  const classEv = new Float32Array(NUM_CLASSES * A);
  const classWsum = new Float32Array(NUM_CLASSES);
  const classEquity = new Float32Array(NUM_CLASSES);
  const classEqr = new Float32Array(NUM_CLASSES);
  const classHandEv = new Float32Array(NUM_CLASSES);
  const seatW: Float32Array[] = Array.from({ length: P }, () => new Float32Array(NUM_CLASSES));
  const combos: DecisionView["combos"] = [];
  for (let h = 0; h < n; h++) {
    const c = combo[h];
    const cls = COMBO_CLASS[c];
    let any = false;
    const weights: number[] = [];
    for (let q = 0; q < P; q++) {
      const v = reach[q][h];
      weights.push(v);
      if (v > 0) {
        any = true;
        seatW[q][cls] += v;
      }
    }
    if (rP[h] > 0) {
      const w = rP[h] * M[h];
      classWsum[cls] += w;
      for (let a = 0; a < A; a++) {
        classFreq[cls * A + a] += w * strategy[a * n + h];
        classEv[cls * A + a] += w * ev[a * n + h];
      }
      classEquity[cls] += w * equity[h];
      classEqr[cls] += w * (src.eqr ? src.eqr[h] : 0);
      classHandEv[cls] += w * handEv[h];
    }
    if (any) {
      const st: number[] = [];
      const ea: number[] = [];
      for (let a = 0; a < A; a++) {
        st.push(strategy[a * n + h]);
        ea.push(ev[a * n + h]);
      }
      combos.push({ combo: c, weight: rP[h], weights, strategy: st, ev: ea, equity: equity[h], eqr: src.eqr ? src.eqr[h] : 0, handEv: handEv[h] });
    }
  }
  for (let cls = 0; cls < NUM_CLASSES; cls++) {
    const ws = classWsum[cls];
    if (ws > 0) {
      for (let a = 0; a < A; a++) {
        classFreq[cls * A + a] /= ws;
        classEv[cls * A + a] /= ws;
      }
      classEquity[cls] /= ws;
      classEqr[cls] /= ws;
      classHandEv[cls] /= ws;
    }
    for (let q = 0; q < P; q++) seatW[q][cls] /= CLASS_COMBOS[cls].length;
  }
  return { kind: "decision", ...meta, classFreq, classEv, classWeightNorm: seatW[p], seatWeightNorm: seatW, classEquity, classEqr, classHandEv, combos, rangeEv, rangeEquity };
}
