// SDK 공개 API (sdk/src) — 로컬 라이브러리 파일로 검증
import { describe, it, expect } from "vitest";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { GtoLibrary, createSolve, estimateSolve, LocalSubPort, parseCard, type PathStep } from "../sdk/src/index";
import { fileFetch } from "../sdk/src/node";
import { SAMPLE_HANDS_MTT } from "../src/lib/sampleHands";

const base = pathToFileURL(resolve("public/lib")).href + "/";
const hasLib = existsSync("public/lib/preflop/mtt8-40.json") && existsSync("public/lib/postflop/m40-btn-bb/index.json");

describe.skipIf(!hasLib)("GtoLibrary", () => {
  const lib = new GtoLibrary({ baseUrl: base, fetch: fileFetch });

  it("포맷·매치업 목록", () => {
    expect(lib.formats().map((f) => f.id)).toContain("mtt8-40");
    expect(lib.matchups().some((m) => m.id === "m40-btn-bb")).toBe(true);
  });

  it("프리플랍 노드: UTG 오픈 빈도와 핸드별 전략", async () => {
    const v = await lib.preflopNode("mtt8-40", []);
    expect(v.kind).toBe("decision");
    expect(v.position).toBe("UTG");
    const open = v.actions!.find((a) => a.type === "raise")!;
    expect(open.freq).toBeGreaterThan(0.12);
    expect(open.freq).toBeLessThan(0.26);
    const aa = v.hands!.find((h) => h.hand === "AA")!;
    expect(aa.freq.reduce((s, x) => s + x, 0)).toBeCloseTo(1, 2);
    expect(v.ranges.UTG.length).toBe(169);
  });

  it("플랍 터미널은 라이브러리 매치업을 알려 준다", async () => {
    const v = await lib.preflopNode("mtt8-40", ["F", "F", "F", "F", "F", "R2.2", "F", "C"]);
    expect(v.kind).toBe("terminal");
    expect(v.matchup?.id).toBe("m40-btn-bb");
  });

  it("포스트플랍 스팟: 플랍 루트 → 턴 노드", async () => {
    const flops = await lib.flops("m40-btn-bb");
    expect(flops.length).toBeGreaterThan(10);
    const spot = await lib.spot("m40-btn-bb", "Ks7d2c");
    const root = await spot.view([]);
    expect(root.kind).toBe("decision");
  }, 60000);

  it("핸드 히스토리 분석 (토너먼트 예시)", async () => {
    const r = await lib.analyzeHands(SAMPLE_HANDS_MTT);
    expect(r.hands.length).toBe(7);
    const h1 = r.hands[0];
    expect(h1.format).toBe("mtt8-40");
    expect(h1.analysis.decisions.some((d) => d.street !== "preflop")).toBe(true);
    expect(r.hands[5].format).toBe("mtt8-15");
  }, 120000);
});

describe("createSolve", () => {
  const river = { board: "Kh7s2d9cJs", pot: 10, stack: 30, oopRange: "AA,KK,QQ,AK,KQ,J9s,T8s,65s", ipRange: "JJ,TT,99,AK,KJ,QJs,A5s" };

  it("메모리 상한을 넘는 트리는 솔브 전에 막는다", async () => {
    const wide = "22+,A2+,K2+,Q2+,J2+,T2+,92+,82+,72+,62+,52+,42+,32";
    await expect(createSolve({ board: "Ks7d2c", pot: 6, stack: 38, oopRange: wide, ipRange: wide, preset: "complex" })).rejects.toThrow(/상한/);
  });

  it("크기 추정", () => {
    const e = estimateSolve({ ...river, preset: "standard" });
    expect(e.decisionNodes).toBeGreaterThan(3);
    expect(e.hands).toBeGreaterThan(50);
  });

  it("리버 단일 스레드: 목표까지 수렴하고 노드를 본다", async () => {
    const s = await createSolve({ ...river, preset: "standard" });
    expect(s.threads).toBe(1);
    const m = await s.run({ targetExploitability: 0.5, maxIterations: 400 });
    expect(m.exploitabilityPct).toBeLessThan(0.5);
    const v = await s.view([]);
    expect(v.node.kind).toBe("decision");
    expect(v.analysis!.actionFreq.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 3);
    // 잠금: OOP 항상 체크
    const A = v.node.actions!.length;
    const freqs = v.node.actions!.map((a) => (a.type === "check" ? 1 : 0));
    await s.lock([], freqs);
    await s.run({ targetExploitability: 0.5, maxIterations: 800 });
    const v2 = await s.view([]);
    const chk = v2.node.actions!.findIndex((a) => a.type === "check");
    expect(v2.analysis!.actionFreq[chk]).toBeCloseTo(1, 5);
    expect(A).toBe(v2.node.actions!.length);
    // 저장 → 다른 세션에 불러오기
    const data = await s.exportStrategy();
    const s2 = await createSolve({ ...river, preset: "standard" });
    await s2.importStrategy(data, s.iterations);
    const v3 = await s2.view([]);
    expect(v3.analysis!.actionFreq[chk]).toBeCloseTo(1, 5);
    s.close();
    s2.close();
  }, 120000);

  it("턴 병렬 세션 (같은 스레드 통로 2개)", async () => {
    const s = await createSolve({ board: "Kh7s2d9c", pot: 10, stack: 30, oopRange: "AA,KK,AK,KQ,T8s,65s", ipRange: "QQ,JJ,AK,KJ,A5s", ports: [new LocalSubPort(), new LocalSubPort()] });
    expect(s.threads).toBe(2);
    const m = await s.run({ targetExploitability: 1, maxIterations: 60, checkEvery: 20 });
    expect(m.exploitabilityPct).toBeLessThan(5);
    const root = await s.view([]);
    const x = root.node.actions!.findIndex((a) => a.type === "check");
    const ipv = await s.view([{ kind: "action", index: x }]);
    const x2 = ipv.node.actions!.findIndex((a) => a.type === "check");
    const path: PathStep[] = [{ kind: "action", index: x }, { kind: "action", index: x2 }, { kind: "card", card: parseCard("3h") }];
    const rv = await s.view(path);
    expect(rv.node.kind).toBe("decision");
    expect(rv.node.board.length).toBe(5);
    s.close();
  }, 120000);
});
