import { parseCards } from "../src/engine/cards";
import { parseRange } from "../src/engine/range";
import { buildTree, type TreeConfig } from "../src/engine/tree";
import { PostflopSolver } from "../src/engine/solver";

const btn = parseRange("22+,A2s+,K2s+,Q5s+,J7s+,T7s+,97s+,86s+,75s+,65s,54s,A5o+,K9o+,Q9o+,J9o+,T9o");
const bbr = parseRange("22-QQ,A2s-AQs,K2s+,Q4s+,J6s+,T6s+,96s+,85s+,74s+,64s+,53s+,43s,A2o-AQo,K7o+,Q8o+,J8o+,T8o+,98o,87o");
const sizesArg = process.argv[2] ?? "33";
const raises = Number(process.argv[3] ?? "1");
const iters = Number(process.argv[4] ?? "5");
const s = { bet: sizesArg.split(",").map(Number), raise: [60] };
const cfg: TreeConfig = {
  board: parseCards(process.argv[5] ?? "Ks7d2c"), pot: 5.5, effStack: 97.5, rakePct: 0, rakeCap: 0,
  oop: { flop: { bet: [], raise: [60] }, turn: s, river: s }, ip: { flop: s, turn: s, river: s },
  allinThresholdPct: 67, maxRaisesPerStreet: raises, maxRaisesByStreet: process.env.RBS ? (process.env.RBS.split(",").map(Number) as [number,number,number]) : undefined, allowDonk: false, includeAllin: false
};
const t0 = performance.now();
const tree = buildTree(cfg);
const solver = new PostflopSolver(tree, bbr, btn);
const mem = PostflopSolver.estimateBytes(tree, solver.hands.n);
console.log(`hands=${solver.hands.n} decisionTemplates=${tree.decisionNodes.length} estMB=${(mem/1048576).toFixed(0)} build=${(performance.now()-t0).toFixed(0)}ms rss=${(process.memoryUsage().rss/1048576).toFixed(0)}MB`);
const t1 = performance.now();
solver.step(1);
console.log(`iter1 ${(performance.now()-t1).toFixed(0)}ms`);
const t2 = performance.now();
const every = Number(process.env.EVERY ?? "0");
if (every > 0) {
  for (let i = 1; i < iters; i += every) {
    solver.step(Math.min(every, iters - i));
    const mm = solver.metrics();
    console.log(`it=${solver.iterationCount} expl=${mm.exploitabilityPct.toFixed(3)}% t=${((performance.now()-t2)/1000).toFixed(0)}s`);
  }
} else solver.step(iters);
const per = (performance.now()-t2)/iters;
console.log(`per-iter ${per.toFixed(0)}ms`);
const t3 = performance.now();
const m = solver.metrics();
console.log(`metrics ${(performance.now()-t3).toFixed(0)}ms expl=${m.exploitabilityPct.toFixed(2)}% ev=${m.evOop.toFixed(2)}/${m.evIp.toFixed(2)} rss=${(process.memoryUsage().rss/1048576).toFixed(0)}MB`);
