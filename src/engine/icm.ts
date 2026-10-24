// ICM (Malmuth-Harville) 계산기와 버블 팩터

/** 각 플레이어의 ICM 상금 기대값. payouts는 1위부터 내림차순 (길이 ≤ 플레이어 수). */
export function icmEquities(stacks: number[], payouts: number[]): number[] {
  const n = stacks.length;
  const places = Math.min(payouts.length, n);
  const total = stacks.reduce((a, b) => a + b, 0);
  const out = new Array<number>(n).fill(0);
  if (total <= 0) return out;
  // 메모: key = (remainingMask) → P(각 플레이어가 remaining 중 1위)
  // 재귀: f(mask, place): mask에 남은 플레이어들 중 place위 확률 분배
  const memo = new Map<number, Float64Array>();
  function dist(mask: number, place: number) {
    // 확률 prob로 mask 상태 도달 → 남은 플레이어 중 다음 순위 분배
    const stack: Array<[number, number, number]> = [[mask, place, 1]];
    while (stack.length) {
      const [m, pl, prob] = stack.pop()!;
      if (pl >= places || prob < 1e-12) continue;
      let sum = 0;
      for (let i = 0; i < n; i++) if (m & (1 << i)) sum += stacks[i];
      if (sum <= 0) continue;
      for (let i = 0; i < n; i++) {
        if (!(m & (1 << i))) continue;
        const p = (stacks[i] / sum) * prob;
        out[i] += p * payouts[pl];
        if (pl + 1 < places) stack.push([m & ~(1 << i), pl + 1, p]);
      }
    }
  }
  void memo;
  dist((1 << n) - 1, 0);
  return out;
}

/** 칩 EV 대비 ICM EV 변화. i가 j와 올인 대결했을 때 버블 팩터 = (지면 잃는 $) / (이기면 얻는 $) */
export function bubbleFactors(stacks: number[], payouts: number[]): number[][] {
  const n = stacks.length;
  const base = icmEquities(stacks, payouts);
  const bf: number[][] = Array.from({ length: n }, () => new Array<number>(n).fill(0));
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      if (i === j) continue;
      const risk = Math.min(stacks[i], stacks[j]);
      if (risk <= 0) continue;
      const win = stacks.slice();
      win[i] += risk;
      win[j] -= risk;
      const lose = stacks.slice();
      lose[i] -= risk;
      lose[j] += risk;
      const gain = icmEquities(win, payouts)[i] - base[i];
      const loss = base[i] - icmEquities(lose, payouts)[i];
      bf[i][j] = gain > 1e-12 ? loss / gain : 0;
    }
  }
  return bf;
}

/** 올인 콜에 필요한 최소 에퀴티 (버블 팩터 기반 간이식): eq ≥ BF / (1 + BF) 의 칩 팟오즈 보정 */
export function requiredEquityWithBubble(potOddsEquity: number, bubbleFactor: number): number {
  // 칩 기준 필요 에퀴티 e = call/(pot+call). ICM 기준: 이득 1, 손실 BF → e' = BF·e / (1 + (BF-1)·e)
  const e = potOddsEquity;
  return (bubbleFactor * e) / (1 + (bubbleFactor - 1) * e);
}
