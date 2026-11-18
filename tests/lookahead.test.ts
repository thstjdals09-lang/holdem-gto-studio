// 깊이 제한 솔버(LookaheadSolver): 잎 뒤에 실제 카드를 딜해 한 라운드 더 풀고 정확한 쇼다운으로 끝낸다
import { describe, it, expect } from "vitest";
import { comboIndex, parseCard, parseCards } from "../src/engine/cards";
import { LookaheadSolver } from "../src/engine/lookahead";
import { LocalSubPort, lookaheadOnPorts } from "../src/engine/parallel";
import { parseRange } from "../src/engine/range";
import { PostflopSolver } from "../src/engine/solver";
import { buildTree, type DecisionNode, type TreeConfig } from "../src/engine/tree";

const one = { bet: [66], raise: [] as number[] };
const oop = parseRange("AA,KK,QQ,JJ,TT,99,88,77,66,55,44,33,22,AK,AQ,AJ,KQ,T9s,98s,87s,76s,65s");
const ip = parseRange("AA,KK,QQ,JJ,TT,99,88,AQ,AJs,KQs,KJs,QJs,JTs,T9s,98s");
function cfg(board: string): TreeConfig {
  return { board: parseCards(board), pot: 10, effStack: 20, rakePct: 0, rakeCap: 0, oop: { flop: one, turn: one, river: one }, ip: { flop: one, turn: one, river: one }, allinThresholdPct: 0, maxRaisesPerStreet: 1, allowDonk: true, includeAllin: false };
}

describe("깊이 제한 솔버", () => {
  it("리버는 전체 솔버와 같은 값으로 수렴한다", () => {
    const full = new PostflopSolver(buildTree(cfg("2c7d9hJsKd")), oop, ip);
    const look = new LookaheadSolver(cfg("2c7d9hJsKd"), oop, ip);
    full.step(200);
    look.step(200);
    const a = full.metrics();
    const b = look.metrics();
    expect(b.exploitabilityPct).toBeLessThan(0.5);
    expect(b.ev[0]).toBeCloseTo(a.evOop, 1);
    expect(b.ev[1]).toBeCloseTo(a.evIp, 1);
  });

  it("턴은 리버 크기가 같으면 턴부터 끝까지 푼 전체 솔버와 같은 게임이다", () => {
    const full = new PostflopSolver(buildTree(cfg("2c7d9hJs")), oop, ip);
    const look = new LookaheadSolver(cfg("2c7d9hJs"), oop, ip);
    expect(look.runouts).toBe(48);
    expect(look.sampled).toBe(false);
    full.step(150);
    look.step(150);
    const a = full.metrics();
    const b = look.metrics();
    expect(b.ev[0]).toBeCloseTo(a.evOop, 1);
    expect(b.ev[1]).toBeCloseTo(a.evIp, 1);
    expect(b.ev[0] + b.ev[1]).toBeCloseTo(10, 2);
    // 루트 전략도 같은 해에 가깝다
    const sa = full.avgStrategy(full.tree.root as DecisionNode, full.walk([]).ctx);
    const sb = look.average(look.tree.root as DecisionNode);
    let diff = 0;
    for (let k = 0; k < sa.length; k++) diff += Math.abs(sa[k] - sb[k]);
    expect(diff / look.hands.n).toBeLessThan(0.1);
  });

  it("플랍: 런아웃 표본으로도 값의 합은 팟이고 익스플로잇어빌리티가 줄어든다", () => {
    const look = new LookaheadSolver(cfg("2c7d9h"), oop, ip, { runouts: 24 });
    expect(look.sampled).toBe(true);
    expect(look.runouts).toBe(24);
    look.step(3);
    const m1 = look.metrics();
    look.step(60);
    const m2 = look.metrics();
    expect(m2.ev[0] + m2.ev[1]).toBeCloseTo(10, 1);
    expect(m2.exploitabilityPct).toBeLessThan(m1.exploitabilityPct);
    expect(m2.exploitabilityPct).toBeLessThan(1);
  });

  it("셋은 벳에 폴드하지 않고, 액션 EV 는 폴드를 0 으로 둔 값이다", () => {
    const look = new LookaheadSolver(cfg("2c7d9hJs"), oop, ip);
    look.step(80);
    const root = look.tree.root as DecisionNode;
    const facing = root.children[root.actions.findIndex((a) => a.type === "bet")] as DecisionNode;
    const an = look.analyze(facing, [look.w[0].slice(), look.w[1].slice()]);
    const n = look.hands.n;
    const fold = facing.actions.findIndex((a) => a.type === "fold");
    const slot = look.hands.slotOfCombo[comboIndex(parseCard("9s"), parseCard("9d"))];
    expect(an.ev[fold * n + slot]).toBeCloseTo(0, 5);
    expect(an.strategy[fold * n + slot]).toBeLessThan(0.02);
  });

  it("하위 솔버 1개에 맡기면 한 스레드와 비트 단위로 같다 (전략·지표·액션 EV)", async () => {
    const c = cfg("2c7d9h");
    const opts = { runouts: 12, cv: 2e7 };
    const one = new LookaheadSolver(c, oop, ip, opts);
    const par = await lookaheadOnPorts([new LocalSubPort()], c, oop, ip, opts);
    one.step(15);
    await par.stepAsync(15);
    expect(await par.metricsAsync()).toEqual(one.metrics());
    const root = one.tree.root as DecisionNode;
    expect(par.average(par.tree.root as DecisionNode)).toEqual(one.average(root));
    expect((await par.analyzeAsync(par.tree.root as DecisionNode, [par.w[0], par.w[1]])).ev).toEqual(one.analyze(root, [one.w[0], one.w[1]]).ev);
  });

  it("하위 솔버 3개: 합 순서만 달라 지표가 거의 같다", async () => {
    const c = cfg("2c7d9h");
    const opts = { runouts: 12, cv: 2e7 };
    const one = new LookaheadSolver(c, oop, ip, opts);
    const par = await lookaheadOnPorts([new LocalSubPort(), new LocalSubPort(), new LocalSubPort()], c, oop, ip, opts);
    one.step(40);
    await par.stepAsync(40);
    const a = one.metrics();
    const b = await par.metricsAsync();
    expect(b.ev[0]).toBeCloseTo(a.ev[0], 1);
    expect(b.ev[1]).toBeCloseTo(a.ev[1], 1);
    expect(Math.abs(b.exploitabilityPct - a.exploitabilityPct)).toBeLessThan(0.3);
  });
});
