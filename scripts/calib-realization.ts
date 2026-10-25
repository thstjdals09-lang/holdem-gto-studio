// 실현율 측정: 프리플랍 라이브러리의 BTN 오픈 vs BB 콜 레인지로 무작위 플랍을 풀어
// 핸드 클래스별 실제 팟 몫(루트 EV / 팟)과 에퀴티를 기록한다. 결과는 fit-realization.ts 가 읽는다.
// 사용: node calib.mjs <format> <플랍 수> <반복> <시드> <샤드 k> <샤드 K>
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { COMBO_CLASS, NUM_CLASSES, cardToString, mulberry32 } from "../src/engine/cards";
import { buildTree } from "../src/engine/tree";
import { PostflopSolver } from "../src/engine/solver";
import { reachToCombos, walkCodes, type PfLib } from "../src/lib/preflopLib";
import { treeConfigFor } from "../src/lib/postflopLib";

const [fid, nArg, itArg, seedArg, kArg, KArg] = process.argv.slice(2);
const lib: PfLib = JSON.parse(readFileSync(`public/lib/preflop/${fid}.json`, "utf-8"));
const N = lib.format.positions.length;
const btn = N - 3;
const codes = [...Array(btn).fill("F"), `R${lib.format.openTo[btn]}`, "F", "C"];
const walk = walkCodes(lib, codes);
const t = walk.terminal;
if (!t || t.type !== "flop") throw new Error("BTN vs BB 플랍 터미널이 아닙니다");
const oi = N - 1;
const ii = btn;
const pot = Math.round(t.pot * 100) / 100;
const eff = Math.round((lib.format.stack - Math.max(t.inv[oi], t.inv[ii])) * 100) / 100;
const w0 = reachToCombos(walk.reach[oi], 0.004);
const w1 = reachToCombos(walk.reach[ii], 0.004);
const nFlops = Number(nArg ?? 8);
const iters = Number(itArg ?? 40);
const rng = mulberry32(Number(seedArg ?? 7));
const shard = Number(kArg ?? 0);
const shards = Number(KArg ?? 1);
const flops: number[][] = [];
while (flops.length < nFlops) {
  const s = new Set<number>();
  while (s.size < 3) s.add(Math.floor(rng() * 52));
  flops.push(Array.from(s));
}
mkdirSync(".cache/calib", { recursive: true });
console.log(`${fid}: pot=${pot} eff=${eff} SPR=${(eff / pot).toFixed(2)} flops=${nFlops} iters=${iters} shard ${shard}/${shards}`);
flops.forEach((board, fi) => {
  if (fi % shards !== shard) return;
  const t0 = Date.now();
  const tree = buildTree(treeConfigFor("srp", board, pot, eff));
  const solver = new PostflopSolver(tree, w0, w1);
  while (solver.iterationCount < iters) solver.step(Math.min(10, iters - solver.iterationCount));
  const met = solver.metrics();
  const rec: Record<string, unknown> = { fid, flop: board.map(cardToString).join(""), pot, eff, expl: met.exploitabilityPct };
  for (const p of [0, 1] as const) {
    const st = solver.rootHandStats(p);
    const num = new Array(NUM_CLASSES).fill(0);
    const den = new Array(NUM_CLASSES).fill(0);
    const eqn = new Array(NUM_CLASSES).fill(0);
    for (let h = 0; h < solver.hands.n; h++) {
      const w = solver.w[p][h] * st.S[h];
      if (!(w > 0)) continue;
      const c = COMBO_CLASS[solver.hands.combo[h]];
      num[c] += w * st.ev[h];
      den[c] += w;
      eqn[c] += w * st.equity[h];
    }
    rec[p === 0 ? "oop" : "ip"] = { num, den, eqn };
  }
  appendFileSync(`.cache/calib/${fid}.jsonl`, JSON.stringify(rec) + "\n");
  console.log(`${rec.flop} expl=${met.exploitabilityPct.toFixed(2)}% ${((Date.now() - t0) / 1000).toFixed(0)}s`);
});
