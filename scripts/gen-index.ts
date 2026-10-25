// 매치업별 index.json (리포트용) 생성
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { flopsFor, MATCHUPS, type FlopMeta, type MatchupIndex } from "../src/lib/postflopLib";
for (const m of MATCHUPS) {
  const flops: MatchupIndex["flops"] = [];
  let pot = 0;
  let eff = 0;
  for (const f of flopsFor(m.id)) {
    const p = `public/lib/postflop/${m.id}/${f}/meta.json`;
    if (!existsSync(p)) continue;
    const meta: FlopMeta = JSON.parse(readFileSync(p, "utf-8"));
    pot = meta.config.pot;
    eff = meta.config.effStack;
    flops.push({ flop: f, iterations: meta.iterations, exploitabilityPct: meta.exploitabilityPct, evOop: meta.evOop, evIp: meta.evIp, eqOop: meta.eqOop, root: meta.root });
  }
  const idx: MatchupIndex = { matchup: m, pot, effStack: eff, flops };
  mkdirSync(`public/lib/postflop/${m.id}`, { recursive: true });
  writeFileSync(`public/lib/postflop/${m.id}/index.json`, JSON.stringify(idx));
  console.log(m.id, flops.length);
}
