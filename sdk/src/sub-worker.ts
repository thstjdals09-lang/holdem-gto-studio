// 브라우저 하위 솔버 워커 (dist/gto-sub-worker.js)
import { serveSubRequests } from "../../src/engine/parallel";

const g = self as unknown as { postMessage(m: unknown): void; onmessage: ((e: MessageEvent) => void) | null };
serveSubRequests(
  (m) => g.postMessage(m),
  (h) => {
    g.onmessage = (e: MessageEvent) => h(e.data);
  }
);
