import { describe, it, expect } from "vitest";
import { parseCards, parseCard, comboIndex } from "../src/engine/cards";
import { parseRange, emptyRange } from "../src/engine/range";
import { buildTree, type TreeConfig } from "../src/engine/tree";
import { PostflopSolver } from "../src/engine/solver";
import { rangeVsRange, handVsHand } from "../src/engine/equity";
import { buildPreflopTree, PreflopSolver, buildNonConflict, buildEquityMatrix } from "../src/engine/preflop";

function cfg(partial: Partial<TreeConfig>): TreeConfig {
  const none = { bet: [] as number[], raise: [] as number[] };
  const one = { bet: [100], raise: [] as number[] };
  return {
    board: parseCards("2c7d9hJsKd"),
    pot: 10,
    effStack: 10,
    rakePct: 0,
    rakeCap: 0,
    oop: { flop: one, turn: one, river: one },
    ip: { flop: none, turn: none, river: none },
    allinThresholdPct: 0,
    maxRaisesPerStreet: 1,
    allowDonk: true,
    includeAllin: false,
    ...partial
  };
}

describe("equity", () => {
  it("AA vs KK 프리플랍 ≈ 81~83%", () => {
    const r = handVsHand([parseCard("As"), parseCard("Ad")], [parseCard("Ks"), parseCard("Kd")], [], 30000);
    expect(r.equity0).toBeGreaterThan(0.79);
    expect(r.equity0).toBeLessThan(0.85);
  });
  it("리버 완전 결정", () => {
    const r = handVsHand([parseCard("As"), parseCard("Ad")], [parseCard("Ks"), parseCard("Kd")], parseCards("2c3d4h9sJc"));
    expect(r.equity0).toBe(1);
    expect(r.exact).toBe(true);
  });
  it("레인지 vs 레인지 합은 1", () => {
    const r = rangeVsRange(parseRange("AA,KK,AKs"), parseRange("QQ,JJ,T9s"), parseCards("2c7d9h"));
    expect(r.equity0 + r.equity1).toBeCloseTo(1, 6);
    expect(r.exact).toBe(true);
    expect(r.equity0).toBeGreaterThan(0.6);
  });
});

