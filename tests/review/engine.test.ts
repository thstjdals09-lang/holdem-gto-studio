import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { CLASS_COMBOS, COMBO_CARDS, COMBO_CLASS, NUM_CLASSES, classInfo, classLabel, comboIndex, parseCard, parseCards } from "../../src/engine/cards";
import { evaluate } from "../../src/engine/evaluator";
import { closedAllin, isClosedAfterCall } from "../../src/review/allin-ev";
import { icmExact, icmField, makeExps } from "../../src/review/icm-analysis";
import provenance from "../../src/review/provenance.json";
import { parseUserRange, rangeFromReach, removeCards } from "../../src/review/ranges";
import { loadLibraryFromText, validateLibrary } from "../../src/review/strategy-provider";
import { CLASS_N } from "../../src/lib/preflopLib";

const readLib = (id: string) => readFileSync(`public/lib/preflop/${id}.json`, "utf8");
const RANKS = "23456789TJQKA";

describe("169 클래스·1326 콤보·블로커", () => {
  it("169 클래스: 이름이 모두 다르고 페어 6·수딧 4·오프수트 12 콤보, AKs ≠ AKo", () => {
    const labels = new Set<string>();
    let total = 0;
    for (let c = 0; c < NUM_CLASSES; c++) {
      const l = classLabel(c);
      labels.add(l);
      const k = classInfo(c).kind;
      expect(CLASS_COMBOS[c].length).toBe(k === "pair" ? 6 : k === "suited" ? 4 : 12);
      // 그리드 규칙(원본): 대각선 페어, 오른쪽 위 수딧, 왼쪽 아래 오프수트
      const row = Math.floor(c / 13);
      const col = c % 13;
      expect(k).toBe(row === col ? "pair" : row < col ? "suited" : "offsuit");
      total += CLASS_COMBOS[c].length;
    }
    expect(labels.size).toBe(169);
    expect(total).toBe(1326);
    expect(classLabel(1)).toBe("AKs");
    expect(classLabel(13)).toBe("AKo");
    expect(classLabel(0)).toBe("AA");
    expect(classLabel(168)).toBe("22");
  });
  it("모든 카드 쌍을 직접 열거해 콤보 번호·클래스와 대조", () => {
    const seen = new Set<number>();
    for (let a = 0; a < 52; a++)
      for (let b = a + 1; b < 52; b++) {
        const i = comboIndex(a, b);
        expect(comboIndex(b, a)).toBe(i);
        expect(COMBO_CARDS[i]).toEqual([a, b]);
        seen.add(i);
        // 독립 표기: 높은 랭크 먼저, 같은 무늬면 s
        const ra = a >> 2;
        const rb = b >> 2;
        const hi = Math.max(ra, rb);
        const lo = Math.min(ra, rb);
        const want = hi === lo ? RANKS[hi] + RANKS[hi] : RANKS[hi] + RANKS[lo] + ((a & 3) === (b & 3) ? "s" : "o");
        expect(classLabel(COMBO_CLASS[i])).toBe(want);
      }
    expect(seen.size).toBe(1326);
    expect(classLabel(COMBO_CLASS[comboIndex(parseCard("As"), parseCard("Ks"))])).toBe("AKs");
    expect(classLabel(COMBO_CLASS[comboIndex(parseCard("As"), parseCard("Kd"))])).toBe("AKo");
  });
  it("블로커: 내 카드 2장은 101 콤보, 보드까지 5장이면 245 콤보를 없앤다", () => {
    const full = new Float32Array(1326).fill(1);
    const hero = parseCards("AsKd");
    expect(removeCards(full, hero).removed).toBe(1326 - 1225);
    const five = parseCards("AsKd7c2h9s");
    const r = removeCards(full, five);
    expect(r.removed).toBe(1326 - 1081); // C(47,2) = 1081
    expect(r.w.reduce((a, x) => a + x, 0)).toBe(1081);
  });
  it("카드 중복과 잘못된 범위 문법을 거부한다", () => {
    expect(() => parseCards("AsAs")).toThrow();
    expect(parseUserRange("AKx")).toHaveProperty("error");
    expect(parseUserRange("")).toHaveProperty("error");
    expect(parseUserRange("AKs")).toHaveProperty("weights");
  });
});

