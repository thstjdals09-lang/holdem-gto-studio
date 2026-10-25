import { describe, it, expect } from "vitest";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { NUM_CLASSES, cardToString, parseCards } from "../src/engine/cards";
import { parseAll } from "../src/lib/hh";
import { analyzePreflop, matchFlop } from "../src/lib/analyze";
import { SAMPLE_HANDS } from "../src/lib/sampleHands";
import { walkCodes, type PfLib } from "../src/lib/preflopLib";
import { FLOPS, MATCHUPS } from "../src/lib/postflopLib";
import { LibSpot } from "../src/worker/libspot";
import type { FlopMeta } from "../src/lib/postflopLib";

const cash: PfLib | null = existsSync("public/lib/preflop/cash6-100.json") ? JSON.parse(readFileSync("public/lib/preflop/cash6-100.json", "utf-8")) : null;

describe("핸드 히스토리 파서", () => {
  const { hands, skipped } = parseAll(SAMPLE_HANDS);
  it("예시 7핸드를 모두 읽는다", () => {
    expect(hands.length).toBe(7);
    expect(skipped).toBe(0);
  });
  it("자리·카드·순이익", () => {
    const h = hands[0];
    expect(h.hero).toBe("Hero");
    expect(h.seats.find((s) => s.name === "Hero")!.position).toBe("BTN");
    expect(h.heroCards!.map(cardToString).join("")).toBe("AhQd");
    expect(h.board.map(cardToString).join("")).toBe("Kh7s2d5c");
    expect(h.heroNet).toBeCloseTo(4.82, 2);
    expect(hands[2].seats.find((s) => s.name === "Hero")!.position).toBe("BB");
    expect(hands[3].seats.find((s) => s.name === "Hero")!.position).toBe("SB");
    expect(hands[4].heroNet).toBeCloseTo(-2.5, 2);
  });
  it("레이즈 금액은 스트리트 총액(to)으로 기록", () => {
    const pre = hands[0].streets.preflop;
    const r = pre.find((a) => a.player === "Hero")!;
    expect(r.type).toBe("raise");
    expect(r.to).toBeCloseTo(2.5, 2);
    const ck = hands[2].streets.flop.find((a) => a.player === "Hero" && a.type === "raise")!;
    expect(ck.amount).toBeCloseTo(7.3, 2);
  });
});

describe("수트 대칭 플랍 매칭", () => {
  it("Kh7s2d → Ks7d2c", () => {
    const m = matchFlop(parseCards("Kh7s2d"), FLOPS)!;
    expect(m.flop).toBe("Ks7d2c");
    expect(parseCards("Kh7s2d").map(m.map).map(cardToString).sort().join("")).toBe(parseCards("Ks7d2c").map(cardToString).sort().join(""));
  });
  it("랭크가 다르면 매칭 안 됨", () => {
    expect(matchFlop(parseCards("Kh8s2d"), ["Ks7d2c"])).toBeNull();
  });
  it("모노톤은 모노톤끼리", () => {
    expect(matchFlop(parseCards("Ac5cTc"), FLOPS)!.flop).toBe("AhTh5h");
  });
});

describe.skipIf(!cash)("프리플랍 라이브러리", () => {
  it("전략 합 = 1, EV 합 ≈ 0", () => {
    for (const n of cash!.nodes) {
      const A = n.a.length;
      for (let c = 0; c < NUM_CLASSES; c++) {
        let s = 0;
        for (let a = 0; a < A; a++) s += n.s[a * NUM_CLASSES + c];
        expect(Math.abs(s - 1000)).toBeLessThanOrEqual(A);
      }
    }
    const sum = cash!.ev.reduce((a, b) => a + b, 0);
    expect(Math.abs(sum)).toBeLessThan(0.1);
  });
  it("매치업 경로가 모두 플랍 터미널로 끝난다", () => {
    for (const m of MATCHUPS) {
      const path = `public/lib/preflop/${m.format}.json`;
      if (!existsSync(path)) continue;
      const lib: PfLib = JSON.parse(readFileSync(path, "utf-8"));
      const w = walkCodes(lib, m.codes);
      expect(w.terminal?.type).toBe("flop");
    }
  });
  it("예시 핸드 프리플랍 분석", () => {
    const { hands } = parseAll(SAMPLE_HANDS);
    const a1 = analyzePreflop(hands[0], cash!).analysis;
    expect(a1.inTree).toBe(true);
    expect(a1.decisions.length).toBe(1);
    expect(a1.matchup).toBeNull(); // 포스트플랍 라이브러리는 토너먼트 기준
    expect(a1.libFlop).toBeNull();
    const a2 = analyzePreflop(hands[1], cash!).analysis;
    expect(a2.decisions[0].chosen).toBe("폴드");
    expect(a2.decisions[0].verdict).toBe("correct");
    const a5 = analyzePreflop(hands[4], cash!).analysis; // BTN 72o 오픈 → 3벳에 폴드
    expect(a5.decisions.length).toBe(2);
    const a7 = analyzePreflop(hands[6], cash!).analysis; // BB 3벳 팟
    expect(a7.inTree).toBe(true);
  });
});

