import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { validateHand } from "../../src/review/hand-history";
import { aggregate, analyzeHand } from "../../src/review/review-report";
import { loadLibraryFromText, type LibraryLoader } from "../../src/review/strategy-provider";
import { DEFAULT_OPTIONS, type HandRecord, type HandReport } from "../../src/review/types";

const libs = new Map<string, ReturnType<typeof loadLibraryFromText>>();
const loader: LibraryLoader = (id) => {
  if (!libs.has(id)) libs.set(id, loadLibraryFromText(id, readFileSync(`public/lib/preflop/${id}.json`, "utf8")));
  return libs.get(id)!;
};
const deps = { loadLibrary: loader };
const ex = (name: string): HandRecord => {
  const v = validateHand(JSON.parse(readFileSync(`examples/review/${name}.json`, "utf8")));
  if (!v.hand) throw new Error(JSON.stringify(v.issues));
  return v.hand;
};
const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x));
const opts = { ...DEFAULT_OPTIONS, samples: 6000 };
const run = (h: HandRecord) => analyzeHand(h, opts, deps);
/** 판단 비교용: 시간·해시 외 내용 */
const core = (r: HandReport, i: number) => {
  const d = r.decisions[i];
  return { viewHash: d.viewHash, options: d.options, verdict: d.verdict, status: d.status, ranges: d.ranges, icm: d.icm };
};

describe("자료와 조건이 정확히 같은 핸드 (mtt8-25)", () => {
  it("오픈과 올인 콜을 자료로 분석하고, 졌다고 판단을 실수로 만들지 않는다", async () => {
    const r = await run(ex("ex-library-25bb"));
    expect(r.replay.ok).toBe(true);
    expect(r.decisions).toHaveLength(2);
    const [open, call] = r.decisions;
    expect(open.status).toBe("analyzed");
    expect(open.method).toBe("preflop-library");
    expect(open.data?.formatId).toBe("mtt8-25");
    expect(open.data?.manifestMatch).toBe(true);
    expect(open.options.find((o) => o.isActual)?.label).toBe("오픈 2");
    expect(open.verdict.kind).toBe("best");
    expect(call.status).toBe("analyzed");
    expect(call.options.find((o) => o.isActual)?.type).toBe("call");
    expect(call.verdict.kind).toBe("best");
    expect(call.quality.notes.join()).toContain("교차 확인");
    // 상대(BB)의 범위는 자료의 'BB 올인' 빈도로 좁혀졌다
    const bb = call.ranges.find((t) => t.position === "BB")!;
    expect(bb.source).toBe("library");
    expect(bb.steps.at(-1)!.label).toContain("올인");
    expect(bb.steps.at(-1)!.massAfter).toBeLessThan(bb.steps.at(-1)!.massBefore);
    // 사후 결과: QQ 에 져서 25.125BB 를 잃었지만 판단 결과는 그대로
    expect(r.outcome.known).toBe(true);
    expect(r.outcome.heroNet).toBeCloseTo(-25.125, 9);
    expect(r.outcome.conservation?.ok).toBe(true);
  });
});

describe("사용자 사례 3: AA 가 BB 160 을 낸 뒤 목표 320 레이즈에 폴드", () => {
  it("추가 콜 160 과 목표 320 을 구분하고, 같은 조건의 자료로 폴드의 EV 차이를 보여 준다", async () => {
    const r = await run(ex("ex-aa-bb160-fold"));
    expect(r.replay.snapshotChecks.every((c) => c.ok)).toBe(true);
    const d = r.decisions[0];
    expect(d.legal?.toCall).toBe(160);
    expect(d.legal?.minTo).toBe(480);
    expect(d.status).toBe("analyzed");
    expect(d.actual?.type).toBe("fold");
    const best = d.options.reduce((b, o) => ((o.ev ?? -1e9) > (b.ev ?? -1e9) ? o : b));
    expect(best.type).toBe("allin");
    expect(d.verdict.kind).toBe("ev-loss");
    expect(d.verdict.evLoss).toBeCloseTo(best.ev!, 9); // 폴드 EV = 0 기준
    expect(d.categories).toContain("ev");
  });
  it("콜 금액을 320 으로 잘못 읽은 기록은 금액 오류로 막고 전략 판단을 내지 않는다", async () => {
    const h = clone(ex("ex-aa-bb160-fold"));
    h.actions[7] = { street: "preflop", seat: 8, type: "call", add: 320 };
    const r = await run(h);
    expect(r.replay.ok).toBe(false);
    expect(r.issues.find((i) => i.severity === "error")?.code).toBe("call-add");
    expect(r.decisions.every((x) => x.verdict.kind === "unknown")).toBe(true);
  });
});

