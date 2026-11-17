// 상태 재구성: 완료(또는 미완료) 핸드의 액션 이력을 규칙대로 다시 진행해 각 액션 직전의 상태를 만든다.
// 노리밋 홀덤 규칙: 헤즈업은 버튼=SB(프리플랍 먼저, 포스트플랍 나중), 최소 레이즈 = 마지막 완전 레이즈 크기,
// 완전 레이즈가 안 되는 짧은 올인은 이미 행동한 자리에 레이즈를 다시 열지 않는다(누적이 완전 레이즈 이상이면 다시 열림),
// 아무도 맞추지 않은 초과 베팅은 돌려준다, 팟은 각자 넣은 총액(앤티 포함)으로 층을 나눠 자격을 정한다.
// 금액은 정수 milli(단위 × 1000)로 계산해서 칩 보존을 정확히 검사한다.
import { parseCard } from "../engine/cards";
import { evaluate } from "../engine/evaluator";
import type { ActionRecord, HandRecord, Issue, IssueCategory, LegalView, NormalizedAction, PotLayer, SnapshotCheck, StateView, Street } from "./types";
import { STREETS } from "./types";

export const MILLI = 1000;
export const toMilli = (x: number) => Math.round(x * MILLI);
export const fromMilli = (x: number) => x / MILLI;
export const isMilliExact = (x: number) => Number.isFinite(x) && Math.abs(x * MILLI - Math.round(x * MILLI)) < 1e-6;

const POS8 = ["UTG", "UTG1", "LJ", "HJ", "CO", "BTN", "SB", "BB"];
/** 프리플랍 행동 순서의 자리 이름 (마지막 두 자리 = SB, BB). 헤즈업은 BTN(=SB), BB */
export function positionNames(n: number): string[] {
  if (n === 2) return ["BTN", "BB"];
  return POS8.slice(8 - n);
}

interface Seat {
  seat: number;
  position: string;
  name?: string;
  start: number;
  stack: number;
  streetIn: number;
  totalIn: number;
  /** BB 앤티처럼 모두의 죽은 돈으로 낸 금액 (totalIn 에 포함) */
  deadIn: number;
  folded: boolean;
  allIn: boolean;
  acted: boolean;
  actedAtBet: number;
}

export interface ReplayStep {
  index: number;
  action: NormalizedAction;
  before: StateView;
  legal: LegalView;
  after: StateView;
}
export interface ReplayResult {
  ok: boolean;
  issues: Issue[];
  /** 프리플랍 행동 순서의 좌석 번호 */
  order: number[];
  positions: Record<number, string>;
  sbSeat: number | null;
  bbSeat: number | null;
  bbNominal: number;
  steps: ReplayStep[];
  final: StateView | null;
  ended: "fold" | "showdown" | "runout" | "incomplete";
  refunds: Array<{ seat: number; amount: number; street: Street }>;
  /** 기록이 끝난 시점에 아직 행동하지 않은 차례 (미완료 기록에서 내 판단 시점으로 쓴다) */
  pending: { seat: number; state: StateView; legal: LegalView } | null;
  /** 보드가 열린 스트리트 */
  reached: Street[];
  snapshotChecks: SnapshotCheck[];
  /** 내부(milli) 최종 상태. 사후 결과 계산용 */
  finalMilli: Array<{ seat: number; stack: number; totalIn: number; deadIn: number; folded: boolean }>;
  startMilli: Array<{ seat: number; start: number }>;
}

/**
 * 각자 넣은 총액으로 팟 층을 나눈다. 폴드한 자리의 돈은 들어가지만 자격은 없다 (milli).
 * BB 앤티(deadIn)는 그 자리의 기여가 아니라 모두의 죽은 돈이라 살아 있는 전원이 자격을 갖는 첫 층으로 둔다.
 * 개인 앤티는 자리마다 같은 금액이라 총액에 넣어 층을 나눠도 같은 결과가 된다.
 */
