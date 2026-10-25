// 브라우저 Web Worker 용 하위 솔버 진입점
import { serveSubRequests } from "../engine/parallel";

const ctx = self as unknown as { postMessage(m: unknown): void; onmessage: ((e: MessageEvent) => void) | null };
serveSubRequests(
  (m) => ctx.postMessage(m),
  (h) => {
    ctx.onmessage = (e: MessageEvent) => h(e.data);
  }
);
