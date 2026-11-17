import { describe, expect, it } from "vitest";
import { computeOutcome, positionNames, potLayersMilli, replay, toMilli } from "../../src/review/replay-state";
import { HAND_SCHEMA, type ActionRecord, type ForcedBet, type HandRecord } from "../../src/review/types";

/** 좌석 1..n, 칩 단위 핸드를 짧게 만든다 */
export function mk(o: { stacks: number[]; button: number; sb?: number; bb?: number; ante?: number; bbAnte?: number; actions?: ActionRecord[]; hero?: number; unit?: "chips" | "bb"; board?: HandRecord["board"]; showdown?: HandRecord["showdown"]; complete?: boolean }): HandRecord {
  const n = o.stacks.length;
  const seats = o.stacks.map((stack, i) => ({ seat: i + 1, stack }));
  const bi = o.button - 1;
  const sbSeat = n === 2 ? o.button : ((bi + 1) % n) + 1;
  const bbSeat = n === 2 ? ((bi + 1) % n) + 1 : ((bi + 2) % n) + 1;
  const bb = o.bb ?? 2;
  const forced: ForcedBet[] = [];
  if (o.ante) for (const s of seats) forced.push({ seat: s.seat, kind: "ante", amount: Math.min(o.ante, s.stack) });
  if (o.bbAnte) forced.push({ seat: bbSeat, kind: "bb-ante", amount: o.bbAnte });
  forced.push({ seat: sbSeat, kind: "sb", amount: o.sb ?? bb / 2 });
  forced.push({ seat: bbSeat, kind: "bb", amount: Math.min(bb, o.stacks[bbSeat - 1]) });
  return {
    schema: HAND_SCHEMA,
    id: "t",
    complete: o.complete ?? false,
    source: { kind: "manual" },
    unit: o.unit ?? "chips",
    bigBlind: o.unit === "bb" ? 1 : bb,
    buttonSeat: o.button,
    seats,
    hero: { seat: o.hero ?? 1, cards: null },
    forced,
    actions: o.actions ?? [],
    board: o.board ?? {},
    showdown: o.showdown
  };
}
export const A = (street: ActionRecord["street"], seat: number, type: ActionRecord["type"], amt?: { add?: number; to?: number; allIn?: boolean }): ActionRecord => ({ street, seat, type, ...amt });
const errors = (r: ReturnType<typeof replay>) => r.issues.filter((i) => i.severity === "error");

describe("행동 순서", () => {
  it("헤즈업: 버튼이 SB 를 내고 프리플랍 먼저, 포스트플랍은 나중", () => {
    const h = mk({ stacks: [100, 100], button: 1, actions: [A("preflop", 1, "call"), A("preflop", 2, "check"), A("flop", 2, "check"), A("flop", 1, "check")] });
    const r = replay(h);
    expect(errors(r)).toEqual([]);
    expect(r.sbSeat).toBe(1);
    expect(r.bbSeat).toBe(2);
    expect(r.positions).toEqual({ 1: "BTN", 2: "BB" });
    expect(r.steps[0].legal.toCall).toBe(1);
    expect(r.steps[2].before.street).toBe("flop");
    expect(r.steps[2].action.seat).toBe(2);
    expect(r.pending?.seat).toBe(2); // 턴 첫 차례도 BB
  });
  it("2~8명: 첫 차례는 BB 다음, 포스트플랍 첫 차례는 버튼 다음 살아 있는 자리", () => {
    for (let n = 3; n <= 8; n++) {
      const stacks = Array(n).fill(100);
      const r = replay(mk({ stacks, button: n })); // 버튼 = 마지막 좌석 → SB 1, BB 2
      expect(errors(r)).toEqual([]);
      expect(r.sbSeat).toBe(1);
      expect(r.bbSeat).toBe(2);
      expect(r.pending?.seat).toBe(3);
      expect(r.order[r.order.length - 1]).toBe(2);
      expect(r.positions[2]).toBe("BB");
      expect(r.positions[1]).toBe("SB");
      expect(r.positions[n]).toBe("BTN");
      expect(positionNames(n)).toHaveLength(n);
    }
    // 4명: 프리플랍 CO 먼저, 플랍은 SB 먼저
    const pre = [A("preflop", 3, "call"), A("preflop", 4, "call"), A("preflop", 1, "call"), A("preflop", 2, "check")];
    const r = replay(mk({ stacks: [100, 100, 100, 100], button: 4, actions: [...pre, A("flop", 1, "check")] }));
    expect(errors(r)).toEqual([]);
    expect(r.positions[3]).toBe("CO");
    expect(r.steps[4].action.position).toBe("SB");
    expect(r.pending?.seat).toBe(2);
  });
  it("차례가 아닌 자리의 액션은 포지션 오류", () => {
    const r = replay(mk({ stacks: [100, 100, 100], button: 3, actions: [A("preflop", 1, "fold")] }));
    expect(errors(r)[0].category).toBe("position");
    expect(errors(r)[0].message).toContain("BTN(3번) 차례");
  });
  it("베팅이 끝나기 전 다음 스트리트 액션은 오류", () => {
    const r = replay(mk({ stacks: [100, 100], button: 1, actions: [A("preflop", 1, "call"), A("flop", 2, "check")] }));
    expect(errors(r)[0].code).toBe("street");
  });
});