describe("사용자 사례 1: K4o 약 129BB 추가 올인 콜", () => {
  it("부분 기록은 초기 스택·블라인드가 없어 판단을 내지 않는다", async () => {
    const r = await run(ex("ex-k4o-partial"));
    expect(r.replay.ok).toBe(false);
    expect(r.issues.some((i) => i.category === "missing" && i.code === "stack-unknown")).toBe(true);
    expect(r.decisions).toHaveLength(0);
  });
  it("범위 출처가 없으면 무작위 범위로 대신하지 않고 미지원", async () => {
    const h = clone(ex("ex-k4o-filled"));
    delete h.assumptions;
    const r = await run(h);
    const d = r.decisions[0];
    expect(d.legal?.callAdd).toBe(128.875);
    expect(d.status).toBe("unsupported");
    expect(d.options).toHaveLength(0);
    expect(d.categories).toContain("range");
    expect(d.categories).toContain("data"); // 스택이 달라 자료와 조건 불일치
    expect(d.unsupportedReasons.join()).toContain("무작위");
    expect(r.replay.refunds).toEqual([{ seat: 7, amount: 10, street: "preflop" }]);
  });
  it("사용자 가정 범위를 넣으면 '근사'로 콜 EV 를 계산하고, 사후 공개 A7o 는 판단에 영향이 없다", async () => {
    const h = ex("ex-k4o-filled");
    const r = await run(h);
    const d = r.decisions[0];
    expect(d.status).toBe("approximate");
    expect(d.method).toBe("allin-closed");
    expect(d.ranges[0].source).toBe("user");
    expect(d.options.find((o) => o.type === "call")?.evSe).toBeGreaterThan(0);
    const noShow = clone(h);
    delete noShow.showdown;
    noShow.board = { flop: ["2c", "3c", "4c"], turn: "5c", river: "6c" }; // 런아웃을 바꿔도
    const r2 = await run(noShow);
    expect(core(r2, 0)).toEqual(core(r, 0));
  });
});

describe("사용자 사례 2: A2 새틀라이트 리버 큰 베팅 콜", () => {
  it("부분 기록(블라인드 없음)은 ICM·GTO 결론을 내지 않는다", async () => {
    const r = await run(ex("ex-a2-satellite-partial"));
    expect(r.replay.ok).toBe(false);
    expect(r.decisions).toHaveLength(0);
  });
  it("보완 기록: 리버 콜은 사용자 범위로 칩 EV 와 새틀라이트 ICM 을 따로 보여 준다", async () => {
    const r = await run(ex("ex-a2-satellite-filled"));
    expect(r.replay.ok).toBe(true);
    expect(r.replay.snapshotChecks.every((c) => c.ok)).toBe(true); // 팟 7,908 · 콜 4,570
    const river = r.decisions.at(-1)!;
    expect(river.street).toBe("river");
    expect(river.metrics.pot).toBe(7908);
    expect(river.legal?.toCall).toBe(4570);
    expect(river.status).toBe("approximate");
    expect(river.icm?.method).toBe("exact");
    expect(river.icm?.fieldSize).toBe(10);
    expect(river.icm?.prizePool).toBe(300);
    expect(river.icm?.scenarios.length).toBeGreaterThanOrEqual(2);
    expect(river.icm?.assumptions.join()).toContain("균형 전략 해가 아닙니다");
    // 앞의 결정들은 포스트플랍 풀이가 없어 미지원으로 이유와 함께
    const turnCall = r.decisions.find((x) => x.street === "turn" && x.actual?.type === "call")!;
    expect(turnCall.status).toBe("unsupported");
    expect(turnCall.unsupportedReasons.join()).toContain("포스트플랍");
  });
  it("지급 구조가 없으면 ICM 을 계산하지 않고 칩 EV 만 둔다", async () => {
    const h = clone(ex("ex-a2-satellite-filled"));
    delete h.tournament;
    const r = await run(h);
    const river = r.decisions.at(-1)!;
    expect(river.icm).toBeUndefined();
    expect(river.icmUnavailable).toContain("전체 필드");
  });
});

