// 복기 보고서: 검증 → 상태 재구성 → 판단 시점(미래 정보 차단) → 전략 비교 → 결과·한계 → 여러 핸드 집계.
// 판단 품질과 실제 승패를 섞지 않는다: outcome(사후 결과)은 decisions 계산에 쓰이지 않는다.
import { COMBO_CLASS, NUM_CLASSES, comboIndex, parseCard } from "../engine/cards";
import { CLASS_N } from "../lib/preflopLib";
import { Cancelled, closedAllin, isClosedAfterCall, isRiverCallClosing, type ClosedResult } from "./allin-ev";
import { canonicalJson, sha256Hex } from "./hand-history";
import { analyzeIcm } from "./icm-analysis";
import { decisionViews, type DecisionView } from "./knowledge";
import { makeTrace, parseUserRange, rangeFromReach, removeCards } from "./ranges";
import { computeOutcome, potLayersMilli, replay, toMilli } from "./replay-state";
import { libraryCandidate, matchAction, walkPreflop, type LibraryLoader, type LoadedLibrary, type PreflopWalk } from "./strategy-provider";
import { CATEGORY_KO, REPORT_SCHEMA, REVIEW_VERSION, STREET_KO, type AnalyzeOptions, type DecisionAnalysis, type HandRecord, type HandReport, type IssueCategory, type NormalizedAction, type OptionView, type RangeTrace } from "./types";

/** 프리플랍 자료 EV 에서 이보다 작은 차이는 실수로 표시하지 않는다 (BB). 자료 EV 는 0.01BB 로 반올림돼 있고 추상 게임의 근사다 */
export const PREFLOP_NOISE_BB = 0.05;
/** 자료 전략이 이 빈도 이상 섞는 액션은 실수가 아니다 */
export const MIXED_FREQ = 0.05;
/** 내 핸드가 이 노드에 오는 비율이 이보다 작으면 그 핸드의 빈도는 학습되지 않은 값일 수 있다 */
export const OFF_LINE_REACH = 0.01;

export interface AnalyzeDeps {
  loadLibrary: LibraryLoader;
  signal?: { cancelled: boolean };
  tick?: () => Promise<void>;
  onProgress?: (done: number, total: number) => void;
}

const LIB_LIMITS = [
  "프리플랍 자료는 이 저장소의 169 핸드 클래스 DCFR 로 푼 제한 추상 게임입니다(정해진 오픈·3벳·4벳·올인 크기, 자발적 참여 3명 상한)",
  "플랍 이후 가치는 실제로 풀지 않고 '승률 × 실현계수'로 근사했습니다 (실현계수는 자체 포스트플랍 솔버로 측정한 값)",
  "3명 이상 올인은 쌍별 승률 곱의 근사입니다. 칩 EV 기준이며 ICM 을 반영하지 않습니다",
  "다인 게임에서 CFR 반복 수와 익스플로잇 지표만으로 내쉬 균형 수렴을 증명할 수 없습니다"
];

function actLabel(a: NormalizedAction | null, unit: string): string {
  if (!a) return "기록 없음";
  const u = unit === "bb" ? "BB" : "";
  if (a.type === "fold") return "폴드";
  if (a.type === "check") return "체크";
  if (a.type === "call") return `콜 +${a.add}${u}${a.allIn ? " (올인)" : ""}`;
  return `${a.type === "bet" ? "벳" : "레이즈"} → ${a.to}${u} (+${a.add}${a.allIn ? ", 올인" : ""})`;
}

