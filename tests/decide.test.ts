// 행동 결정 모델: 한 스트리트 솔버(StreetSolver)와 decide()
import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { comboIndex, parseCard, parseCards } from "../src/engine/cards";
import { parseRange } from "../src/engine/range";
import { PostflopSolver } from "../src/engine/solver";
import { StreetSolver } from "../src/engine/street";
import { buildTree, type TreeConfig } from "../src/engine/tree";
import { decide, type Spot } from "../src/lib/decide";
import type { PfLib } from "../src/lib/preflopLib";

const one = { bet: [66], raise: [] as number[] };
const oop = parseRange("AA,KK,QQ,JJ,TT,99,88,77,66,55,44,33,22,AK,AQ,AJ,KQ,T9s,98s,87s,76s,65s");
const ip = parseRange("AA,KK,QQ,JJ,TT,99,88,AQ,AJs,KQs,KJs,QJs,JTs,T9s,98s");
function cfg(board: string): TreeConfig {
  return { board: parseCards(board), pot: 10, effStack: 20, rakePct: 0, rakeCap: 0, oop: { flop: one, turn: one, river: one }, ip: { flop: one, turn: one, river: one }, allinThresholdPct: 0, maxRaisesPerStreet: 1, allowDonk: true, includeAllin: false };
}

describe("한 스트리트 솔버", () => {
  it("리버는 전체 솔버와 같은 값으로 수렴한다", () => {
    const full = new PostflopSolver(buildTree(cfg("2c7d9hJsKd")), oop, ip);
    const st = new StreetSolver(buildTree(cfg("2c7d9hJsKd")), oop, ip);
    full.step(200);
    st.step(200);
    const a = full.metrics();
    const b = st.metrics();
    expect(b.exploitabilityPct).toBeLessThan(0.5);
    expect(b.ev[0]).toBeCloseTo(a.evOop, 1);
    expect(b.ev[1]).toBeCloseTo(a.evIp, 1);
    expect(b.ev[0] + b.ev[1]).toBeCloseTo(10, 3);
  });

  it("플랍 승률 행렬: AA 는 KK 를 크게 이기고 두 값의 합은 1", () => {
    const st = new StreetSolver(buildTree(cfg("2c7d9h")), oop, ip);
    const slot = (s: string) => st.hands.slotOfCombo[comboIndex(parseCard(s.slice(0, 2)), parseCard(s.slice(2)))];
    const aa = slot("AsAh");
    const kk = slot("KsKh");
    expect(st.sampled).toBe(false);
    expect(st.equity(aa, kk)).toBeGreaterThan(0.88);
    expect(st.equity(aa, kk) + st.equity(kk, aa)).toBeCloseTo(1, 5);
    expect(st.equity(aa, slot("AsKd"))).toBe(0); // 같은 카드를 쓰는 쌍
  });

  it("플랍(깊이 제한)도 값의 합이 팟이고 익스플로잇어빌리티가 줄어든다", () => {
    const st = new StreetSolver(buildTree(cfg("2c7d9h")), oop, ip);
    st.step(3);
    const m1 = st.metrics();
    st.step(80);
    const m2 = st.metrics();
    expect(m2.ev[0] + m2.ev[1]).toBeCloseTo(10, 2);
    expect(m2.exploitabilityPct).toBeLessThan(m1.exploitabilityPct);
    expect(m2.exploitabilityPct).toBeLessThan(1);
  });
});

const file = "public/lib/preflop/mtt8-40.json";
const lib: PfLib | null = existsSync(file) ? JSON.parse(readFileSync(file, "utf-8")) : null;
const preflop = async () => lib!;
const freqOf = (d: Awaited<ReturnType<typeof decide>>, type: string) => d.options.filter((o) => o.type === type).reduce((s, o) => s + o.freq, 0);
const folds = (...pos: string[]) => pos.map((p) => ({ pos: p, type: "fold" as const }));

describe.skipIf(!lib)("decide — 프리플랍", () => {
  it("8명 UTG: AA 는 오픈, 72o 는 폴드", async () => {
    const aa = await decide({ players: 8, hero: "UTG", cards: "AsAh", stack: 40, preflop: [] }, { preflop });
    expect(aa.street).toBe("preflop");
    expect(aa.source).toBe("library");
    expect(aa.options[aa.pick].type).toBe("raise");
    const junk = await decide({ players: 8, hero: "UTG", cards: "7s2h", stack: 40, preflop: [] }, { preflop });
    expect(junk.options[junk.pick].type).toBe("fold");
  });

  it("6명이면 LJ 가 첫 행동자, BB 는 BTN 오픈에 방어 빈도를 받는다", async () => {
    const lj = await decide({ players: 6, hero: "LJ", cards: "AsKs", stack: 40, preflop: [] }, { preflop });
    expect(lj.options[lj.pick].type).toBe("raise");
    const bb = await decide({ players: 6, hero: "BB", cards: "Ts9s", stack: 40, preflop: [...folds("LJ", "HJ", "CO"), { pos: "BTN", type: "raise", to: 2.2 }, ...folds("SB")] }, { preflop });
    expect(freqOf(bb, "fold")).toBeLessThan(0.05);
    expect(bb.options.reduce((s, o) => s + o.freq, 0)).toBeCloseTo(1, 2);
  });

  it("앞사람 액션이 빠지면 알려 준다", async () => {
    await expect(decide({ players: 6, hero: "BB", cards: "Ts9s", stack: 40, preflop: [] }, { preflop })).rejects.toThrow("LJ");
  });
});