export function potLayersMilli(raw: Array<{ seat: number; totalIn: number; folded: boolean; deadIn?: number }>): PotLayer[] {
  const dead = raw.reduce((s, e) => s + (e.deadIn ?? 0), 0);
  const entries = raw.map((e) => ({ ...e, totalIn: e.totalIn - (e.deadIn ?? 0) }));
  const levels = [...new Set(entries.filter((e) => !e.folded && e.totalIn > 0).map((e) => e.totalIn))].sort((a, b) => a - b);
  const out: PotLayer[] = [];
  if (dead > 0) out.push({ amount: dead, eligible: entries.filter((e) => !e.folded).map((e) => e.seat) });
  let prev = 0;
  for (const level of levels) {
    let amount = 0;
    for (const e of entries) amount += Math.min(e.totalIn, level) - Math.min(e.totalIn, prev);
    const eligible = entries.filter((e) => !e.folded && e.totalIn >= level).map((e) => e.seat);
    if (amount > 0) out.push({ amount, eligible });
    prev = level;
  }
  // 살아 있는 사람의 최고 총액보다 더 낸 폴드 자리의 돈은 마지막 층에 들어간다
  const leftover = entries.reduce((s, e) => s + Math.max(0, e.totalIn - prev), 0);
  if (leftover > 0) {
    if (out.length) out[out.length - 1].amount += leftover;
    else out.push({ amount: leftover, eligible: entries.filter((e) => !e.folded).map((e) => e.seat) });
  }
  return out;
}

