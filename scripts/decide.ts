// 명령줄: 상황(JSON 파일)을 읽어 내 차례의 결정을 출력한다.   npm run decide -- 상황.json
import { readFileSync } from "node:fs";
import { decide, type Spot } from "../src/lib/decide";
import type { PfLib } from "../src/lib/preflopLib";

const file = process.argv[2];
if (!file) {
  console.error("사용법: npm run decide -- <상황.json>   (형식은 README 의 '행동 결정 모델')");
  process.exit(1);
}
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
  const d = await decide(spot, { preflop, eq });
  console.log(`${d.street} · ${d.format} · ${d.ms}ms` + (d.iterations ? ` · 반복 ${d.iterations} · 익스플로잇 ${d.exploitabilityPct}%` : ""));
  d.options.forEach((o, i) => console.log(`${i === d.pick ? "→" : " "} ${o.label.padEnd(18)} ${(o.freq * 100).toFixed(1).padStart(5)}%   EV ${o.ev.toFixed(2)}`));
  for (const n of d.notes) console.log(`※ ${n}`);
} catch (e) {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
}
