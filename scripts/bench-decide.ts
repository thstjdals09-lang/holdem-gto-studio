// 빠른 포스트플랍 솔버(결정 모델용) 벤치마크.
// 정답: gto-studio 배포본의 포스트플랍 라이브러리 = 같은 트리를 리버까지 끝까지 푼 해 (익스플로잇 약 0.2%).
// 각 노드에서 빠른 솔버의 전략을 라이브러리 EV 로 채점한다: 손실 = Σ 핸드 (최선 EV − 빠른 전략 EV), 그 뒤는 정답대로 친다고 본 값.
// 사용: npm run bench:decide -- [플랍 모델,..] [턴 모델,..] [ms=2000] [턴 플랍 수=8]  (모델: street, full, flop, turn, plain)
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { cardToString } from "../src/engine/cards";
import { oppMass } from "../src/engine/handeq";
import { buildHandSet, PostflopSolver, type HandSet } from "../src/engine/solver";
import { StreetSolver } from "../src/engine/street";
import { buildTree, type ChanceNode, type DecisionNode, type TreeConfig, type TreeNode } from "../src/engine/tree";
import type { FlopMeta, MatchupIndex } from "../src/lib/postflopLib";
import { decode } from "../src/worker/libspot";
import { LookaheadSolver, type LookaheadOptions } from "../src/engine/lookahead";
import { FLOP_LOOK, TURN_LOOK } from "../src/lib/decide";

const BASE = "https://raw.githubusercontent.com/thstjdals09-lang/gto-studio/main/lib/postflop/";
// 받은 파일은 .cache 에 둔다 (앱의 public/lib/postflop 에 일부만 두면 라이브러리 테스트가 전체 파일을 기대하고 실패한다)
const LOCAL = ".cache/lib-postflop/";

async function file(rel: string): Promise<Buffer> {
  const p = LOCAL + rel;
  if (!existsSync(p)) {
    const res = await fetch(BASE + rel);
    if (!res.ok) throw new Error(`${rel}: ${res.status}`);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, Buffer.from(await res.arrayBuffer()));
  }
  return readFileSync(p);
}

/** 빠른 솔버: 스트리트 시작 설정과 레인지로 풀고, 그 스트리트 안의 액션 경로로 전략(슬롯 순서)을 준다 */
interface Solved {
  hands: HandSet;
  iterations: number;
  strategy(path: number[]): Float32Array;
}
type Model = (cfg: TreeConfig, w0: Float32Array, w1: Float32Array, ms: number) => Solved;

const nodeAt = (root: TreeNode, path: number[]): DecisionNode => {
  let at = root;
  for (const i of path) at = (at as DecisionNode).children[i];
  return at as DecisionNode;
};
function timed(s: { step(k: number): void; iterations: number }, ms: number, chunk: number) {
  const end = Date.now() + ms;
  while (s.iterations < 10 || Date.now() < end) s.step(chunk);
}

const look =
  (opts: LookaheadOptions = {}): Model =>
  (cfg, w0, w1, ms) => {
    const s = new LookaheadSolver(cfg, w0, w1, opts);
    timed(s, ms, 1);
    return { hands: s.hands, iterations: s.iterations, strategy: (path) => s.average(nodeAt(s.tree.root, path)) };
  };

export const MODELS: Record<string, Model> = {
  /** 예전 결정 모델: 지금 스트리트만, 잎은 에퀴티 × 실현 모델 */
  street: (cfg, w0, w1, ms) => {
    const tree = buildTree(cfg);
    const s = new StreetSolver(tree, w0, w1);
    timed(s, ms, 2);
    return { hands: s.hands, iterations: s.iterations, strategy: (path) => s.average(nodeAt(tree.root, path)) };
  },
  /** 끝까지 푸는 전체 솔버 (턴은 2초에 가능, 플랍은 너무 느리다) */
  full: (cfg, w0, w1, ms) => {
    const tree = buildTree(cfg);
    const s = new PostflopSolver(tree, w0, w1);
    const it = { step: (k: number) => s.step(k), get iterations() { return s.iterationCount; } };
    timed(it, ms, 1);
    return {
      hands: s.hands,
      iterations: s.iterationCount,
      strategy: (path) => {
        const { node, ctx } = s.walk(path.map((index) => ({ kind: "action" as const, index })));
        return s.avgStrategy(node as DecisionNode, ctx);
      }
    };
  },
  /** 깊이 제한, 결정 모델의 설정 그대로 */
  flop: look(FLOP_LOOK),
  turn: look(TURN_LOOK),
  /** 깊이 제한, 대조 변량 없이 (플랍 40쌍, 턴은 리버 전부) */
  plain: look({}),
  /** 5초 예산 후보: 표본을 늘린 것 */
  flop20: look({ ...FLOP_LOOK, runouts: 20 }),
  turn16: look({ ...TURN_LOOK, runouts: 16 })
};

