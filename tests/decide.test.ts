// 행동 결정 모델: 한 스트리트 솔버(StreetSolver)와 decide()
import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { comboIndex, parseCard, parseCards } from "../src/engine/cards";
import { parseRange } from "../src/engine/range";
import { PostflopSolver } from "../src/engine/solver";
import { StreetSolver } from "../src/engine/street";
import { buildTree, type TreeConfig } from "../src/engine/tree";
import { decide, multiwayEquity, type Spot } from "../src/lib/decide";
import { CLASS_N, type PfLib } from "../src/lib/preflopLib";

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

  it("앞사람 액션이 빠지면 폴드로 보고 답하며 알려 준다", async () => {
    const d = await decide({ players: 6, hero: "BB", cards: "Ts9s", stack: 40, preflop: [] }, { preflop });
    expect(d.notes.join(" ")).toContain("LJ 의 프리플랍 액션이 기록에 없어");
    expect(d.options[d.pick].type).toBe("check"); // 모두 폴드한 것으로 보면 BB 는 할 일이 없다
  });
});

const has = (id: string) => existsSync(`public/lib/preflop/${id}.json`);
const byId = async (id: string) => JSON.parse(readFileSync(`public/lib/preflop/${id}.json`, "utf-8")) as PfLib;
const eqFile = "public/lib/eq169.bin";
const eq = async () => {
  const b = readFileSync(eqFile);
  return new Float32Array(b.buffer, b.byteOffset, b.length / 4);
};

describe.skipIf(!lib || !has("mtt8-10") || !existsSync(eqFile))("decide — 표 밖 프리플랍 흐름 (림프·올인 위 레이즈·사이드팟)", () => {
  // 2026-11-17 실전 로그에서 엔진이 예외를 던져 호출자가 제멋대로 콜한 자리들
  it("림프 팟의 BB 는 예외 대신 체크를 답한다", async () => {
    const limps = [{ pos: "UTG", type: "fold" as const }, { pos: "UTG1", type: "call" as const }, ...folds("LJ", "HJ", "CO"), { pos: "BTN", type: "call" as const }, ...folds("SB")];
    const d = await decide({ players: 8, hero: "BB", cards: "As8s", stack: 40, preflop: limps }, { preflop, eq });
    expect(d.source).toBe("allin-equity");
    expect(d.options[d.pick].type).toBe("check");
    expect(d.notes.join(" ")).toContain("림프");
  });

  it("올인 위의 더 큰 올인은 콜로 보고 표로 답한다: 72o 폴드, AA 콜", async () => {
    const pre = [{ pos: "UTG", type: "raise" as const, allin: true }, ...folds("UTG1", "LJ", "HJ"), { pos: "CO", type: "raise" as const, to: 25, allin: true }, ...folds("BTN", "SB")];
    const junk = await decide({ players: 8, hero: "BB", cards: "7s2h", stack: 10, preflop: pre }, { preflop: byId, eq });
    expect(junk.source).toBe("library");
    expect(junk.notes.join(" ")).toContain("CO raise 는 표에 없는 액션");
    expect(junk.options[junk.pick].type).toBe("fold");
    const aces = await decide({ players: 8, hero: "BB", cards: "AsAh", stack: 10, preflop: pre }, { preflop: byId, eq });
    expect(aces.options[aces.pick].type).toBe("call");
  });

  it("내가 림프한 뒤 올인을 받으면 레인지 대 승률과 메인팟으로 콜·폴드를 답한다", async () => {
    const pre = [...folds("UTG", "UTG1", "LJ"), { pos: "HJ", type: "call" as const }, { pos: "CO", type: "raise" as const, to: 30.67, allin: true }, ...folds("BTN", "SB", "BB")];
    const qq = await decide({ players: 8, hero: "HJ", cards: "QdQs", stack: 36, preflop: pre }, { preflop, eq });
    expect(qq.source).toBe("allin-equity");
    const call = qq.options.find((o) => o.type === "call")!;
    expect(call.amount).toBeCloseTo(30.67, 2);
    expect(call.label).toBe("콜 29.67");
    expect(call.ev).toBeGreaterThan(5);
    expect(qq.options[qq.pick].type).toBe("call");
    const junk = await decide({ players: 8, hero: "HJ", cards: "7s2h", stack: 36, preflop: pre }, { preflop, eq });
    expect(junk.options[junk.pick].type).toBe("fold");
    expect(junk.options.find((o) => o.type === "call")!.ev).toBeLessThan(0);
  });

  it("사이드팟: 짧은 내가 두 올인을 받을 때 이길 수 있는 돈은 내 스택 몫까지만", async () => {
    // 7bb BB. UTG 30bb 올인, CO 가 60bb 로 다시 올인(표에 없는 레이즈 → 콜로 봄). 메인팟 = 7×3 + 블라인드·앤티 몫
    const pre = [{ pos: "UTG", type: "raise" as const, to: 30, allin: true }, ...folds("UTG1", "LJ", "HJ"), { pos: "CO", type: "raise" as const, to: 60, allin: true }, ...folds("BTN", "SB")];
    const d = await decide({ players: 8, hero: "BB", cards: "7h3c", stack: 7, preflop: pre }, { preflop: byId, eq });
    const call = d.options.find((o) => o.type === "call")!;
    expect(call.amount).toBe(7);
    expect(d.options[d.pick].type).toBe("fold");
  });

  it("다자 승률: AA 는 두 명의 무작위 핸드를 60% 넘게 이기고, 72o 는 25% 아래", () => {
    const any = () => Float64Array.from(CLASS_N);
    expect(multiwayEquity(parseCards("AsAh"), [any(), any()], 1500)).toBeGreaterThan(0.6);
    expect(multiwayEquity(parseCards("7s2h"), [any(), any()], 1500)).toBeLessThan(0.25);
  });
});