describe("추가 콜과 목표액", () => {
  // 사용자 사례 3: BB 160 을 낸 뒤 목표 320 레이즈를 마주함 → 추가 콜은 160
  const base = { stacks: [10000, 10000, 10000], button: 3, bb: 160, sb: 80 };
  it("BB 160 뒤 목표 320 레이즈의 추가 콜은 160", () => {
    const r = replay(mk({ ...base, actions: [A("preflop", 3, "raise", { to: 320 }), A("preflop", 1, "fold")] }));
    expect(errors(r)).toEqual([]);
    expect(r.pending?.seat).toBe(2);
    expect(r.pending?.legal.toCall).toBe(160);
    expect(r.pending?.legal.callAdd).toBe(160);
    expect(r.pending?.legal.minTo).toBe(480);
  });
  it("콜을 목표액 320 으로 적으면 맞고, 추가 320 으로 적으면 금액 오류", () => {
    const ok = replay(mk({ ...base, actions: [A("preflop", 3, "raise", { to: 320 }), A("preflop", 1, "fold"), A("preflop", 2, "call", { to: 320 })] }));
    expect(errors(ok)).toEqual([]);
    expect(ok.steps[2].action.add).toBe(160);
    const bad = replay(mk({ ...base, actions: [A("preflop", 3, "raise", { to: 320 }), A("preflop", 1, "fold"), A("preflop", 2, "call", { add: 320 })] }));
    expect(errors(bad)[0].code).toBe("call-add");
    expect(errors(bad)[0].category).toBe("amount");
  });
  it("레이즈의 추가액과 목표액이 함께 있으면 서로 맞아야 한다", () => {
    const r = replay(mk({ ...base, actions: [A("preflop", 3, "raise", { to: 320 }), A("preflop", 1, "fold"), A("preflop", 2, "raise", { add: 800, to: 800 })] }));
    expect(errors(r)[0].code).toBe("add-to-mismatch");
    const ok = replay(mk({ ...base, actions: [A("preflop", 3, "raise", { to: 320 }), A("preflop", 1, "fold"), A("preflop", 2, "raise", { add: 640 })] }));
    expect(errors(ok)).toEqual([]);
    expect(ok.steps[2].action.to).toBe(800);
  });
});

