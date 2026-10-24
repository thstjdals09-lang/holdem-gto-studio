/// <reference lib="webworker" />
import { CLASS_COMBOS, COMBO_CLASS, NUM_CLASSES } from "../engine/cards";
import { buildTree, estimateTree, type DecisionNode, type GameTree, type TreeConfig } from "../engine/tree";
import { PostflopSolver, type PathStep } from "../engine/solver";
import { rangeVsRange, handVsHand } from "../engine/equity";
import { buildEquityMatrix, buildNonConflict, buildPreflopTree, PreflopSolver, type PfDecision } from "../engine/preflop";
import type { ActionView, DecisionView, Envelope, EstimateResult, NodeView, PfView, Req, Res } from "./protocol";

let solver: PostflopSolver | null = null;
let tree: GameTree | null = null;
let stopRequested = false;
let pfSolver: PreflopSolver | null = null;
let nonConflict: Float32Array | null = null;

function post(id: number, payload: Res, transfer?: Transferable[]) {
  (self as unknown as Worker).postMessage({ id, payload } satisfies Envelope<Res>, transfer ?? []);
}

async function yieldToQueue() {
  await new Promise((r) => setTimeout(r, 0));
}

async function runSolve(id: number, targetExploitPct: number, maxIters: number, maxMs: number, batch: number) {
  if (!solver) throw new Error("솔버가 준비되지 않았습니다");
  stopRequested = false;
  const start = performance.now();
  let reason = "완료";
  let m = solver.metrics();
  post(id, { type: "progress", data: { ...m, done: false } });
  while (true) {
    if (stopRequested) {
      reason = "사용자 중단";
      break;
    }
    if (solver.iterationCount >= maxIters) {
      reason = "최대 반복 도달";
      break;
    }
    if (performance.now() - start > maxMs) {
      reason = "시간 예산 도달";
      break;
    }
    const n = Math.min(batch, maxIters - solver.iterationCount);
    solver.step(n);
    m = solver.metrics();
    post(id, { type: "progress", data: { ...m, done: false } });
    if (m.exploitabilityPct <= targetExploitPct) {
      reason = "목표 정확도 도달";
      break;
    }
    await yieldToQueue();
  }
  post(id, { type: "progress", data: { ...m, done: true, reason } });
  post(id, { type: "result", data: { ...m, reason } });
}

function viewDecision(d: DecisionNode, ctx: ReturnType<PostflopSolver["walk"]>["ctx"], reach: [Float32Array, Float32Array]): DecisionView {
  const s = solver!;
  const an = s.analyzeDecision(d, ctx, reach);
  const n = s.hands.n;
  const A = d.actions.length;
  const classFreq = new Float32Array(NUM_CLASSES * A);
  const classEv = new Float32Array(NUM_CLASSES * A);
  const classWeight = new Float32Array(NUM_CLASSES);
  const oppClassWeight = new Float32Array(NUM_CLASSES);
  const classEquity = new Float32Array(NUM_CLASSES);
  const classEqr = new Float32Array(NUM_CLASSES);
  const classHandEv = new Float32Array(NUM_CLASSES);
  const oppEqAcc = new Float32Array(NUM_CLASSES);
  const combos: DecisionView["combos"] = [];
  // 상대 에퀴티 (상대 reach 기준, 행동 플레이어 reach에 대한)
  const oppEquity = s.equityVector(ctx, an.reachP);
  for (let h = 0; h < n; h++) {
    const combo = s.hands.combo[h];
    const cls = COMBO_CLASS[combo];
    const w = an.reachP[h] * an.S[h];
    const wo = an.reachO[h];
    if (an.reachP[h] > 0) {
      classWeight[cls] += an.reachP[h];
      for (let a = 0; a < A; a++) {
        classFreq[cls * A + a] += w * an.strategy[a * n + h];
        classEv[cls * A + a] += w * an.ev[a * n + h];
      }
      classEquity[cls] += w * an.equity[h];
      classEqr[cls] += w * an.eqr[h];
      classHandEv[cls] += w * an.handEv[h];
    }
    if (wo > 0) {
      oppClassWeight[cls] += wo;
      oppEqAcc[cls] += wo * oppEquity[h];
    }
    if (an.reachP[h] > 0 || wo > 0) {
      const strategy: number[] = [];
      const ev: number[] = [];
      for (let a = 0; a < A; a++) {
        strategy.push(an.strategy[a * n + h]);
        ev.push(an.ev[a * n + h]);
      }
      combos.push({ combo, weight: an.reachP[h], oppWeight: wo, strategy, ev, equity: an.equity[h], eqr: an.eqr[h], handEv: an.handEv[h] });
    }
  }
  // 정규화
  const classWsum = new Float32Array(NUM_CLASSES);
  for (let h = 0; h < n; h++) {
    if (an.reachP[h] <= 0) continue;
    classWsum[COMBO_CLASS[s.hands.combo[h]]] += an.reachP[h] * an.S[h];
  }
  for (let c = 0; c < NUM_CLASSES; c++) {
    const ws = classWsum[c];
    if (ws > 0) {
      for (let a = 0; a < A; a++) {
        classFreq[c * A + a] /= ws;
        classEv[c * A + a] /= ws;
      }
      classEquity[c] /= ws;
      classEqr[c] /= ws;
      classHandEv[c] /= ws;
    }
  }
  const classWeightNorm = new Float32Array(NUM_CLASSES);
  const oppClassWeightNorm = new Float32Array(NUM_CLASSES);
  let oppEqNum = 0;
  let oppEqDen = 0;
  for (let c = 0; c < NUM_CLASSES; c++) {
    classWeightNorm[c] = classWeight[c] / CLASS_COMBOS[c].length;
    oppClassWeightNorm[c] = oppClassWeight[c] / CLASS_COMBOS[c].length;
    oppEqNum += oppEqAcc[c];
    oppEqDen += oppClassWeight[c];
  }
  const actions: ActionView[] = d.actions.map((a, i) => ({ label: a.label, code: a.code, type: a.type, amount: a.amount, freq: an.actionFreq[i], ev: an.actionEv[i] }));
  return {
    kind: "decision",
    player: d.player,
    street: d.street,
    board: ctx.board,
    pot: d.pot,
    invested: d.invested,
    toCall: d.toCall,
    actions,
    classFreq,
    classEv,
    classWeight,
    classWeightNorm,
    oppClassWeightNorm,
    classEquity,
    classEqr,
    classHandEv,
    combos,
    rangeEv: an.rangeEv,
    rangeEquity: an.rangeEquity,
    oppRangeEquity: oppEqDen > 0 ? oppEqNum / oppEqDen : 0
  };
}