describe.skipIf(!lib)("decide — 포스트플랍 (스트리트마다 3초 안)", () => {
  const base: Spot = { players: 8, hero: "BTN", cards: "AsKd", stack: 40, preflop: [...folds("UTG", "UTG1", "LJ", "HJ", "CO"), { pos: "BTN", type: "raise", to: 2.2 }, ...folds("SB"), { pos: "BB", type: "call" }] };

  it("플랍 → 턴 → 리버를 처음 보는 상태에서 각각 3초 안에 답한다", async () => {
    const flop = await decide({ ...base, cards: "QsJd", board: "Ks7d2c", flop: [{ pos: "BB", type: "check" }] }, { preflop });
    expect(flop.street).toBe("flop");
    expect(flop.ms).toBeLessThan(3000);
    expect(flop.options.reduce((s, o) => s + o.freq, 0)).toBeCloseTo(1, 2);
    expect(flop.options.map((o) => o.type)).toContain("check");

    const turn = await decide({ ...base, cards: "QhJh", board: "Ts7d2c9h", flop: [{ pos: "BB", type: "check" }, { pos: "BTN", type: "check" }], turn: [{ pos: "BB", type: "bet", to: 3.5 }] }, { preflop });
    expect(turn.street).toBe("turn");
    expect(turn.ms).toBeLessThan(3000);
    expect(turn.options.map((o) => o.type)).toEqual(expect.arrayContaining(["fold", "call"]));

    const river = await decide(
      { ...base, cards: "AhKh", board: "Th7h2c9s3h", flop: [{ pos: "BB", type: "check" }, { pos: "BTN", type: "bet", to: 1.8 }, { pos: "BB", type: "call" }], turn: [{ pos: "BB", type: "check" }, { pos: "BTN", type: "check" }], river: [{ pos: "BB", type: "bet", to: 6 }] },
      { preflop }
    );
    expect(river.street).toBe("river");
    expect(river.ms).toBeLessThan(3000);
    // 넛 플러시는 리버 벳에 폴드하지 않는다
    expect(freqOf(river, "fold")).toBeLessThan(0.02);
  });

  it("리버에서 아무것도 못 이기는 핸드는 큰 벳에 콜하지 않는다", async () => {
    const d = await decide(
      { ...base, cards: "5s4s", board: "AhKc9d8h2c", flop: [{ pos: "BB", type: "check" }, { pos: "BTN", type: "check" }], turn: [{ pos: "BB", type: "check" }, { pos: "BTN", type: "check" }], river: [{ pos: "BB", type: "bet", to: 5 }] },
      { preflop }
    );
    expect(freqOf(d, "call")).toBeLessThan(0.02);
    // 리버는 끝까지 풀어서 주어진 레인지 안에서는 거의 수렴한다
    expect(d.exploitabilityPct).toBeLessThan(0.5);
  });

  it("상대 올인은 올인 금액 그대로 콜 여부를 묻는다", async () => {
    const jam = { board: "Ks7d2c9h", flop: [{ pos: "BB", type: "check" as const }, { pos: "BTN", type: "check" as const }], turn: [{ pos: "BB", type: "bet" as const, allin: true }] };
    const air = await decide({ ...base, cards: "5d4d", ...jam }, { preflop });
    expect(air.options.find((o) => o.type === "call")!.amount).toBeCloseTo(37.8, 1); // 40 − 프리플랍 2.2
    expect(air.options[air.pick].type).toBe("fold"); // 5 하이로 팟의 6배 올인은 콜하지 않는다
    const set = await decide({ ...base, cards: "KhKc", ...jam }, { preflop });
    expect(set.options[set.pick].type).toBe("call");
  });

  it("지나간 스트리트에 콜이 빠져 있으면 알려 준다", async () => {
    await expect(decide({ ...base, board: "Ks7d2c9h", flop: [{ pos: "BB", type: "check" }, { pos: "BTN", type: "bet", to: 1.8 }], turn: [{ pos: "BB", type: "check" }] }, { preflop })).rejects.toThrow("끝나지 않았는데");
  });

  it("3명 팟도 답하고, 줄여 푼 근사임을 알려 준다", async () => {
    const d = await decide(
      { players: 8, hero: "BB", cards: "9s8s", stack: 40, board: "7s6d2c", preflop: [...folds("UTG", "UTG1", "LJ", "HJ"), { pos: "CO", type: "raise", to: 2.2 }, { pos: "BTN", type: "call" }, ...folds("SB"), { pos: "BB", type: "call" }], flop: [] },
      { preflop }
    );
    expect(d.street).toBe("flop");
    expect(d.notes.join(" ")).toContain("3명 이상");
  });

  it("내 차례가 아니면 알려 준다", async () => {
    await expect(decide({ ...base, board: "Ks7d2c", flop: [] }, { preflop })).rejects.toThrow("내 차례");
  });
});