describe("실제 프리플랍 JSON", () => {
  it("mtt8-25: 해시가 출처 목록과 같고, 루트·후속 노드 빈도와 EV 기준이 원본 해석과 맞다", async () => {
    const L = await loadLibraryFromText("mtt8-25", readLib("mtt8-25"));
    expect(L.sha256).toBe(provenance.files["mtt8-25.json"].sha256);
    expect(L.manifestMatch).toBe(true);
    const root = L.lib.nodes[0];
    expect(root.p).toBe(0); // UTG
    expect(root.pot).toBe(2.5); // 앤티 8×0.125 + SB 0.5 + BB 1 (독립 계산)
    expect(root.a.map((x) => x[3])).toEqual(["F", "R2", "A"]);
    // 모든 노드·클래스의 빈도 합은 1000 (반올림 오차 ±액션 수)
    let sumBad = 0;
    let foldNonZero = 0;
    for (const n of L.lib.nodes) {
      const f = n.a.findIndex((x) => x[0] === "fold");
      for (let c = 0; c < 169; c++) {
        let s = 0;
        for (let k = 0; k < n.a.length; k++) s += n.s[k * 169 + c];
        if (Math.abs(s - 1000) > n.a.length) sumBad++;
        // EV 기준: 폴드 = 0 — e[a*169+c]/100 이 '그 노드에서 폴드 대비' BB 라는 해석의 독립 확인
        if (f >= 0 && n.e[f * 169 + c] !== 0) foldNonZero++;
      }
    }
    expect(sumBad).toBe(0);
    expect(foldNonZero).toBe(0);
    expect(root.s[1 * 169 + 0]).toBe(1000); // AA UTG 오픈
    expect(root.e[1 * 169 + 0] / 100).toBeCloseTo(7.85, 2);
    // 후속 노드: BTN 오픈 → SB 폴드 → BB 차례. a[i][1] 은 누적 목표액(폴드 = 이미 낸 1BB)
    const bb = L.lib.nodes.find((x) => x.line === "UTG F · UTG1 F · LJ F · HJ F · CO F · BTN 2 · SB F")!;
    expect(bb.p).toBe(7);
    expect(bb.pot).toBe(4.5);
    expect(bb.a.map((x) => [x[0], x[1]])).toEqual([["fold", 1], ["call", 2], ["raise", 6.8], ["allin", 25]]);
    expect(bb.s[3 * 169 + 0]).toBe(1000);
    expect(bb.e[3 * 169 + 0] / 100).toBeCloseTo(8.99, 2);
  });
  it("손상된 자료를 거부한다 (배열 길이, 빈도 합, 순환, 없는 터미널, 이름 불일치)", () => {
    const base = JSON.parse(readLib("mtt8-6"));
    const clone = () => JSON.parse(JSON.stringify(base));
    expect(validateLibrary(base, "mtt8-6")).toEqual([]);
    const a = clone();
    a.nodes[0].s.pop();
    expect(validateLibrary(a, "mtt8-6").join()).toContain("길이");
    const b = clone();
    b.nodes[0].s[0] += 500;
    expect(validateLibrary(b, "mtt8-6").join()).toContain("빈도");
    const c = clone();
    c.nodes[3].c[0] = 1;
    expect(validateLibrary(c, "mtt8-6").join()).toContain("순환");
    const d = clone();
    d.nodes[0].c[0] = "t999999";
    expect(validateLibrary(d, "mtt8-6").join()).toContain("터미널");
    expect(validateLibrary(base, "mtt8-10").join()).toContain("파일 이름");
    expect(validateLibrary({ nodes: 1 }, "x")[0]).toContain("형식");
  });
  it("자료 reach → 콤보 가중치는 클래스 안에서 같은 비율", () => {
    const reach = Float64Array.from(CLASS_N);
    reach[0] = 3; // AA 6콤보 중 3 → 0.5
    const w = rangeFromReach(reach);
    for (const i of CLASS_COMBOS[0]) expect(w[i]).toBe(0.5);
    expect(w[CLASS_COMBOS[1][0]]).toBe(1);
  });
});