export async function analyzeHand(hand: HandRecord, options: AnalyzeOptions, deps: AnalyzeDeps): Promise<HandReport> {
  const t0 = Date.now();
  const inputHash = await sha256Hex(canonicalJson(hand));
  const rp = replay(hand);
  const issues = [...rp.issues];
  for (const m of hand.missing ?? []) issues.push({ severity: "warn", category: "missing", code: "import-missing", message: `가져오기에서 확인하지 못함: ${m}` });
  const views = decisionViews(hand, rp);
  const decisions: DecisionAnalysis[] = [];
  for (let i = 0; i < views.length; i++) {
    deps.onProgress?.(i, views.length);
    if (deps.signal?.cancelled) throw new Cancelled();
    decisions.push(rp.ok ? await analyzeDecision(views[i], options, deps) : invalidDecision(views[i], rp.issues.filter((x) => x.severity === "error").map((x) => x.message)));
  }
  deps.onProgress?.(views.length, views.length);
  return {
    schema: REPORT_SCHEMA,
    handId: hand.id,
    inputHash,
    modelVersion: REVIEW_VERSION,
    createdAt: new Date().toISOString(),
    options,
    unit: hand.unit,
    bigBlind: hand.bigBlind,
    issues,
    replay: { ok: rp.ok, ended: rp.ended, steps: rp.steps.length, refunds: rp.refunds, snapshotChecks: rp.snapshotChecks, conservationOk: !rp.issues.some((x) => x.code === "conservation") },
    decisions,
    outcome: computeOutcome(hand, rp),
    ms: Date.now() - t0
  };
}

function baseDecision(view: DecisionView): DecisionAnalysis {
  const hero = view.state.seats.find((s) => s.seat === view.seat)!;
  const opp = view.state.seats.filter((s) => s.seat !== view.seat && !s.folded);
  const effStack = Math.min(hero.stack, Math.max(0, ...opp.map((s) => s.stack + s.streetIn - hero.streetIn)));
  const { pot } = view.state;
  const callAdd = view.legal.callAdd;
  const bb = view.bigBlind;
  return {
    status: "unsupported",
    decisionIndex: view.decisionIndex,
    street: view.street,
    seat: view.seat,
    position: view.position,
    viewHash: "",
    heroCards: view.heroCards,
    board: view.board,
    state: view.state,
    legal: view.legal,
    pots: potLayersMilli(view.state.seats.map((s) => ({ seat: s.seat, totalIn: toMilli(s.totalIn), deadIn: toMilli(s.deadIn), folded: s.folded }))).map((l) => ({ amount: l.amount / 1000, eligible: l.eligible })),
    metrics: {
      pot,
      toCall: view.legal.toCall,
      potOdds: callAdd > 0 ? callAdd / (pot + callAdd) : null,
      effStack,
      spr: view.street !== "preflop" && pot > 0 ? effStack / pot : null,
      potBb: bb ? pot / bb : null,
      toCallBb: bb ? view.legal.toCall / bb : null
    },
    actual: view.actual ? { type: view.actual.type, add: view.actual.add, to: view.actual.to, allIn: view.actual.allIn, label: actLabel(view.actual, view.unit) } : null,
    method: "none",
    evUnit: "",
    options: [],
    verdict: { kind: "unknown", text: "" },
    ranges: [],
    quality: { ms: 0, method: "없음", notes: [] },
    assumptions: [],
    limitations: [],
    unsupportedReasons: [],
    categories: []
  };
}

function invalidDecision(view: DecisionView, reasons: string[]): DecisionAnalysis {
  const d = baseDecision(view);
  d.status = "invalid";
  d.unsupportedReasons = [`핸드 기록에 오류가 있어 판단을 분석하지 않았습니다: ${reasons.slice(0, 3).join(" / ")}`];
  d.verdict = { kind: "unknown", text: "잘못된 입력" };
  d.categories = ["position"];
  return d;
}

