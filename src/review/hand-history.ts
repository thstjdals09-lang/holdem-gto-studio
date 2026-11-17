// 가져오기·검증: 문서화된 핸드 JSON(DATA-CONTRACT.md), 루루 판단 기록(읽기 전용). 모르는 값은 채우지 않고 missing 에 적는다.
import { HAND_SCHEMA, STREETS, type ActionRecord, type ForcedBet, type HandRecord, type Issue, type SeatRecord, type SnapshotRecord, type Street } from "./types";
import { positionNames } from "./replay-state";

export const MAX_IMPORT_BYTES = 5 * 1024 * 1024;
const MAX_TEXT = 300;
const CARD_RE = /^[2-9TJQKA][cdhs]$/;

/** "as" → "As", "10h" → "Th". 형식이 틀리면 null */
export function normCard(s: unknown): string | null {
  if (typeof s !== "string") return null;
  let t = s.trim();
  if (/^10[cdhsCDHS]$/.test(t)) t = "T" + t[2];
  if (t.length !== 2) return null;
  const c = t[0].toUpperCase() + t[1].toLowerCase();
  return CARD_RE.test(c) ? c : null;
}
const isNum = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x);
const str = (x: unknown, max = MAX_TEXT) => (typeof x === "string" ? x.slice(0, max) : undefined);

