// 프리플랍 라이브러리 생성: 에퀴티 행렬 → 포맷별 솔브 → public/lib/preflop/<id>.json
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { NUM_CLASSES } from "../src/engine/cards";
import { buildEquityMatrix } from "../src/engine/preflop";
import { buildCompat, buildRingTree, RING_FORMATS, RingSolver, type RingNode } from "../src/engine/ring";

const EQ_PATH = ".cache/eq169-4000.bin";
const OUT = process.env.PF_OUT ?? "public/lib/preflop"; // 실험용 출력 폴더 지정 가능
mkdirSync(OUT, { recursive: true });
let eq: Float32Array;
if (existsSync(EQ_PATH)) eq = new Float32Array(readFileSync(EQ_PATH).buffer.slice(0));
else {
  const t0 = Date.now();
  eq = buildEquityMatrix(4000, 90210, (p) => process.stdout.write(`\requity ${(p * 100).toFixed(0)}%`));
  writeFileSync(EQ_PATH, Buffer.from(eq.buffer));
  console.log(`\nequity matrix ${(Date.now() - t0) / 1000}s`);
}
if (!process.env.PF_OUT) writeFileSync("public/lib/eq169.bin", Buffer.from(eq.buffer));
const compat = buildCompat();
const only = process.argv[2];
const iters = Number(process.argv[3] ?? "600");
for (const f0 of RING_FORMATS) {
  if (only && f0.id !== only) continue;
  // 실험용: PF_SLOPE 로 실현계수 기울기 덮어쓰기
  const f = process.env.PF_SLOPE ? { ...f0, realization: { ...f0.realization, slope: Number(process.env.PF_SLOPE) } } : f0;
  const tree = buildRingTree(f);
  const solver = new RingSolver(tree, eq, compat);
  const t0 = Date.now();
  let last = solver.metrics();
  for (let k = 0; k < iters; k += 50) {
    solver.step(Math.min(50, iters - k));
    last = solver.metrics();
    console.log(`${f.id} it=${solver.iterations} expl=${last.exploitability.toFixed(4)}bb ev=[${last.ev.map((x) => x.toFixed(3)).join(",")}] ${((Date.now() - t0) / 1000).toFixed(0)}s`);
  }
  const evs = solver.actionEVs();
  const q = (x: number) => Math.round(x * 1000);
  const nodes: unknown[] = [];
  const serial = (node: RingNode): number | string => (node.kind === "decision" ? node.id : `t${node.id}`);
  for (const d of tree.decisions) {
    const st = solver.avgStrategy(d);
    const ev = evs.get(d.id)!;
    nodes.push({
      id: d.id,
      p: d.player,
      pot: d.pot,
      inv: d.invested,
      fold: d.folded.map((x) => (x ? 1 : 0)),
      call: d.toCall,
      lv: d.raiseLevel,
      line: d.line,
      a: d.actions.map((a) => [a.type, a.to, a.label, a.code]),
      c: d.children.map(serial),
      s: Array.from(st, q),
      e: Array.from(ev, (x) => Math.round(x * 100))
    });
  }
  const terms = tree.terminals.map((t) => ({ id: t.id, type: t.type, pot: t.pot, inv: t.invested, fold: t.folded.map((x) => (x ? 1 : 0)), w: t.winner }));
  const data = { format: f, iterations: solver.iterations, exploitabilityBb: last.exploitability, ev: last.ev, classes: NUM_CLASSES, nodes, terminals: terms, generatedAt: new Date().toISOString() };
  writeFileSync(`${OUT}/${f.id}.json`, JSON.stringify(data));
  console.log(`wrote ${OUT}/${f.id}.json nodes=${nodes.length} ${(JSON.stringify(data).length / 1048576).toFixed(1)}MB`);
}