async function analyzeDecision(view: DecisionView, options: AnalyzeOptions, deps: AnalyzeDeps): Promise<DecisionAnalysis> {
  const t0 = Date.now();
  const d = baseDecision(view);
  d.viewHash = await sha256Hex(canonicalJson(view));
  const cats = new Set<IssueCategory>();
  const reason = (cat: IssueCategory, text: string) => {
    cats.add(cat);
    if (!d.unsupportedReasons.includes(text)) d.unsupportedReasons.push(text);
  };
  const finish = () => {
    d.categories = [...cats];
    d.quality.ms = Date.now() - t0;
    return d;
  };
  if (!view.heroCards) {
    reason("missing", "내 카드가 기록되지 않아 전략을 비교할 수 없습니다");
    return finish();
  }
  const need = { preflop: 0, flop: 3, turn: 4, river: 5 }[view.street];
  if (view.board.length !== need) {
    reason("missing", `${STREET_KO[view.street]} 보드 카드 ${need}장이 기록되지 않았습니다`);
    return finish();
  }
  const heroCards = view.heroCards.map(parseCard);
  const board = view.board.map(parseCard);
  const dead = [...heroCards, ...board];
  const bb = view.bigBlind;
  const cls = COMBO_CLASS[comboIndex(heroCards[0], heroCards[1])];
  const live = view.state.seats.filter((s) => s.seat !== view.seat && !s.folded);

  // ---- 1) 프리플랍 자료: 조건이 정확히 같을 때만 ----
  const cand = libraryCandidate(view);
  let loaded: LoadedLibrary | null = null;
  let walk: PreflopWalk | null = null;
  if (cand.id) {
    loaded = await deps.loadLibrary(cand.id);
    walk = walkPreflop(loaded.lib, view, view.history.filter((a) => a.street === "preflop"));
    if (!walk.ok) for (const r of walk.reasons) reason("data", `자료 ${cand.id}: ${r}`);
  } else for (const r of cand.reasons) reason("data", `프리플랍 자료와 조건이 다름 — ${r}`);
  const heroP = view.order.indexOf(view.seat);
  const libRangeOk = !!walk?.ok;
  const libTrace = (seat: number, note: string[]): RangeTrace => {
    const p = view.order.indexOf(seat);
    const w = removeCards(rangeFromReach(walk!.reach[p]), dead).w;
    return makeTrace(
      {
        seat,
        position: view.positions[seat],
        source: "library",
        sourceDetail: `${cand.id}.json (${loaded!.sha256.slice(0, 12)}…) 루트의 전체 핸드에서 시작`,
        conditioned: true,
        steps: walk!.steps.filter((s) => s.p === p).map((s) => ({ street: "preflop" as const, label: s.label, massBefore: Math.round(s.massBefore * 10) / 10, massAfter: Math.round(s.massAfter * 10) / 10 })),
        notes: note
      },
      w,
      dead
    );
  };

  if (view.street === "preflop" && walk?.ok && walk.node && walk.node.p === heroP && loaded) {
    const node = walk.node;
    const hero = view.state.seats.find((s) => s.seat === view.seat)!;
    const reachRatio = walk.reach[heroP][cls] / CLASS_N[cls];
    const offLine = reachRatio < OFF_LINE_REACH;
    const actualIndex = view.actual ? matchAction(node, view.actual, bb!) : -1;
    d.method = "preflop-library";
    d.status = "analyzed";
    d.evUnit = "BB · 자료의 제한 추상 게임 · 이 시점에서 폴드 = 0";
    d.options = node.a.map((x, i) => ({
      label: x[2],
      type: x[0],
      to: x[1] * bb!,
      add: Math.max(0, x[1] * bb! - hero.streetIn),
      freq: node.s[i * NUM_CLASSES + cls] / 1000,
      ev: node.e[i * NUM_CLASSES + cls] / 100,
      isActual: i === actualIndex
    }));
    d.ranges = live.map((s) => libTrace(s.seat, []));
    d.data = { formatId: loaded.id, sha256: loaded.sha256, manifestMatch: loaded.manifestMatch, iterations: loaded.lib.iterations, exploitabilityBb: loaded.lib.exploitabilityBb, generatedAt: loaded.lib.generatedAt, conditions: [...cand.conditions, `베팅 경로 일치: ${walk.steps.map((s) => s.label).join(" · ") || "첫 액션"}`] };
    d.quality = { ms: 0, method: "자료 조회", notes: [`자료 반복 ${loaded.lib.iterations}회, 익스플로잇 ${loaded.lib.exploitabilityBb.toExponential(2)}BB (자료 모델 안에서의 지표)`] };
    d.limitations.push(...LIB_LIMITS);
    if (offLine) d.limitations.push(`내 핸드가 자료 전략으로는 이 노드에 거의 오지 않습니다(도달 ${(reachRatio * 100).toFixed(2)}%). 이 핸드의 빈도는 학습되지 않은 값일 수 있어 빈도로 판정하지 않고 EV 만 봅니다`);
    d.verdict = libraryVerdict(d.options, actualIndex, offLine, !!view.actual);
    if (d.verdict.kind === "ev-loss") cats.add("ev");
    d.unsupportedReasons = [];
    cats.delete("data");
  }

  // ---- 2) 닫힌 올인: 콜하면 더 베팅이 없는 상황. 상대 범위 출처가 있어야 계산 ----
  const callAdd = view.legal.callAdd;
  const allinClosed = callAdd > 0 && isClosedAfterCall(view.state, view.seat, callAdd);
  // 리버에서 내 콜로 베팅이 끝나는 경우도 결과가 카드로만 정해진다. 다만 레이즈가 가능할 수 있어 콜·폴드만 비교한다
  const riverClose = !allinClosed && isRiverCallClosing(view.state, view.seat, callAdd);
  const closed = allinClosed || riverClose;
  if (closed) {
    const traces: RangeTrace[] = [];
    const opps: Array<{ seat: number; weights: Float32Array }> = [];
    const missingRange: string[] = [];
    for (const s of live) {
      const text = view.assumedRanges[String(s.seat)];
      if (libRangeOk && (walk!.node !== null || walk!.terminal !== null)) {
        const note = view.street === "preflop" ? [] : ["플랍 이후 관측 액션으로는 조건화하지 않았습니다 (포스트플랍 전략 자료 없음)"];
        const tr = libTrace(s.seat, note);
        traces.push(tr);
        opps.push({ seat: s.seat, weights: removeCards(rangeFromReach(walk!.reach[view.order.indexOf(s.seat)]), dead).w });
      } else if (text) {
        const pr = parseUserRange(text);
        if ("error" in pr) {
          reason("range", `${view.positions[s.seat]} 범위 가정 문법 오류: ${pr.error}`);
          missingRange.push(view.positions[s.seat]);
          continue;
        }
        const w = removeCards(pr.weights, dead).w;
        traces.push(makeTrace({ seat: s.seat, position: view.positions[s.seat], source: "user", sourceDetail: `사용자 가정: ${text.slice(0, 120)}`, conditioned: false, steps: [], notes: ["관측 액션으로 조건화하지 않은 사용자 가정입니다. GTO 범위가 아닙니다"] }, w, dead));
        opps.push({ seat: s.seat, weights: w });
      } else {
        traces.push(makeTrace({ seat: s.seat, position: view.positions[s.seat], source: "none", sourceDetail: "출처 없음", conditioned: false, steps: [], notes: [] }, null, dead));
        missingRange.push(view.positions[s.seat]);
      }
    }
    if (d.method === "none") d.ranges = traces;
    if (missingRange.length) reason("range", `${missingRange.join(", ")} 의 범위 출처가 없습니다. 무작위·상위 N% 범위로 대신하지 않습니다 — '범위 가정'을 넣으면 사용자 가정으로 계산합니다`);
    else if (opps.some((o) => !o.weights.some((x) => x > 0))) reason("range", "내 카드·보드를 빼면 상대 범위가 비어 있습니다");
    else {
      let res: ClosedResult | null = null;
      try {
        res = await closedAllin(
          { heroSeat: view.seat, heroCards, board, entries: view.state.seats.map((s) => ({ seat: s.seat, totalIn: toMilli(s.totalIn), deadIn: toMilli(s.deadIn), stack: toMilli(s.stack), folded: s.folded })), callAdd: toMilli(callAdd), opponents: opps },
          { samples: options.samples, seed: options.seed, signal: deps.signal, tick: deps.tick }
        );
      } catch (e) {
        if (e instanceof Cancelled) throw e;
        reason("range", (e as Error).message);
      }
      if (res) applyClosed(d, view, res, traces, options, cats, riverClose && view.legal.canRaise);
    }
  } else if (d.method === "none") {
    if (view.street !== "preflop") reason("data", "포스트플랍 전략 풀이는 이 복기 도구에 넣지 않았습니다. 이후 베팅이 남은 결정이라 팟 오즈만으로 EV 를 정할 수 없습니다 (MODEL-LIMITATIONS.md)");
    else if (walk?.ok && !walk.node) reason("data", "자료 트리가 이 판단 전에 끝났습니다 (자료에 없는 흐름)");
    else if (walk?.ok && walk.node && walk.node.p !== heroP) reason("position", "자료 트리의 차례와 내 차례가 다릅니다");
  }
  if (d.method === "none" && !d.unsupportedReasons.length) reason("data", "이 판단에 맞는 자료·계산이 없습니다");
  return finish();
}

