import { describe, it, expect } from "vitest";
import { parseCards } from "../src/engine/cards";
import { parseRange } from "../src/engine/range";
import { buildTree, type TreeConfig } from "../src/engine/tree";
import { PostflopSolver } from "../src/engine/solver";

function cfg(partial: Partial<TreeConfig>): TreeConfig {
  const none = { bet: [] as number[], raise: [] as number[] };
  return {
    board: parseCards("2c7d9hJsKd"),
    pot: 10,
    effStack: 20,
    rakePct: 0,
    rakeCap: 0,
    oop: { flop: none, turn: none, river: none },
    ip: { flop: none, turn: none, river: none },
    allinThresholdPct: 0,
    maxRaisesPerStreet: 1,
    allowDonk: true,
    includeAllin: false,
    ...partial
  };
}
const oop = parseRange("AA,KK,QQ,JJ,TT,99,88,77,66,55,44,33,22,AK,AQ,AJ,KQ,T9s,98s,87s,76s,65s");
const ip = parseRange("AA,KK,QQ,JJ,TT,99,88,AQ,AJs,KQs,KJs,QJs,JTs,T9s,98s");
const one = { bet: [66], raise: [] as number[] };

describe("EV 보존 (레이크 0이면 EV OOP + EV IP = 팟)", () => {
  it("리버 체크만", () => {
    const s = new PostflopSolver(buildTree(cfg({ board: parseCards("2c7d9hJsKd") })), oop, ip);
    s.step(2);
    const m = s.metrics();
    expect(m.evOop + m.evIp).toBeCloseTo(10, 5);
  });
  it("턴 체크만 (찬스 노드 확률)", () => {
    const s = new PostflopSolver(buildTree(cfg({ board: parseCards("2c7d9hJs") })), oop, ip);
    s.step(2);
    const m = s.metrics();
    expect(m.evOop + m.evIp).toBeCloseTo(10, 4);
  });
  it("플랍 체크만 (찬스 노드 2단)", () => {
    const s = new PostflopSolver(buildTree(cfg({ board: parseCards("2c7d9h") })), oop, ip);
    s.step(1);
    const m = s.metrics();
    expect(m.evOop + m.evIp).toBeCloseTo(10, 3);
  });
  it("리버 벳 포함: 빠른 수렴", () => {
    const s = new PostflopSolver(buildTree(cfg({ board: parseCards("2c7d9hJsKd"), oop: { flop: one, turn: one, river: one }, ip: { flop: one, turn: one, river: one } })), oop, ip);
    s.step(50);
    const m = s.metrics();
    expect(m.evOop + m.evIp).toBeCloseTo(10, 4);
    expect(m.exploitabilityPct).toBeLessThan(0.5);
  });
  it("턴 벳 포함", () => {
    const s = new PostflopSolver(buildTree(cfg({ board: parseCards("2c7d9hJs"), oop: { flop: one, turn: one, river: one }, ip: { flop: one, turn: one, river: one } })), oop, ip);
    s.step(60);
    const m = s.metrics();
    expect(m.evOop + m.evIp).toBeCloseTo(10, 3);
    expect(m.exploitabilityPct).toBeLessThan(1.5);
  });
  it("레이크가 있으면 EV 합 < 팟", () => {
    const s = new PostflopSolver(buildTree(cfg({ board: parseCards("2c7d9hJsKd"), rakePct: 5, rakeCap: 1, oop: { flop: one, turn: one, river: one }, ip: { flop: one, turn: one, river: one } })), oop, ip);
    s.step(30);
    const m = s.metrics();
    expect(m.evOop + m.evIp).toBeLessThan(10);
    expect(m.evOop + m.evIp).toBeGreaterThan(9);
  });
});
