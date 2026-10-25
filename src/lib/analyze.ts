// 핸드 분석: 프리플랍은 프리플랍 라이브러리, 포스트플랍은 라이브러리 스팟과 비교
import { COMBO_CLASS, NUM_CLASSES, cardToString, comboIndex, classLabel, parseCards } from "../engine/cards";
import type { PfLib, PfLibNode } from "./preflopLib";
import { flopsFor, MATCHUPS, type Matchup } from "./postflopLib";
import type { HHAction, ParsedHand } from "./hh";

export type Verdict = "correct" | "inaccuracy" | "blunder";
export interface DecisionGrade {
  street: "preflop" | "flop" | "turn" | "river";
  label: string; // 상황 설명
  chosen: string;
  best: string;
  freq: number; // 선택한 액션의 GTO 빈도
  evLoss: number; // bb
  verdict: Verdict;
  options: Array<{ label: string; freq: number; ev: number }>;
  link?: { fmt: string; pf: number[]; fl?: string; pp?: Array<{ kind: "action"; index: number } | { kind: "card"; card: number }> };
}
export interface HandAnalysis {
  id: string;
  position: string;
  cards: string;
  net: number;
  preflopLine: string;
  inTree: boolean; // 프리플랍 라인을 끝까지 라이브러리로 따라갔는지
  note: string;
  matchup: string | null;
  libFlop: string | null; // 수트 대칭으로 매칭된 라이브러리 플랍
  decisions: DecisionGrade[];
  postflopPending: boolean; // 포스트플랍 분석 가능 (워커 필요)
  vpip: boolean;
  pfr: boolean;
  threeBet: boolean;
  threeBetOpp: boolean;
}

export function verdictOf(evLossBb: number, freq: number, pot: number, street: string): Verdict {
  if (freq >= 0.3) return "correct";
  if (street === "preflop") return evLossBb <= 0.05 ? "correct" : evLossBb <= 0.3 ? "inaccuracy" : "blunder";
  const rel = pot > 0 ? evLossBb / pot : 0;
  return rel <= 0.01 ? "correct" : rel <= 0.05 ? "inaccuracy" : "blunder";
}

/** 핸드 히스토리 액션을 라이브러리 노드 액션 인덱스로 매핑 */
export function mapPreflopAction(node: PfLibNode, a: HHAction, stack: number): number {
  const types = node.a.map((x) => x[0]);
  if (a.type === "fold") return types.indexOf("fold");
  if (a.type === "check") return types.indexOf("check");
  if (a.type === "call") {
    const i = types.indexOf("call");
    if (i >= 0) return i;
    return types.indexOf("check");
  }
  // bet/raise: 가장 가까운 레이즈/올인 (to 기준)
  let best = -1;
  let bd = Infinity;
  node.a.forEach((x, i) => {
    if (x[0] !== "raise" && x[0] !== "allin") return;
    const d = a.allin || a.to >= stack * 0.9 ? (x[0] === "allin" ? 0 : Math.abs(x[1] - a.to) + 1000) : Math.abs(x[1] - a.to);
    if (d < bd) {
      bd = d;
      best = i;
    }
  });
  return best;
}

const SUIT_PERMS: number[][] = (() => {
  const out: number[][] = [];
  const perm = (arr: number[], k: number) => {
    if (k === arr.length) {
      out.push(arr.slice());
      return;
    }
    for (let i = k; i < arr.length; i++) {
      [arr[k], arr[i]] = [arr[i], arr[k]];
      perm(arr, k + 1);
      [arr[k], arr[i]] = [arr[i], arr[k]];
    }
  };
  perm([0, 1, 2, 3], 0);
  return out;
})();

/** 실제 플랍을 수트 치환으로 라이브러리 플랍에 맞춘다. 성공 시 치환 함수 반환 */
export function matchFlop(actual: number[], candidates: string[]): { flop: string; map: (c: number) => number } | null {
  for (const f of candidates) {
    const lib = parseCards(f);
    const libSet = new Set(lib);
    for (const p of SUIT_PERMS) {
      const map = (c: number) => (c & ~3) | p[c & 3];
      if (actual.every((c) => libSet.has(map(c)))) return { flop: f, map };
    }
  }
  return null;
}