function libraryVerdict(opts: OptionView[], actual: number, offLine: boolean, hasActual: boolean) {
  const best = opts.reduce((b, o, i) => ((o.ev ?? -Infinity) > (opts[b].ev ?? -Infinity) ? i : b), 0);
  if (!hasActual) return { kind: "unknown" as const, text: `기록이 이 판단에서 끝나 실제 선택이 없습니다. 자료 EV 최대: ${opts[best].label}` };
  if (actual < 0) return { kind: "unknown" as const, text: "실제 선택(크기 포함)이 자료 트리에 없어 그 EV 를 계산하지 않았습니다. 손실액을 만들지 않습니다" };
  if (actual === best) return { kind: "best" as const, text: "자료 EV 가 가장 큰 액션을 골랐습니다" };
  const f = opts[actual].freq ?? 0;
  if (!offLine && f >= MIXED_FREQ) return { kind: "mixed" as const, text: `자료 전략이 이 핸드로 이 액션을 ${(f * 100).toFixed(0)}% 섞습니다 (실수 아님)` };
  const diff = (opts[best].ev ?? 0) - (opts[actual].ev ?? 0);
  if (diff <= PREFLOP_NOISE_BB) return { kind: "within-noise" as const, text: `EV 차이 ${diff.toFixed(2)}BB 는 판정 기준 ${PREFLOP_NOISE_BB}BB 안이라 실수로 표시하지 않습니다` };
  return { kind: "ev-loss" as const, evLoss: diff, text: `자료 모델 기준 ${opts[best].label} 보다 ${diff.toFixed(2)}BB 낮습니다` };
}

