import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { canonicalJson, completeLuluHand, importLuluLog, normCard, parseHandsJson, sha256Hex, validateHand } from "../../src/review/hand-history";
import { replay } from "../../src/review/replay-state";

const read = (n: string) => readFileSync(`examples/review/${n}`, "utf8");
const good = () => JSON.parse(read("ex-library-25bb.json"));

describe("핸드 JSON 검증", () => {
  it("모든 예제 핸드가 계약을 통과한다", () => {
    for (const f of readdirSync("examples/review").filter((x) => x.startsWith("ex-"))) {
      const v = validateHand(JSON.parse(read(f)));
      expect(v.issues, f).toEqual([]);
      expect(v.hand?.id).toBe(f.replace(".json", ""));
    }
  });
  it("손상된 입력을 이유와 함께 거부한다", () => {
    const cases: Array<[(h: Record<string, any>) => void, string]> = [
      [(h) => (h.schema = "x"), "schema"],
      [(h) => (h.hero.cards = ["Ad", "1x"]), "hero-cards"],
      [(h) => (h.board.turn = "Ad"), "dup-card"], // 내 카드와 중복
      [(h) => delete h.board.flop, "turn-no-flop"],
      [(h) => (h.seats = []), "seats"],
      [(h) => (h.unit = "won"), "unit"],
      [(h) => delete h.forced, "forced"],
      [(h) => (h.actions[0].type = "shove"), "action-item"],
      [(h) => (h.actions[5].to = "2bb"), "action-amount"],
      [(h) => (h.showdown = [{ seat: 6, cards: ["As", "Kc"] }]), "hero-shown"],
      [(h) => (h.tournament = { kind: "standard", payouts: [], otherStacks: [] }), "tournament"]
    ];
    for (const [mut, code] of cases) {
      const h = good();
      mut(h);
      const v = validateHand(h);
      expect(v.hand, code).toBeNull();
      expect(v.issues.map((i) => i.code), code).toContain(code);
    }
  });
  it("카드 표기를 정규화한다", () => {
    expect(normCard("as")).toBe("As");
    expect(normCard("10h")).toBe("Th");
    expect(normCard("Ax")).toBeNull();
    expect(normCard(5)).toBeNull();
  });
  it("붙여넣기: 핸드 하나·배열·{hands}·잘못된 JSON·너무 큰 입력", () => {
    expect(parseHandsJson(read("ex-library-25bb.json")).hands).toHaveLength(1);
    expect(parseHandsJson(JSON.stringify([good(), good()])).hands).toHaveLength(2);
    expect(parseHandsJson(JSON.stringify({ hands: [good()] })).hands).toHaveLength(1);
    expect(parseHandsJson("{oops").issues[0].code).toBe("json");
    expect(parseHandsJson(" ".repeat(5 * 1024 * 1024 + 1)).issues[0].code).toBe("too-big");
  });
  it("해시: 키 순서와 무관하고 SHA-256 표준 값과 같다", async () => {
    expect(canonicalJson({ b: 1, a: [1, { d: 2, c: 3 }] })).toBe('{"a":[1,{"c":3,"d":2}],"b":1}');
    expect(await sha256Hex("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });
});

describe("루루 판단 기록 (읽기 전용)", () => {
  it("관측한 것만 가져오고 모르는 값은 비워 둔다", () => {
    const r = importLuluLog(read("lulu-sample-synthetic.json"));
    expect(r.events).toBe(2);
    expect(r.hands).toHaveLength(1);
    const h = r.hands[0];
    expect(h.source.kind).toBe("lulu-decision-log");
    expect(h.complete).toBe(false);
    expect(h.unit).toBe("bb");
    expect(h.seats.map((s) => s.name)).toEqual(["LJ", "HJ", "CO", "BTN", "SB", "BB"]);
    expect(h.buttonSeat).toBe(4);
    expect(h.hero).toEqual({ seat: 4, cards: ["Ah", "Qd"] });
    expect(h.seats.every((s) => s.stack === null)).toBe(true); // 앤티를 모르면 초기 스택을 만들지 않는다
    expect(h.seats[3].observedStackAfterAnte).toBe(40);
    expect(h.forced).toEqual([{ seat: 6, kind: "bb", amount: 1 }]); // SB·앤티는 비워 둠
    expect(h.actions).toHaveLength(7);
    expect(h.actions[3]).toEqual({ street: "preflop", seat: 4, type: "raise", to: 2.2 });
    expect(h.board.flop).toEqual(["Qs", "7d", "2c"]);
    expect(h.missing).toContain("SB 금액");
    expect(h.missing).toContain("앤티 종류·금액");
    expect(h.notes!.join()).toContain("실행 여부 미확인");
    expect(h.snapshots!.map((s) => s.beforeAction)).toEqual([3, 7]);
    // 그대로는 재구성할 수 없다
    expect(replay(h).ok).toBe(false);
    expect(validateHand(JSON.parse(JSON.stringify(h))).hand).not.toBeNull();
  });
  it("사용자가 SB·앤티를 보완하면 재구성되고, 관측 팟과 다르면 불일치로 표시된다", () => {
    const h = importLuluLog(read("lulu-sample-synthetic.json")).hands[0];
    const c = completeLuluHand(h, { sb: 0.5, anteKind: "ante", ante: 0.125 });
    expect(c.error).toBeUndefined();
    expect(c.hand!.seats[3].stack).toBe(40.125);
    expect(c.hand!.missing).not.toContain("SB 금액");
    const rp = replay(c.hand!);
    expect(rp.ok).toBe(true);
    expect(rp.pending?.seat).toBe(4); // 플랍에서 BB 체크 뒤 내 차례
    const pot = rp.snapshotChecks.find((x) => x.beforeAction === 3 && x.field.startsWith("팟"))!;
    expect(pot.ok).toBe(false); // 합성 기록의 2.5 ≠ 재구성 2.25 (앤티 0.75 + 블라인드 1.5)
    expect(pot.reconstructed).toBe(2.25);
    expect(completeLuluHand(h, { sb: 0, anteKind: "none", ante: 0 }).error).toBeDefined();
  });
  it("형식이 다른 파일은 거부한다", () => {
    expect(importLuluLog("{}").issues[0].code).toBe("lulu");
    expect(importLuluLog("not json").issues[0].code).toBe("lulu");
    expect(importLuluLog(JSON.stringify({ schema: 1, events: [] })).issues[0].code).toBe("lulu-empty");
  });
});