/** 프리플랍 분석 (동기) */
export function analyzePreflop(h: ParsedHand, lib: PfLib, flopsOf: (matchupId: string) => string[] = flopsFor): { analysis: HandAnalysis; pfPath: number[]; seatOf: Map<string, number>; codes: string[] } {
  const N = lib.format.positions.length;
  // 테이블 인원이 라이브러리보다 적으면 앞자리(UTG 쪽)가 비어 있는 것으로, 많으면 앞자리 초과분은 매핑하지 않는다
  const seatOf = new Map<string, number>();
  const count = h.seats.length;
  const unmapped: string[] = [];
  for (const s of h.seats) {
    const idx = N - count + s.order;
    if (idx >= 0) seatOf.set(s.name, idx);
    else unmapped.push(s.name);
  }
  const heroSeat = h.hero ? h.seats.find((s) => s.name === h.hero) : undefined;
  const cards = h.heroCards ? cardToString(h.heroCards[0]) + cardToString(h.heroCards[1]) : "??";
  const cls = h.heroCards ? COMBO_CLASS[comboIndex(h.heroCards[0], h.heroCards[1])] : -1;
  const decisions: DecisionGrade[] = [];
  const pfPath: number[] = [];
  const codes: string[] = [];
  let node: PfLibNode | null = lib.nodes[0];
  let inTree = true;
  let note = "";
  const acts = h.streets.preflop.slice();
  let vpip = false;
  let pfr = false;
  let threeBet = false;
  let threeBetOpp = false;
  const lineParts: string[] = [];
  // 매핑되지 않은 앞자리 플레이어가 폴드 외 액션을 했다면 라이브러리로 분석할 수 없다
  const blocked = h.streets.preflop.find((a) => unmapped.includes(a.player) && a.type !== "fold");
  if (blocked) {
    inTree = false;
    note = `${count}인 테이블의 앞자리 액션은 ${N}맥스 라이브러리로 분석할 수 없습니다`;
    node = null;
  }
  // 라이브러리 순서대로 진행: 노드의 행동자가 HH에서 행동하지 않았다면(테이블에 없는 자리) 폴드로 간주
  let guard = 0;
  while (node && guard++ < 60) {
    const seatName = lib.format.positions[node.p];
    const player = Array.from(seatOf.entries()).find(([, i]) => i === node!.p)?.[0];
    let ai: number;
    let hhAct: HHAction | null = null;
    if (!player) {
      ai = node.a.findIndex((x) => x[0] === "fold");
      if (ai < 0) ai = node.a.findIndex((x) => x[0] === "check");
    } else {
      const k = acts.findIndex((x) => x.player === player);
      if (k < 0) {
        // 이미 행동을 마친 플레이어 (예: 뒤에서 폴드로 처리)
        ai = node.a.findIndex((x) => x[0] === "fold");
        if (ai < 0) ai = node.a.findIndex((x) => x[0] === "check");
      } else {
        hhAct = acts.splice(k, 1)[0];
        // 올인 판정은 행동한 플레이어 자신의 스택 기준
        const actorStack = h.seats.find((s) => s.name === player)?.stack ?? lib.format.stack;
        ai = mapPreflopAction(node, hhAct, actorStack);
      }
    }
    if (ai < 0) {
      inTree = false;
      note = `${seatName}의 액션(${hhAct?.type ?? "?"})이 라이브러리 트리에 없습니다`;
      break;
    }
    if (player && player === h.hero && cls >= 0) {
      if (node.lv === 1 && node.a.some((x) => x[0] === "raise")) threeBetOpp = true;
      const evs = node.a.map((_, i) => node!.e[i * NUM_CLASSES + cls] / 100);
      let best = 0;
      for (let i = 1; i < evs.length; i++) if (evs[i] > evs[best]) best = i;
      const freq = node.s[ai * NUM_CLASSES + cls] / 1000;
      const evLoss = Math.max(0, evs[best] - evs[ai]);
      decisions.push({
        street: "preflop",
        label: `${seatName} · ${node.line}`,
        chosen: node.a[ai][2],
        best: node.a[best][2],
        freq,
        evLoss,
        verdict: verdictOf(evLoss, freq, node.pot, "preflop"),
        options: node.a.map((x, i) => ({ label: x[2], freq: node!.s[i * NUM_CLASSES + cls] / 1000, ev: evs[i] })),
        link: { fmt: lib.format.id, pf: pfPath.slice() }
      });
      const t = node.a[ai][0];
      if (t === "call" || t === "raise" || t === "allin") vpip = true;
      if (t === "raise" || t === "allin") {
        pfr = true;
        if (node.lv === 1) threeBet = true;
      }
    }
    if (player) lineParts.push(`${seatName} ${node.a[ai][2]}`);
    pfPath.push(ai);
    codes.push(node.a[ai][3]);
    const c: number | string = node.c[ai];
    node = typeof c === "string" ? null : lib.nodes[c];
  }
  let matchup: Matchup | null = null;
  let libFlop: string | null = null;
  if (inTree && !node) {
    matchup = MATCHUPS.find((m) => m.format === lib.format.id && m.codes.length === codes.length && m.codes.every((c, i) => c === codes[i])) ?? null;
    // 라이브러리 자리 이름으로 비교 (헤즈업 버튼 = 라이브러리 SB 등 테이블 인원 차이 보정)
    const heroLibPos = h.hero && seatOf.has(h.hero) ? lib.format.positions[seatOf.get(h.hero)!] : "";
    if (matchup && h.board.length >= 3 && h.hero && [matchup.oop, matchup.ip].includes(heroLibPos)) {
      const mf = matchFlop(h.board.slice(0, 3), flopsOf(matchup.id));
      libFlop = mf ? mf.flop : null;
      if (!libFlop) note = "이 플랍(수트 대칭 포함)은 라이브러리에 없습니다";
    } else if (h.board.length >= 3 && !matchup) note = "이 프리플랍 라인의 포스트플랍 라이브러리가 없습니다";
  }
  return {
    analysis: {
      id: h.id,
      position: heroSeat?.position ?? "?",
      cards,
      net: h.heroNet,
      preflopLine: lineParts.join(" · "),
      inTree,
      note,
      matchup: matchup?.id ?? null,
      libFlop,
      decisions,
      postflopPending: !!libFlop,
      vpip,
      pfr,
      threeBet,
      threeBetOpp
    },
    pfPath,
    seatOf,
    codes
  };
}

