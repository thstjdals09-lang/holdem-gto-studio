// 노드 잠금: 잠근 노드는 고정 전략을 따르고, 상대는 그에 맞춰 바뀐다
import { describe, it, expect } from "vitest";
import { parseCards } from "../src/engine/cards";
import { parseRange, emptyRange } from "../src/engine/range";
import { buildTree, type TreeConfig } from "../src/engine/tree";
import { PostflopSolver } from "../src/engine/solver";

function river(): TreeConfig {
  const none = { bet: [] as number[], raise: [] as number[] };
  const one = { bet: [100], raise: [] as number[] };
  return { board: parseCards("2c7d9hJsKd"), pot: 10, effStack: 10, rakePct: 0, rakeCap: 0, oop: { flop: one, turn: one, river: one }, ip: { flop: none, turn: none, river: none }, allinThresholdPct: 0, maxRaisesPerStreet: 1, allowDonk: true, includeAllin: false };
}

function idx(text: string): number[] {
  const r = parseRange(text);
  const out: number[] = [];
  for (let i = 0; i < r.length; i++) if (r[i] > 0) out.push(i);
  return out;
}

function setup() {
  const oop = emptyRange();
  const ip = emptyRange();
  for (const i of idx("AA")) oop[i] = 1;
  for (const i of idx("83o")) oop[i] = 0.5;
  for (const i of idx("QQ")) ip[i] = 1;
  return new PostflopSolver(buildTree(river()), oop, ip);
}

/** IP가 벳을 맞은 노드에서 레인지 전체 콜 빈도 */
function ipCallFreq(s: PostflopSolver): number {
  const root = s.walk([]).node as any;
  const bet = root.actions.findIndex((a: any) => a.type !== "check");
  const { node, ctx, reach } = s.walk([{ kind: "action", index: bet }]);
  const d = node as any;
  const call = d.actions.findIndex((a: any) => a.type === "call");
  const st = s.avgStrategy(d, ctx);
  const n = s.hands.n;
  let f = 0;
  let w = 0;
  for (let h = 0; h < n; h++) {
    f += reach[1][h] * st[call * n + h];
    w += reach[1][h];
  }
  return f / w;
}

describe("노드 잠금", () => {
  it("OOP를 '항상 벳'으로 잠그면 IP는 거의 항상 콜한다", () => {
    const s = setup();
    s.step(300);
    const before = ipCallFreq(s);
    expect(before).toBeGreaterThan(0.4);
    expect(before).toBeLessThan(0.6);
    const root = s.walk([]).node as any;
    const A = root.actions.length;
    const bet = root.actions.findIndex((a: any) => a.type !== "check");
    const lock = new Float32Array(A * s.hands.n);
    for (let h = 0; h < s.hands.n; h++) lock[bet * s.hands.n + h] = 1;
    s.lockNode([], lock);
    expect(s.lockCount).toBe(1);
    s.step(400);
    // 잠긴 노드의 평균 전략은 고정값
    const st = s.avgStrategy(root, s.walk([]).ctx);
    for (let h = 0; h < s.hands.n; h++) if (s.w[0][h] > 0) expect(st[bet * s.hands.n + h]).toBeCloseTo(1, 5);
    expect(ipCallFreq(s)).toBeGreaterThan(0.9);
    // 잠금을 전제로 한 나머지 전략은 수렴
    expect(s.metrics().exploitabilityPct).toBeLessThan(3);
    // 해제하면 다시 균형으로
    expect(s.unlockNode([])).toBe(true);
    expect(s.lockCount).toBe(0);
    s.step(1500);
    expect(ipCallFreq(s)).toBeLessThan(0.7);
  });
});