describe("불균등 스택·짧은 올인·재오픈", () => {
  // 블라인드 1/2, 좌석 1=SB 2=BB 3=UTG(CO) 4=BTN
  it("짧은 올인은 이미 행동한 자리에 레이즈를 열지 않는다", () => {
    const acts = [A("preflop", 3, "raise", { to: 6 }), A("preflop", 4, "raise", { to: 9, allIn: true }), A("preflop", 1, "fold"), A("preflop", 2, "call")];
    const r = replay(mk({ stacks: [100, 100, 100, 9], button: 4, actions: acts }));
    expect(errors(r)).toEqual([]);
    expect(r.steps[1].action.fullRaise).toBe(false);
    expect(r.pending?.seat).toBe(3);
    expect(r.pending?.legal.canRaise).toBe(false);
    expect(r.pending?.legal.raiseBlockedBy).toContain("짧은 올인");
    const bad = replay(mk({ stacks: [100, 100, 100, 9], button: 4, actions: [...acts, A("preflop", 3, "raise", { to: 20 })] }));
    expect(errors(bad)[0].code).toBe("raise-blocked");
  });
  it("짧은 올인이 겹쳐 완전 레이즈 이상이 되면 다시 열린다", () => {
    const acts = [A("preflop", 3, "raise", { to: 6 }), A("preflop", 4, "raise", { to: 9, allIn: true }), A("preflop", 1, "raise", { to: 11, allIn: true }), A("preflop", 2, "call")];
    const r = replay(mk({ stacks: [11, 100, 100, 9], button: 4, actions: acts }));
    expect(errors(r)).toEqual([]);
    expect(r.pending?.seat).toBe(3);
    expect(r.pending?.legal.canRaise).toBe(true); // 6 → 11 은 5 ≥ 4
  });
  it("완전 레이즈를 마주한 자리는 다시 레이즈할 수 있다", () => {
    const acts = [A("preflop", 3, "raise", { to: 6 }), A("preflop", 4, "raise", { to: 20 }), A("preflop", 1, "fold"), A("preflop", 2, "fold")];
    const r = replay(mk({ stacks: [100, 100, 100, 100], button: 4, actions: acts }));
    expect(r.pending?.legal.canRaise).toBe(true);
    expect(r.pending?.legal.minTo).toBe(34);
  });
  it("최소 레이즈 미달(올인 아님)은 금액 오류", () => {
    const r = replay(mk({ stacks: [100, 100, 100, 100], button: 4, actions: [A("preflop", 3, "raise", { to: 6 }), A("preflop", 4, "raise", { to: 8 })] }));
    expect(errors(r)[0].code).toBe("min-raise");
  });
  it("스택보다 큰 목표액은 오류", () => {
    const r = replay(mk({ stacks: [100, 100, 50, 100], button: 4, actions: [A("preflop", 3, "raise", { to: 60 })] }));
    expect(errors(r)[0].code).toBe("over-stack");
  });
  it("BB 가 스택이 모자라 덜 내도 다른 자리는 BB 전액을 맞춘다", () => {
    const r = replay(mk({ stacks: [100, 1.5, 100], button: 3, actions: [] }));
    expect(errors(r)).toEqual([]);
    expect(r.final!.seats.find((s) => s.seat === 2)!.allIn).toBe(true);
    expect(r.pending?.legal.toCall).toBe(2);
  });
});

