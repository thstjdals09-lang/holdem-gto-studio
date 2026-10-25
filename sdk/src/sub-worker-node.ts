// Node 하위 솔버 워커 (dist/gto-sub-worker-node.js)
import { parentPort } from "node:worker_threads";
import { serveSubRequests } from "../../src/engine/parallel";

if (!parentPort) throw new Error("worker_threads 안에서만 실행합니다");
const port = parentPort;
serveSubRequests(
  (m) => port.postMessage(m),
  (h) => port.on("message", h)
);