// 손으로 계산할 수 있는 작은 게임
function entriesHU(o: { heroIn: number; heroStack: number; villIn: number; villStack: number }) {
  return [
    { seat: 1, totalIn: o.heroIn * 1000, stack: o.heroStack * 1000, folded: false },
    { seat: 2, totalIn: o.villIn * 1000, stack: o.villStack * 1000, folded: false }
  ];
}
const rangeOf = (text: string) => (parseUserRange(text) as { weights: Float32Array }).weights;

describe("닫힌 올인 EV (작은 검증 가능한 게임)", () => {
  const board = parseCards("2c7d9sJc3h");
  const hero = parseCards("AhKh");
  // 상대: QQ 6콤보(내 A-high 를 이김) + 54s 4콤보(짐) → 승률 정확히 0.4
  const vill = rangeOf("QQ,54s");
  it("리버 올인 콜: EV = 0.4 × 400 − 150 = +10 (전부 열거)", async () => {
    const r = await closedAllin({ heroSeat: 1, heroCards: hero, board, entries: entriesHU({ heroIn: 50, heroStack: 300, villIn: 200, villStack: 0 }), callAdd: 150000, opponents: [{ seat: 2, weights: vill }] }, { samples: 1000, seed: 1 });
    expect(r.method).toBe("enumeration");
    expect(r.evCall / 1000).toBeCloseTo(10, 9);
    expect(r.win).toBeCloseTo(0.4, 12);
    expect(r.requiredEquity).toBeCloseTo(150 / 400, 12);
    expect(r.se).toBe(0);
  });
  it("내 스택이 모자라면 상대 초과분은 돌려받고 내가 이길 수 있는 팟만 계산: 0.4 × 220 − 60 = +28", async () => {
    const r = await closedAllin({ heroSeat: 1, heroCards: hero, board, entries: entriesHU({ heroIn: 50, heroStack: 60, villIn: 200, villStack: 0 }), callAdd: 60000, opponents: [{ seat: 2, weights: vill }] }, { samples: 1000, seed: 1 });
    expect(r.heroEligiblePot / 1000).toBe(220);
    expect(r.evCall / 1000).toBeCloseTo(28, 9);
    // 콜 결과마다 칩이 보존된다
    for (const o of r.callOutcomes) expect(o.stacks.reduce((a, b) => a + b, 0)).toBe(310000); // 나 50+60, 상대 200
  });
  it("3명 사이드팟: 메인은 짧은 올인(QQ)이, 사이드는 내가(A-high > 8-high) 가져간다 → EV = 200 − 150 = +50", async () => {
    const entries = [
      { seat: 1, totalIn: 0, stack: 400000, folded: false }, // 나
      { seat: 2, totalIn: 50000, stack: 0, folded: false }, // QdQs 올인 50
      { seat: 3, totalIn: 150000, stack: 500000, folded: false } // 8h6h 벳 150
    ];
    const r = await closedAllin({ heroSeat: 1, heroCards: hero, board, entries, callAdd: 150000, opponents: [{ seat: 2, weights: rangeOf("QdQs") }, { seat: 3, weights: rangeOf("8h6h") }] }, { samples: 500, seed: 3 });
    expect(r.method).toBe("monte-carlo");
    expect(r.evCall / 1000).toBeCloseTo(50, 9);
    expect(r.se).toBeCloseTo(0, 9);
    expect(r.callLayers.map((l) => l.amount / 1000)).toEqual([150, 200]);
  });
  it("최적 대응: 상대 범위를 이기는 핸드가 더 많아지면 콜 EV 가 음수로 바뀐다", async () => {
    const r = await closedAllin({ heroSeat: 1, heroCards: hero, board, entries: entriesHU({ heroIn: 50, heroStack: 300, villIn: 200, villStack: 0 }), callAdd: 150000, opponents: [{ seat: 2, weights: rangeOf("QQ,JJ,54s") }] }, { samples: 1000, seed: 1 });
    // JJ 3콤보(보드 Jc) 추가 → 승률 4/13
    expect(r.evCall / 1000).toBeCloseTo((4 / 13) * 400 - 150, 9);
    expect(r.evCall).toBeLessThan(0);
  });
  it("프리플랍 표본은 여러 시드에서 직접 전수 계산한 값과 3 표준오차 안", async () => {
    // AsAh vs KdKc: 보드 C(48,5) 전부 직접 열거 (독립 계산)
    const h = parseCards("AsAh");
    const v = parseCards("KdKc");
    const deck = Array.from({ length: 52 }, (_, i) => i).filter((c) => !h.includes(c) && !v.includes(c));
    const seven = new Int32Array(7);
    let win = 0;
    let tie = 0;
    let n = 0;
    for (let a = 0; a < 48; a++)
      for (let b = a + 1; b < 48; b++)
        for (let c = b + 1; c < 48; c++)
          for (let d = c + 1; d < 48; d++)
            for (let e = d + 1; e < 48; e++) {
              seven[2] = deck[a];
              seven[3] = deck[b];
              seven[4] = deck[c];
              seven[5] = deck[d];
              seven[6] = deck[e];
              seven[0] = h[0];
              seven[1] = h[1];
              const x = evaluate(seven, 7);
              seven[0] = v[0];
              seven[1] = v[1];
              const y = evaluate(seven, 7);
              if (x > y) win++;
              else if (x === y) tie++;
              n++;
            }
    const eq = (win + tie / 2) / n;
    expect(eq).toBeGreaterThan(0.81);
    expect(eq).toBeLessThan(0.83);
    const exactEv = eq * 200 - 100;
    for (const seed of [1, 2, 3]) {
      const r = await closedAllin({ heroSeat: 1, heroCards: h, board: [], entries: entriesHU({ heroIn: 0, heroStack: 100, villIn: 100, villStack: 0 }), callAdd: 100000, opponents: [{ seat: 2, weights: rangeOf("KdKc") }] }, { samples: 20000, seed });
      expect(Math.abs(r.evCall / 1000 - exactEv)).toBeLessThan(3 * (r.se / 1000) + 1e-9);
    }
  }, 60000);
  it("닫힌 상황 판정: 뒤에 행동할 칩 있는 자리가 있으면 닫히지 않는다", () => {
    const seat = (s: number, stack: number, streetIn: number, allIn = false) => ({ seat: s, position: "", start: 0, stack, streetIn, totalIn: streetIn, deadIn: 0, folded: false, allIn });
    const st = (seats: ReturnType<typeof seat>[]) => ({ street: "preflop" as const, seats, pot: 0, potSettled: 0, currentBet: 100, toAct: 1 });
    expect(isClosedAfterCall(st([seat(1, 200, 0), seat(2, 0, 100, true)]), 1, 100)).toBe(true);
    expect(isClosedAfterCall(st([seat(1, 200, 0), seat(2, 0, 100, true), seat(3, 300, 0)]), 1, 100)).toBe(false);
    expect(isClosedAfterCall(st([seat(1, 50, 0), seat(2, 400, 100)]), 1, 50)).toBe(true); // 내가 올인 콜
    expect(isClosedAfterCall(st([seat(1, 200, 0), seat(2, 300, 100)]), 1, 100)).toBe(false); // 둘 다 칩이 남음
  });
});

