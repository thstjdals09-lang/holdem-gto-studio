// ICM(Malmuth-Harville) 대회 시나리오 분석. 이것은 "정해진 상대 범위에서 폴드·콜 결과별 상금 지분의 기대값"이다.
// ICM 균형 전략 솔버가 아니다. 전체 필드의 스택과 남은 지급 구조가 있어야 계산한다(현재 테이블만으로 대신하지 않는다).
// 정확 계산: 남은 인원 18명 이하는 부분집합 동적계획. 그보다 많으면 지수 시계 표본(Harville 순서와 같은 분포), 시드 고정.
import { mulberry32 } from "../engine/cards";
import type { ClosedResult } from "./allin-ev";
import type { DecisionView } from "./knowledge";
import type { IcmDecision, IcmScenario } from "./types";

export const EXACT_MAX = 18;

/** Harville 정확 계산: stacks 는 모두 양수. payouts[k] = k+1 위 지급액 */
export function icmExact(stacks: number[], payouts: number[]): number[] {
  const n = stacks.length;
  if (n > EXACT_MAX) throw new Error(`정확 계산은 ${EXACT_MAX}명까지입니다`);
  if (stacks.some((s) => !(s > 0))) throw new Error("ICM 스택은 모두 양수여야 합니다");
  const P = Math.min(payouts.length, n);
  const total = stacks.reduce((a, b) => a + b, 0);
  const size = 1 << n;
  const f = new Float64Array(size);
  const sum = new Float64Array(size);
  const pop = new Uint8Array(size);
  for (let m = 1; m < size; m++) {
    const low = m & -m;
    const i = 31 - Math.clz32(low);
    sum[m] = sum[m ^ low] + stacks[i];
    pop[m] = pop[m ^ low] + 1;
  }
  const eq = new Array<number>(n).fill(0);
  f[0] = 1;
  for (let m = 0; m < size; m++) {
    const fm = f[m];
    if (fm === 0 || pop[m] >= P) continue;
    const rem = total - sum[m];
    const pay = payouts[pop[m]];
    for (let i = 0; i < n; i++) {
      if (m & (1 << i)) continue;
      const p = (fm * stacks[i]) / rem;
      eq[i] += p * pay;
      f[m | (1 << i)] += p;
    }
  }
  return eq;
}

/**
 * 필드 하나의 지분. busted(이 핸드에서 탈락) 는 생존자 아래 순위로, 핸드 시작 스택이 큰 쪽이 높고 같으면 상금을 나눈다.
 * exps 를 주면 같은 난수(공통 난수)로 표본을 뽑아 시나리오끼리 비교할 때 잡음을 줄인다.
 */
export function icmField(field: Array<{ stack: number; start: number }>, payouts: number[], mc: { exps: Float64Array[] } | null): { eq: number[]; se: number[] } {
  const surv = field.map((f, i) => ({ ...f, i })).filter((f) => f.stack > 0);
  const busted = field.map((f, i) => ({ ...f, i })).filter((f) => !(f.stack > 0));
  const eq = new Array<number>(field.length).fill(0);
  const se = new Array<number>(field.length).fill(0);
  const m = surv.length;
  const pay = (k: number) => payouts[k] ?? 0;
  // 탈락자: m 위 다음부터. 시작 스택이 같은 묶음은 그 순위들의 상금을 나눈다
  busted.sort((a, b) => b.start - a.start);
  for (let k = 0; k < busted.length; ) {
    let j = k;
    while (j < busted.length && busted[j].start === busted[k].start) j++;
    let s = 0;
    for (let t = k; t < j; t++) s += pay(m + t);
    for (let t = k; t < j; t++) eq[busted[t].i] = s / (j - k);
    k = j;
  }
  if (!mc) {
    const e = icmExact(surv.map((f) => f.stack), payouts.slice(0, m));
    surv.forEach((f, t) => (eq[f.i] = e[t]));
    return { eq, se };
  }
  const S = mc.exps.length;
  const P = Math.min(payouts.length, m);
  const acc = new Float64Array(m);
  const acc2 = new Float64Array(m);
  const idx = new Int32Array(m);
  const t = new Float64Array(m);
  for (let s = 0; s < S; s++) {
    const ex = mc.exps[s];
    for (let k = 0; k < m; k++) {
      t[k] = ex[surv[k].i] / surv[k].stack; // 지수 시계: 먼저 울리는 순서가 Harville 순위
      idx[k] = k;
    }
    const order = Array.from(idx).sort((a, b) => t[a] - t[b]);
    for (let k = 0; k < m; k++) {
      const v = k < P ? payouts[k] : 0;
      acc[order[k]] += v;
      acc2[order[k]] += v * v;
    }
  }
  surv.forEach((f, k) => {
    const mean = acc[k] / S;
    eq[f.i] = mean;
    se[f.i] = Math.sqrt(Math.max(0, acc2[k] / S - mean * mean) / S);
  });
  return { eq, se };
}

export function makeExps(size: number, samples: number, seed: number): Float64Array[] {
  const rng = mulberry32((seed ^ 0x9e3779b9) >>> 0);
  return Array.from({ length: samples }, () => Float64Array.from({ length: size }, () => -Math.log(1 - rng())));
}

