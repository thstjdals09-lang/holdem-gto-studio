// 복기 도구가 쓰는 프리플랍 자료의 출처·해시 목록을 만든다 → src/review/provenance.json
// 실행: node scripts/review-provenance.mjs   (자료나 기준 커밋이 바뀌면 다시 실행)
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";

const dir = "public/lib/preflop";
const git = (cmd) => execSync(`git ${cmd}`, { encoding: "utf8" }).trim();
const files = {};
for (const f of readdirSync(dir).filter((x) => x.endsWith(".json")).sort()) {
  const buf = readFileSync(`${dir}/${f}`);
  const lib = JSON.parse(buf.toString("utf8"));
  files[f] = {
    sha256: createHash("sha256").update(buf).digest("hex"),
    bytes: buf.length,
    formatId: lib.format.id,
    name: lib.format.name,
    players: lib.format.positions.length,
    stackBb: lib.format.stack,
    anteBb: lib.format.ante,
    iterations: lib.iterations,
    exploitabilityBb: lib.exploitabilityBb,
    generatedAt: lib.generatedAt,
    nodes: lib.nodes.length,
    lastCommit: git(`log -1 --format=%H -- ${dir}/${f}`)
  };
}
const out = {
  repository: "https://github.com/thstjdals09-lang/holdem-gto-studio",
  baseCommit: git("merge-base HEAD main"),
  generator: "scripts/gen-preflop.ts → src/engine/ring.ts RingSolver (169 핸드 클래스 DCFR, 칩 EV, 실현계수 근사)",
  license: "저작권자(thstjdals09-lang) 보유. 이 저장소의 자체 솔버로 생성했고 외부 솔버 코드·데이터는 없음 (README 라이선스 절)",
  files
};
writeFileSync("src/review/provenance.json", JSON.stringify(out, null, 2) + "\n");
console.log(`provenance: ${Object.keys(files).length}개 자료, 기준 커밋 ${out.baseCommit.slice(0, 7)}`);
