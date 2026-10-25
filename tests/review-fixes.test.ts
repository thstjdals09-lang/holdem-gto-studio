// 코드 리뷰 지적 사항 회귀 테스트
import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { CLASS_COMBOS, NUM_CLASSES, classIndexFromRanks, parseCards } from "../src/engine/cards";
import { classifyMade } from "../src/engine/categories";
import { buildCompat, buildRingTree, RING_FORMATS, RingSolver } from "../src/engine/ring";
import { parseAll } from "../src/lib/hh";

const L = (...lines: string[]) => lines.join("\n");

describe("HH 자리 계산", () => {
  it("자리 비움 좌석은 빼고 블라인드 기준으로 자리를 정한다", () => {
    const hh = L(
      "PokerStars Hand #250000000101: Hold'em No Limit ($0.50/$1.00 USD) - 2026/10/20 21:00:00 ET",
      "Table 'Beta' 6-max Seat #1 is the button",
      "Seat 1: Btn ($100 in chips)",
      "Seat 2: Away ($100 in chips) is sitting out",
      "Seat 3: Small ($100 in chips)",
      "Seat 4: Big ($100 in chips)",
      "Seat 5: First ($100 in chips)",
      "Seat 6: Second ($100 in chips)",
      "Small: posts small blind $0.50",
      "Big: posts big blind $1",
      "*** HOLE CARDS ***",
      "Dealt to Btn [Ah Kd]",
      "First: folds",
      "Second: folds",
      "Btn: raises $1.50 to $2.50",
      "Small: folds",
      "Big: folds",
      "Uncalled bet ($1.50) returned to Btn",
      "Btn collected $2.50 from pot",
      "*** SUMMARY ***"
    );
    const { hands } = parseAll(hh);
    expect(hands.length).toBe(1);
    const pos = Object.fromEntries(hands[0].seats.map((s) => [s.name, s.position]));
    expect(hands[0].seats.length).toBe(5);
    expect(pos.Small).toBe("SB");
    expect(pos.Big).toBe("BB");
    expect(pos.Btn).toBe("BTN");
    expect(pos.Away).toBeUndefined();
  });

  it("데드 버튼(버튼 좌석이 빈 경우)", () => {
    const hh = L(
      "PokerStars Hand #250000000102: Hold'em No Limit ($0.50/$1.00 USD) - 2026/10/20 21:00:00 ET",
      "Table 'Beta' 6-max Seat #2 is the button",
      "Seat 1: A1 ($100 in chips)",
      "Seat 3: A3 ($100 in chips)",
      "Seat 4: A4 ($100 in chips)",
      "Seat 5: A5 ($100 in chips)",
      "A3: posts small blind $0.50",
      "A4: posts big blind $1",
      "*** HOLE CARDS ***",
      "Dealt to A1 [Ah Kd]",
      "A5: folds",
      "A1: folds",
      "A3: folds",
      "Uncalled bet ($0.50) returned to A4",
      "A4 collected $1 from pot",
      "*** SUMMARY ***"
    );
    const { hands } = parseAll(hh);
    const pos = Object.fromEntries(hands[0].seats.map((s) => [s.name, s.position]));
    expect(pos.A3).toBe("SB");
    expect(pos.A4).toBe("BB");
    expect(pos.A1).toBe("BTN");
    expect(pos.A5).toBe("CO");
  });
});

describe("보드 족보 분류", () => {
  it("보드 트립스 + 키커는 하이카드", () => {
    expect(classifyMade(parseCards("AhKd") as [number, number], parseCards("7c7d7h"))).toBe("에이스 하이");
    expect(classifyMade(parseCards("QhJd") as [number, number], parseCards("7c7d7h"))).toBe("노메이드");
    expect(classifyMade(parseCards("7sKd") as [number, number], parseCards("7c7d2h"))).toBe("트립스");
  });
  it("리버 보드가 그대로 플레이되면 노메이드", () => {
    // 보드 플러시, 히어로의 하트가 보드보다 낮음
    expect(classifyMade(parseCards("2h3c") as [number, number], parseCards("AhKhQh9h8h"))).toBe("노메이드");
    // 히어로가 더 높은 플러시를 만들면 플러시
    expect(classifyMade(parseCards("Jh3c") as [number, number], parseCards("AhKhQh9h8h"))).toBe("플러시");
    // 보드 풀하우스
    expect(classifyMade(parseCards("AsKd") as [number, number], parseCards("7c7d7h2s2c"))).toBe("노메이드");
  });
});