describe.skipIf(!has("mtt8-6") || !has("mtt8-15") || !existsSync(eqFile))("decide — 이상한 자리에서 AA·KK 가 폴드하지 않는다", () => {
  // 2026-11-17 사용자 신고. GTO 라인 밖 노드는 그 핸드의 빈도가 학습되지 않아 균등값(폴드 50%·콜 50%)으로 남아 있고,
  // 표가 4명째 참여를 막은 노드는 폴드 하나뿐이었다
  const offLine = [...folds("UTG", "UTG1", "LJ", "HJ", "CO"), { pos: "BTN", type: "raise" as const, to: 2 }, { pos: "SB", type: "call" as const }, { pos: "BB", type: "raise" as const, allin: true }, ...folds("BTN")];
  const fourth = [...folds("UTG", "UTG1", "LJ", "HJ"), { pos: "CO", type: "raise" as const, allin: true }, { pos: "BTN", type: "call" as const }, { pos: "SB", type: "call" as const }];
  for (const cards of ["AsAh", "KsKh"]) {
    it(`${cards}: SB 로 콜했다가 BB 올인을 받으면 빈도 대신 EV 로 콜한다 (빈도대로 뽑아도)`, async () => {
      const d = await decide({ players: 8, hero: "SB", cards, stack: 15, preflop: offLine }, { preflop: byId, rng: () => 0.1 });
      expect(d.options[d.pick].type).toBe("call");
      expect(freqOf(d, "fold")).toBe(0);
      expect(d.notes.join(" ")).toContain("EV 가 가장 큰");
    });

    it(`${cards}: 표가 막은 4명째 자리(6bb BB, CO 올인·BTN 콜·SB 콜)에서 폴드만 답하지 않고 승률로 콜한다`, async () => {
      const d = await decide({ players: 8, hero: "BB", cards, stack: 6, preflop: fourth }, { preflop: byId, eq });
      expect(d.source).toBe("allin-equity");
      expect(d.options[d.pick].type).toBe("call");
      expect(d.options.find((o) => o.type === "call")!.amount).toBe(6);
    });
  }

  it("10bb CO AA: 오픈·콜·콜 뒤 HJ 올인 — 아직 행동 안 한 BTN·SB·BB 를 콜하는 상대로 세지 않는다", async () => {
    const pre = [{ pos: "UTG", type: "raise" as const, to: 2 }, { pos: "UTG1", type: "call" as const }, { pos: "LJ", type: "call" as const }, { pos: "HJ", type: "raise" as const, allin: true }];
    const d = await decide({ players: 8, hero: "CO", cards: "AsAh", stack: 10, preflop: pre }, { preflop: byId, eq });
    expect(d.options[d.pick].type).toBe("call");
    expect(d.notes.join(" ")).toContain("아직 행동하지 않은 BTN, SB, BB 은 폴드");
  });

  it("40bb SB KK: 4벳 뒤 BB 5벳 올인·HJ 콜 — 표의 다자 올인 근사가 폴드라 해도 실제 승률로 콜", async () => {
    const pre = [{ pos: "UTG", type: "fold" as const }, { pos: "UTG1", type: "raise" as const, to: 2.2 }, { pos: "LJ", type: "fold" as const }, { pos: "HJ", type: "raise" as const, to: 6.16 }, ...folds("CO", "BTN"), { pos: "SB", type: "raise" as const, to: 13.55 }, { pos: "BB", type: "raise" as const, allin: true }, { pos: "UTG1", type: "fold" as const }, { pos: "HJ", type: "call" as const }];
    const lib40 = await byId("mtt8-40");
    const d = await decide({ players: 8, hero: "SB", cards: "KsKh", stack: 40, preflop: pre }, { preflop: async () => lib40, eq });
    expect(d.source).toBe("allin-equity");
    expect(d.options[d.pick].type).toBe("call");
    expect(d.notes.join(" ")).toContain("실제 승률로 다시");
  });

  it("72o 는 같은 4명째 자리에서 여전히 폴드", async () => {
    const d = await decide({ players: 8, hero: "BB", cards: "7s2h", stack: 6, preflop: fourth }, { preflop: byId, eq });
    expect(d.options[d.pick].type).toBe("fold");
  });
});

