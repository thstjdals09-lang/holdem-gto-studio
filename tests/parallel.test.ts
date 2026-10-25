// 병렬 솔버 = 단일 스레드 솔버 (같은 반복 수에서 같은 전략·지표)
import { describe, it, expect } from "vitest";
import { parseCards, parseCard } from "../src/engine/cards";
import { parseRange } from "../src/engine/range";
import { buildTree, type TreeConfig } from "../src/engine/tree";
import { PostflopSolver, type PathStep } from "../src/engine/solver";
import { LocalSubPort, ParallelPostflopSolver } from "../src/engine/parallel";

function flopCfg(): TreeConfig {
  const s = { bet: [50], raise: [] as number[] };
  return { board: parseCards("Kh7s2d"), pot: 10, effStack: 40, rakePct: 0, rakeCap: 0, oop: { flop: s, turn: s, river: s }, ip: { flop: s, turn: s, river: s }, allinThresholdPct: 67, maxRaisesPerStreet: 1, allowDonk: true, includeAllin: false };
}
const W0 = parseRange("AA,KK,77,AK,KQ,QJs,T9s,65s,A5s");
const W1 = parseRange("QQ,JJ,TT,AK,KJ,AQ,98s,76s,A4s");

async function both(iters: number, threads: number) {
  const cfg = flopCfg();
  const seq = new PostflopSolver(buildTree(cfg), W0, W1);
  seq.step(iters);
  const par = await ParallelPostflopSolver.create(cfg, W0, W1, Array.from({ length: threads }, () => new LocalSubPort()));
  await par.step(iters);
  return { seq, par };
}

function maxDiff(a: ArrayLike<number>, b: ArrayLike<number>): number {
  let m = 0;
  for (let i = 0; i < a.length; i++) m = Math.max(m, Math.abs(a[i] - b[i]));
  return m;
}

describe("병렬 포스트플랍 솔버", () => {
  it("하위 솔버 1개면 단일 스레드와 비트 단위로 같다 (지표·전략·내보내기)", async () => {
    const { seq, par } = await both(6, 1);
    const ms = seq.metrics();
    const mp = await par.metrics();
    expect(mp.exploitabilityPct).toBe(ms.exploitabilityPct);
    expect(maxDiff(await par.exportStrategy(), seq.serializeStrategy())).toBe(0);
    // 턴 노드 분석(EV 포함)도 같다
    const root = seq.walk([]).node as any;
    const x = root.actions.findIndex((a: any) => a.type === "check");
    const ip = seq.walk([{ kind: "action", index: x }]).node as any;
    const x2 = ip.actions.findIndex((a: any) => a.type === "check");
    const path: PathStep[] = [{ kind: "action", index: x }, { kind: "action", index: x2 }, { kind: "card", card: parseCard("9c") }];
    const vt = await par.view(path);
    const st = seq.walk(path);
    expect(maxDiff(vt.analysis!.ev, seq.analyzeDecision(st.node as any, st.ctx, st.reach).ev)).toBe(0);
    par.close();
  }, 120000);

  it("하위 솔버 3개: 합산 순서만 달라 지표가 거의 같다", async () => {
    const { seq, par } = await both(10, 3);
    const ms = seq.metrics();
    const mp = await par.metrics();
    expect(Math.abs(mp.exploitabilityPct - ms.exploitabilityPct)).toBeLessThan(0.05);
    expect(Math.abs(mp.evOop - ms.evOop)).toBeLessThan(0.02);
    const vRoot = await par.view([]);
    const sRoot = seq.walk([]);
    expect(maxDiff(vRoot.analysis!.strategy, seq.avgStrategy(sRoot.node as any, sRoot.ctx))).toBeLessThan(0.02);
    par.close();
  }, 120000);

  it("턴 노드 잠금(모든 런아웃)이 하위 솔버에 걸린다", async () => {
    const cfg = flopCfg();
    const par = await ParallelPostflopSolver.create(cfg, W0, W1, [new LocalSubPort(), new LocalSubPort()]);
    await par.step(5);
    const root = (await par.view([])).node;
    const x = root.actions!.findIndex((a) => a.type === "check");
    const ipNode = (await par.view([{ kind: "action", index: x }])).node;
    const x2 = ipNode.actions!.findIndex((a) => a.type === "check");
    const path: PathStep[] = [{ kind: "action", index: x }, { kind: "action", index: x2 }, { kind: "card", card: parseCard("9c") }];
    const tv = await par.view(path);
    const A = tv.node.actions!.length;
    const n = par.hands.n;
    const chk = tv.node.actions!.findIndex((a) => a.type === "check");
    const lock = new Float32Array(A * n);
    for (let h = 0; h < n; h++) lock[chk * n + h] = 1;
    await par.lockNode(path, lock, true);
    await par.step(3);
    // 다른 턴 카드(다른 하위 솔버)에서도 OOP 는 항상 체크
    const other: PathStep[] = [path[0], path[1], { kind: "card", card: parseCard("4d") }];
    const ov = await par.view(other);
    const s = ov.analysis!.strategy;
    for (let h = 0; h < n; h++) expect(s[chk * n + h]).toBeCloseTo(1, 5);
    expect(await par.unlockNode(path, true)).toBe(true);
    par.close();
  }, 120000);
});
