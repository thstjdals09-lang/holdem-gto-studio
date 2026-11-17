// 화면 쪽 워커 클라이언트: 한 번에 한 작업만 "현재"로 둔다. 새 작업을 시작하거나 취소하면 이전 작업의 늦은 응답은 버린다.
// 캐시 키 = 핸드 전체(카드·행동 경로·자리별 스택·블라인드/앤티·지급 구조·범위 가정) + 옵션(시드·표본) + 모델 버전 + 자료 해시
import { canonicalJson, sha256Hex } from "./hand-history";
import provenance from "./provenance.json";
import { REVIEW_VERSION, type AnalyzeOptions, type HandRecord, type HandReport } from "./types";
import type { ReviewReq, ReviewRes } from "./worker";

export interface WorkerLike {
  postMessage(msg: ReviewReq): void;
  onmessage: ((ev: { data: ReviewRes }) => void) | null;
  terminate?(): void;
}
export type AnalyzeOutcome = { status: "done"; report: HandReport; cached: boolean } | { status: "stale" } | { status: "cancelled" } | { status: "error"; message: string };

const DATA_KEY = canonicalJson(Object.entries((provenance as { files: Record<string, { sha256: string }> }).files).map(([k, v]) => [k, v.sha256]));

export async function cacheKey(hand: HandRecord, options: AnalyzeOptions): Promise<string> {
  return sha256Hex(canonicalJson({ hand, options, model: REVIEW_VERSION, data: DATA_KEY }));
}

export class ReviewClient {
  private nextId = 1;
  private current: number | null = null;
  private pending = new Map<number, { resolve: (o: AnalyzeOutcome) => void; onProgress?: (done: number, total: number) => void }>();
  private cache = new Map<string, HandReport>();
  private w: WorkerLike | null = null;
  constructor(private makeWorker: () => WorkerLike, private libBase: string, private maxCache = 200) {}

  private worker(): WorkerLike {
    if (!this.w) {
      this.w = this.makeWorker();
      this.w.onmessage = (ev) => this.onMessage(ev.data);
    }
    return this.w;
  }
  private onMessage(m: ReviewRes) {
    const p = this.pending.get(m.jobId);
    if (!p) return;
    if (m.type === "progress") {
      if (m.jobId === this.current) p.onProgress?.(m.done, m.total);
      return;
    }
    this.pending.delete(m.jobId);
    if (m.jobId !== this.current) return p.resolve({ status: "stale" });
    this.current = null;
    if (m.type === "result") p.resolve({ status: "done", report: m.report, cached: false });
    else if (m.type === "cancelled") p.resolve({ status: "cancelled" });
    else p.resolve({ status: "error", message: m.message });
  }
  get currentJob(): number | null {
    return this.current;
  }
  /** 새 분석을 시작한다. 진행 중이던 작업은 취소되고 그 결과는 'stale' 로 버려진다 */
  analyze(hand: HandRecord, options: AnalyzeOptions, onProgress?: (done: number, total: number) => void): { jobId: number; result: Promise<AnalyzeOutcome> } {
    this.cancel();
    const jobId = this.nextId++;
    this.current = jobId;
    const result = (async (): Promise<AnalyzeOutcome> => {
      const key = await cacheKey(hand, options);
      if (this.current !== jobId) return { status: "stale" };
      const hit = this.cache.get(key);
      if (hit) {
        this.current = null;
        return { status: "done", report: hit, cached: true };
      }
      const out = await new Promise<AnalyzeOutcome>((resolve) => {
        this.pending.set(jobId, { resolve, onProgress });
        this.worker().postMessage({ type: "analyze", jobId, hand, options, libBase: this.libBase });
      });
      if (out.status === "done") {
        if (this.cache.size >= this.maxCache) this.cache.delete(this.cache.keys().next().value!);
        this.cache.set(key, out.report);
      }
      return out;
    })();
    return { jobId, result };
  }
  /** 진행 중인 작업 취소. 그 작업의 응답은 화면에 쓰지 않는다 */
  cancel() {
    const id = this.current;
    if (id === null) return;
    this.current = null;
    this.w?.postMessage({ type: "cancel", jobId: id });
    const p = this.pending.get(id);
    if (p) {
      this.pending.delete(id);
      p.resolve({ status: "cancelled" });
    }
  }
  dispose() {
    this.cancel();
    this.w?.terminate?.();
    this.w = null;
  }
}
