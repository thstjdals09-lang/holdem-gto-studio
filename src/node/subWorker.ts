// Node worker_threads 용 하위 솔버 진입점 (esbuild 로 묶어 Worker 파일로 쓴다)
import { parentPort } from "node:worker_threads";
import { serveSubRequests } from "../engine/parallel";

if (!parentPort) throw new Error("worker_threads 안에서만 실행합니다");
const port = parentPort;
serveSubRequests(
  (m) => port.postMessage(m),
  (h) => port.on("message", h)
);