export function replay(hand: HandRecord): ReplayResult {
  const issues: Issue[] = [];
  const err = (category: IssueCategory, code: string, message: string, actionIndex?: number) => issues.push({ severity: "error", category, code, message, actionIndex });
  const warn = (category: IssueCategory, code: string, message: string, actionIndex?: number) => issues.push({ severity: "warn", category, code, message, actionIndex });
  const tol = hand.unit === "bb" ? 6 : 0; // 기록이 소수 둘째 자리로 반올림된 경우(BB 단위)만 허용
  const base: ReplayResult = {
    ok: false,
    issues,
    order: [],
    positions: {},
    sbSeat: null,
    bbSeat: null,
    bbNominal: 0,
    steps: [],
    final: null,
    ended: "incomplete",
    refunds: [],
    pending: null,
    reached: ["preflop"],
    snapshotChecks: [],
    finalMilli: [],
    startMilli: []
  };
  const hasError = () => issues.some((i) => i.severity === "error");

  const sorted = [...hand.seats].sort((a, b) => a.seat - b.seat);
  const n = sorted.length;
  if (n < 2 || n > 8) {
    err("format", "seat-count", `인원은 2~8명이어야 합니다 (현재 ${n}명)`);
    return base;
  }
  if (new Set(sorted.map((s) => s.seat)).size !== n) {
    err("format", "seat-dup", "같은 좌석 번호가 두 번 있습니다");
    return base;
  }
  const bi = sorted.findIndex((s) => s.seat === hand.buttonSeat);
  if (bi < 0) {
    err("position", "button", `버튼 좌석 ${hand.buttonSeat}번에 앉은 사람이 없습니다 (빈 버튼은 지원하지 않습니다)`);
    return base;
  }
  const sbi = n === 2 ? bi : (bi + 1) % n;
  const bbi = n === 2 ? (bi + 1) % n : (bi + 2) % n;
  const first = n === 2 ? bi : (bbi + 1) % n;
  const names = positionNames(n);
  base.order = names.map((_, k) => sorted[(first + k) % n].seat);
  base.order.forEach((seat, k) => (base.positions[seat] = names[k]));
  base.sbSeat = sorted[sbi].seat;
  base.bbSeat = sorted[bbi].seat;
  const label = (seat: number) => `${base.positions[seat] ?? "?"}(${seat}번)`;

  for (const s of sorted) {
    if (s.stack === null || s.stack === undefined) err("missing", "stack-unknown", `${label(s.seat)} 초기 스택을 모릅니다`);
    else if (!(s.stack > 0) || !isMilliExact(s.stack)) err("amount", "stack-bad", `${label(s.seat)} 초기 스택 ${s.stack} 이 올바르지 않습니다 (양수, 소수 셋째 자리까지)`);
  }
  if (hand.unit === "bb" && hand.bigBlind !== 1) err("amount", "bb-unit", "단위가 BB 이면 bigBlind 는 1 이어야 합니다");
  if (hand.bigBlind !== null && !(hand.bigBlind > 0)) err("amount", "bb-size", "BB 크기가 올바르지 않습니다");
  if (hasError()) return base;

  const seats: Seat[] = sorted.map((s) => ({
    seat: s.seat,
    position: base.positions[s.seat],
    name: s.name,
    start: toMilli(s.stack!),
    stack: toMilli(s.stack!),
    streetIn: 0,
    totalIn: 0,
    deadIn: 0,
    folded: false,
    allIn: false,
    acted: false,
    actedAtBet: 0
  }));
  base.startMilli = seats.map((s) => ({ seat: s.seat, start: s.start }));
  const bySeat = new Map(seats.map((s) => [s.seat, s]));

  // ---- 강제 베팅 ----
  const kinds = new Map<string, number>();
  for (const f of hand.forced) {
    const s = bySeat.get(f.seat);
    if (!s) {
      err("position", "forced-seat", `${f.kind} 를 낸 좌석 ${f.seat}번이 테이블에 없습니다`);
      continue;
    }
    if (!(f.amount > 0) || !isMilliExact(f.amount)) {
      err("amount", "forced-amount", `${label(f.seat)} ${f.kind} 금액 ${f.amount} 이 올바르지 않습니다`);
      continue;
    }
    if ((f.kind === "sb" && f.seat !== base.sbSeat) || ((f.kind === "bb" || f.kind === "bb-ante") && f.seat !== base.bbSeat)) {
      err("position", "forced-position", `${f.kind.toUpperCase()} 는 ${label(f.kind === "sb" ? base.sbSeat! : base.bbSeat!)} 이 내야 합니다 (버튼 ${hand.buttonSeat}번 기준). 기록은 ${f.seat}번`);
      continue;
    }
    const key = f.kind === "ante" ? `ante:${f.seat}` : f.kind;
    kinds.set(key, (kinds.get(key) ?? 0) + 1);
    if (kinds.get(key)! > 1) {
      err("format", "forced-dup", `${label(f.seat)} 의 ${f.kind} 가 두 번 기록됐습니다`);
      continue;
    }
    const amt = toMilli(f.amount);
    if (amt > s.stack) {
      err("amount", "forced-over", `${label(f.seat)} 가 낸 ${f.kind} ${f.amount} 이 남은 스택 ${fromMilli(s.stack)} 보다 큽니다`);
      continue;
    }
    s.stack -= amt;
    s.totalIn += amt;
    if (f.kind === "bb-ante") s.deadIn += amt;
    if (f.kind === "sb" || f.kind === "bb") s.streetIn += amt;
    if (s.stack === 0) s.allIn = true;
  }
  if (hand.forced.some((f) => f.kind === "ante") && hand.forced.some((f) => f.kind === "bb-ante")) warn("format", "ante-mixed", "개인 앤티와 BB 앤티가 함께 기록됐습니다");
  if (!kinds.has("bb")) {
    // 앤티를 먼저 내서 스택이 0 이 된 BB 는 블라인드를 못 낸다 (규칙상 정상). 그때는 BB 크기를 따로 알아야 한다
    const bbEmpty = bySeat.get(base.bbSeat!)!.stack === 0;
    if (!bbEmpty) err("missing", "no-bb", "BB 게시 기록이 없습니다");
    else if (hand.bigBlind === null) err("missing", "no-bb-size", "BB 가 앤티로 올인해 블라인드를 못 냈습니다. 이때는 bigBlind(BB 크기)가 필요합니다");
    else warn("amount", "bb-ante-allin", `${label(base.bbSeat!)} 가 앤티로 올인해 BB 를 내지 못했습니다`);
  }
  if (!kinds.has("sb")) warn("missing", "no-sb", "SB 게시 기록이 없습니다 (SB 없이 진행)");
  if (hasError()) return base;
  const bbSeatObj = bySeat.get(base.bbSeat!)!;
  const bbNominal = hand.bigBlind !== null ? toMilli(hand.bigBlind) : bbSeatObj.streetIn;
  base.bbNominal = fromMilli(bbNominal);
  if (bbSeatObj.streetIn > bbNominal) err("amount", "bb-over", `BB 가 BB 크기(${fromMilli(bbNominal)})보다 많이 냈습니다 (${fromMilli(bbSeatObj.streetIn)})`);
  if (bbSeatObj.streetIn < bbNominal && bbSeatObj.stack > 0) err("amount", "bb-short", "BB 를 덜 냈는데 스택이 남아 있습니다 (스택이 모자랄 때만 덜 낼 수 있음)");
  const sbObj = bySeat.get(base.sbSeat!)!;
  if (sbObj.streetIn > bbNominal) err("amount", "sb-over", "SB 가 BB 보다 많이 냈습니다");
  if (hasError()) return base;

  // ---- 진행 ----
  let street: Street = "preflop";
  let currentBet = Math.max(bbNominal, ...seats.map((s) => s.streetIn));
  let lastRaise = bbNominal;
  let toAct: number | null = null;
  let settled = 0; // 지난 스트리트까지의 팟
  let ended: ReplayResult["ended"] = "incomplete";
  const idxOf = new Map(sorted.map((s, i) => [s.seat, i]));

  const alive = () => seats.filter((s) => !s.folded);
  const canAct = () => alive().filter((s) => !s.allIn);
  const pending = (s: Seat): boolean => {
    if (s.folded || s.allIn) return false;
    const lone = canAct().length === 1;
    if (lone && s.streetIn >= currentBet) return false;
    return !s.acted || s.streetIn < currentBet;
  };
  const nextFrom = (fromIdx: number, inclusive: boolean): number | null => {
    for (let k = inclusive ? 0 : 1; k <= n; k++) {
      const s = seats[(fromIdx + k) % n];
      if (pending(s)) return s.seat;
    }
    return null;
  };
  const view = (): StateView => ({
    street,
    seats: seats.map((s) => ({
      seat: s.seat,
      position: s.position,
      name: s.name,
      start: fromMilli(s.start),
      stack: fromMilli(s.stack),
      streetIn: fromMilli(s.streetIn),
      totalIn: fromMilli(s.totalIn),
      deadIn: fromMilli(s.deadIn),
      folded: s.folded,
      allIn: s.allIn
    })),
    pot: fromMilli(seats.reduce((a, s) => a + s.totalIn, 0)),
    potSettled: fromMilli(settled),
    currentBet: fromMilli(currentBet),
    toAct
  });
  const reopenOk = (s: Seat) => !s.acted || currentBet - s.actedAtBet >= lastRaise;
  const legalFor = (s: Seat): LegalView => {
    const toCall = Math.max(0, currentBet - s.streetIn);
    const callAdd = Math.min(toCall, s.stack);
    const others = alive().filter((o) => o !== s && !o.allIn).length;
    let blocked: string | undefined;
    if (s.stack <= toCall) blocked = "스택이 콜 금액 이하라 콜(올인)만 할 수 있습니다";
    else if (others === 0) blocked = "상대가 모두 올인이라 더 베팅할 수 없습니다";
    else if (!reopenOk(s)) blocked = "짧은 올인은 이미 행동한 자리에 레이즈를 다시 열어 주지 않습니다 (콜·폴드만)";
    const can = !blocked;
    const maxTo = s.streetIn + s.stack;
    const minTo = can ? Math.min(currentBet === 0 ? bbNominal : currentBet + lastRaise, maxTo) : null;
    return {
      seat: s.seat,
      toCall: fromMilli(toCall),
      callAdd: fromMilli(callAdd),
      canCheck: toCall === 0,
      canCall: toCall > 0,
      canBet: currentBet === 0 && can,
      canRaise: currentBet > 0 && can,
      minTo: minTo === null ? null : fromMilli(minTo),
      maxTo: fromMilli(maxTo),
      raiseBlockedBy: blocked
    };
  };
  const refund = () => {
    const sortedIn = [...seats].sort((a, b) => b.streetIn - a.streetIn);
    const top = sortedIn[0];
    const second = sortedIn[1]?.streetIn ?? 0;
    if (top.streetIn > second) {
      const amt = top.streetIn - second;
      top.streetIn -= amt;
      top.totalIn -= amt;
      top.stack += amt;
      if (top.stack > 0) top.allIn = false;
      base.refunds.push({ seat: top.seat, amount: fromMilli(amt), street });
    }
  };
  const boardFor: Record<Street, boolean> = {
    preflop: true,
    flop: !!hand.board.flop?.length,
    turn: !!hand.board.turn,
    river: !!hand.board.river
  };
  const roundEnd = (): void => {
    refund();
    if (street === "river") {
      ended = "showdown";
      toAct = null;
      return;
    }
    if (canAct().length <= 1) {
      ended = "runout";
      toAct = null;
      return;
    }
    settled = seats.reduce((a, s) => a + s.totalIn, 0);
    street = STREETS[STREETS.indexOf(street) + 1];
    base.reached.push(street);
    if (!boardFor[street]) warn("missing", "board-missing", `${street === "flop" ? "플랍" : street === "turn" ? "턴" : "리버"} 카드 기록이 없습니다`);
    for (const s of seats) {
      s.streetIn = 0;
      s.acted = false;
      s.actedAtBet = 0;
    }
    currentBet = 0;
    lastRaise = bbNominal;
    toAct = nextFrom((bi + 1) % n, true);
    if (toAct === null) roundEnd();
  };
  const afterAction = (actorIdx: number) => {
    if (alive().length === 1) {
      refund();
      ended = "fold";
      toAct = null;
      return;
    }
    toAct = nextFrom(actorIdx, false);
    if (toAct === null) roundEnd();
  };

  toAct = nextFrom(first, true);
  if (toAct === null) roundEnd();

  const checkSnapshots = (index: number) => {
    for (const snap of hand.snapshots ?? []) {
      if (snap.beforeAction !== index) continue;
      const v = view();
      const stol = hand.unit === "bb" ? 0.011 : 1e-9;
      const push = (field: string, recorded: number, reconstructed: number, note?: string) =>
        base.snapshotChecks.push({ beforeAction: index, field, recorded, reconstructed, ok: Math.abs(recorded - reconstructed) <= stol, note });
      if (snap.pot !== undefined) {
        if (snap.potKind === "settled") push("팟(지난 스트리트까지)", snap.pot, v.potSettled);
        else if (snap.potKind === "total") push("팟(이번 스트리트 포함)", snap.pot, v.pot);
        else {
          const okTotal = Math.abs(snap.pot - v.pot) <= stol;
          const okSettled = Math.abs(snap.pot - v.potSettled) <= stol;
          push("팟", snap.pot, okSettled && !okTotal ? v.potSettled : v.pot, okTotal ? "이번 스트리트 베팅 포함 기준과 일치" : okSettled ? "지난 스트리트까지 기준과 일치" : "두 기준 모두 불일치");
        }
      }
      if (snap.toCall !== undefined && toAct !== null) {
        const s = bySeat.get(toAct)!;
        push(`${label(toAct)} 추가 콜`, snap.toCall, fromMilli(Math.max(0, currentBet - s.streetIn)));
      }
      for (const [k, val] of Object.entries(snap.stacks ?? {})) {
        const s = bySeat.get(Number(k));
        if (s) push(`${label(s.seat)} 남은 스택`, val, fromMilli(s.stack));
      }
    }
  };

  hand.actions.forEach((a, index) => {
    if (hasError()) return;
    checkSnapshots(index);
    if (ended !== "incomplete") {
      err("position", "after-end", `핸드가 끝난 뒤(${ended === "fold" ? "폴드로 종료" : "베팅 종료"})에 액션 #${index + 1} 이 있습니다`, index);
      return;
    }
    if (a.street !== street) {
      const want = STREETS.indexOf(street);
      const got = STREETS.indexOf(a.street);
      err("position", "street", got > want ? `액션 #${index + 1}: ${street} 베팅이 아직 끝나지 않았는데 ${a.street} 액션이 나왔습니다 (${label(toAct!)} 차례)` : `액션 #${index + 1}: 이미 ${street} 인데 ${a.street} 액션이 나왔습니다`, index);
      return;
    }
    if (a.seat !== toAct) {
      err("position", "order", `액션 #${index + 1}: ${label(toAct!)} 차례인데 ${label(a.seat)} 가 행동했습니다`, index);
      return;
    }
    const s = bySeat.get(a.seat)!;
    const before = view();
    const legal = legalFor(s);
    const norm = applyAction(a, s, index);
    if (!norm) return;
    afterAction(idxOf.get(s.seat)!);
    base.steps.push({ index, action: norm, before, legal, after: view() });
  });

  function applyAction(a: ActionRecord, s: Seat, index: number): NormalizedAction | null {
    const pre = `액션 #${index + 1} ${label(s.seat)}`;
    const toCall = Math.max(0, currentBet - s.streetIn);
    const callAdd = Math.min(toCall, s.stack);
    for (const [k, v] of [["add", a.add], ["to", a.to]] as const) {
      if (v !== undefined && (!Number.isFinite(v) || v < 0 || !isMilliExact(v))) {
        err("amount", "amount-bad", `${pre}: ${k} 금액 ${v} 이 올바르지 않습니다`, index);
        return null;
      }
    }
    const addM = a.add !== undefined ? toMilli(a.add) : undefined;
    const toM = a.to !== undefined ? toMilli(a.to) : undefined;
    let add = 0;
    let fullRaise = false;
    if (a.type === "fold") {
      if (toCall === 0) warn("position", "fold-free", `${pre}: 체크할 수 있는데 폴드했습니다`, index);
      if ((addM ?? 0) > 0) {
        err("amount", "fold-amount", `${pre}: 폴드에 금액이 있습니다`, index);
        return null;
      }
      s.folded = true;
    } else if (a.type === "check") {
      if (toCall > 0) {
        err("position", "check-facing", `${pre}: 콜할 금액 ${fromMilli(toCall)} 이 있는데 체크로 기록됐습니다`, index);
        return null;
      }
    } else if (a.type === "call") {
      if (toCall === 0) {
        err("position", "call-free", `${pre}: 콜할 금액이 없습니다 (체크로 기록해야 합니다)`, index);
        return null;
      }
      add = callAdd;
      if (addM !== undefined && Math.abs(addM - add) > tol) {
        err("amount", "call-add", `${pre}: 기록된 추가 콜 ${a.add} 이 재구성한 추가 콜 ${fromMilli(add)} 과 다릅니다 (목표액 ${fromMilli(s.streetIn + add)})`, index);
        return null;
      }
      if (toM !== undefined && Math.abs(toM - (s.streetIn + add)) > tol) {
        err("amount", "call-to", `${pre}: 기록된 콜 목표액 ${a.to} 이 재구성한 목표액 ${fromMilli(s.streetIn + add)} 과 다릅니다 (추가 콜 ${fromMilli(add)})`, index);
        return null;
      }
      if (a.allIn === true && add !== s.stack) {
        err("amount", "call-allin", `${pre}: 올인 콜로 기록됐지만 추가 콜 ${fromMilli(add)} 이 스택 ${fromMilli(s.stack)} 보다 작습니다`, index);
        return null;
      }
    } else {
      if (a.type === "bet" && currentBet > 0) {
        err("position", "bet-facing", `${pre}: 이미 ${fromMilli(currentBet)} 베팅이 있어 벳이 아니라 레이즈입니다`, index);
        return null;
      }
      if (a.type === "raise" && currentBet === 0) {
        err("position", "raise-free", `${pre}: 베팅이 없어 레이즈가 아니라 벳입니다`, index);
        return null;
      }
      const lg = legalFor(s);
      if (lg.raiseBlockedBy) {
        err("position", "raise-blocked", `${pre}: ${a.type === "bet" ? "벳" : "레이즈"}할 수 없는 상황입니다 — ${lg.raiseBlockedBy}`, index);
        return null;
      }
      let to: number;
      if (addM !== undefined && toM !== undefined) {
        if (Math.abs(toM - (s.streetIn + addM)) > tol) {
          err("amount", "add-to-mismatch", `${pre}: 추가 금액 ${a.add} 과 목표액 ${a.to} 이 맞지 않습니다 (이미 낸 ${fromMilli(s.streetIn)} + 추가 ${a.add} = ${fromMilli(s.streetIn + addM)})`, index);
          return null;
        }
        to = toM;
      } else if (toM !== undefined) to = toM;
      else if (addM !== undefined) to = s.streetIn + addM;
      else if (a.allIn) to = s.streetIn + s.stack;
      else {
        err("amount", "no-amount", `${pre}: ${a.type === "bet" ? "벳" : "레이즈"} 금액(추가액 또는 목표액)이 없습니다`, index);
        return null;
      }
      const maxTo = s.streetIn + s.stack;
      if (to > maxTo && to - maxTo <= tol) to = maxTo; // 소수 반올림 차이만 맞춘다
      if (to > maxTo) {
        err("amount", "over-stack", `${pre}: 목표액 ${fromMilli(to)} 이 가능한 최대(이미 낸 ${fromMilli(s.streetIn)} + 스택 ${fromMilli(s.stack)} = ${fromMilli(maxTo)})를 넘습니다`, index);
        return null;
      }
      if (a.allIn && to < maxTo) {
        if (maxTo - to <= tol) to = maxTo;
        else {
          err("amount", "allin-short", `${pre}: 올인으로 기록됐지만 목표액 ${fromMilli(to)} 이 올인 금액 ${fromMilli(maxTo)} 보다 작습니다`, index);
          return null;
        }
      }
      if (to <= currentBet) {
        err("amount", "not-raise", `${pre}: 목표액 ${fromMilli(to)} 이 현재 베팅 ${fromMilli(currentBet)} 이하입니다 (${to === maxTo ? "모자란 올인은 콜로 기록" : "콜로 기록"})`, index);
        return null;
      }
      const inc = to - currentBet;
      const allIn = to === maxTo;
      const minInc = currentBet === 0 ? bbNominal : lastRaise;
      fullRaise = inc >= minInc;
      if (!fullRaise && !allIn) {
        err("amount", "min-raise", `${pre}: 최소 ${currentBet === 0 ? "벳" : "레이즈"} 미달입니다 (목표 ${fromMilli(to)}, 최소 목표 ${fromMilli(currentBet + minInc)})`, index);
        return null;
      }
      add = to - s.streetIn;
      if (fullRaise) lastRaise = inc;
      currentBet = to;
    }
    s.stack -= add;
    s.streetIn += add;
    s.totalIn += add;
    if (s.stack === 0 && !s.folded) s.allIn = true;
    if (a.type !== "fold") {
      s.acted = true;
      s.actedAtBet = currentBet;
    }
    if (a.allIn === false && s.allIn) warn("amount", "allin-flag", `${pre}: 올인이 아니라고 기록됐지만 스택을 모두 넣었습니다`, index);
    return { index, street, seat: s.seat, position: s.position, type: a.type, add: fromMilli(add), to: fromMilli(s.streetIn), allIn: s.allIn, fullRaise };
  }

  checkSnapshots(hand.actions.length);
  base.ok = !hasError();
  base.ended = base.ok ? ended : "incomplete";
  base.final = view();
  base.finalMilli = seats.map((s) => ({ seat: s.seat, stack: s.stack, totalIn: s.totalIn, deadIn: s.deadIn, folded: s.folded }));
  if (base.ok && ended === "incomplete" && toAct !== null) base.pending = { seat: toAct, state: view(), legal: legalFor(bySeat.get(toAct)!) };
  if (base.ok && hand.complete && ended === "incomplete") err("position", "not-finished", `완료 핸드로 표시됐지만 ${label(toAct ?? 0)} 의 액션이 남아 있습니다`);
  // 칩 보존: 시작 스택 합 = 남은 스택 합 + 팟
  const startSum = seats.reduce((a, s) => a + s.start, 0);
  const nowSum = seats.reduce((a, s) => a + s.stack + s.totalIn, 0);
  if (startSum !== nowSum) err("amount", "conservation", `칩 보존 실패: 시작 ${fromMilli(startSum)} ≠ 남은 스택+팟 ${fromMilli(nowSum)}`);
  // 팟 층의 합은 팟 전체와 같아야 한다 (층 나누기에서 돈이 새거나 생기지 않는지)
  const layered = potLayersMilli(base.finalMilli).reduce((a, l) => a + l.amount, 0);
  const potSum = seats.reduce((a, s) => a + s.totalIn, 0);
  if (layered !== potSum) err("amount", "pot-layers", `팟 층의 합 ${fromMilli(layered)} 이 팟 ${fromMilli(potSum)} 과 다릅니다`);
  base.ok = !hasError();
  return base;
}