describe("팟·사이드팟·환급·칩 보존", () => {
  /** 독립 공식: 내가 이길 수 있는 최대 금액 = Σ_j min(내 총액, j 의 총액) */
  const winnable = (totals: number[], i: number) => totals.reduce((s, t) => s + Math.min(t, totals[i]), 0);
  it("3명 올인의 메인·사이드팟", () => {
    // 좌석 1 SB(100) 2 BB(50) 3 BTN(200): BTN 올인 200, SB 콜 100(올인), BB 콜 50(올인)
    const acts = [A("preflop", 3, "raise", { to: 200, allIn: true }), A("preflop", 1, "call"), A("preflop", 2, "call")];
    const r = replay(mk({ stacks: [100, 50, 200], button: 3, actions: acts }));
    expect(errors(r)).toEqual([]);
    expect(r.ended).toBe("runout");
    expect(r.refunds).toEqual([{ seat: 3, amount: 100, street: "preflop" }]);
    const layers = potLayersMilli(r.finalMilli);
    expect(layers.map((l) => l.amount / 1000)).toEqual([150, 100]);
    expect(layers.map((l) => l.eligible.sort())).toEqual([[1, 2, 3], [1, 3]]);
    const totals = r.finalMilli.map((s) => s.totalIn);
    for (const [i, seat] of r.finalMilli.map((s) => s.seat).entries()) {
      const mine = layers.filter((l) => l.eligible.includes(seat)).reduce((a, l) => a + l.amount, 0);
      expect(mine).toBe(winnable(totals, i));
    }
  });
  it("BB 앤티는 BB 의 기여가 아니라 모두의 죽은 돈이다 (BB 에게만 돌아가는 층이 생기지 않는다)", () => {
    // 좌석 1 SB, 2 BB(앤티 2 + BB 2), 3 BTN 50 올인, SB 폴드, BB 콜
    const r = replay(mk({ stacks: [100, 100, 50], button: 3, bbAnte: 2, bb: 2, sb: 1, actions: [A("preflop", 3, "raise", { to: 50, allIn: true }), A("preflop", 1, "fold"), A("preflop", 2, "call")] }));
    expect(errors(r)).toEqual([]);
    const layers = potLayersMilli(r.finalMilli);
    expect(layers.map((l) => [l.amount / 1000, l.eligible.sort()])).toEqual([[2, [2, 3]], [101, [2, 3]]]);
    expect(layers.reduce((a, l) => a + l.amount, 0) / 1000).toBe(103);
  });
  it("아무도 맞추지 않은 초과 베팅은 돌려준다 (헤즈업 리버)", () => {
    const acts = [A("preflop", 1, "call"), A("preflop", 2, "check"), A("flop", 2, "check"), A("flop", 1, "check"), A("turn", 2, "check"), A("turn", 1, "check"), A("river", 2, "bet", { to: 150, allIn: false }), A("river", 1, "call")];
    const r = replay(mk({ stacks: [60, 200], button: 1, actions: acts }));
    expect(errors(r)).toEqual([]);
    expect(r.steps[7].action).toMatchObject({ add: 58, allIn: true });
    expect(r.refunds).toEqual([{ seat: 2, amount: 92, street: "river" }]);
    expect(r.ended).toBe("showdown");
  });
  it("모두 폴드하면 맞춰지지 않은 레이즈를 돌려주고 칩이 보존된다", () => {
    const h = mk({ stacks: [100, 100, 100], button: 3, ante: 1, actions: [A("preflop", 3, "raise", { to: 6 }), A("preflop", 1, "fold"), A("preflop", 2, "fold")], complete: true });
    const r = replay(h);
    expect(errors(r)).toEqual([]);
    expect(r.ended).toBe("fold");
    expect(r.refunds).toEqual([{ seat: 3, amount: 4, street: "preflop" }]);
    const o = computeOutcome(h, r);
    expect(o.known).toBe(true);
    // 버튼: 앤티 1 + 레이즈 중 맞춰진 2 를 내고 팟(앤티 3 + SB 1 + BB 2 + 2 = 8)을 가져감 → 105
    expect(o.finalStacks).toEqual([{ seat: 1, stack: 98 }, { seat: 2, stack: 97 }, { seat: 3, stack: 105 }]);
    expect(o.conservation?.ok).toBe(true);
  });
  it("앤티는 팟에 들어가지만 추가 콜에는 들어가지 않는다 (개인 앤티, BB 앤티)", () => {
    const r = replay(mk({ stacks: [100, 100, 100], button: 3, ante: 0.5, bb: 2 }));
    expect(r.pending?.legal.toCall).toBe(2);
    expect(r.final!.pot).toBe(4.5);
    const r2 = replay(mk({ stacks: [100, 100, 100], button: 3, bbAnte: 2, bb: 2 }));
    expect(r2.pending?.legal.toCall).toBe(2);
    expect(r2.final!.pot).toBe(5);
    expect(r2.final!.seats.find((s) => s.seat === 2)!.stack).toBe(96);
  });
  it("쇼다운 분배: 동점이면 나누고 칩이 보존된다", () => {
    const acts = [A("preflop", 3, "call"), A("preflop", 1, "call"), A("preflop", 2, "check"), A("flop", 1, "check"), A("flop", 2, "check"), A("flop", 3, "check"), A("turn", 1, "check"), A("turn", 2, "check"), A("turn", 3, "check"), A("river", 1, "check"), A("river", 2, "check"), A("river", 3, "check")];
    const h = mk({ stacks: [100, 100, 100], button: 3, bb: 2, sb: 1, ante: 1, actions: acts, board: { flop: ["As", "Ks", "Qs"], turn: "Js", river: "Ts" }, showdown: [{ seat: 1, cards: ["2c", "3d"] }, { seat: 2, cards: ["4c", "5d"] }, { seat: 3, cards: ["6c", "7d"] }], complete: true });
    const r = replay(h);
    expect(errors(r)).toEqual([]);
    const o = computeOutcome(h, r);
    expect(o.known).toBe(true);
    expect(o.finalStacks.map((s) => s.stack)).toEqual([100, 100, 100]); // 보드 로열 플러시 → 셋이 나눔
    expect(o.conservation?.ok).toBe(true);
  });
  it("나누어 떨어지지 않는 칩은 버튼 왼쪽부터 준다", () => {
    // SB 1 폴드, BTN·BB 가 2씩 → 팟 5칩을 둘이 나눔. 버튼 왼쪽(SB 는 폴드)의 첫 승자인 BB 가 3칩
    const acts = [A("preflop", 3, "call"), A("preflop", 1, "fold"), A("preflop", 2, "check"), A("flop", 2, "check"), A("flop", 3, "check"), A("turn", 2, "check"), A("turn", 3, "check"), A("river", 2, "check"), A("river", 3, "check")];
    const h = mk({ stacks: [100, 100, 100], button: 3, bb: 2, sb: 1, actions: acts, board: { flop: ["As", "Ks", "Qs"], turn: "Js", river: "Ts" }, showdown: [{ seat: 2, cards: ["4c", "5d"] }, { seat: 3, cards: ["6c", "7d"] }], complete: true });
    const r = replay(h);
    expect(errors(r)).toEqual([]);
    const o = computeOutcome(h, r);
    expect(o.conservation?.ok).toBe(true);
    expect(o.awards.reduce((a, x) => a + x.amount, 0)).toBe(5);
    expect(o.awards.find((x) => x.seat === 2)!.amount).toBe(3);
    expect(o.awards.find((x) => x.seat === 3)!.amount).toBe(2);
  });
  it("완료 핸드로 표시됐는데 액션이 남으면 오류", () => {
    const r = replay(mk({ stacks: [100, 100], button: 1, actions: [A("preflop", 1, "call")], complete: true }));
    expect(errors(r)[0].code).toBe("not-finished");
  });
  it("milli 로 바꿔도 금액이 정확하다", () => {
    expect(toMilli(0.125)).toBe(125);
    expect(toMilli(2.2)).toBe(2200);
  });
});

describe("체크·벳 구분과 스냅샷", () => {
  it("콜할 금액이 있는데 체크하면 오류, 베팅이 있는데 벳이면 오류", () => {
    const r = replay(mk({ stacks: [100, 100], button: 1, actions: [A("preflop", 1, "check")] }));
    expect(errors(r)[0].code).toBe("check-facing");
    const r2 = replay(mk({ stacks: [100, 100], button: 1, actions: [A("preflop", 1, "bet", { to: 6 })] }));
    expect(errors(r2)[0].code).toBe("bet-facing");
  });
  it("스냅샷 팟·추가 콜·스택을 재구성 결과와 대조한다", () => {
    const h = mk({ stacks: [100, 100, 100], button: 3, actions: [A("preflop", 3, "raise", { to: 6 }), A("preflop", 1, "fold")] });
    h.snapshots = [{ beforeAction: 2, pot: 9, toCall: 4, stacks: { "2": 98, "3": 90 } }];
    const r = replay(h);
    const bad = r.snapshotChecks.filter((c) => !c.ok);
    expect(r.snapshotChecks.length).toBe(4);
    expect(bad.map((c) => c.field)).toEqual(["BTN(3번) 남은 스택"]); // 실제는 94
  });
});
