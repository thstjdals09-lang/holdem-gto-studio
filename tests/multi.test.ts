import { describe, it, expect } from "vitest";
import { parseCards } from "../src/engine/cards";
import { parseRange } from "../src/engine/range";
import { buildTree, type TreeConfig } from "../src/engine/tree";
import { PostflopSolver } from "../src/engine/solver";
import { buildMultiTree, MultiSolver, type MultiTreeConfig } from "../src/engine/multi";

const one = { bet: [66], raise: [] as number[] };
const none = { bet: [] as number[], raise: [] as number[] };
const oop = parseRange("AA,KK,QQ,JJ,TT,99,88,77,66,55,44,33,22,AK,AQ,AJ,KQ,T9s,98s,87s,76s,65s");
const ip = parseRange("AA,KK,QQ,JJ,TT,99,88,AQ,AJs,KQs,KJs,QJs,JTs,T9s,98s");
const third = parseRange("AA,KK,QQ,AKs,AQs,KQs,JTs,T9s,98s,87s,76s,55,44");

function mcfg(board: string, players: number, sizes = one, extra: Partial<MultiTreeConfig> = {}): MultiTreeConfig {
  return { board: parseCards(board), pot: 10, effStack: 20, rakePct: 0, rakeCap: 0, players, sizes: { flop: sizes, turn: sizes, river: sizes }, allinThresholdPct: 0, maxRaisesPerStreet: 1, includeAllin: false, ...extra };
}
function hcfg(board: string, sizes = one): TreeConfig {
  return { board: parseCards(board), pot: 10, effStack: 20, rakePct: 0, rakeCap: 0, oop: { flop: sizes, turn: sizes, river: sizes }, ip: { flop: sizes, turn: sizes, river: sizes }, allinThresholdPct: 0, maxRaisesPerStreet: 1, allowDonk: true, includeAllin: false };
}

describe("멀티웨이 솔버 — 표본 런아웃·근사 쇼다운 (결정 모델용)", () => {
  it("표본에 리버를 전부 넣으면 전체 솔버와 같은 값 (2인 턴)", () => {
    const board = parseCards("2c7d9hJs");
    const rivers = [...Array(52).keys()].filter((c) => !board.includes(c)).map((c) => [c]);
    const full = new MultiSolver(buildMultiTree(mcfg("2c7d9hJs", 2)), [oop, ip]);
    const smp = new MultiSolver(buildMultiTree(mcfg("2c7d9hJs", 2)), [oop, ip], { runouts: rivers });
    full.step(40);
    smp.step(40);
    const a = full.metrics();
    const b = smp.metrics();
    expect(b.ev[0]).toBeCloseTo(a.ev[0], 2);
    expect(b.ev[1]).toBeCloseTo(a.ev[1], 2);
  });

  it("표본 런아웃(턴·리버 쌍, 턴 베팅 없음)으로도 EV 합은 팟이고 익스플로잇어빌리티가 줄어든다 (3인 플랍)", () => {
    const board = parseCards("2c7d9h");
    const deck = [...Array(52).keys()].filter((c) => !board.includes(c));
    const pairs = Array.from({ length: 8 }, (_, i) => [deck[i * 3], deck[i * 3 + 1]]);
    const tree = buildMultiTree({ ...mcfg("2c7d9h", 3), sizes: { flop: one, turn: none, river: none } });
    const mu = new MultiSolver(tree, [oop, ip, third], { runouts: pairs, approx: true });
    mu.step(3);
    const m1 = mu.metrics();
    mu.step(40);
    const m2 = mu.metrics();
    // 사람마다 만난 상대 질량으로 정규화해서 표본이 적으면 합이 팟에서 조금 벗어난다 (쌍 8개에서 1% 안팎)
    expect(Math.abs(m2.ev[0] + m2.ev[1] + m2.ev[2] - 10)).toBeLessThan(0.15);
    expect(m2.exploitabilityPct).toBeLessThan(m1.exploitabilityPct);
  });

  it("근사 쇼다운(상대끼리 카드 겹침 무시)은 정확한 3인 리버 값과 팟의 2% 안", () => {
    const exact = new MultiSolver(buildMultiTree(mcfg("2c7d9hJsKd", 3)), [oop, ip, third]);
    const approx = new MultiSolver(buildMultiTree(mcfg("2c7d9hJsKd", 3)), [oop, ip, third], { approx: true });
    exact.step(60);
    approx.step(60);
    const a = exact.metrics();
    const b = approx.metrics();
    for (let q = 0; q < 3; q++) expect(Math.abs(b.ev[q] - a.ev[q])).toBeLessThan(0.2);
  });
});