describe("미래 정보 차단", () => {
  it("판단 보기에는 그 스트리트까지의 보드만 있다", async () => {
    const r = await run(ex("ex-a2-satellite-filled"));
    for (const d of r.decisions) expect(d.board.length).toBe({ preflop: 0, flop: 3, turn: 4, river: 5 }[d.street]);
    expect(r.decisions.find((d) => d.street === "turn")!.board).not.toContain("9s");
  });
  it("이후 액션·보드·쇼다운·결과를 바꿔도 앞선 판단은 같다", async () => {
    const h = ex("ex-a2-satellite-filled");
    const r = await run(h);
    const changed = clone(h);
    changed.board.river = "2c"; // 리버 카드
    changed.showdown = [{ seat: 3, cards: ["Kh", "Kd"] }];
    changed.actions = changed.actions.slice(0, 11); // 리버 액션 제거 → 기록이 리버 첫 차례(내 차례)에서 끝남
    changed.complete = false;
    const r2 = await run(changed);
    const turnIdx = r.decisions.findIndex((d) => d.street === "turn" && d.actual?.type === "call");
    for (let i = 0; i <= turnIdx; i++) expect(core(r2, i)).toEqual(core(r, i));
    // 잘린 기록의 마지막은 '실제 행동 없음' 판단
    expect(r2.decisions.at(-1)!.actual).toBeNull();
  });
});

describe("집계", () => {
  it("핸드 상태와 오류 유형을 따로 센다", async () => {
    const names = ["ex-library-25bb", "ex-aa-bb160-fold", "ex-k4o-partial", "ex-k4o-filled", "ex-a2-satellite-partial", "ex-a2-satellite-filled"];
    const reports = await Promise.all(names.map((n) => run(ex(n))));
    const a = aggregate(reports);
    expect(a.hands).toBe(6);
    expect(a.handsAnalyzed).toBe(2); // 자료와 정확히 맞는 두 핸드
    expect(a.handsApproximate).toBe(1); // K4o 보완 (사용자 범위)
    expect(a.handsUnsupported).toBe(1); // A2 보완: 포스트플랍 결정이 미지원
    expect(a.handsInvalid).toBe(2); // 부분 기록 둘
    expect(a.handsAnalyzed + a.handsApproximate + a.handsUnsupported + a.handsInvalid + a.handsNoDecision).toBe(a.hands);
    const cat = Object.fromEntries(a.categories.map((c) => [c.key, c]));
    expect(cat.missing.hands).toBe(2);
    expect(cat.ev.decisions).toBeGreaterThanOrEqual(1);
    // 단위가 다른 손실은 BB 로 바꿔 정렬하고, 모델 이름을 같이 남긴다 (더하지 않음)
    expect(a.evLosses.map((x) => x.handId)).toContain("ex-aa-bb160-fold");
    for (let i = 1; i < a.evLosses.length; i++) expect(a.evLosses[i - 1].evLossBb!).toBeGreaterThanOrEqual(a.evLosses[i].evLossBb!);
    expect(a.evLosses.find((x) => x.handId === "ex-aa-bb160-fold")!.model).toBe("자료 mtt8-25");
    expect(a.byStatus.analyzed + a.byStatus.approximate + a.byStatus.unsupported + a.byStatus.invalid).toBe(a.decisions);
  });
});
