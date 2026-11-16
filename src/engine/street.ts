// 한 스트리트 깊이 제한 HU 솔버 — 몇 초 안에 답해야 하는 결정용.
// 지금 스트리트의 베팅만 DCFR로 풀고, 다음 카드가 남은 잎은 "에퀴티 × 실현 모델"로 값을 매긴다.
// 리버는 잎이 실제 쇼다운이라 주어진 레인지·사이즈 안에서 정확하고, 플랍·턴은 근사다.
import { mulberry32 } from "./cards";
import { evaluate } from "./evaluator";
import { oppMass } from "./handeq";
import type { RangeWeights } from "./range";
import { realizationAt } from "./ring";
import { buildHandSet, type HandSet } from "./solver";
import type { DecisionNode, GameTree, TreeNode } from "./tree";

/** 승률 행렬을 만들 때 허용하는 핸드 쌍 비교 횟수(약 0.4초). 넘으면 런아웃을 표본으로 뽑는다 */
const PAIR_BUDGET = 1.5e8;
const MIN_RUNOUTS = 30;

export class StreetSolver {
  readonly hands: HandSet;
  readonly n: number;
  readonly w: [Float32Array, Float32Array];
  /** 승률 계산에 쓴 런아웃 수와, 전부가 아니라 표본인지 */
  readonly runouts: number;
  readonly sampled: boolean;
  iterations = 0;
  /** n×n. 행 핸드가 열 핸드를 이길 확률(동률 0.5). 카드가 겹치는 쌍은 양쪽 다 0 */
  private E: Float32Array;
  private shares = new Map<number, Float32Array>();
  private regret = new Map<number, Float32Array>();
  private sum = new Map<number, Float32Array>();

  constructor(
    readonly tree: GameTree,
    w0: RangeWeights,
    w1: RangeWeights,
    seed = 1
  ) {
    const board = tree.config.board;
    this.hands = buildHandSet(board, w0, w1);
    const n = (this.n = this.hands.n);
    if (n === 0) throw new Error("레인지에 보드와 겹치지 않는 핸드가 없습니다");
    this.w = [Float32Array.from(this.hands.combo, (c) => w0[c]), Float32Array.from(this.hands.combo, (c) => w1[c])];

    const live: number[] = [];
    for (let c = 0; c < 52; c++) if (!board.includes(c)) live.push(c);
    let runs: number[][] = [[]];
    if (board.length === 4) runs = live.map((c) => [c]);
    if (board.length === 3) {
      runs = [];
      for (let i = 0; i < live.length; i++) for (let j = i + 1; j < live.length; j++) runs.push([live[i], live[j]]);
    }
    const max = Math.max(MIN_RUNOUTS, Math.floor(PAIR_BUDGET / ((n * n) / 2)));
    this.sampled = runs.length > max;
    if (this.sampled) {
      const rnd = mulberry32(seed);
      for (let i = 0; i < max; i++) {
        const j = i + Math.floor(rnd() * (runs.length - i));
        [runs[i], runs[j]] = [runs[j], runs[i]];
      }
      runs.length = max;
    }
    this.runouts = runs.length;
    this.E = this.equityMatrix(runs);
  }