function nodeView(path: PathStep[]): NodeView {
  const s = solver!;
  const { node, ctx, reach } = s.walk(path);
  if (node.kind === "decision") return viewDecision(node, ctx, reach);
  if (node.kind === "chance") {
    const live = s.remaining.filter((c) => !ctx.board.includes(c));
    return { kind: "chance", street: node.street, board: ctx.board, pot: node.pot, invested: node.invested, liveCards: live, allin: node.allin };
  }
  // terminal: 양쪽 reach 기준 기대 팟 지분
  let evOop = 0;
  let evIp = 0;
  if (node.type === "fold") {
    evOop = node.folder === 0 ? 0 : node.pot;
    evIp = node.pot - evOop;
  } else {
    const eq = s.equityVector(ctx, reach[1]);
    let num = 0;
    let den = 0;
    for (let h = 0; h < s.hands.n; h++) {
      if (reach[0][h] <= 0) continue;
      num += reach[0][h] * eq[h];
      den += reach[0][h];
    }
    const e = den > 0 ? num / den : 0.5;
    evOop = e * node.pot;
    evIp = node.pot - evOop;
  }
  return { kind: "terminal", type: node.type, board: ctx.board, pot: node.pot, invested: node.invested, folder: node.folder, evOop, evIp };
}

function pfView(path: number[]): PfView {
  const s = pfSolver!;
  const { node, reach } = s.walk(path);
  if (node.kind === "terminal") {
    return {
      player: 0,
      pot: node.pot,
      invested: node.invested,
      toCall: 0,
      actions: [],
      classFreq: new Float32Array(0),
      classEv: new Float32Array(0),
      classWeightNorm: new Float32Array(0),
      oppClassWeightNorm: new Float32Array(0),
      isTerminal: true,
      terminalType: node.type
    };
  }
  const d = node as PfDecision;
  const an = s.analyze(d, reach);
  const A = d.actions.length;
  const N = NUM_CLASSES;
  const classFreq = new Float32Array(N * A);
  const classEv = new Float32Array(N * A);
  for (let c = 0; c < N; c++) for (let a = 0; a < A; a++) {
    classFreq[c * A + a] = an.strategy[a * N + c];
    classEv[c * A + a] = an.ev[a * N + c];
  }
  const cw = new Float32Array(N);
  const ow = new Float32Array(N);
  const rP = reach[d.player];
  const rO = reach[d.player === 0 ? 1 : 0];
  for (let c = 0; c < N; c++) {
    cw[c] = rP[c] / CLASS_COMBOS[c].length;
    ow[c] = rO[c] / CLASS_COMBOS[c].length;
  }
  return {
    player: d.player,
    pot: d.pot,
    invested: d.invested,
    toCall: d.toCall,
    actions: d.actions.map((a, i) => ({ label: a.label, code: a.code, type: a.type, amount: a.amount, freq: an.freq[i], ev: an.actionEv[i] })),
    classFreq,
    classEv,
    classWeightNorm: cw,
    oppClassWeightNorm: ow,
    isTerminal: false
  };
}