const flopDir = "public/lib/postflop/m40-btn-bb";
const readyFlop = existsSync(flopDir) ? readdirSync(flopDir).find((f: string) => existsSync(`${flopDir}/${f}/meta.json`)) : undefined;

describe.skipIf(!readyFlop)("포스트플랍 라이브러리 스팟", () => {
  it("플랍 루트·턴·리버 재솔브", async () => {
    const dir = `${flopDir}/${readyFlop}/`;
    const meta: FlopMeta = JSON.parse(readFileSync(dir + "meta.json", "utf-8"));
    const buf = readFileSync(dir + "flop.bin");
    const spot = new LibSpot(meta, buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), dir);
    // fetch 대체: 디스크에서 턴 파일 읽기
    (globalThis as any).fetch = async (url: string) => {
      const b = readFileSync(url);
      return { ok: true, headers: { get: () => "application/octet-stream" }, arrayBuffer: async () => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength), json: async () => JSON.parse(b.toString()) };
    };
    const root = await spot.view([]);
    expect(root.kind).toBe("decision");
    if (root.kind !== "decision") return;
    const fsum = root.actions.reduce((s, a) => s + a.freq, 0);
    expect(fsum).toBeCloseTo(1, 3);
    // 메타의 루트 통계와 일치
    root.actions.forEach((a, i) => expect(a.freq).toBeCloseTo(meta.root.oop[i].freq, 2));
    // 체크 → IP 체크 → 턴 카드 → 턴 노드
    const x = root.actions.findIndex((a) => a.type === "check");
    const ipv = await spot.view([{ kind: "action", index: x }]);
    expect(ipv.kind).toBe("decision");
    const ipx = (ipv as any).actions.findIndex((a: any) => a.type === "check");
    const turnCard = Array.from({ length: 52 }, (_, c) => c).find((c) => !meta.config.board.includes(c))!;
    const tv = await spot.view([{ kind: "action", index: x }, { kind: "action", index: ipx }, { kind: "card", card: turnCard }]);
    expect(tv.kind).toBe("decision");
    if (tv.kind !== "decision") return;
    expect(tv.street).toBe(2);
    expect(tv.actions.reduce((s, a) => s + a.freq, 0)).toBeCloseTo(1, 3);
    // 턴 체크-체크 → 리버 카드 → 리버 재솔브
    const tx = tv.actions.findIndex((a) => a.type === "check");
    const tv2 = (await spot.view([{ kind: "action", index: x }, { kind: "action", index: ipx }, { kind: "card", card: turnCard }, { kind: "action", index: tx }])) as any;
    const tx2 = tv2.actions.findIndex((a: any) => a.type === "check");
    const riverCard = Array.from({ length: 52 }, (_, c) => c).find((c) => !meta.config.board.includes(c) && c !== turnCard)!;
    const rv = await spot.view([{ kind: "action", index: x }, { kind: "action", index: ipx }, { kind: "card", card: turnCard }, { kind: "action", index: tx }, { kind: "action", index: tx2 }, { kind: "card", card: riverCard }]);
    expect(rv.kind).toBe("decision");
    expect(rv.river).toBeDefined();
    expect(rv.river!.exploitabilityPct).toBeLessThan(0.5);
  }, 120000);
});