export function heroClassLabel(h: ParsedHand): string {
  if (!h.heroCards) return "";
  return classLabel(COMBO_CLASS[comboIndex(h.heroCards[0], h.heroCards[1])]);
}

/** 핸드에 맞는 프리플랍 라이브러리 포맷. 토너먼트는 유효 스택(히어로와 가장 큰 상대 스택 중 작은 값)에 가장 가까운 깊이 */
export function pickFormat(h: ParsedHand, ids: string[]): string {
  const first = h.raw.split("\n")[0] ?? "";
  const isMtt = /Tournament/i.test(first) || h.raw.includes("posts the ante") || h.seats.length > 6;
  if (!isMtt) return ids.includes("cash6-100") ? "cash6-100" : ids[0];
  const hero = h.seats.find((s) => s.name === h.hero);
  const others = h.seats.filter((s) => s.name !== h.hero).map((s) => s.stack);
  const eff = hero && others.length ? Math.min(hero.stack, Math.max(...others)) : 40;
  let best = ids.find((id) => id.startsWith("mtt")) ?? ids[0];
  let bd = Infinity;
  for (const id of ids) {
    const m = id.match(/^mtt\d+-(\d+)$/);
    if (!m) continue;
    const d = Math.abs(Math.log(Math.max(1, eff) / Number(m[1])));
    if (d < bd) {
      bd = d;
      best = id;
    }
  }
  return best;
}
