import { describe, it, expect } from "vitest";
import { parseCards, parseCard, mulberry32, shuffledDeck, comboIndex, classLabel, classOfCombo, COMBO_CARDS } from "../src/engine/cards";
import { evaluate, evaluateSlow7, categoryOf } from "../src/engine/evaluator";
import { parseRange, rangeToString, totalCombos, classWeights } from "../src/engine/range";
import { icmEquities, bubbleFactors } from "../src/engine/icm";

describe("evaluator", () => {
  it("카테고리 판정", () => {
    const sf = evaluate(parseCards("AsKsQsJsTs2d3c"));
    expect(categoryOf(sf)).toBe(8);
    expect(categoryOf(evaluate(parseCards("AsAdAhAc2d")))).toBe(7);
    expect(categoryOf(evaluate(parseCards("AsAdAhKcKd")))).toBe(6);
    expect(categoryOf(evaluate(parseCards("As9s5s3s2s")))).toBe(5);
    expect(categoryOf(evaluate(parseCards("5s4d3h2cAs")))).toBe(4); // 휠
    expect(categoryOf(evaluate(parseCards("AsAdAh9c2d")))).toBe(3);
    expect(categoryOf(evaluate(parseCards("AsAdKhKc2d")))).toBe(2);
    expect(categoryOf(evaluate(parseCards("AsAd5h9c2d")))).toBe(1);
    expect(categoryOf(evaluate(parseCards("AsKd5h9c2d")))).toBe(0);
  });
  it("비교 순서", () => {
    const wheel = evaluate(parseCards("5s4d3h2cAs"));
    const six = evaluate(parseCards("6s5d4h3c2s"));
    expect(six).toBeGreaterThan(wheel);
    const kk = evaluate(parseCards("KsKdQhJc2d"));
    const aa = evaluate(parseCards("AsAd2h3c4d"));
    expect(aa).toBeGreaterThan(kk);
    // 투페어 킥커
    const a = evaluate(parseCards("AsAdKhKcQd"));
    const b = evaluate(parseCards("AsAdKhKcJd"));
    expect(a).toBeGreaterThan(b);
    // 풀하우스: 트립스 우선
    const fh1 = evaluate(parseCards("QsQdQhKcKd"));
    const fh2 = evaluate(parseCards("KsKdKhQcQd"));
    expect(fh2).toBeGreaterThan(fh1);
  });
  it("7장 평가가 5장 조합 최댓값과 일치 (무작위 3000핸드)", () => {
    const rng = mulberry32(42);
    for (let t = 0; t < 3000; t++) {
      const deck = shuffledDeck([], rng).slice(0, 7);
      expect(evaluate(deck)).toBe(evaluateSlow7(deck));
    }
  });
});

describe("cards", () => {
  it("콤보 인덱스와 클래스", () => {
    const i = comboIndex(parseCard("Ah"), parseCard("Kh"));
    expect(COMBO_CARDS[i].length).toBe(2);
    expect(classLabel(classOfCombo(i))).toBe("AKs");
    expect(classLabel(classOfCombo(comboIndex(parseCard("Ah"), parseCard("Kd"))))).toBe("AKo");
    expect(classLabel(classOfCombo(comboIndex(parseCard("2h"), parseCard("2d"))))).toBe("22");
  });
});

describe("range", () => {
  it("기본 문법", () => {
    expect(totalCombos(parseRange("AA"))).toBe(6);
    expect(totalCombos(parseRange("AKs"))).toBe(4);
    expect(totalCombos(parseRange("AKo"))).toBe(12);
    expect(totalCombos(parseRange("AK"))).toBe(16);
    expect(totalCombos(parseRange("KK+"))).toBe(12);
    expect(totalCombos(parseRange("77-55"))).toBe(18);
    expect(totalCombos(parseRange("A5s-A2s"))).toBe(16);
    expect(totalCombos(parseRange("ATs+"))).toBe(16); // ATs AJs AQs AKs
    expect(totalCombos(parseRange("T9s+"))).toBe(20); // T9 JT QJ KQ AK
    expect(totalCombos(parseRange("AA:0.5"))).toBeCloseTo(3);
    expect(totalCombos(parseRange("AA:50%"))).toBeCloseTo(3);
    expect(totalCombos(parseRange("AhKh"))).toBe(1);
  });
  it("직렬화 왕복", () => {
    const text = "AA,KK:0.5,AKs,A5s-A2s,T9o";
    const w = parseRange(text);
    const w2 = parseRange(rangeToString(w));
    expect(Array.from(w2)).toEqual(Array.from(w));
    const cw = classWeights(w);
    expect(cw.length).toBe(169);
  });
  it("오류 문법 거절", () => {
    expect(() => parseRange("AAs")).toThrow();
    expect(() => parseRange("ZZ")).toThrow();
  });
});

describe("icm", () => {
  it("동일 스택이면 균등 분배", () => {
    const eq = icmEquities([1000, 1000, 1000], [50, 30, 20]);
    for (const e of eq) expect(e).toBeCloseTo(100 / 3, 6);
  });
  it("총합 보존", () => {
    const eq = icmEquities([5000, 3000, 1500, 500], [500, 300, 200]);
    expect(eq.reduce((a, b) => a + b, 0)).toBeCloseTo(1000, 6);
    expect(eq[0]).toBeGreaterThan(eq[1]);
    expect(eq[3]).toBeLessThan(eq[2]);
  });
  it("버블 팩터는 1 이상 (ICM 압박)", () => {
    const bf = bubbleFactors([5000, 3000, 1500, 500], [500, 300, 200]);
    expect(bf[2][0]).toBeGreaterThan(1);
  });
});
