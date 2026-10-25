// Node 전용 진입점: 공개 API 전부 + worker_threads 병렬 통로 + 로컬 파일 라이브러리
import { Worker } from "node:worker_threads";
import { availableParallelism } from "node:os";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { MessageSubPort, type SubPort } from "../../src/engine/parallel";
import type { LibraryFetch } from "../../src/worker/libspot";

export * from "./index";

/**
 * worker_threads 하위 솔버. count 를 생략하면 (코어 수 − 1).
 * workerFile 을 생략하면 이 파일 옆의 gto-sub-worker-node.js 를 쓴다.
 */
export function nodeSubPorts(count?: number, workerFile?: string | URL): SubPort[] {
  const file = workerFile ?? new URL("./gto-sub-worker-node.js", import.meta.url);
  const k = Math.max(1, count ?? availableParallelism() - 1);
  return Array.from({ length: k }, () => {
    const w = new Worker(file);
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

/**
 * 로컬 폴더(또는 file:// 주소)에 받아 둔 라이브러리를 읽는 fetch.
 * new GtoLibrary({ baseUrl: "file:///C:/data/lib/", fetch: fileFetch }) 처럼 쓴다. http(s) 주소는 전역 fetch 로 넘긴다.
 */
export const fileFetch: LibraryFetch = async (url: string) => {
  if (!url.startsWith("file:")) return fetch(url);
  try {
    const buf = await readFile(fileURLToPath(url));
    const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
    return {
      ok: true,
      headers: { get: (n: string) => (n.toLowerCase() === "content-type" ? (url.endsWith(".json") ? "application/json" : "application/octet-stream") : null) },
      arrayBuffer: async () => ab,
      json: async () => JSON.parse(buf.toString("utf-8"))
    };
  } catch {
    return { ok: false, headers: { get: () => null }, arrayBuffer: async () => new ArrayBuffer(0), json: async () => null };
  }
};