describe("멀티웨이 솔버", () => {
  it("2인이면 HU 솔버와 같은 값 (리버)", () => {
    const hu = new PostflopSolver(buildTree(hcfg("2c7d9hJsKd")), oop, ip);
    const mu = new MultiSolver(buildMultiTree(mcfg("2c7d9hJsKd", 2)), [oop, ip]);
    hu.step(40);
    mu.step(40);
    const a = hu.metrics();
    const b = mu.metrics();
    expect(b.ev[0]).toBeCloseTo(a.evOop, 3);
    expect(b.ev[1]).toBeCloseTo(a.evIp, 3);
    expect(b.exploitabilityPct).toBeCloseTo(a.exploitabilityPct, 2);
  });
  it("2인 턴 트리도 HU와 일치 (찬스 노드)", () => {
    const hu = new PostflopSolver(buildTree(hcfg("2c7d9hJs")), oop, ip);
    const mu = new MultiSolver(buildMultiTree(mcfg("2c7d9hJs", 2)), [oop, ip]);
    hu.step(15);
    mu.step(15);
    const a = hu.metrics();
    const b = mu.metrics();
    expect(b.ev[0]).toBeCloseTo(a.evOop, 2);
    expect(b.ev[1]).toBeCloseTo(a.evIp, 2);
  });
  it("3인 리버 체크만: EV 합 = 팟", () => {
    const mu = new MultiSolver(buildMultiTree(mcfg("2c7d9hJsKd", 3, none)), [oop, ip, third]);
    mu.step(2);
    const m = mu.metrics();
    expect(m.ev[0] + m.ev[1] + m.ev[2]).toBeCloseTo(10, 4);
    expect(m.exploitabilityPct).toBeCloseTo(0, 3);
  });
  it("3인 턴 체크만: EV 합 = 팟 (찬스 확률)", () => {
    const mu = new MultiSolver(buildMultiTree(mcfg("2c7d9hJs", 3, none)), [oop, ip, third]);
    mu.step(1);
    const m = mu.metrics();
    expect(m.ev[0] + m.ev[1] + m.ev[2]).toBeCloseTo(10, 3);
  });
  it("3인 리버 벳 포함: EV 합 보존, 익스플로잇어빌리티 감소", () => {
    const tree = buildMultiTree(mcfg("2c7d9hJsKd", 3));
    const mu = new MultiSolver(tree, [oop, ip, third]);
    mu.step(5);
    const m1 = mu.metrics();
    mu.step(60);
    const m2 = mu.metrics();
    expect(m2.ev[0] + m2.ev[1] + m2.ev[2]).toBeCloseTo(10, 3);
    expect(m2.exploitabilityPct).toBeLessThan(m1.exploitabilityPct);
    expect(m2.exploitabilityPct).toBeLessThan(2);
    // 직렬화 왕복
    const data = mu.serializeStrategy();
    const mu2 = new MultiSolver(buildMultiTree(mcfg("2c7d9hJsKd", 3)), [oop, ip, third]);
    mu2.loadStrategy(data, m2.iterations);
    const m3 = mu2.metrics();
    expect(m3.ev[0]).toBeCloseTo(m2.ev[0], 4);
  });
  it("3인 폴드 터미널: 한 명 폴드 후 2인 비교 (트리 구조)", () => {
    const tree = buildMultiTree(mcfg("2c7d9hJsKd", 3));
    const root = tree.root;
    expect(root.kind).toBe("decision");
    if (root.kind !== "decision") return;
    // P0 벳 → P1 폴드 → P2 콜 → 쇼다운(active: P0,P2)
    const bet = root.children[1];
    expect(bet.kind).toBe("decision");
    if (bet.kind !== "decision") return;
    const fold = bet.children[0];
    expect(fold.kind).toBe("decision");
    if (fold.kind !== "decision") return;
    expect(fold.player).toBe(2);
    const call = fold.children[1];
    expect(call.kind).toBe("terminal");
    if (call.kind !== "terminal") return;
    expect(call.type).toBe("showdown");
    expect(call.active).toEqual([true, false, true]);
    // P1 폴드 → P2 폴드 → 폴드 터미널 승자 P0
    const fold2 = fold.children[0];
    expect(fold2.kind).toBe("terminal");
    if (fold2.kind !== "terminal") return;
    expect(fold2.type).toBe("fold");
    expect(fold2.winner).toBe(0);
  });
  it("4인 리버 (근사): EV 합이 팟 근처", () => {
    const mu = new MultiSolver(buildMultiTree(mcfg("2c7d9hJsKd", 4, none)), [oop, ip, third, oop]);
    mu.step(2);
    const m = mu.metrics();
    const sum = m.ev.reduce((a, b) => a + b, 0);
    expect(Math.abs(sum - 10)).toBeLessThan(0.6);
  });
});
