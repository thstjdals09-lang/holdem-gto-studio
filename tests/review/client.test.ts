import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ReviewClient, cacheKey, type WorkerLike } from "../../src/review/client";
import { validateHand } from "../../src/review/hand-history";
import { DEFAULT_OPTIONS, type HandRecord } from "../../src/review/types";
import { createHandler, type ReviewReq, type ReviewRes } from "../../src/review/worker";

const ex = (n: string): HandRecord => validateHand(JSON.parse(readFileSync(`examples/review/${n}.json`, "utf8"))).hand!;
const fetchText = async (url: string) => readFileSync(url, "utf8");

/** 실제 처리기를 쓰되, 응답을 붙잡아 두었다가 원하는 순서로 내보낼 수 있는 가짜 워커 */
function fakeWorker(hold = false) {
  const sent: ReviewReq[] = [];
  const held: ReviewRes[] = [];
  const w: WorkerLike & { sent: ReviewReq[]; held: ReviewRes[]; flush: (pred?: (m: ReviewRes) => boolean) => void } = {
    sent,
    held,
    onmessage: null,
    postMessage(msg) {
      sent.push(msg);
      void handler(msg);
    },
    flush(pred = () => true) {
      for (const m of held.splice(0).filter(pred)) w.onmessage?.({ data: m });
    }
  };
  const handler = createHandler(fetchText, (m) => (hold ? held.push(m) : w.onmessage?.({ data: m })));
  return w;
}
const until = async (cond: () => boolean) => {
  for (let i = 0; i < 2000 && !cond(); i++) await new Promise((r) => setTimeout(r, 5));
};

describe("워커 취소·늦은 응답·캐시", () => {
  it("다른 핸드를 고르면 이전 작업의 늦은 응답은 버린다", async () => {
    const w = fakeWorker(true);
    const c = new ReviewClient(() => w, "public/lib/preflop/");
    const a = c.analyze(ex("ex-library-25bb"), DEFAULT_OPTIONS);
    await until(() => w.sent.length >= 1);
    const b = c.analyze(ex("ex-aa-bb160-fold"), DEFAULT_OPTIONS);
    expect(await a.result).toEqual({ status: "cancelled" });
    await until(() => w.held.filter((m) => m.type !== "progress").length >= 2);
    w.flush(); // 앞 작업 응답이 먼저 와도
    const rb = await b.result;
    expect(rb.status).toBe("done");
    if (rb.status === "done") expect(rb.report.handId).toBe("ex-aa-bb160-fold");
    expect(w.sent.some((m) => m.type === "cancel" && m.jobId === a.jobId)).toBe(true);
  }, 60000);
  it("계산 중 취소하면 처리기가 양보 지점에서 멈추고 'cancelled' 를 보낸다", async () => {
    const out: ReviewRes[] = [];
    const handle = createHandler(fetchText, (m) => out.push(m));
    const hand = ex("ex-k4o-filled");
    const p = handle({ type: "analyze", jobId: 7, hand, options: { ...DEFAULT_OPTIONS, samples: 2_000_000 }, libBase: "public/lib/preflop/" });
    await new Promise((r) => setTimeout(r, 30));
    await handle({ type: "cancel", jobId: 7 });
    await p;
    expect(out.at(-1)).toEqual({ type: "cancelled", jobId: 7 });
  }, 60000);
  it("같은 입력은 캐시에서, 시드·스택·범위가 바뀌면 다시 계산한다", async () => {
    const w = fakeWorker(false);
    const c = new ReviewClient(() => w, "public/lib/preflop/");
    const h = ex("ex-aa-bb160-fold");
    const r1 = await c.analyze(h, DEFAULT_OPTIONS).result;
    const r2 = await c.analyze(h, DEFAULT_OPTIONS).result;
    expect(r1.status === "done" && !r1.cached).toBe(true);
    expect(r2.status === "done" && r2.cached).toBe(true);
    expect(w.sent.filter((m) => m.type === "analyze")).toHaveLength(1);
    const k0 = await cacheKey(h, DEFAULT_OPTIONS);
    const seed = await cacheKey(h, { ...DEFAULT_OPTIONS, seed: 2 });
    const stack = await cacheKey({ ...h, seats: h.seats.map((s, i) => (i === 0 ? { ...s, stack: 4021 } : s)) }, DEFAULT_OPTIONS);
    const range = await cacheKey({ ...h, assumptions: { ranges: { "1": "AA" } } }, DEFAULT_OPTIONS);
    const pay = await cacheKey({ ...h, tournament: { kind: "standard", payouts: [10], otherStacks: [] } }, DEFAULT_OPTIONS);
    expect(new Set([k0, seed, stack, range, pay]).size).toBe(5);
  }, 60000);
  it("명시적 취소 뒤 도착한 응답은 버린다", async () => {
    const w = fakeWorker(true);
    const c = new ReviewClient(() => w, "public/lib/preflop/");
    const a = c.analyze(ex("ex-aa-bb160-fold"), DEFAULT_OPTIONS);
    await until(() => w.sent.length >= 1);
    c.cancel();
    expect(await a.result).toEqual({ status: "cancelled" });
    await until(() => w.held.some((m) => m.type === "result" || m.type === "cancelled"));
    w.flush();
    expect(c.currentJob).toBeNull();
  }, 60000);
});