/** 판단 하나의 ICM 시나리오. 필요한 입력이 없으면 이유 문자열 */
export function analyzeIcm(view: DecisionView, closed: ClosedResult, opts: { samples: number; seed: number }, rangeNote: string): IcmDecision | string {
  const t = view.tournament;
  if (!t) return "지급 구조와 전체 필드 스택이 없어 ICM 을 계산하지 않았습니다 (칩 EV 만 표시)";
  const seats = view.state.seats;
  const fieldSize = seats.length + t.otherStacks.length;
  if (t.payouts.length > fieldSize) return `지급 순위(${t.payouts.length})가 남은 인원(${fieldSize})보다 많습니다. 남은 순위의 지급액만 넣어 주세요`;
  if (t.payouts.every((x) => x === 0)) return "지급액이 모두 0 입니다";
  const others = t.otherStacks.map((s) => ({ stack: s, start: s }));
  const startOf = (seat: number) => view.seats.find((s) => s.seat === seat)!.start;
  const exact = fieldSize <= EXACT_MAX;
  // shortcut: 큰 필드는 계산량(인원 × 표본 × 시나리오)을 4천만 번 안으로 맞춰 표본 수를 줄인다. 더 정밀해야 하면 이 상한을 올릴 것
  const samples = exact ? 0 : Math.max(2000, Math.min(opts.samples, Math.floor(4e7 / fieldSize / Math.max(1, closed.callOutcomes.length + closed.foldOutcomes.length))));
  const mc = exact ? null : { exps: makeExps(fieldSize, samples, opts.seed) };
  const heroI = seats.findIndex((s) => s.seat === view.seat);
  const evalOutcomes = (outs: ClosedResult["callOutcomes"]) => {
    let mean = 0;
    let icmVar = 0;
    const per = outs.map((o) => {
      const field = [...seats.map((s, i) => ({ stack: o.stacks[i] / 1000, start: startOf(s.seat) })), ...others];
      const r = icmField(field, t.payouts, mc);
      mean += o.prob * r.eq[heroI];
      icmVar += (o.prob * r.se[heroI]) ** 2;
      return { o, eq: r.eq[heroI] };
    });
    // 결과 분포를 표본으로 얻었으면 그 잡음도 더한다
    const between = closed.method === "monte-carlo" ? per.reduce((a, x) => a + x.o.prob * (x.eq - mean) ** 2, 0) / closed.samples : 0;
    return { mean, se: Math.sqrt(icmVar + between), per };
  };
  const fold = evalOutcomes(closed.foldOutcomes);
  const call = evalOutcomes(closed.callOutcomes);
  const heroBefore = seats[heroI].stack;
  const scenarios: IcmScenario[] = [
    ...fold.per.map((x) => ({ label: `폴드${closed.foldOutcomes.length > 1 ? " (남은 상대끼리 결과)" : ""}`, prob: x.o.prob, heroStack: x.o.stacks[heroI] / 1000, heroEquity: x.eq })),
    ...call.per.map((x) => {
      const st = x.o.stacks[heroI] / 1000;
      const label = st <= 0 ? "콜 → 패배(탈락)" : st > heroBefore + 1e-9 ? "콜 → 승리" : st < heroBefore - 1e-9 ? "콜 → 패배(일부 남음)" : "콜 → 무승부·돌려받음";
      return { label, prob: x.o.prob, heroStack: st, heroEquity: x.eq };
    })
  ];
  const diff = call.mean - fold.mean;
  const se = Math.sqrt(call.se ** 2 + fold.se ** 2);
  const prizePool = t.payouts.reduce((a, b) => a + b, 0);
  const verdict = Math.abs(diff) <= 2 * se || Math.abs(diff) < prizePool * 1e-6 ? "ICM 기준 콜과 폴드의 차이가 오차 범위 안입니다" : diff > 0 ? "ICM 기준으로 콜의 상금 지분 기대값이 큽니다" : "ICM 기준으로 폴드의 상금 지분 기대값이 큽니다";
  return {
    method: exact ? "exact" : "monte-carlo",
    ...(exact ? {} : { samples }),
    fieldSize,
    prizePool,
    payoutUnit: t.payoutUnit ?? "상금 단위",
    foldEquity: fold.mean,
    callEquity: call.mean,
    callEquitySe: se,
    diff,
    scenarios,
    chipEvBb: view.bigBlind ? closed.evCall / 1000 / view.bigBlind : null,
    verdict,
    assumptions: [
      "Malmuth-Harville ICM: 남은 칩 비율로 순위 확률을 정합니다 (실력·블라인드 진행·자리 이동은 반영하지 않음)",
      "이 핸드에서 함께 탈락하면 핸드 시작 스택이 큰 쪽이 높은 순위, 같으면 그 순위들의 상금을 나눕니다",
      `${t.kind === "satellite" ? "같은 티켓 새틀라이트: 지급액이 모두 같은 순위 구조" : "일반 지급 구조"}, 테이블 밖 ${t.otherStacks.length}명 스택은 입력값 그대로`,
      exact ? `남은 ${fieldSize}명 정확 계산` : `남은 ${fieldSize}명이라 표본 ${samples}개(시드 ${opts.seed}, 시나리오끼리 같은 난수)`,
      `상대 범위: ${rangeNote}`,
      "정해진 범위에 대한 조건부 EV 이며 ICM 균형 전략 해가 아닙니다"
    ]
  };
}