/** 스트리트 안의 결정 노드(액션 2개 이상) 경로 */
function streetPaths(root: TreeNode): number[][] {
  const out: number[][] = [];
  const go = (node: TreeNode, path: number[]) => {
    if (node.kind !== "decision" || node.street !== (root as DecisionNode).street) return;
    if (node.actions.length > 1) out.push(path);
    node.children.forEach((c, i) => go(c, [...path, i]));
  };
  go(root, []);
  return out;
}

interface Row {
  street: string;
  loss: number; // 노드 팟 대비 %
  libLoss: number;
  freqErr: number;
}

/** 라이브러리 노드 데이터로 빠른 전략을 채점 */
function grade(hands: HandSet, d: DecisionNode, data: { strat: Float32Array; ev: Float32Array }, reach: [Float32Array, Float32Array], fast: Float32Array, fastHands: HandSet, z: number, street: string): Row | null {
  const n = hands.n;
  const A = d.actions.length;
  const p = d.player;
  const mass = oppMass(hands, reach[p === 0 ? 1 : 0]);
  let w = 0;
  let loss = 0;
  let libLoss = 0;
  let fe = 0;
  const fn = fastHands.n;
  for (let h = 0; h < n; h++) {
    const wgt = reach[p][h] * mass[h];
    if (!(wgt > 0)) continue;
    const fs = fastHands.slotOfCombo[hands.combo[h]];
    if (fs < 0) continue;
    let best = -Infinity;
    for (let a = 0; a < A; a++) best = Math.max(best, data.ev[a * n + h]);
    let mine = 0;
    let lib = 0;
    let diff = 0;
    for (let a = 0; a < A; a++) {
      mine += fast[a * fn + fs] * data.ev[a * n + h];
      lib += data.strat[a * n + h] * data.ev[a * n + h];
      diff += Math.abs(fast[a * fn + fs] - data.strat[a * n + h]);
    }
    w += wgt;
    loss += wgt * (best - mine);
    libLoss += wgt * (best - lib);
    fe += (wgt * diff) / 2;
  }
  // 거의 오지 않는 노드는 라이브러리 전략도 수렴하지 않았으니 뺀다
  if (!(w > 0) || w / z < 0.02) return null;
  return { street, loss: (loss / w / d.pot) * 100, libLoss: (libLoss / w / d.pot) * 100, freqErr: fe / w };
}

function reachAlong(root: TreeNode, path: number[], data: (d: DecisionNode) => { strat: Float32Array } | undefined, w: [Float32Array, Float32Array], n: number): [Float32Array, Float32Array] {
  const r: [Float32Array, Float32Array] = [w[0].slice(), w[1].slice()];
  let at = root;
  for (const i of path) {
    const d = at as DecisionNode;
    const s = data(d)!.strat;
    for (let h = 0; h < n; h++) r[d.player][h] *= s[i * n + h];
    at = d.children[i];
  }
  return r;
}
const totalZ = (hands: HandSet, r: [Float32Array, Float32Array]) => {
  const m = oppMass(hands, r[1]);
  let z = 0;
  for (let h = 0; h < hands.n; h++) z += r[0][h] * m[h];
  return z;
};
const toCombos = (hands: HandSet, r: Float32Array) => {
  let top = 0;
  for (let h = 0; h < hands.n; h++) top = Math.max(top, r[h]);
  const out = new Float32Array(1326);
  for (let h = 0; h < hands.n; h++) if (r[h] / top > 1e-4) out[hands.combo[h]] = r[h] / top;
  return out;
};

