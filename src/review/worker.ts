// 무거운 계산(자료 읽기·열거·표본·ICM)을 화면과 분리한다. 작업마다 jobId 가 있고, cancel 을 받으면 다음 양보 지점에서 멈춘다.
import { Cancelled } from "./allin-ev";
import { analyzeHand } from "./review-report";
import { loadLibraryFromText, type LoadedLibrary } from "./strategy-provider";
import type { AnalyzeOptions, HandRecord, HandReport } from "./types";

export type ReviewReq = { type: "analyze"; jobId: number; hand: HandRecord; options: AnalyzeOptions; libBase: string } | { type: "cancel"; jobId: number };
export type ReviewRes =
  | { type: "progress"; jobId: number; done: number; total: number }
  | { type: "result"; jobId: number; report: HandReport }
  | { type: "cancelled"; jobId: number }
  | { type: "error"; jobId: number; message: string };

export type Fetcher = (url: string) => Promise<string>;

export function createHandler(fetchText: Fetcher, post: (m: ReviewRes) => void) {
  const libs = new Map<string, Promise<LoadedLibrary>>();
  const jobs = new Map<number, { cancelled: boolean }>();
  const tick = () => new Promise<void>((r) => setTimeout(r, 0));
  return async (msg: ReviewReq) => {
    if (msg.type === "cancel") {
      const j = jobs.get(msg.jobId);
      if (j) j.cancelled = true;
      return;
    }
    const signal = { cancelled: false };
    jobs.set(msg.jobId, signal);
    const loadLibrary = (id: string) => {
      if (!/^[a-z0-9-]{1,20}$/.test(id)) return Promise.reject(new Error("잘못된 자료 이름"));
      if (!libs.has(id)) {
        const p = fetchText(`${msg.libBase}${id}.json`).then((t) => loadLibraryFromText(id, t));
        p.catch(() => libs.delete(id)); // 실패한 읽기는 다음에 다시 시도
        libs.set(id, p);
      }
      return libs.get(id)!;
    };
    try {
      const report = await analyzeHand(msg.hand, msg.options, { loadLibrary, signal, tick, onProgress: (done, total) => post({ type: "progress", jobId: msg.jobId, done, total }) });
      post(signal.cancelled ? { type: "cancelled", jobId: msg.jobId } : { type: "result", jobId: msg.jobId, report });
    } catch (e) {
      post(e instanceof Cancelled ? { type: "cancelled", jobId: msg.jobId } : { type: "error", jobId: msg.jobId, message: (e as Error).message });
    } finally {
      jobs.delete(msg.jobId);
    }
  };
}

// 브라우저 워커 진입점 (Node 테스트에서는 createHandler 만 쓴다)
declare const self: { postMessage?: (m: unknown) => void; onmessage?: unknown; location?: { origin: string } } | undefined;
if (typeof self !== "undefined" && typeof self.postMessage === "function" && typeof window === "undefined") {
  const ws = self as { postMessage: (m: unknown) => void; onmessage: unknown; location: { origin: string } };
  const handle = createHandler(
    async (url) => {
      if (new URL(url).origin !== ws.location.origin) throw new Error("다른 출처의 자료는 읽지 않습니다");
      const r = await fetch(url);
      if (!r.ok) throw new Error(`자료를 읽지 못했습니다 (${r.status})`);
      return r.text();
    },
    (m) => ws.postMessage(m)
  );
  ws.onmessage = (ev: { data: ReviewReq }) => void handle(ev.data);
}