  private equityMatrix(runs: number[][]): Float32Array {
    const { n } = this;
    const { a, b } = this.hands;
    const board = this.tree.config.board;
    const win = new Float32Array(n * n); // 위쪽 삼각형만 쓴다
    const cnt = new Float32Array(n * n);
    const str = new Int32Array(n);
    const cards = new Array<number>(7);
    for (const run of runs) {
      const full = board.concat(run);
      for (let k = 0; k < 5; k++) cards[k] = full[k];
      for (let h = 0; h < n; h++) {
        if (run.includes(a[h]) || run.includes(b[h])) {
          str[h] = -1;
          continue;
        }
        cards[5] = a[h];
        cards[6] = b[h];
        str[h] = evaluate(cards, 7);
      }
      for (let i = 0; i < n; i++) {
        const si = str[i];
        if (si < 0) continue;
        const row = i * n;
        for (let j = i + 1; j < n; j++) {
          const sj = str[j];
          if (sj < 0) continue;
          cnt[row + j]++;
          if (si > sj) win[row + j]++;
          else if (si === sj) win[row + j] += 0.5;
        }
      }
    }
    const E = new Float32Array(n * n);
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        if (a[i] === a[j] || a[i] === b[j] || b[i] === a[j] || b[i] === b[j]) continue;
        const c = cnt[i * n + j];
        const e = c > 0 ? win[i * n + j] / c : 0.5;
        E[i * n + j] = e;
        E[j * n + i] = 1 - e;
      }
    }
    return E;
  }

  /** 슬롯 i가 슬롯 j를 이길 확률 (카드가 겹치면 0) */
  equity(i: number, j: number): number {
    return this.E[i * this.n + j];
  }

  /** 잎에서 OOP가 가져가는 팟 몫 행렬 (행 OOP 핸드, 열 IP 핸드) */
  private share(node: TreeNode): Float32Array {
    // 리버 쇼다운과 올인 런아웃은 더 칠 돈이 없으니 승률 그대로
    if (node.kind !== "chance" || node.allin) return this.E;
    const spr = (this.tree.config.effStack - node.invested[0]) / node.pot;
    const key = Math.round(Math.log(Math.max(0.05, spr)) * 8) * 4 + node.street;
    let G = this.shares.get(key);
    if (G) return G;
    // shortcut: 실현 표는 플랍 시작(3스트리트 남음) 기준으로 잰 값이라 남은 스트리트 비율만큼 줄여 쓴다. 턴·리버 잎을 따로 재면 그 값으로 바꿀 것.
    const f = (4 - node.street) / 3;
    const m = realizationAt(spr);
    const ratio = Math.pow(m.ratio, f);
    const slope = m.slope * f;
    const rOop = 1 / Math.sqrt(ratio);
    const rIp = Math.sqrt(ratio);
    const { n, E } = this;
    G = new Float32Array(n * n);
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) {
        const e = E[i * n + j];
        if (e + E[j * n + i] < 0.5) continue; // 카드가 겹치는 쌍
        const fe = Math.max(0.2, 1 + slope * (e - 0.5));
        const fo = Math.max(0.2, 1 + slope * (0.5 - e));
        const p = (e * fe) / (e * fe + (1 - e) * fo);
        const x = p * rOop;
        G[i * n + j] = x / (x + (1 - p) * rIp);
      }
    }
    this.shares.set(key, G);
    return G;
  }

  /** 잎에서 p의 핸드별 반사실 값: 팟 × 몫 − 내가 넣은 돈 (상대 도달 가중) */
  private value(node: Exclude<TreeNode, DecisionNode>, p: 0 | 1, rO: Float32Array): Float32Array {
    const { n } = this;
    const mass = oppMass(this.hands, rO);
    const out = new Float32Array(n);
    const inv = node.invested[p];
    if (node.kind === "terminal" && node.type === "fold") {
      const u = node.folder === p ? -inv : node.pot - inv;
      for (let h = 0; h < n; h++) out[h] = u * mass[h];
      return out;
    }
    const G = this.share(node);
    const acc = new Float64Array(n);
    // 상대 레인지에 있는 슬롯만 돈다. 두 경우 모두 행렬을 행 방향으로 읽어야 빠르다
    const nz = new Int32Array(n);
    let m = 0;
    for (let k = 0; k < n; k++) if (rO[k] !== 0) nz[m++] = k;
    if (p === 0) {
      for (let i = 0; i < n; i++) {
        const row = i * n;
        let s = 0;
        for (let k = 0; k < m; k++) s += rO[nz[k]] * G[row + nz[k]];
        out[i] = node.pot * s - inv * mass[i];
      }
    } else {
      for (let k = 0; k < m; k++) {
        const r = rO[nz[k]];
        const row = nz[k] * n;
        for (let j = 0; j < n; j++) acc[j] += r * G[row + j];
      }
      for (let h = 0; h < n; h++) out[h] = node.pot * (mass[h] - acc[h]) - inv * mass[h];
    }
    return out;
  }

  private table(map: Map<number, Float32Array>, d: DecisionNode): Float32Array {
    let t = map.get(d.id);
    if (!t) map.set(d.id, (t = new Float32Array(d.actions.length * this.n)));
    return t;
  }

  /** 핸드마다 합이 1이 되게 나눈다. positiveOnly 면 양수만 쓴다(후회 매칭). 합이 0이면 고르게 */
  private normalize(src: Float32Array, A: number, positiveOnly: boolean): Float32Array {
    const { n } = this;
    const s = new Float32Array(A * n);
    for (let h = 0; h < n; h++) {
      let tot = 0;
      for (let a = 0; a < A; a++) {
        const x = src[a * n + h];
        if (!positiveOnly || x > 0) tot += x;
      }
      for (let a = 0; a < A; a++) {
        const x = src[a * n + h];
        s[a * n + h] = tot > 0 ? (!positiveOnly || x > 0 ? x / tot : 0) : 1 / A;
      }
    }
    return s;
  }

  /** 평균 전략 (A×n) */
  average(d: DecisionNode): Float32Array {
    return this.normalize(this.table(this.sum, d), d.actions.length, false);
  }

  private scaled(r: Float32Array, s: Float32Array, a: number): Float32Array {
    const { n } = this;
    const out = new Float32Array(n);
    for (let h = 0; h < n; h++) out[h] = r[h] * s[a * n + h];
    return out;
  }

  private cfr(node: TreeNode, p: 0 | 1, rP: Float32Array, rO: Float32Array): Float32Array {
    if (node.kind !== "decision") return this.value(node, p, rO);
    const { n } = this;
    const A = node.actions.length;
    const R = this.table(this.regret, node);
    const s = this.normalize(R, A, true);
    const out = new Float32Array(n);
    if (node.player !== p) {
      for (let a = 0; a < A; a++) {
        const v = this.cfr(node.children[a], p, rP, this.scaled(rO, s, a));
        for (let h = 0; h < n; h++) out[h] += v[h];
      }
      return out;
    }
    const vs: Float32Array[] = [];
    for (let a = 0; a < A; a++) {
      const v = this.cfr(node.children[a], p, this.scaled(rP, s, a), rO);
      vs.push(v);
      for (let h = 0; h < n; h++) out[h] += s[a * n + h] * v[h];
    }
    // DCFR (α 1.5, β 0, γ 2) — 다른 솔버와 같은 값
    const t = this.iterations;
    const pos = Math.pow(t, 1.5) / (Math.pow(t, 1.5) + 1);
    const g = Math.pow(t / (t + 1), 2);
    const S = this.table(this.sum, node);
    for (let a = 0; a < A; a++) {
      const v = vs[a];
      for (let h = 0; h < n; h++) {
        const k = a * n + h;
        const x = R[k];
        R[k] = x * (x > 0 ? pos : 0.5) + v[h] - out[h];
        S[k] = S[k] * g + rP[h] * s[k];
      }
    }
    return out;
  }

  step(k = 1): void {
    for (; k > 0; k--) {
      this.iterations++;
      this.cfr(this.tree.root, 0, this.w[0], this.w[1]);
      this.cfr(this.tree.root, 1, this.w[1], this.w[0]);
    }
  }

  /** 평균 전략으로 둘 때 p의 반사실 값. best 면 p만 핸드마다 최선 액션을 고른다(최선 대응) */
  private evaluate(node: TreeNode, p: 0 | 1, rO: Float32Array, best: boolean): Float32Array {
    if (node.kind !== "decision") return this.value(node, p, rO);
    const { n } = this;
    const A = node.actions.length;
    const s = this.average(node);
    const out = new Float32Array(n);
    if (node.player !== p) {
      for (let a = 0; a < A; a++) {
        const v = this.evaluate(node.children[a], p, this.scaled(rO, s, a), best);
        for (let h = 0; h < n; h++) out[h] += v[h];
      }
      return out;
    }
    if (best) out.fill(-Infinity);
    for (let a = 0; a < A; a++) {
      const v = this.evaluate(node.children[a], p, rO, best);
      for (let h = 0; h < n; h++) out[h] = best ? Math.max(out[h], v[h]) : out[h] + s[a * n + h] * v[h];
    }
    return out;
  }

  /** 지금 전략의 값(bb)과 익스플로잇어빌리티(시작 팟 대비 %). 깊이 제한 게임 안에서 잰 값이다 */
  metrics(): { ev: [number, number]; exploitabilityPct: number } {
    const mass = oppMass(this.hands, this.w[1]);
    let z = 0;
    for (let h = 0; h < this.n; h++) z += this.w[0][h] * mass[h];
    const total = (p: 0 | 1, best: boolean) => {
      const v = this.evaluate(this.tree.root, p, this.w[p === 0 ? 1 : 0], best);
      let s = 0;
      for (let h = 0; h < this.n; h++) if (this.w[p][h] > 0) s += this.w[p][h] * v[h];
      return z > 0 ? s / z : 0;
    };
    const pot = this.tree.config.pot;
    return { ev: [total(0, false), total(1, false)], exploitabilityPct: ((total(0, true) + total(1, true) - pot) / 2 / pot) * 100 };
  }

  /** 노드에서 행동할 사람의 핸드별 평균 전략과 액션 EV (A×n, bb, 지금 폴드하는 것을 0으로 둔 값) */
  analyze(node: DecisionNode, reach: [Float32Array, Float32Array]): { strategy: Float32Array; ev: Float32Array } {
    const { n } = this;
    const p = node.player;
    const rO = reach[p === 0 ? 1 : 0];
    const mass = oppMass(this.hands, rO);
    const ev = new Float32Array(node.actions.length * n);
    node.actions.forEach((_, a) => {
      const v = this.evaluate(node.children[a], p, rO, false);
      for (let h = 0; h < n; h++) ev[a * n + h] = mass[h] > 0 ? v[h] / mass[h] + node.invested[p] : 0;
    });
    return { strategy: this.average(node), ev };
  }
}