describe("ICM", () => {
  /** 독립 구현: 모든 순위 순열을 Harville 확률로 직접 열거 */
  function brute(stacks: number[], pay: number[]): number[] {
    const n = stacks.length;
    const eq = new Array(n).fill(0);
    const rec = (left: number[], prob: number, place: number) => {
      if (!left.length) return;
      const s = left.reduce((a, i) => a + stacks[i], 0);
      for (const i of left) {
        const p = (prob * stacks[i]) / s;
        eq[i] += p * (pay[place] ?? 0);
        rec(left.filter((x) => x !== i), p, place + 1);
      }
    };
    rec(stacks.map((_, i) => i), 1, 0);
    return eq;
  }
  it("정확 계산이 순열 전수 열거와 같고 지급 총액이 보존된다", () => {
    for (const [st, pay] of [
      [[5000, 3000, 2000], [50, 30, 20]],
      [[1200, 800, 3000, 450, 2600], [40, 25, 15]],
      [[10, 20, 30, 40, 50, 60, 70], [100, 60, 40, 20]]
    ] as Array<[number[], number[]]>) {
      const e = icmExact(st, pay);
      const b = brute(st, pay);
      e.forEach((x, i) => expect(x).toBeCloseTo(b[i], 9));
      expect(e.reduce((a, x) => a + x, 0)).toBeCloseTo(pay.slice(0, st.length).reduce((a, x) => a + x, 0), 9);
    }
    // 알려진 값: 50/30/20 스택, 50/30/20 상금 → 1위 스택 38.39
    expect(icmExact([5000, 3000, 2000], [50, 30, 20])[0]).toBeCloseTo(38.393, 2);
  });
  it("같은 스택이면 지분이 같고, 같은 티켓 새틀라이트는 티켓 × 상위 확률", () => {
    for (const x of icmExact([1, 1, 1, 1], [100, 100, 100])) expect(x).toBeCloseTo(75, 9);
  });
  it("표본 ICM 은 여러 시드에서 정확 값과 3 표준오차 안", () => {
    const st = [3000, 1500, 900, 4200, 2200, 800, 1700, 2500];
    const pay = [50, 30, 20];
    const exact = icmExact(st, pay);
    for (const seed of [1, 7, 42]) {
      const r = icmField(st.map((s) => ({ stack: s, start: s })), pay, { exps: makeExps(st.length, 20000, seed) });
      r.eq.forEach((x, i) => expect(Math.abs(x - exact[i])).toBeLessThan(3 * r.se[i] + 1e-9));
    }
  });
  it("함께 탈락: 시작 스택이 큰 쪽이 높은 순위, 같으면 상금을 나누고 총액이 보존된다", () => {
    const pay = [50, 30, 20, 10];
    // 생존 2명, 탈락 2명(시작 스택 300·200) → 탈락자는 3위 20, 4위 10
    const r = icmField([{ stack: 600, start: 300 }, { stack: 0, start: 300 }, { stack: 400, start: 200 }, { stack: 0, start: 200 }], pay, null);
    expect(r.eq[1]).toBe(20);
    expect(r.eq[3]).toBe(10);
    expect(r.eq.reduce((a, x) => a + x, 0)).toBeCloseTo(110, 9);
    const tie = icmField([{ stack: 1000, start: 300 }, { stack: 0, start: 250 }, { stack: 0, start: 250 }], [50, 30, 20], null);
    expect(tie.eq[1]).toBe(25);
    expect(tie.eq[2]).toBe(25);
  });
  it("새틀라이트 버블: 칩 EV 로는 콜이 이득인데 ICM 으로는 폴드가 낫다", () => {
    // 4명 남고 티켓 3장. 나 4000 가 3000 의 올인을 승률 55% 로 콜할지
    const pay = [100, 100, 100];
    const start = [4000, 3000, 2000, 1000];
    const f = (st: number[]) => icmField(st.map((s, i) => ({ stack: s, start: start[i] })), pay, null).eq[0];
    const chipEv = 0.55 * 3000 - 0.45 * 3000;
    const icmFold = f([4000, 3000, 2000, 1000]);
    const icmCall = 0.55 * f([7000, 0, 2000, 1000]) + 0.45 * f([1000, 6000, 2000, 1000]);
    expect(chipEv).toBeGreaterThan(0);
    expect(icmCall).toBeLessThan(icmFold);
  });
});