describe("프리플랍 링 솔버", () => {
  it("coldCall3bet 옵션이 트리를 바꾼다", () => {
    const base = RING_FORMATS.find((f) => f.id === "cash6-100")!;
    const a = buildRingTree({ ...base, coldCall3bet: false });
    const b = buildRingTree({ ...base, coldCall3bet: true });
    expect(b.decisions.length).toBeGreaterThan(a.decisions.length);
  });

  it("3벳 이후 콜드 4벳 + 올인을 마주해도 3벳터가 콜할 수 있다 (강제 폴드 없음)", () => {
    const tree = buildRingTree(RING_FORMATS.find((f) => f.id === "cash6-100")!);
    let n: any = tree.root;
    for (const code of ["R2.5", "R7.5", "F", "F", "F", "R16.88", "A"]) n = n.children[n.actions.findIndex((a: any) => a.code === code)];
    expect(n.kind).toBe("decision");
    expect(n.actions.map((a: any) => a.code)).toContain("C");
  });

  const eqPath = "public/lib/eq169.bin";
  const eqBuf = existsSync(eqPath) ? readFileSync(eqPath) : null;
  it.skipIf(!eqBuf)("멀티웨이 팟 몫이 0~1 범위이고 강한 핸드가 과대평가되지 않는다", () => {
    const eq = new Float32Array(eqBuf!.buffer.slice(eqBuf!.byteOffset, eqBuf!.byteOffset + eqBuf!.byteLength));
    const f0 = RING_FORMATS.find((x) => x.id === "cash6-100")!;
    // 정규화 자체를 보기 위해 실현 보정을 끈 고정 모델
    const f = { ...f0, realizationModel: "fixed" as const, realization: { ip: 1, oop: 1, mwIp: 1, mwOop: 1, slope: 0 } };
    const tree = buildRingTree(f);
    const solver = new RingSolver(tree, eq, buildCompat());
    const t = tree.terminals.find((x) => x.type === "flop" && x.folded.filter((z) => !z).length === 3)!;
    expect(t).toBeDefined();
    const r = Array.from({ length: f.positions.length }, () => Float64Array.from({ length: NUM_CLASSES }, (_, c) => CLASS_COMBOS[c].length));
    const active = t.folded.map((z, i) => (z ? -1 : i)).filter((i) => i >= 0);
    const AA = classIndexFromRanks(12, 12, false);
    const s72 = classIndexFromRanks(5, 0, false);
    for (const p of active) {
      const sAA = solver.potShare(t, p, r, AA);
      const sLow = solver.potShare(t, p, r, s72);
      expect(sAA).toBeGreaterThan(0.5);
      expect(sAA).toBeLessThan(0.8);
      expect(sLow).toBeGreaterThan(0);
      expect(sLow).toBeLessThan(0.25);
    }
  });
});

describe("포스트플랍 에퀴티 함수", () => {
  it("플랍에서도 런아웃을 돌아 0이 아닌 에퀴티를 낸다 (else 결합 버그)", async () => {
    const { buildTree } = await import("../src/engine/tree");
    const { PostflopSolver } = await import("../src/engine/solver");
    const board = parseCards("Kh7s2d");
    const w = new Float32Array(1326).fill(1);
    const tree = buildTree({ board, pot: 10, effStack: 20, rakePct: 0, rakeCap: 0, oop: { flop: { bet: [], raise: [] }, turn: { bet: [], raise: [] }, river: { bet: [], raise: [] } }, ip: { flop: { bet: [], raise: [] }, turn: { bet: [], raise: [] }, river: { bet: [], raise: [] } }, allinThresholdPct: 67, maxRaisesPerStreet: 1, allowDonk: false, includeAllin: false });
    const s = new PostflopSolver(tree, w, w);
    const st = s.rootHandStats(0);
    let num = 0, den = 0;
    for (let h = 0; h < s.hands.n; h++) {
      num += st.S[h] * st.equity[h];
      den += st.S[h];
    }
    expect(num / den).toBeGreaterThan(0.45);
    expect(num / den).toBeLessThan(0.55);
  }, 60000);
});

