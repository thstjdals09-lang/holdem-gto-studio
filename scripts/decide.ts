// 명령줄: 상황(JSON 파일)을 읽어 내 차례의 결정을 출력한다.   npm run decide -- 상황.json [--threads N]
// 플랍·턴 깊이 제한 풀이는 워커 스레드(기본: 코어 수 − 1)에 런아웃 계산을 나눠 맡긴다. --threads 0 이면 한 스레드
import { readFileSync } from "node:fs";
import { availableParallelism } from "node:os";
import { nodeSubPorts } from "../sdk/src/node";
import { decide, type Spot } from "../src/lib/decide";
import type { PfLib } from "../src/lib/preflopLib";

const file = process.argv[2];
if (!file) {
  console.error("사용법: npm run decide -- <상황.json> [--threads N]   (형식은 README 의 '행동 결정 모델')");
  process.exit(1);
}
const ti = process.argv.indexOf("--threads");
const threads = ti > 0 ? Number(process.argv[ti + 1]) : availableParallelism() - 1;
if (!(Number.isInteger(threads) && threads >= 0)) {
  console.error("--threads 는 0 이상의 정수여야 합니다");
  process.exit(1);
}
// 워커 파일은 npm run decide 가 이 스크립트 옆(.cache)에 함께 빌드한다
const ports = threads > 0 ? nodeSubPorts(threads, new URL("./gto-sub-worker-node.mjs", import.meta.url)) : undefined;
const libs = new Map<string, PfLib>();
const preflop = async (id: string) => {
  let l = libs.get(id);
  if (!l) libs.set(id, (l = JSON.parse(readFileSync(`public/lib/preflop/${id}.json`, "utf-8")) as PfLib));
  return l;
};

try {
  const spot: Spot = JSON.parse(readFileSync(file, "utf-8"));
  const eq = async () => {
    const b = readFileSync("public/lib/eq169.bin");
    return new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
  };
  const d = await decide(spot, { preflop, eq, ports });
  console.log(`${d.street} · ${d.format} · ${d.ms}ms` + (d.iterations ? ` · 반복 ${d.iterations}` : "") + (d.exploitabilityPct !== undefined ? ` · 익스플로잇 ${d.exploitabilityPct}%` : ""));
  d.options.forEach((o, i) => console.log(`${i === d.pick ? "→" : " "} ${o.label.padEnd(18)} ${(o.freq * 100).toFixed(1).padStart(5)}%   EV ${o.ev.toFixed(2)}`));
  for (const n of d.notes) console.log(`※ ${n}`);
} catch (e) {
  console.error(e instanceof Error ? e.message : e);
  process.exitCode = 1;
} finally {
  ports?.forEach((p) => p.close());
}