function applyClosed(d: DecisionAnalysis, view: DecisionView, res: ClosedResult, traces: RangeTrace[], options: AnalyzeOptions, cats: Set<IssueCategory>, raiseOpen: boolean) {
  const unit = view.unit === "bb" ? "BB" : "칩";
  const bb = view.bigBlind;
  const ev = res.evCall / 1000;
  const se = res.se / 1000;
  const src = [...new Set(traces.map((t) => (t.source === "library" ? "자료 경로 조건화" : "사용자 가정")))].join(" + ");
  const qnote = `${res.method === "enumeration" ? `전부 열거 ${res.samples.toLocaleString()}개 (상대 콤보 × 런아웃)` : `표본 ${res.samples.toLocaleString()}개, 시드 ${options.seed}, 수락률 ${(res.acceptRate * 100).toFixed(1)}%`}. 콜 시 승 ${(res.win * 100).toFixed(1)}% · 나눔 ${(res.split * 100).toFixed(1)}% · 패 ${(res.lose * 100).toFixed(1)}%, 필요 승률 ${(res.requiredEquity * 100).toFixed(1)}% (내가 이길 수 있는 팟 ${res.heroEligiblePot / 1000}${unit})`;
  if (d.method === "preflop-library") {
    // 같은 범위로 직접 계산한 값을 교차 확인으로만 붙인다 (자료 EV 를 덮어쓰지 않음)
    const libCall = d.options.find((o) => o.type === "call")?.ev;
    d.quality.notes.push(`교차 확인: 같은 조건화 범위로 직접 계산한 콜 EV ${(bb ? ev / bb : ev).toFixed(2)}${bb ? "BB" : unit} ± ${(bb ? se / bb : se).toFixed(2)} (자료 콜 EV ${libCall ?? "?"}BB). 차이는 자료가 올인 결과를 쌍별 승률·실현 근사로 계산하기 때문일 수 있습니다. ${qnote}`);
    return;
  }
  d.method = "allin-closed";
  d.status = "approximate";
  d.evUnit = `${unit} · 이 시점에서 폴드 = 0 · 상대 범위: ${src}`;
  d.options = [
    { label: "폴드", type: "fold", freq: null, ev: 0, evSe: 0, isActual: view.actual?.type === "fold" },
    { label: `콜 +${view.legal.callAdd}${view.unit === "bb" ? "BB" : ""}`, type: "call", add: view.legal.callAdd, freq: null, ev, evSe: se, isActual: view.actual?.type === "call" },
    ...(raiseOpen ? [{ label: "레이즈 (계산 안 함)", type: "raise", freq: null, ev: null, isActual: view.actual?.type === "raise" }] : [])
  ];
  d.ranges = traces;
  d.quality = { ms: 0, method: `${raiseOpen ? "리버 콜(베팅 종료)" : "닫힌 올인"} · ${res.method === "enumeration" ? "전부 열거" : "표본"}`, samples: res.samples, seed: options.seed, enumeration: res.method === "enumeration", notes: [qnote] };
  d.assumptions.push(raiseOpen ? "리버에서 내 콜로 베팅이 끝나 결과가 카드로만 정해지는 상황입니다. 콜과 폴드 둘만 비교합니다" : "내가 콜하면 이후 베팅 결정이 없어 결과가 카드로만 정해지는 상황입니다(최적 대응 = EV 가 0보다 크면 콜)");
  if (raiseOpen) d.limitations.push("레이즈 선택지는 풀지 않았습니다. 레이즈가 콜·폴드보다 나을 수 있어 이 판정은 '콜과 폴드 중'에 대한 것입니다");
  if (traces.some((t) => t.source === "user")) d.assumptions.push("상대 범위 중 사용자 가정이 있습니다. 가정이 바뀌면 결론이 바뀝니다");
  if (view.street !== "preflop" && traces.some((t) => t.source === "library")) d.limitations.push("자료 범위는 프리플랍 액션으로만 좁혔고 플랍 이후 액션은 반영하지 않았습니다");
  d.limitations.push("빈도는 계산하지 않습니다(두 선택지의 EV 만 비교). 칩 EV 이며 ICM 은 아래 대회 분석에서 따로 봅니다");
  const noise = Math.max(2 * se, 0.01 * (bb ?? 1));
  const evS = `${ev.toFixed(2)}${unit}${bb && view.unit !== "bb" ? ` (${(ev / bb).toFixed(2)}BB)` : ""}`;
  if (view.actual && view.actual.type !== "call" && view.actual.type !== "fold") d.verdict = { kind: "unknown", text: `실제 선택(레이즈)의 EV 는 계산하지 않아 판정하지 않습니다. 참고: 콜 EV ${evS}` };
  else if (!view.actual) d.verdict = { kind: "unknown", text: `기록이 이 판단에서 끝나 실제 선택이 없습니다. 콜 EV ${evS}` };
  else if (Math.abs(ev) <= noise) d.verdict = { kind: "within-noise", text: `콜 EV ${evS} 가 오차 범위(±${noise.toFixed(2)}) 안이라 어느 쪽도 실수로 표시하지 않습니다` };
  else if ((view.actual.type === "call") === ev > 0) d.verdict = { kind: "best", text: `칩 EV 기준 ${raiseOpen ? "콜·폴드 중 " : ""}맞는 선택입니다 (콜 EV ${evS})` };
  else {
    d.verdict = { kind: "ev-loss", evLoss: Math.abs(ev), text: `칩 EV 기준 ${ev > 0 ? "콜" : "폴드"}보다 ${Math.abs(ev).toFixed(2)}${unit} 낮습니다 (범위: ${src})` };
    cats.add("ev");
  }
  const icm = analyzeIcm(view, res, { samples: options.icmSamples, seed: options.seed }, src);
  if (typeof icm === "string") d.icmUnavailable = icm;
  else d.icm = icm;
}