describe.skipIf(!has("mtt8-6") || !has("mtt8-10"))("decide — 짧은 스택 (15bb 미만)", () => {
  const toBtn = folds("UTG", "UTG1", "LJ", "HJ", "CO");

  it("7bb BTN K9o: 6bb 표에서 올인하고, 금액은 표의 6이 아니라 내 스택 7", async () => {
    const d = await decide({ players: 8, hero: "BTN", cards: "Ks9d", stack: 7, preflop: toBtn }, { preflop: byId });
    expect(d.format).toBe("mtt8-6");
    expect(d.options[d.pick].type).toBe("allin");
    expect(d.options[d.pick].amount).toBe(7);
    expect(d.options[d.pick].label).toBe("올인 7");
  });

  it("7bb BB 가 BTN 올인을 받으면 A2o 는 콜, 72o 는 폴드, 콜 금액은 7", async () => {
    const jam = [...toBtn, { pos: "BTN", type: "raise" as const, allin: true }, ...folds("SB")];
    const a2 = await decide({ players: 8, hero: "BB", cards: "As2d", stack: 7, preflop: jam }, { preflop: byId });
    const call = a2.options[a2.pick];
    expect(call.type).toBe("call");
    expect(call.amount).toBe(7);
    expect(call.label).toBe("콜 6");
    const junk = await decide({ players: 8, hero: "BB", cards: "7s2h", stack: 7, preflop: jam }, { preflop: byId });
    expect(junk.options[junk.pick].type).toBe("fold");
  });

  it("11bb 는 10bb 표를 쓰고 UTG AA 는 들어간다", async () => {
    const d = await decide({ players: 8, hero: "UTG", cards: "AsAh", stack: 11, preflop: [] }, { preflop: byId });
    expect(d.format).toBe("mtt8-10");
    expect(d.options[d.pick].type).not.toBe("fold");
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
