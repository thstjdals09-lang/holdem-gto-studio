/// <reference lib="webworker" />
import { CLASS_COMBOS, COMBO_CLASS, NUM_CLASSES } from "../engine/cards";
import { buildTree, estimateTree, type DecisionNode, type GameTree } from "../engine/tree";
import { PostflopSolver, type Ctx } from "../engine/solver";
import { buildMultiTree, estimateMultiTree, MultiSolver, type MCtx, type MDecision, type MultiTree } from "../engine/multi";
import { rangeVsRange, handVsHand } from "../engine/equity";
import { buildEquityMatrix, buildNonConflict, buildPreflopTree, PreflopSolver, type PfDecision } from "../engine/preflop";
import type { ActionView, Envelope, EstimateResult, NodeView, PathStep, PfView, Req, Res, SpotInput } from "./protocol";
import { buildDecisionView } from "./views";
import { LibSpot } from "./libspot";

// 현재 로드된 스팟 (HU 또는 멀티)
let hu: { tree: GameTree; solver: PostflopSolver } | null = null;
let mu: { tree: MultiTree; solver: MultiSolver } | null = null;
let lib: LibSpot | null = null;
let libKey = "";
let stopRequested = false;
let pfSolver: PreflopSolver | null = null;
let nonConflict: Float32Array | null = null;

function post(id: number, payload: Res, transfer?: Transferable[]) {
  (self as unknown as Worker).postMessage({ id, payload } satisfies Envelope<Res>, transfer ?? []);
}
const yieldToQueue = () => new Promise((r) => setTimeout(r, 0));

function metrics() {
  if (hu) {
    const m = hu.solver.metrics();
    return { iterations: m.iterations, exploitabilityPct: m.exploitabilityPct, elapsedMs: m.elapsedMs, ev: [m.evOop, m.evIp], evOop: m.evOop, evIp: m.evIp };
  }
  if (mu) {
    const m = mu.solver.metrics();
    return { iterations: m.iterations, exploitabilityPct: m.exploitabilityPct, elapsedMs: m.elapsedMs, ev: m.ev, evOop: m.ev[0], evIp: m.ev[1] };
  }
  throw new Error("로드된 스팟이 없습니다");
}
function iterationCount() {
  return hu ? hu.solver.iterationCount : mu ? mu.solver.iterationCount : 0;
}
function step(n: number) {
  if (hu) hu.solver.step(n);
  else if (mu) mu.solver.step(n);
}

function loadSpot(input: SpotInput) {
  hu = null;
  mu = null;
  lib = null;
  libKey = "";
  if (input.players === 2) {
    if (!input.config) throw new Error("HU 설정이 없습니다");
    const tree = buildTree(input.config);
    hu = { tree, solver: new PostflopSolver(tree, input.ranges[0], input.ranges[1]) };
  } else {
    if (!input.mconfig) throw new Error("멀티웨이 설정이 없습니다");
    const tree = buildMultiTree(input.mconfig);
    mu = { tree, solver: new MultiSolver(tree, input.ranges) };
  }
}