// ---------------- 여러 핸드 집계 ----------------
export interface Aggregate {
  hands: number;
  handsAnalyzed: number;
  handsApproximate: number;
  handsUnsupported: number;
  handsInvalid: number;
  handsNoDecision: number;
  decisions: number;
  byStatus: Record<string, number>;
  categories: Array<{ key: IssueCategory; label: string; decisions: number; hands: number }>;
  /** 모델이 다른 값은 더하지 않는다. BB 로 바꿀 수 있는 것만 evLossBb 가 있고 그 기준으로 정렬한다 */
  evLosses: Array<{ handId: string; decisionIndex: number; street: string; evLoss: number; unit: string; evLossBb: number | null; model: string; text: string }>;
}
export function aggregate(reports: HandReport[]): Aggregate {
  const byStatus: Record<string, number> = { analyzed: 0, approximate: 0, unsupported: 0, invalid: 0 };
  const catDec = new Map<IssueCategory, number>();
  const catHand = new Map<IssueCategory, Set<string>>();
  const out: Aggregate = { hands: reports.length, handsAnalyzed: 0, handsApproximate: 0, handsUnsupported: 0, handsInvalid: 0, handsNoDecision: 0, decisions: 0, byStatus, categories: [], evLosses: [] };
  const bump = (k: IssueCategory, hand: string, dec: boolean) => {
    if (dec) catDec.set(k, (catDec.get(k) ?? 0) + 1);
    if (!catHand.has(k)) catHand.set(k, new Set());
    catHand.get(k)!.add(hand);
  };
  for (const r of reports) {
    const errs = r.issues.filter((i) => i.severity === "error");
    for (const e of errs) bump(e.category, r.handId, false);
    const st = r.decisions.map((d) => d.status);
    if (errs.length || st.includes("invalid")) out.handsInvalid++;
    else if (!st.length) out.handsNoDecision++;
    else if (st.every((s) => s === "analyzed")) out.handsAnalyzed++;
    else if (st.every((s) => s === "analyzed" || s === "approximate")) out.handsApproximate++;
    else out.handsUnsupported++;
    for (const d of r.decisions) {
      out.decisions++;
      byStatus[d.status]++;
      for (const c of d.categories) bump(c, r.handId, true);
      if (d.verdict.kind === "ev-loss" && d.verdict.evLoss !== undefined) {
        const lib = d.method === "preflop-library";
        const unit = lib || r.unit === "bb" ? "BB" : "칩";
        const evLossBb = unit === "BB" ? d.verdict.evLoss : r.bigBlind ? d.verdict.evLoss / r.bigBlind : null;
        out.evLosses.push({ handId: r.handId, decisionIndex: d.decisionIndex, street: STREET_KO[d.street], evLoss: d.verdict.evLoss, unit, evLossBb, model: lib ? `자료 ${d.data?.formatId}` : "닫힌 올인 칩 EV", text: d.verdict.text });
      }
    }
  }
  out.categories = (Object.keys(CATEGORY_KO) as IssueCategory[]).map((k) => ({ key: k, label: CATEGORY_KO[k], decisions: catDec.get(k) ?? 0, hands: catHand.get(k)?.size ?? 0 }));
  out.evLosses.sort((a, b) => (b.evLossBb ?? -1) - (a.evLossBb ?? -1));
  return out;
}
