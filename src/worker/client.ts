// 워커 RPC 클라이언트 (단일 워커, 요청 id 기반)
import type { Envelope, Req, Res, SolveProgress } from "./protocol";

type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void; onProgress?: (p: SolveProgress) => void };

class SolverClient {
  private worker: Worker;
  private nextId = 1;
  private pending = new Map<number, Pending>();

  constructor() {
    this.worker = new Worker(new URL("./solver.worker.ts", import.meta.url), { type: "module" });
    this.worker.onmessage = (ev: MessageEvent<Envelope<Res>>) => {
      const { id, payload } = ev.data;
      const p = this.pending.get(id);
      if (!p) return;
      if (payload.type === "progress") {
        p.onProgress?.(payload.data);
        return;
      }
      this.pending.delete(id);
      if (payload.type === "error") p.reject(new Error(payload.message));
      else p.resolve(payload.data);
    };
    this.worker.onerror = (e) => {
      for (const p of this.pending.values()) p.reject(new Error(e.message || "워커 오류"));
      this.pending.clear();
    };
  }

  call<T>(req: Req, onProgress?: (p: SolveProgress) => void, transfer?: Transferable[]): Promise<T> {
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, onProgress });
      this.worker.postMessage({ id, payload: req } satisfies Envelope<Req>, transfer ?? []);
    });
  }

  /** 진행 중인 솔브 중단 (별 id로 전송) */
  stop(): Promise<boolean> {
    return this.call<boolean>({ type: "solve.stop" });
  }

  restart() {
    this.worker.terminate();
    for (const p of this.pending.values()) p.reject(new Error("워커 재시작"));
    this.pending.clear();
    this.worker = new Worker(new URL("./solver.worker.ts", import.meta.url), { type: "module" });
  }
}

export const solverClient = new SolverClient();
/** 트레이너·계산기용 별도 워커 (스터디 솔버와 분리) */
export const auxClient = new SolverClient();