/** 사후 결과: 종료된 핸드의 팟 분배. 판단 분석에는 쓰지 않는다 */
export function computeOutcome(hand: HandRecord, rp: ReplayResult) {
  const board = [...(hand.board.flop ?? []), ...(hand.board.turn ? [hand.board.turn] : []), ...(hand.board.river ? [hand.board.river] : [])];
  const shown = hand.showdown ?? [];
  const startSum = rp.startMilli.reduce((a, s) => a + s.start, 0);
  const res = {
    known: false,
    reason: undefined as string | undefined,
    ended: rp.ended,
    board,
    shown,
    awards: [] as Array<{ seat: number; amount: number }>,
    finalStacks: [] as Array<{ seat: number; stack: number }>,
    heroNet: null as number | null,
    conservation: null as { start: number; end: number; ok: boolean } | null
  };
  if (!rp.ok || rp.ended === "incomplete") {
    res.reason = rp.ok ? "핸드가 끝나지 않았습니다" : "재구성에 실패했습니다";
    return res;
  }
  const layers = potLayersMilli(rp.finalMilli);
  const award = new Map<number, number>();
  if (rp.ended === "fold") {
    const w = rp.finalMilli.find((s) => !s.folded)!;
    award.set(w.seat, layers.reduce((a, l) => a + l.amount, 0));
  } else {
    if (board.length !== 5) {
      res.reason = "보드 5장이 기록되지 않아 승자를 정할 수 없습니다";
      return res;
    }
    const live = rp.finalMilli.filter((s) => !s.folded);
    const score = new Map<number, number>();
    for (const s of live) {
      const sd = shown.find((x) => x.seat === s.seat);
      if (!sd || sd.cards.length !== 2) {
        res.reason = `${rp.positions[s.seat]}(${s.seat}번)의 쇼다운 카드가 없어 결과를 계산할 수 없습니다`;
        return res;
      }
      score.set(s.seat, evaluate([...sd.cards, ...board].map(parseCard), 7));
    }
    const integerChips = hand.unit === "chips" && rp.startMilli.every((s) => s.start % MILLI === 0);
    const g = integerChips ? MILLI : 1;
    const clockFromButton = rp.order.length === 2 ? [rp.bbSeat!, rp.sbSeat!] : [...rp.order.slice(rp.order.indexOf(rp.sbSeat!)), ...rp.order.slice(0, rp.order.indexOf(rp.sbSeat!))];
    for (const l of layers) {
      const best = Math.max(...l.eligible.map((s) => score.get(s) ?? -1));
      const winners = clockFromButton.filter((s) => l.eligible.includes(s) && score.get(s) === best);
      const share = Math.floor(l.amount / (winners.length * g)) * g;
      let rest = l.amount - share * winners.length;
      for (const w of winners) award.set(w, (award.get(w) ?? 0) + share);
      // 나누어 떨어지지 않는 칩은 버튼 왼쪽부터 한 칩씩 (가정)
      for (let k = 0; rest > 0; k++, rest -= g) award.set(winners[k % winners.length], award.get(winners[k % winners.length])! + Math.min(g, rest));
    }
  }
  res.known = true;
  res.awards = [...award.entries()].map(([seat, a]) => ({ seat, amount: fromMilli(a) }));
  res.finalStacks = rp.finalMilli.map((s) => ({ seat: s.seat, stack: fromMilli(s.stack + (award.get(s.seat) ?? 0)) }));
  const endSum = rp.finalMilli.reduce((a, s) => a + s.stack + (award.get(s.seat) ?? 0), 0);
  res.conservation = { start: fromMilli(startSum), end: fromMilli(endSum), ok: startSum === endSum };
  const hero = rp.startMilli.find((s) => s.seat === hand.hero.seat);
  if (hero) res.heroNet = res.finalStacks.find((s) => s.seat === hand.hero.seat)!.stack - fromMilli(hero.start);
  return res;
}