async function runSolve(id: number, targetExploitPct: number, maxIters: number, maxMs: number, batch: number) {
  stopRequested = false;
  const start = performance.now();
  let reason = "완료";
  let m = metrics();
  post(id, { type: "progress", data: { ...m, done: false } });
  while (true) {
    if (stopRequested) {
      reason = "사용자 중단";
      break;
    }
    if (iterationCount() >= maxIters) {
      reason = "최대 반복 도달";
      break;
    }
    if (performance.now() - start > maxMs) {
      reason = "시간 예산 도달";
      break;
    }
    step(Math.min(batch, maxIters - iterationCount()));
    m = metrics();
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

function nodeView(path: PathStep[]): NodeView {
  if (hu) {
    const s = hu.solver;
    const { node, ctx, reach } = s.walk(path);
    if (node.kind === "decision") {
      const d: DecisionNode = node;
      const an = s.analyzeDecision(d, ctx as Ctx, reach);
      const actions: ActionView[] = d.actions.map((a, i) => ({ label: a.label, code: a.code, type: a.type, amount: a.amount, freq: an.actionFreq[i], ev: an.actionEv[i] }));
      return buildDecisionView(
        { n: s.hands.n, combo: s.hands.combo, A: d.actions.length, strategy: an.strategy, ev: an.ev, handEv: an.handEv, equity: an.equity, eqr: an.eqr, M: an.S, reach: [reach[0], reach[1]] },
        { players: 2, player: d.player, active: [true, true], allin: [false, false], street: d.street, board: ctx.board, pot: d.pot, invested: [d.invested[0], d.invested[1]], toCall: d.toCall, actions },
        an.rangeEv,
        an.rangeEquity
      );
    }
    if (node.kind === "chance") {
      return { kind: "chance", players: 2, street: node.street, board: ctx.board, pot: node.pot, invested: [node.invested[0], node.invested[1]], active: [true, true], liveCards: s.remaining.filter((c) => !ctx.board.includes(c)), allin: node.allin };
    }
    let shares: number[];
    if (node.type === "fold") shares = node.folder === 0 ? [0, node.pot] : [node.pot, 0];
    else {
      const eq = s.equityVector(ctx, reach[1]);
      let num = 0;
      let den = 0;
      for (let h = 0; h < s.hands.n; h++) {
        if (reach[0][h] <= 0) continue;
        num += reach[0][h] * eq[h];
        den += reach[0][h];
      }
      const e = den > 0 ? num / den : 0.5;
      shares = [e * node.pot, (1 - e) * node.pot];
    }
    return { kind: "terminal", players: 2, type: node.type, board: ctx.board, pot: node.pot, invested: [node.invested[0], node.invested[1]], active: [node.folder !== 0, node.folder !== 1], winner: node.folder === -1 ? -1 : node.folder === 0 ? 1 : 0, shares };
  }
  if (!mu) throw new Error("로드된 스팟이 없습니다");
  const s = mu.solver;
  const { node, ctx, reach } = s.walk(path);
  const P = s.P;
  if (node.kind === "decision") {
    const d: MDecision = node;
    const an = s.analyzeDecision(d, ctx as MCtx, reach);
    const actions: ActionView[] = d.actions.map((a, i) => ({ label: a.label, code: a.code, type: a.type, amount: a.amount, freq: an.actionFreq[i], ev: an.actionEv[i] }));
    // EQR = (EV + 투자) / (eq × pot)
    const eqr = new Float32Array(s.n);
    for (let h = 0; h < s.n; h++) eqr[h] = an.equity[h] > 1e-6 && d.pot > 0 ? (an.handEv[h] + d.invested[d.player]) / (an.equity[h] * d.pot) : 0;
    return buildDecisionView(
      { n: s.n, combo: s.combo, A: d.actions.length, strategy: an.strategy, ev: an.ev, handEv: an.handEv, equity: an.equity, eqr, M: an.M, reach },
      { players: P, player: d.player, active: d.active, allin: d.allin, street: d.street, board: ctx.board, pot: d.pot, invested: d.invested, toCall: d.toCall, actions },
      an.rangeEv,
      an.rangeEquity
    );
  }
  if (node.kind === "chance") {
    return { kind: "chance", players: P, street: node.street, board: ctx.board, pot: node.pot, invested: node.invested, active: node.active, liveCards: s.remaining.filter((c) => !ctx.board.includes(c)), allin: node.allin };
  }
  const shares = new Array<number>(P).fill(0);
  if (node.type === "fold") shares[node.winner] = node.pot;
  else {
    for (let p = 0; p < P; p++) {
      if (!node.active[p]) continue;
      const eq = s.equityVector(ctx, p, node.active, reach);
      let num = 0;
      let den = 0;
      for (let h = 0; h < s.n; h++) {
        if (reach[p][h] <= 0) continue;
        num += reach[p][h] * eq[h];
        den += reach[p][h];
      }
      shares[p] = (den > 0 ? num / den : 0) * node.pot;
    }
  }
  return { kind: "terminal", players: P, type: node.type, board: ctx.board, pot: node.pot, invested: node.invested, active: node.active, winner: node.winner, shares };
}

function pfView(path: number[]): PfView {
  const s = pfSolver!;
  const { node, reach } = s.walk(path);
  if (node.kind === "terminal") {
    return { player: 0, pot: node.pot, invested: node.invested, toCall: 0, actions: [], classFreq: new Float32Array(0), classEv: new Float32Array(0), classWeightNorm: new Float32Array(0), oppClassWeightNorm: new Float32Array(0), isTerminal: true, terminalType: node.type };
  }
  const d = node as PfDecision;
  const an = s.analyze(d, reach);
  const A = d.actions.length;
  const N = NUM_CLASSES;
  const classFreq = new Float32Array(N * A);
  const classEv = new Float32Array(N * A);
  for (let c = 0; c < N; c++)
    for (let a = 0; a < A; a++) {
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
  return { player: d.player, pot: d.pot, invested: d.invested, toCall: d.toCall, actions: d.actions.map((a, i) => ({ label: a.label, code: a.code, type: a.type, amount: a.amount, freq: an.freq[i], ev: an.actionEv[i] })), classFreq, classEv, classWeightNorm: cw, oppClassWeightNorm: ow, isTerminal: false };
}

self.onmessage = async (ev: MessageEvent<Envelope<Req>>) => {
  const { id, payload: req } = ev.data;
  try {
    switch (req.type) {
      case "estimate": {
        let hands = 0;
        for (let i = 0; i < 1326; i++) if (req.ranges.some((r) => r[i] > 0)) hands++;
        let decisionNodes: number;
        let actionSlots: number;
        let bytes: number;
        if (req.players === 2) {
          const t = buildTree(req.config!);
          const est = estimateTree(req.config!);
          decisionNodes = est.decision;
          actionSlots = est.actionSlots;
          bytes = PostflopSolver.estimateBytes(t, hands);
        } else {
          const t = buildMultiTree(req.mconfig!);
          const est = estimateMultiTree(req.mconfig!);
          decisionNodes = est.decision;
          actionSlots = est.actionSlots;
          bytes = MultiSolver.estimateBytes(t, hands);
        }
        const perPlayerFactor = req.players === 2 ? 1 : req.players * (req.players === 3 ? 8 : 3);
        const res: EstimateResult = { decisionNodes, actionSlots, hands, bytes, estSecondsPerIter: (actionSlots * hands * 2 * 12 * perPlayerFactor) / 2.5e8 };
        post(id, { type: "result", data: res });
        break;
      }
      case "solve.start": {
        loadSpot(req);
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
        loadSpot(req);
        if (hu) hu.solver.loadStrategy(req.strategy, req.iterations);
        else mu!.solver.loadStrategy(req.strategy, req.iterations);
        post(id, { type: "result", data: metrics() });
        break;
      }
      case "spot.export": {
        const strategy = hu ? hu.solver.serializeStrategy() : mu ? mu.solver.serializeStrategy() : null;
        if (!strategy) throw new Error("솔버 없음");
        post(id, { type: "result", data: { strategy, iterations: iterationCount(), metrics: metrics() } }, [strategy.buffer]);
        break;
      }
      case "node.view": {
        if (lib) {
          const v = await lib.view(req.path, (it, expl) => post(id, { type: "progress", data: { iterations: it, exploitabilityPct: expl, elapsedMs: 0, ev: [], evOop: 0, evIp: 0, done: false } }));
          post(id, { type: "result", data: v });
        } else post(id, { type: "result", data: nodeView(req.path) });
        break;
      }
      case "lib.analyze": {
        const key = `${req.matchup}/${req.flop}`;
        if (!lib || libKey !== key) {
          hu = null;
          mu = null;
          lib = await LibSpot.load(req.baseUrl, req.matchup, req.flop);
          libKey = key;
        }
        post(id, { type: "result", data: await lib.analyzeLine(req.heroSeat, req.heroCombo, req.items) });
        break;
      }
      case "lib.runouts": {
        if (!lib) throw new Error("라이브러리 스팟이 없습니다");
        post(id, { type: "result", data: await lib.runouts(req.path) });
        break;
      }
      case "lib.load": {
        const key = `${req.matchup}/${req.flop}`;
        if (!lib || libKey !== key) {
          hu = null;
          mu = null;
          lib = await LibSpot.load(req.baseUrl, req.matchup, req.flop);
          libKey = key;
        }
        post(id, { type: "result", data: { hands: lib.hands.n, meta: { ...lib.meta, hands: [], w0: [], w1: [] } } });
        break;
      }
      case "equity": {
        post(id, { type: "result", data: rangeVsRange(req.oop, req.ip, req.board, req.samples) });
        break;
      }
      case "handVsHand": {
        post(id, { type: "result", data: handVsHand(req.h0, req.h1, req.board, req.samples) });
        break;
      }
      case "preflop.matrix": {
        const m = buildEquityMatrix(req.samplesPerPair, 2026, (p) => post(id, { type: "progress", data: { iterations: Math.round(p * 1000), exploitabilityPct: 0, elapsedMs: 0, ev: [], evOop: 0, evIp: 0, done: false } }));
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
          post(id, { type: "progress", data: { iterations: m.iterations, exploitabilityPct: m.exploitabilityPct, elapsedMs: performance.now() - start, ev: [m.evSb, m.evBb], evOop: m.evSb, evIp: m.evBb, done: false } });
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
