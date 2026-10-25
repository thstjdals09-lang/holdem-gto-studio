// Node 에서 병렬 솔버 하위 워커를 띄우는 도우미
import { Worker } from "node:worker_threads";
import { availableParallelism } from "node:os";
import { MessageSubPort, type SubPort } from "../engine/parallel";

/** workerFile: 묶은 하위 워커 스크립트 경로(.mjs). count 를 생략하면 코어 수 − 1 */
export function nodeSubPorts(workerFile: string | URL, count = Math.max(1, availableParallelism() - 1), resourceLimits?: { maxOldGenerationSizeMb?: number }): SubPort[] {
  return Array.from({ length: count }, () => {
    const w = new Worker(workerFile, { resourceLimits });
    return new MessageSubPort({
      postMessage: (m) => w.postMessage(m),
      listen: (h) => {
        w.on("message", h);
      },
      terminate: () => {
        void w.terminate();
      }
    });
  });
}
