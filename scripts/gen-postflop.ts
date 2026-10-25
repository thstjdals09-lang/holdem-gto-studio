// 포스트플랍 라이브러리 생성: node gen-postflop.mjs <matchupId> <shard k> <shards K> [iters] [targetPct]
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { cardToString, parseCards } from "../src/engine/cards";
import { buildTree, type DecisionNode } from "../src/engine/tree";
import { PostflopSolver } from "../src/engine/solver";
import { rangeVsRange } from "../src/engine/equity";
import { reachToCombos, seatIndex, walkCodes, type PfLib } from "../src/lib/preflopLib";
import { flopsFor, MATCHUPS, treeConfigFor, type FlopMeta } from "../src/lib/postflopLib";

const [mid, kArg, KArg, itArg, tgArg] = process.argv.slice(2);
const m = MATCHUPS.find((x) => x.id === mid);
if (!m) throw new Error("matchup?");
const shard = Number(kArg ?? 0);
const shards = Number(KArg ?? 1);
const small = m.id !== "btn-bb-srp" && m.kind === "srp";
const maxIters = small ? Math.min(Number(itArg ?? 100), 80) : Number(itArg ?? 100);
const target = small ? Math.max(Number(tgArg ?? 0.2), 0.3) : Number(tgArg ?? 0.2);
const lib: PfLib = JSON.parse(readFileSync(`public/lib/preflop/${m.format}.json`, "utf-8"));
const walk = walkCodes(lib, m.codes);
const t = walk.terminal!;
if (!t || t.type !== "flop") throw new Error("플랍 터미널이 아닙니다: " + m.codes.join(" "));
const oi = seatIndex(lib, m.oop);
const ii = seatIndex(lib, m.ip);
const pot = Math.round((t.pot) * 100) / 100;
const effStack = Math.round((lib.format.stack - Math.max(t.inv[oi], t.inv[ii])) * 100) / 100;
const w0 = reachToCombos(walk.reach[oi], 0.004);
const w1 = reachToCombos(walk.reach[ii], 0.004);
const outDir = `public/lib/postflop/${m.id}`;
mkdirSync(outDir, { recursive: true });
console.log(`${m.id}: pot=${pot} eff=${effStack} shard ${shard}/${shards}`);

flopsFor(m.id).forEach((flop, fi) => {
  if (fi % shards !== shard) return;
  const dir = `${outDir}/${flop}`;
  if (existsSync(`${dir}/meta.json`)) {
    console.log(`skip ${flop}`);
    return;
  }
  mkdirSync(`${dir}/t`, { recursive: true });
  const board = parseCards(flop);
  const cfg = treeConfigFor(m.kind, board, pot, effStack);
  const tree = buildTree(cfg);
  const solver = new PostflopSolver(tree, w0, w1);
  const t0 = Date.now();
  let met = solver.metrics();
  while (solver.iterationCount < maxIters) {
    solver.step(Math.min(20, maxIters - solver.iterationCount));
    met = solver.metrics();
    if (met.exploitabilityPct <= target) break;
  }
  const n = solver.hands.n;
  const evs = solver.recordEVs(2);
  const stratAll = solver.serializeStrategy();
  // 노드별 전략 오프셋
  const stratOff: number[] = [];
  let off = 0;
  for (const d of tree.decisionNodes) {
    stratOff.push(off);
    off += solver.stratSum[d.id].length;
  }
  const writeNodes = (nodes: DecisionNode[], runout: number, path: string) => {
    let size = 0;
    for (const d of nodes) size += d.actions.length * n * 3;
    const buf = Buffer.alloc(size);
    let p = 0;
    for (const d of nodes) {
      const A = d.actions.length;
      const base = runout * A * n;
      const so = stratOff[d.id] + base;
      for (let k = 0; k < A * n; k++) buf.writeUInt8(Math.max(0, Math.min(255, Math.round(stratAll[so + k] * 255))), p++);
      const ev = evs[d.id];
      for (let k = 0; k < A * n; k++) {
        const v = Math.max(-32768, Math.min(32767, Math.round(ev[base + k] * 100)));
        buf.writeInt16LE(v, p);
        p += 2;
      }
    }
    writeFileSync(path, buf);
  };
  const flopNodes = tree.decisionNodes.filter((d) => d.street === tree.startStreet);
  const turnNodes = tree.decisionNodes.filter((d) => d.street === tree.startStreet + 1);
  writeNodes(flopNodes, 0, `${dir}/flop.bin`);
  for (const c of solver.remaining) writeNodes(turnNodes, solver.cardIdx[c], `${dir}/t/${cardToString(c)}.bin`);
  // 루트 통계
  const root = solver.walk([]);
  const anRoot = solver.analyzeDecision(root.node as DecisionNode, root.ctx, root.reach);
  const xi = (root.node as DecisionNode).actions.findIndex((a) => a.type === "check");
  const ipNode = solver.walk([{ kind: "action", index: xi }]);
  const anIp = ipNode.node.kind === "decision" ? solver.analyzeDecision(ipNode.node, ipNode.ctx, ipNode.reach) : null;
  const eq = rangeVsRange(w0, w1, board);
  const r3 = (x: number) => Math.round(x * 1000) / 1000;
  const meta: FlopMeta = {
    matchup: m.id,
    flop,
    config: cfg,
    hands: Array.from(solver.hands.combo),
    w0: Array.from(solver.w[0], r3),
    w1: Array.from(solver.w[1], r3),
    iterations: solver.iterationCount,
    exploitabilityPct: r3(met.exploitabilityPct),
    evOop: r3(met.evOop),
    evIp: r3(met.evIp),
    eqOop: r3(eq.equity0),
    root: {
      oop: anRoot.node.actions.map((a, i) => ({ label: a.label, freq: r3(anRoot.actionFreq[i]), ev: r3(anRoot.actionEv[i]) })),
      ipVsCheck: anIp ? anIp.node.actions.map((a, i) => ({ label: a.label, freq: r3(anIp.actionFreq[i]), ev: r3(anIp.actionEv[i]) })) : []
    }
  };
  writeFileSync(`${dir}/meta.json`, JSON.stringify(meta));
  console.log(`${flop}: it=${solver.iterationCount} expl=${met.exploitabilityPct.toFixed(3)}% ev=${met.evOop.toFixed(2)}/${met.evIp.toFixed(2)} n=${n} ${((Date.now() - t0) / 1000).toFixed(0)}s`);
});