/** 객체 키를 정렬한 JSON (해시·캐시 키용) */
export function canonicalJson(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v ?? null);
  if (Array.isArray(v) || ArrayBuffer.isView(v)) return `[${Array.from(v as ArrayLike<unknown>, canonicalJson).join(",")}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o)
    .filter((k) => o[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`)
    .join(",")}}`;
}
export async function sha256Hex(text: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** 알 수 없는 입력을 검사해 HandRecord 로 만든다. 오류가 있으면 hand 는 null */
export function validateHand(raw: unknown): { hand: HandRecord | null; issues: Issue[] } {
  const issues: Issue[] = [];
  const bad = (code: string, message: string, category: Issue["category"] = "format") => issues.push({ severity: "error", category, code, message });
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    bad("not-object", "핸드는 JSON 객체여야 합니다");
    return { hand: null, issues };
  }
  const r = raw as Record<string, unknown>;
  if (r.schema !== HAND_SCHEMA) bad("schema", `schema 는 "${HAND_SCHEMA}" 여야 합니다`);
  const id = str(r.id, 120);
  if (!id) bad("id", "id(핸드 식별자)가 필요합니다");
  if (typeof r.complete !== "boolean") bad("complete", "complete(완료 여부)는 true/false 여야 합니다");
  if (r.unit !== "chips" && r.unit !== "bb") bad("unit", 'unit 은 "chips" 또는 "bb" 여야 합니다', "amount");
  const bigBlind = r.bigBlind === null ? null : isNum(r.bigBlind) && r.bigBlind > 0 ? r.bigBlind : undefined;
  if (bigBlind === undefined) bad("bigBlind", "bigBlind 는 양수 또는 null(모름)이어야 합니다", "amount");
  if (!Number.isInteger(r.buttonSeat)) bad("buttonSeat", "buttonSeat(버튼 좌석 번호)가 필요합니다", "position");

  const seats: SeatRecord[] = [];
  if (!Array.isArray(r.seats) || r.seats.length < 2 || r.seats.length > 8) bad("seats", "seats 는 2~8개 좌석 배열이어야 합니다");
  else
    for (const s of r.seats as unknown[]) {
      const o = (s ?? {}) as Record<string, unknown>;
      if (!Number.isInteger(o.seat) || (o.seat as number) < 1 || (o.seat as number) > 99) {
        bad("seat-no", "좌석 번호는 1~99 정수여야 합니다", "position");
        continue;
      }
      const stack = o.stack === null || o.stack === undefined ? null : isNum(o.stack) ? o.stack : NaN;
      if (Number.isNaN(stack)) bad("seat-stack", `좌석 ${o.seat} 스택은 숫자 또는 null 이어야 합니다`, "amount");
      seats.push({ seat: o.seat as number, name: str(o.name, 60), stack: Number.isNaN(stack) ? null : stack, ...(isNum(o.observedStackAfterAnte) ? { observedStackAfterAnte: o.observedStackAfterAnte } : {}) });
    }
  const seatSet = new Set(seats.map((s) => s.seat));
  const hero = (r.hero ?? {}) as Record<string, unknown>;
  if (!Number.isInteger(hero.seat) || !seatSet.has(hero.seat as number)) bad("hero-seat", "hero.seat 는 앉은 좌석이어야 합니다", "position");
  let heroCards: string[] | null = null;
  if (hero.cards !== null && hero.cards !== undefined) {
    if (!Array.isArray(hero.cards) || hero.cards.length !== 2) bad("hero-cards", "hero.cards 는 카드 2장 배열 또는 null 이어야 합니다");
    else {
      heroCards = hero.cards.map(normCard) as string[];
      if (heroCards.some((c) => !c)) bad("hero-cards", `내 카드 형식이 잘못됐습니다 (${JSON.stringify(hero.cards).slice(0, 40)})`);
    }
  }

  const forced: ForcedBet[] = [];
  if (!Array.isArray(r.forced)) bad("forced", "forced(블라인드·앤티) 배열이 필요합니다", "missing");
  else
    for (const f of r.forced as unknown[]) {
      const o = (f ?? {}) as Record<string, unknown>;
      if (!["sb", "bb", "ante", "bb-ante"].includes(o.kind as string) || !Number.isInteger(o.seat) || !isNum(o.amount)) {
        bad("forced-item", "forced 항목은 { seat, kind: sb|bb|ante|bb-ante, amount } 여야 합니다", "amount");
        continue;
      }
      forced.push({ seat: o.seat as number, kind: o.kind as ForcedBet["kind"], amount: o.amount as number });
    }

  const actions: ActionRecord[] = [];
  if (!Array.isArray(r.actions) || r.actions.length > 300) bad("actions", "actions 는 300개 이하 배열이어야 합니다");
  else
    (r.actions as unknown[]).forEach((a, i) => {
      const o = (a ?? {}) as Record<string, unknown>;
      if (!STREETS.includes(o.street as Street) || !Number.isInteger(o.seat) || !["fold", "check", "call", "bet", "raise"].includes(o.type as string)) {
        bad("action-item", `액션 #${i + 1} 형식이 잘못됐습니다 ({ street, seat, type, add?, to?, allIn? })`, "position");
        return;
      }
      for (const k of ["add", "to"] as const) if (o[k] !== undefined && !isNum(o[k])) bad("action-amount", `액션 #${i + 1} 의 ${k} 는 숫자여야 합니다`, "amount");
      actions.push({
        street: o.street as Street,
        seat: o.seat as number,
        type: o.type as ActionRecord["type"],
        ...(isNum(o.add) ? { add: o.add } : {}),
        ...(isNum(o.to) ? { to: o.to } : {}),
        ...(typeof o.allIn === "boolean" ? { allIn: o.allIn } : {})
      });
    });

  const b = (r.board ?? {}) as Record<string, unknown>;
  const board: HandRecord["board"] = {};
  if (b.flop !== undefined) {
    const f = Array.isArray(b.flop) ? b.flop.map(normCard) : [];
    if (f.length !== 3 || f.some((c) => !c)) bad("flop", "board.flop 은 카드 3장이어야 합니다");
    else board.flop = f as string[];
  }
  for (const k of ["turn", "river"] as const) {
    if (b[k] === undefined) continue;
    const c = normCard(b[k]);
    if (!c) bad(k, `board.${k} 카드 형식이 잘못됐습니다`);
    else board[k] = c;
  }
  if (board.turn && !board.flop) bad("turn-no-flop", "플랍 없이 턴이 있습니다");
  if (board.river && !board.turn) bad("river-no-turn", "턴 없이 리버가 있습니다");

  const showdown = Array.isArray(r.showdown)
    ? (r.showdown as unknown[]).flatMap((s) => {
        const o = (s ?? {}) as Record<string, unknown>;
        const cards = Array.isArray(o.cards) ? o.cards.map(normCard) : [];
        if (!Number.isInteger(o.seat) || !seatSet.has(o.seat as number) || cards.length !== 2 || cards.some((c) => !c)) {
          bad("showdown", "showdown 항목은 { seat, cards: [2장] } 여야 합니다");
          return [];
        }
        return [{ seat: o.seat as number, cards: cards as string[] }];
      })
    : undefined;

  // 카드 중복 (내 카드·보드·쇼다운 전체)
  const all = [...(heroCards ?? []), ...(board.flop ?? []), ...(board.turn ? [board.turn] : []), ...(board.river ? [board.river] : [])];
  for (const s of showdown ?? []) if (s.seat !== hero.seat) all.push(...s.cards);
  const heroShown = showdown?.find((s) => s.seat === hero.seat);
  if (heroShown && heroCards && heroShown.cards.some((c) => !heroCards!.includes(c))) bad("hero-shown", "쇼다운의 내 카드가 hero.cards 와 다릅니다");
  if (new Set(all.filter(Boolean)).size !== all.filter(Boolean).length) bad("dup-card", "같은 카드가 두 번 나옵니다 (내 카드·보드·쇼다운)");

  const snapshots = Array.isArray(r.snapshots)
    ? (r.snapshots as unknown[]).flatMap((s): SnapshotRecord[] => {
        const o = (s ?? {}) as Record<string, unknown>;
        if (!Number.isInteger(o.beforeAction)) return [];
        const stacks: Record<string, number> = {};
        if (o.stacks && typeof o.stacks === "object") for (const [k, v] of Object.entries(o.stacks as object)) if (isNum(v)) stacks[k] = v;
        return [{ beforeAction: o.beforeAction as number, ...(isNum(o.pot) ? { pot: o.pot } : {}), ...(o.potKind === "total" || o.potKind === "settled" ? { potKind: o.potKind as "total" | "settled" } : {}), ...(isNum(o.toCall) ? { toCall: o.toCall } : {}), ...(Object.keys(stacks).length ? { stacks } : {}), ...(str(o.label) ? { label: str(o.label) } : {}) }];
      })
    : undefined;

  let tournament: HandRecord["tournament"];
  if (r.tournament !== undefined && r.tournament !== null) {
    const t = r.tournament as Record<string, unknown>;
    const payouts = Array.isArray(t.payouts) ? t.payouts : [];
    const others = Array.isArray(t.otherStacks) ? t.otherStacks : null;
    if ((t.kind !== "standard" && t.kind !== "satellite") || !payouts.length || payouts.some((x) => !isNum(x) || x < 0) || !others || others.some((x) => !isNum(x) || x <= 0) || others.length > 5000)
      bad("tournament", "tournament 는 { kind: standard|satellite, payouts: [1위부터], otherStacks: [테이블 밖 스택들] } 여야 합니다", "missing");
    else tournament = { kind: t.kind, payouts: payouts as number[], otherStacks: others as number[], ...(str(t.payoutUnit, 20) ? { payoutUnit: str(t.payoutUnit, 20) } : {}) };
  }
  const ranges: Record<string, string> = {};
  const asm = (r.assumptions ?? {}) as Record<string, unknown>;
  if (asm.ranges && typeof asm.ranges === "object") for (const [k, v] of Object.entries(asm.ranges as object)) if (typeof v === "string" && seatSet.has(Number(k))) ranges[k] = v.slice(0, 2000);
  const src = (r.source ?? {}) as Record<string, unknown>;
  const kind = ["manual", "json", "lulu-decision-log", "example"].includes(src.kind as string) ? (src.kind as HandRecord["source"]["kind"]) : "json";

  if (issues.length) return { hand: null, issues };
  const hand: HandRecord = {
    schema: HAND_SCHEMA,
    id: id!,
    complete: r.complete as boolean,
    source: { kind, ...(str(src.detail, 500) ? { detail: str(src.detail, 500) } : {}) },
    unit: r.unit as HandRecord["unit"],
    bigBlind: bigBlind ?? null,
    buttonSeat: r.buttonSeat as number,
    seats,
    hero: { seat: hero.seat as number, cards: heroCards },
    forced,
    actions,
    board,
    ...(showdown ? { showdown } : {}),
    ...(snapshots?.length ? { snapshots } : {}),
    ...(tournament ? { tournament } : {}),
    ...(Object.keys(ranges).length ? { assumptions: { ranges } } : {}),
    ...(Array.isArray(r.missing) ? { missing: (r.missing as unknown[]).map((x) => str(x)).filter((x): x is string => !!x).slice(0, 50) } : {}),
    ...(Array.isArray(r.notes) ? { notes: (r.notes as unknown[]).map((x) => str(x)).filter((x): x is string => !!x).slice(0, 50) } : {})
  };
  return { hand, issues };
}