self.onmessage = async (ev: MessageEvent<Envelope<Req>>) => {
  const { id, payload: req } = ev.data;
  try {
    switch (req.type) {
      case "estimate": {
        const t = buildTree(req.config);
        const est = estimateTree(req.config);
        // 핸드 수
        const dead = new Set(req.config.board);
        let hands = 0;
        for (let i = 0; i < 1326; i++) {
          if (req.oop[i] <= 0 && req.ip[i] <= 0) continue;
          hands++;
        }
        void dead;
        const bytes = PostflopSolver.estimateBytes(t, hands);
        const res: EstimateResult = { decisionNodes: est.decision, actionSlots: est.actionSlots, hands, bytes, estSecondsPerIter: (est.actionSlots * hands * 2 * 12) / 2.5e8 };
        post(id, { type: "result", data: res });
        break;
      }
      case "solve.start": {
        tree = buildTree(req.config);
        solver = new PostflopSolver(tree, req.oop, req.ip);
        await runSolve(id, req.targetExploitPct, req.maxIters, req.maxMs, req.batch);
        break;
      }
      case "solve.continue": {
        await runSolve(id, req.targetExploitPct, req.maxIters, req.maxMs, req.batch);
        break;
      }
      case "solve.stop": {
        stopRequested = true;
        post(id, { type: "result", data: true });
        break;
      }
      case "spot.load": {
        tree = buildTree(req.config);
        solver = new PostflopSolver(tree, req.oop, req.ip);
        solver.loadStrategy(req.strategy, req.iterations);
        post(id, { type: "result", data: solver.metrics() });
        break;
      }
      case "spot.export": {
        if (!solver) throw new Error("솔버 없음");
        const strategy = solver.serializeStrategy();
        post(id, { type: "result", data: { strategy, iterations: solver.iterationCount, metrics: solver.metrics() } }, [strategy.buffer]);
        break;
      }
      case "node.view": {
        if (!solver) throw new Error("로드된 스팟이 없습니다");
        post(id, { type: "result", data: nodeView(req.path) });
        break;
      }
      case "equity": {
        const r = rangeVsRange(req.oop, req.ip, req.board, req.samples);
        post(id, { type: "result", data: r });
        break;
      }
      case "handVsHand": {
        post(id, { type: "result", data: handVsHand(req.h0, req.h1, req.board, req.samples) });
        break;
      }
      case "preflop.matrix": {
        const m = buildEquityMatrix(req.samplesPerPair, 2026, (p) => post(id, { type: "progress", data: { iterations: Math.round(p * 1000), exploitabilityPct: 0, elapsedMs: 0, evOop: 0, evIp: 0, done: false } }));
        post(id, { type: "result", data: m }, [m.buffer]);
        break;
      }
      case "preflop.solve": {
        if (!nonConflict) nonConflict = buildNonConflict();
        const t = buildPreflopTree(req.config);
        pfSolver = new PreflopSolver(t, req.matrix, nonConflict);
        const start = performance.now();
        let done = 0;
        while (done < req.iters) {
          const n = Math.min(req.batch, req.iters - done);
          pfSolver.step(n);
          done += n;
          const m = pfSolver.metrics();
          post(id, { type: "progress", data: { iterations: m.iterations, exploitabilityPct: m.exploitabilityPct, elapsedMs: performance.now() - start, evOop: m.evSb, evIp: m.evBb, done: false } });
          await yieldToQueue();
        }
        const m = pfSolver.metrics();
        post(id, { type: "result", data: { ...m, nodes: t.decisions.length } });
        break;
      }
      case "preflop.view": {
        if (!pfSolver) throw new Error("프리플랍 솔버 없음");
        post(id, { type: "result", data: pfView(req.path) });
        break;
      }
    }
  } catch (e) {
    post(id, { type: "error", message: e instanceof Error ? e.message : String(e) });
  }
};