async function main() {
  const flopModels = (process.argv[2] ?? "street,flop").split(",");
  const turnModels = (process.argv[3] ?? "street,turn").split(",");
  const models = [...new Set([...flopModels, ...turnModels])];
  const ms = Number(process.argv[4] ?? 2000);
  const turnFlops = Number(process.argv[5] ?? 8);
  const rows: Record<string, Row[]> = Object.fromEntries(models.map((m) => [m, []]));
  const iters: Record<string, Record<string, number[]>> = Object.fromEntries(models.map((m) => [m, { flop: [], turn: [] }]));
  for (const matchup of ["m40-btn-bb", "m40-bb-btn-3bp"]) {
    const index = JSON.parse((await file(`${matchup}/index.json`)).toString()) as MatchupIndex;
    for (const [fi, { flop }] of index.flops.entries()) {
      const meta = JSON.parse((await file(`${matchup}/${flop}/meta.json`)).toString()) as FlopMeta;
      const tree = buildTree(meta.config);
      const w0 = new Float32Array(1326);
      const w1 = new Float32Array(1326);
      meta.hands.forEach((c, s) => ((w0[c] = meta.w0[s]), (w1[c] = meta.w1[s])));
      const hands = buildHandSet(meta.config.board, w0, w1);
      const n = hands.n;
      const sw: [Float32Array, Float32Array] = [Float32Array.from(meta.w0), Float32Array.from(meta.w1)];
      const flopNodes = tree.decisionNodes.filter((d) => d.street === tree.startStreet);
      const flopData = decode(new Uint8Array(await file(`${matchup}/${flop}/flop.bin`)).buffer, flopNodes, n);
      const z0 = totalZ(hands, sw);
      // ---- 플랍 ----
      for (const m of flopModels) {
        const s = MODELS[m](meta.config, w0, w1, ms);
        iters[m].flop.push(s.iterations);
        for (const path of streetPaths(tree.root)) {
          const d = nodeAt(tree.root, path);
          const reach = reachAlong(tree.root, path, (x) => flopData.get(x.id), sw, n);
          const row = grade(hands, d, flopData.get(d.id)!, reach, s.strategy(path), s.hands, z0, "flop");
          if (row) rows[m].push(row);
        }
        process.stderr.write(`${matchup} ${flop} flop ${m} it=${s.iterations}\n`);
      }
      // ---- 턴: 체크·체크와 벳·콜 뒤, 카드 2장 ----
      if (matchup !== "m40-btn-bb" || fi >= turnFlops) continue;
      const turnNodes = tree.decisionNodes.filter((d) => d.street === tree.startStreet + 1);
      const lines: number[][] = [];
      const findChance = (node: TreeNode, path: number[]) => {
        if (node.kind === "chance") lines.push(path);
        else if (node.kind === "decision") node.children.forEach((c, i) => findChance(c, [...path, i]));
      };
      findChance(tree.root, []);
      const pick = [lines[0], lines.find((l) => l.length >= 3 && nodeAt(tree.root, l.slice(0, -1)).actions[l[l.length - 1]].type === "call")].filter(Boolean) as number[][];
      for (const line of pick) {
        let ch: TreeNode = tree.root;
        for (const i of line) ch = (ch as DecisionNode).children[i];
        const chance = ch as ChanceNode;
        const live = [...Array(52).keys()].filter((c) => !meta.config.board.includes(c));
        for (const card of [live[fi % live.length], live[(fi * 7 + 23) % live.length]]) {
          const turnData = decode(new Uint8Array(await file(`${matchup}/${flop}/t/${cardToString(card)}.bin`)).buffer, turnNodes, n);
          const r = reachAlong(tree.root, line, (x) => flopData.get(x.id), sw, n);
          for (const k of hands.handsWithCard[card]) r[0][k] = r[1][k] = 0;
          const troot = chance.children[card]!;
          if (troot.kind !== "decision") continue;
          const cfg: TreeConfig = { ...meta.config, board: [...meta.config.board, card], pot: chance.pot, effStack: Math.round((meta.config.effStack - chance.invested[0]) * 100) / 100 };
          const zt = totalZ(hands, r);
          const fastRoot = buildTree(cfg).root;
          for (const m of turnModels) {
            const s = MODELS[m](cfg, toCombos(hands, r[0]), toCombos(hands, r[1]), ms);
            iters[m].turn.push(s.iterations);
            for (const path of streetPaths(troot)) {
              const d = nodeAt(troot, path);
              const fd = nodeAt(fastRoot, path);
              if (fd.actions.map((a) => a.type).join() !== d.actions.map((a) => a.type).join()) throw new Error("턴 트리 모양이 라이브러리와 다릅니다");
              const reach = reachAlong(troot, path, (x) => turnData.get(x.id), r, n);
              const row = grade(hands, d, turnData.get(d.id)!, reach, s.strategy(path), s.hands, zt, "turn");
              if (row) rows[m].push(row);
            }
            process.stderr.write(`${matchup} ${flop} turn ${cardToString(card)} ${m} it=${s.iterations}\n`);
          }
        }
      }
    }
  }
  const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
  for (const m of models) {
    for (const street of ["flop", "turn"]) {
      const rs = rows[m].filter((r) => r.street === street);
      console.log(
        `${m.padEnd(6)} ${street}: nodes=${rs.length} loss=${avg(rs.map((r) => r.loss)).toFixed(3)}%pot worst=${Math.max(0, ...rs.map((r) => r.loss)).toFixed(2)} freqErr=${avg(rs.map((r) => r.freqErr)).toFixed(3)} lib=${avg(rs.map((r) => r.libLoss)).toFixed(3)} it=${avg(iters[m][street]).toFixed(0)}`
      );
    }
  }
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