describe("postflop solver (river clairvoyance)", () => {
  // OOP: 너츠(AA) 50% + 에어(72o는 보드와 겹치니 83o) 50%, IP: 블러프캐처(QQ). 팟 10, 벳 10(팟 사이즈).
  // 이론: OOP는 너츠 전부 + 에어의 1/2 벳(블러프:밸류 = 1:2), IP는 MDF 50% 콜.
  it("이론값에 수렴", () => {
    const board = parseCards("2c7d9hJsKd");
    const oop = emptyRange();
    const ip = emptyRange();
    // 너츠: AA 6콤보, 에어: 83o 12콤보 중 6콤보만 (가중치 0.5)로 같은 질량
    for (const i of comboIndicesOf("AA")) oop[i] = 1;
    for (const i of comboIndicesOf("83o")) oop[i] = 0.5;
    for (const i of comboIndicesOf("QQ")) ip[i] = 1;
    const tree = buildTree(cfg({ board, pot: 10, effStack: 10 }));
    const solver = new PostflopSolver(tree, oop, ip);
    solver.step(400);
    const m = solver.metrics();
    expect(m.exploitabilityPct).toBeLessThan(1.0);
    const root = solver.walk([]);
    const an = solver.analyzeDecision(root.node as any, root.ctx, root.reach);
    // 액션 1 = 벳 100%
    const betIdx = an.node.actions.findIndex((a) => a.type === "bet" || a.type === "allin");
    expect(betIdx).toBeGreaterThan(0);
    // 너츠는 거의 항상 벳
    const n = solver.hands.n;
    let nutsBet = 0;
    let nutsCnt = 0;
    let airBet = 0;
    let airCnt = 0;
    for (let h = 0; h < n; h++) {
      const combo = solver.hands.combo[h];
      if (oop[combo] === 0) continue;
      const f = an.strategy[betIdx * n + h];
      if (oop[combo] === 1) {
        nutsBet += f;
        nutsCnt++;
      } else {
        airBet += f;
        airCnt++;
      }
    }
    expect(nutsBet / nutsCnt).toBeGreaterThan(0.95);
    expect(airBet / airCnt).toBeGreaterThan(0.4);
    expect(airBet / airCnt).toBeLessThan(0.6);
    // IP 콜 빈도 ≈ 50%
    const facing = solver.walk([{ kind: "action", index: betIdx }]);
    const an2 = solver.analyzeDecision(facing.node as any, facing.ctx, facing.reach);
    const callIdx = an2.node.actions.findIndex((a) => a.type === "call");
    expect(an2.actionFreq[callIdx]).toBeGreaterThan(0.42);
    expect(an2.actionFreq[callIdx]).toBeLessThan(0.58);
    // OOP 루트 EV: 이론값 = 팟 10 × (너츠 0.5 + 블러프 이득) ... 베터 EV = P*(1 - x) 형태; 범위만 확인
    expect(m.evOop).toBeGreaterThan(5);
    expect(m.evOop).toBeLessThan(8);
    // 직렬화 왕복
    const data = solver.serializeStrategy();
    const solver2 = new PostflopSolver(buildTree(cfg({ board, pot: 10, effStack: 10 })), oop, ip);
    solver2.loadStrategy(data, m.iterations);
    const an3 = solver2.analyzeDecision(root.node as any, root.ctx, solver2.walk([]).reach);
    expect(an3.actionFreq[betIdx]).toBeCloseTo(an.actionFreq[betIdx], 4);
  });

  it("턴 시작 트리도 수렴 (익스플로잇어빌리티 감소)", () => {
    const board = parseCards("2c7d9hJs");
    const oop = parseRange("AA,KK,QQ,JJ,TT,99,88,77,66,55,44,33,22,AK,AQ,AJ,KQ,T9s,98s,87s,76s,65s");
    const ip = parseRange("AA,KK,QQ,JJ,TT,99,88,AQ,AJs,KQs,KJs,QJs,JTs,T9s,98s");
    const sizing = { bet: [66], raise: [] as number[] };
    const tree = buildTree(cfg({ board, pot: 10, effStack: 20, oop: { flop: sizing, turn: sizing, river: sizing }, ip: { flop: sizing, turn: sizing, river: sizing }, maxRaisesPerStreet: 1 }));
    const solver = new PostflopSolver(tree, oop, ip);
    solver.step(30);
    const m1 = solver.metrics();
    solver.step(120);
    const m2 = solver.metrics();
    expect(m2.exploitabilityPct).toBeLessThan(m1.exploitabilityPct);
    expect(m2.exploitabilityPct).toBeLessThan(3);
    // EV 합 ≈ 팟 (레이크 0)
    expect(m2.evOop + m2.evIp).toBeCloseTo(10, 1);
  });
});

describe("preflop solver", () => {
  it("HU 푸시/폴드 10bb: SB가 넓게 올인, BB가 넓게 콜 (근사)", () => {
    const nc = buildNonConflict();
    const eq = buildEquityMatrix(40, 3); // 테스트용 저해상도
    const tree = buildPreflopTree({ stackBb: 10, sbPosts: 0.5, bbPosts: 1, openSizes: [], threeBetMult: [], fourBetMult: [], maxRaises: 1, allowLimp: false, includeAllin: true });
    const solver = new PreflopSolver(tree, eq, nc);
    solver.step(300);
    const m = solver.metrics();
    expect(m.exploitabilityPct).toBeLessThan(2);
    const root = solver.walk([]);
    const an = solver.analyze(root.node as any, root.reach);
    const allin = an.node.actions.findIndex((a) => a.type === "allin");
    expect(an.freq[allin]).toBeGreaterThan(0.45);
    expect(an.freq[allin]).toBeLessThan(0.9);
  });
});

function comboIndicesOf(cls: string): number[] {
  const w = parseRange(cls);
  const out: number[] = [];
  for (let i = 0; i < w.length; i++) if (w[i] > 0) out.push(i);
  return out;
}