/** 붙여넣은 JSON: 핸드 하나, 핸드 배열, { hands: [...] } 를 받는다 */
export function parseHandsJson(text: string): { hands: HandRecord[]; issues: Array<Issue & { item: number }> } {
  if (text.length > MAX_IMPORT_BYTES) return { hands: [], issues: [{ severity: "error", category: "format", code: "too-big", message: "5MB 보다 큰 입력은 받지 않습니다", item: 0 }] };
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (e) {
    return { hands: [], issues: [{ severity: "error", category: "format", code: "json", message: `JSON 이 아닙니다: ${(e as Error).message.slice(0, 120)}`, item: 0 }] };
  }
  const list = Array.isArray(data) ? data : data && typeof data === "object" && Array.isArray((data as { hands?: unknown }).hands) ? (data as { hands: unknown[] }).hands : [data];
  const hands: HandRecord[] = [];
  const issues: Array<Issue & { item: number }> = [];
  list.slice(0, 2000).forEach((x, i) => {
    const v = validateHand(x);
    if (v.hand) hands.push(v.hand);
    issues.push(...v.issues.map((is) => ({ ...is, item: i })));
  });
  return { hands, issues };
}

// ---------------- 루루 판단 기록 (읽기 전용) ----------------
// 형식: { schema: 1, version, events: [{ kind: "decision", id, input: { hole, board, potBb, toCallBb, heroStackBb, tournament: { mode },
//   decisionHistory: { handKey, complete, players, hero, stacks: { 자리: 앤티 뺀 관측 스택+투자액(BB) }, preflop/flop/turn/river: [{ pos, type, to?, allin? }], notes } }, output }] }
// 이 기록은 공개 화면에서 관측한 이력이지 공식 핸드 기록이 아니다. 블라인드·앤티·결과·지급 구조는 들어 있지 않다.
interface LuluAct {
  pos?: unknown;
  type?: unknown;
  to?: unknown;
  allin?: unknown;
}
export function importLuluLog(text: string): { hands: HandRecord[]; issues: Issue[]; events: number } {
  const issues: Issue[] = [];
  const fail = (m: string) => ({ hands: [], issues: [{ severity: "error" as const, category: "format" as const, code: "lulu", message: m }], events: 0 });
  if (text.length > MAX_IMPORT_BYTES) return fail("5MB 보다 큰 기록은 받지 않습니다");
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(text);
  } catch {
    return fail("JSON 이 아닙니다");
  }
  if (!data || data.schema !== 1 || !Array.isArray(data.events) || data.events.length > 5000) return fail("루루 판단 기록 형식(schema 1, events 배열)이 아닙니다");
  const version = str(data.version, 20) ?? "?";
  const decisions = (data.events as Array<Record<string, unknown>>).filter((e) => e?.kind === "decision" && e.input && typeof e.input === "object" && (e.input as Record<string, unknown>).decisionHistory);
  const groups = new Map<string, Array<Record<string, unknown>>>();
  decisions.forEach((e, i) => {
    const h = (e.input as Record<string, unknown>).decisionHistory as Record<string, unknown>;
    const key = str(h.handKey, 80) ?? `event-${i}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(e);
  });
  const hands: HandRecord[] = [];
  for (const [key, evs] of groups) {
    const count = (e: Record<string, unknown>) => {
      const h = (e.input as Record<string, unknown>).decisionHistory as Record<string, unknown>;
      return STREETS.reduce((s, k) => s + (Array.isArray(h[k]) ? (h[k] as unknown[]).length : 0), 0);
    };
    evs.sort((a, b) => count(a) - count(b));
    const last = evs[evs.length - 1];
    const input = last.input as Record<string, unknown>;
    const h = input.decisionHistory as Record<string, unknown>;
    const n = h.players;
    if (!Number.isInteger(n) || (n as number) < 2 || (n as number) > 8) {
      issues.push({ severity: "error", category: "format", code: "lulu-players", message: `${key}: 인원(players)이 2~8 이 아닙니다` });
      continue;
    }
    const names = positionNames(n as number); // 루루 기록과 같은 이름(뒷자리 기준). 프리플랍 순서 = 시계 방향
    const seatOf = (pos: unknown): number | null => {
      if (typeof pos !== "string") return null;
      if (n === 2) return pos === "BB" ? 2 : pos === "SB" || pos === "BTN" ? 1 : null;
      const i = names.indexOf(pos);
      return i >= 0 ? i + 1 : null;
    };
    const heroSeat = seatOf(h.hero);
    const hole = Array.isArray(input.hole) ? input.hole.map(normCard) : [];
    const brd = Array.isArray(input.board) ? input.board.map(normCard) : [];
    if (!heroSeat || hole.length !== 2 || hole.some((c) => !c) || ![0, 3, 4, 5].includes(brd.length) || brd.some((c) => !c)) {
      issues.push({ severity: "error", category: "format", code: "lulu-cards", message: `${key}: 내 자리·카드·보드 형식이 잘못됐습니다` });
      continue;
    }
    const stacks = (h.stacks ?? {}) as Record<string, unknown>;
    const seats: SeatRecord[] = names.map((pos, i) => {
      const seat = n === 2 ? (pos === "BB" ? 2 : 1) : i + 1;
      const key2 = n === 2 ? Object.keys(stacks).find((k) => seatOf(k) === seat) : pos;
      const obs = key2 !== undefined ? stacks[key2] : undefined;
      return { seat, name: pos, stack: null, ...(isNum(obs) ? { observedStackAfterAnte: obs } : {}) };
    });
    const actions: ActionRecord[] = [];
    let broken = false;
    for (const street of STREETS) {
      for (const a of (Array.isArray(h[street]) ? h[street] : []) as LuluAct[]) {
        const seat = seatOf(a.pos);
        if (!seat || !["fold", "check", "call", "bet", "raise"].includes(a.type as string)) {
          broken = true;
          continue;
        }
        actions.push({ street, seat, type: a.type as ActionRecord["type"], ...(isNum(a.to) ? { to: a.to } : {}), ...(a.allin === true ? { allIn: true } : {}) });
      }
    }
    const missing = [
      "SB 금액",
      "앤티 종류·금액",
      "초기 스택(앤티 포함) — 기록 스택은 앤티를 뺀 관측값",
      "실제 좌석 번호(포지션 순서로 1..N 을 붙임)",
      "핸드 결과·쇼다운",
      "지급 구조·전체 필드 스택"
    ];
    if (h.complete !== true) missing.push("관측 시작 전 액션 이력(기록에 불완전 표시)");
    if (broken) missing.push("자리 이름을 읽지 못한 액션(제외됨)");
    const notes = [`루루 수집 도우미 ${version} 판단 기록 ${evs.length}개 이벤트에서 가져옴 — 공식 핸드 기록이 아닙니다`];
    for (const x of (Array.isArray(h.notes) ? h.notes : []) as unknown[]) if (str(x)) notes.push(`기록 메모: ${str(x)}`);
    const t = (input.tournament ?? {}) as Record<string, unknown>;
    if (t.mode === "satellite") notes.push("기록에 새틀라이트로 표시됨(지급 구조는 없음)");
    // 기록된 자동 판단은 참고로만 남긴다. 실제로 실행됐는지는 기록으로 확인할 수 없다
    for (const e of evs) {
      const out = (e.output ?? {}) as Record<string, unknown>;
      const opts = Array.isArray(out.options) ? (out.options as Array<Record<string, unknown>>) : [];
      const pick = Number.isInteger(out.pick) ? opts[out.pick as number] : undefined;
      notes.push(`기록된 판단(액션 ${count(e)}개 뒤): ${pick ? `${str(pick.label, 40) ?? str(pick.type, 20)}` : str(out.reason, 80) ?? "없음"} — 출처 ${str(out.source, 30) ?? "미확인"}, 실행 여부 미확인`);
    }
    const snapshots = evs.flatMap((e) => {
      const inp = e.input as Record<string, unknown>;
      return [{ beforeAction: count(e), ...(isNum(inp.potBb) ? { pot: inp.potBb } : {}), ...(isNum(inp.toCallBb) ? { toCall: inp.toCallBb } : {}), ...(isNum(inp.heroStackBb) ? { stacks: { [String(heroSeat)]: inp.heroStackBb } } : {}), label: "루루 화면 관측값" }];
    });
    const bbSeat = n === 2 ? 2 : names.indexOf("BB") + 1;
    const bbObs = seats.find((s) => s.seat === bbSeat)?.observedStackAfterAnte;
    // BB 는 단위 정의상 1BB. 관측 스택이 1BB 보다 작을 때만 낸 만큼
    const forced: ForcedBet[] = [{ seat: bbSeat, kind: "bb", amount: isNum(bbObs) && bbObs < 1 ? bbObs : 1 }];
    hands.push({
      schema: HAND_SCHEMA,
      id: `lulu-${key}`.slice(0, 120),
      complete: false,
      source: { kind: "lulu-decision-log", detail: `루루 ${version} · ${key}` },
      unit: "bb",
      bigBlind: 1,
      buttonSeat: n === 2 ? 1 : names.indexOf("BTN") + 1,
      seats,
      hero: { seat: heroSeat, cards: hole as string[] },
      forced,
      actions,
      board: brd.length ? { flop: brd.slice(0, 3) as string[], ...(brd[3] ? { turn: brd[3] as string } : {}), ...(brd[4] ? { river: brd[4] as string } : {}) } : {},
      snapshots,
      missing,
      notes: notes.slice(0, 50)
    });
  }
  if (!decisions.length) issues.push({ severity: "warn", category: "missing", code: "lulu-empty", message: "판단(decision) 이벤트가 없습니다" });
  return { hands, issues, events: decisions.length };
}

/**
 * 루루 기록 보완: 사용자가 확인한 SB·앤티로 강제 베팅과 초기 스택을 만든다 (새 객체).
 * 초기 스택 = 관측 스택(앤티 뺀 값) + 그 자리가 낸 앤티.
 */
export function completeLuluHand(hand: HandRecord, fill: { sb: number; anteKind: "none" | "ante" | "bb-ante"; ante: number }): { hand: HandRecord | null; error?: string } {
  if (!(fill.sb > 0 && fill.sb <= 1)) return { hand: null, error: "SB 금액(BB 단위, 0~1)을 넣어 주세요" };
  if (fill.anteKind !== "none" && !(fill.ante > 0)) return { hand: null, error: "앤티 금액을 넣어 주세요" };
  const n = hand.seats.length;
  const names = positionNames(n);
  const seatOfPos = (p: string) => (n === 2 ? (p === "BB" ? 2 : 1) : names.indexOf(p) + 1);
  const bbSeat = seatOfPos("BB");
  const sbSeat = n === 2 ? 1 : seatOfPos("SB");
  const seats = hand.seats.map((s) => {
    if (!isNum(s.observedStackAfterAnte)) return { ...s };
    const ante = fill.anteKind === "ante" ? fill.ante : fill.anteKind === "bb-ante" && s.seat === bbSeat ? fill.ante : 0;
    return { ...s, stack: Math.round((s.observedStackAfterAnte + ante) * 1000) / 1000 };
  });
  if (seats.some((s) => s.stack === null)) return { hand: null, error: "관측 스택이 없는 자리가 있어 초기 스택을 만들 수 없습니다" };
  const forced: ForcedBet[] = [];
  if (fill.anteKind === "ante") for (const s of seats) forced.push({ seat: s.seat, kind: "ante", amount: fill.ante });
  if (fill.anteKind === "bb-ante") forced.push({ seat: bbSeat, kind: "bb-ante", amount: fill.ante });
  const sbStack = seats.find((s) => s.seat === sbSeat)!.stack! - (fill.anteKind === "ante" ? fill.ante : 0);
  forced.push({ seat: sbSeat, kind: "sb", amount: Math.min(fill.sb, sbStack) });
  forced.push(...hand.forced.filter((f) => f.kind === "bb"));
  const resolved = ["SB 금액", "앤티 종류·금액", "초기 스택(앤티 포함) — 기록 스택은 앤티를 뺀 관측값"];
  return {
    hand: {
      ...hand,
      seats,
      forced,
      missing: (hand.missing ?? []).filter((m) => !resolved.includes(m)),
      notes: [...(hand.notes ?? []), `사용자 보완: SB ${fill.sb}BB, 앤티 ${fill.anteKind === "none" ? "없음" : `${fill.anteKind === "ante" ? "개인" : "BB"} 앤티 ${fill.ante}BB`}`]
    }
  };
}
