// 토너먼트 기준: 예시 핸드 파싱, 스택 깊이별 포맷 선택, 40bb 매치업 매핑
import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { parseAll } from "../src/lib/hh";
import { analyzePreflop, pickFormat } from "../src/lib/analyze";
import { SAMPLE_HANDS_MTT } from "../src/lib/sampleHands";
import type { PfLib } from "../src/lib/preflopLib";

const IDS = ["mtt8-15", "mtt8-25", "mtt8-40", "mtt8-60", "cash6-100"];
const load = (id: string): PfLib | null => (existsSync(`public/lib/preflop/${id}.json`) ? JSON.parse(readFileSync(`public/lib/preflop/${id}.json`, "utf-8")) : null);
const { hands, skipped } = parseAll(SAMPLE_HANDS_MTT);

describe("토너먼트 예시 핸드", () => {
  it("7핸드를 모두 읽고 앤티를 투자액에 넣는다", () => {
    expect(hands.length).toBe(7);
    expect(skipped).toBe(0);
    // BTN 오픈 후 턴 벳이 폴드됨: 순이익 = (앤티 1 + SB 0.5 + BB 2.2 + 플랍 1.95) − 앤티 0.125 = 5.525bb
    expect(hands[0].heroNet).toBeCloseTo(3920 / 400 - (50 + 880 + 780) / 400, 2);
    expect(hands[0].seats.find((s) => s.name === "Hero")!.position).toBe("BTN");
    expect(hands[1].seats.find((s) => s.name === "Hero")!.position).toBe("UTG");
    expect(hands[3].seats.find((s) => s.name === "Hero")!.position).toBe("SB");
  });
  it("스택 깊이에 가장 가까운 포맷을 고른다", () => {
    expect(pickFormat(hands[0], IDS)).toBe("mtt8-40");
    expect(pickFormat(hands[5], IDS)).toBe("mtt8-15");
    expect(pickFormat(hands[6], IDS)).toBe("mtt8-25");
  });
});

const m40 = load("mtt8-40");
describe.skipIf(!m40)("40bb 매치업 매핑", () => {
  it("BTN·CO 오픈, SB 림프, BB 3벳 팟이 각 라이브러리 플랍으로 이어진다", () => {
    const a = (i: number) => analyzePreflop(hands[i], m40!).analysis;
    expect(a(0).matchup).toBe("m40-btn-bb");
    expect(a(0).libFlop).toBe("Ks7d2c");
    expect(a(2).matchup).toBe("m40-co-bb");
    expect(a(2).libFlop).toBe("9h7d2c");
    expect(a(3).matchup).toBe("m40-sb-bb-limp");
    expect(a(3).libFlop).toBe("8s6d5c");
    expect(a(4).matchup).toBe("m40-bb-btn-3bp");
    expect(a(4).libFlop).toBe("AhKd4c");
    expect(a(1).decisions[0].chosen).toBe("폴드");
  });
});

const m15 = load("mtt8-15");
const m25 = load("mtt8-25");
describe.skipIf(!m15 || !m25)("숏스택 올인", () => {
  it("15bb 오픈 올인과 25bb 리셔브가 올인 액션으로 채점된다", () => {
    const a6 = analyzePreflop(hands[5], m15!).analysis;
    expect(a6.inTree).toBe(true);
    expect(a6.decisions[0].chosen).toContain("올인");
    const a7 = analyzePreflop(hands[6], m25!).analysis;
    expect(a7.inTree).toBe(true);
    expect(a7.decisions[0].chosen).toContain("올인");
  });
});
