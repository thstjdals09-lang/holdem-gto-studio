// 브라우저: Web Worker 로 병렬 하위 솔버를 띄운다
import { MessageSubPort, type SubPort } from "../../src/engine/parallel";

/**
 * workerUrl: SDK 의 dist/gto-sub-worker.js 를 앱에서 서비스하는 주소.
 * count 를 생략하면 (논리 코어 수 − 1), 최소 1.
 * 반환된 통로를 createSolve({ ports }) 에 넘긴다. 세션을 close() 하면 워커도 끝난다.
 */
export function browserSubPorts(workerUrl: string | URL, count?: number): SubPort[] {
  const hc = typeof navigator !== "undefined" && navigator.hardwareConcurrency ? navigator.hardwareConcurrency : 4;
  const k = Math.max(1, count ?? hc - 1);
  return Array.from({ length: k }, () => {
    const w = new Worker(workerUrl, { type: "module" });
    return new MessageSubPort({
      postMessage: (m) => w.postMessage(m),
      listen: (h) => w.addEventListener("message", (e) => h((e as MessageEvent).data)),
      terminate: () => w.terminate()
    });
  });
}
