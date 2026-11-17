// 미래 정보 차단: 각 판단 시점에 그때 알 수 있던 것만 담은 DecisionView 를 만든다.
// 들어가는 것: 내 카드, 그 스트리트까지 공개된 보드, 그 판단 전 액션, 초기 스택·강제 베팅, 대회 정보(핸드 전에 아는 것), 사용자 가정.
// 빠지는 것: 이후 액션, 이후 보드 카드, 쇼다운 카드, 결과, 이후 스냅샷. 분석 함수는 이 보기만 받는다.
import type { ReplayResult } from "./replay-state";
import type { ForcedBet, HandRecord, LegalView, NormalizedAction, StateView, Street, TournamentRecord } from "./types";

export interface DecisionView {
  handId: string;
  /** 이 판단이 액션 목록의 몇 번째인지 (기록이 내 차례에서 끝났으면 actions.length) */
  decisionIndex: number;
  street: Street;
  seat: number;
  position: string;
  unit: HandRecord["unit"];
  bigBlind: number | null;
  bbNominal: number;
  heroCards: string[] | null;
  board: string[];
  order: number[];
  positions: Record<number, string>;
  seats: Array<{ seat: number; position: string; start: number }>;
  forced: ForcedBet[];
  history: NormalizedAction[];
  state: StateView;
  legal: LegalView;
  /** 이 판단에서 실제로 한 행동. 기록이 여기서 끝났으면 null. 선택지의 EV 계산에는 쓰지 않는다 */
  actual: NormalizedAction | null;
  tournament: TournamentRecord | null;
  assumedRanges: Record<string, string>;
}

export function visibleBoard(hand: HandRecord, street: Street): string[] {
  const b = hand.board;
  if (street === "preflop") return [];
  const out = [...(b.flop ?? [])];
  if ((street === "turn" || street === "river") && b.turn) out.push(b.turn);
  if (street === "river" && b.river) out.push(b.river);
  return out;
}

/** 내 판단 시점마다 보기를 만든다 (재구성에 성공한 범위 안에서만) */
export function decisionViews(hand: HandRecord, rp: ReplayResult): DecisionView[] {
  const common = {
    handId: hand.id,
    unit: hand.unit,
    bigBlind: hand.bigBlind,
    bbNominal: rp.bbNominal,
    heroCards: hand.hero.cards ? [...hand.hero.cards] : null,
    order: [...rp.order],
    positions: { ...rp.positions },
    seats: rp.startMilli.map((s) => ({ seat: s.seat, position: rp.positions[s.seat], start: s.start / 1000 })),
    forced: hand.forced.map((f) => ({ ...f })),
    tournament: hand.tournament ? { ...hand.tournament, payouts: [...hand.tournament.payouts], otherStacks: [...hand.tournament.otherStacks] } : null,
    assumedRanges: { ...(hand.assumptions?.ranges ?? {}) }
  };
  const views: DecisionView[] = [];
  rp.steps.forEach((st, k) => {
    if (st.action.seat !== hand.hero.seat) return;
    views.push({
      ...common,
      decisionIndex: st.index,
      street: st.before.street,
      seat: st.action.seat,
      position: st.action.position,
      board: visibleBoard(hand, st.before.street),
      history: rp.steps.slice(0, k).map((s) => ({ ...s.action })),
      state: st.before,
      legal: st.legal,
      actual: { ...st.action }
    });
  });
  if (rp.pending && rp.pending.seat === hand.hero.seat) {
    views.push({
      ...common,
      decisionIndex: hand.actions.length,
      street: rp.pending.state.street,
      seat: rp.pending.seat,
      position: rp.positions[rp.pending.seat],
      board: visibleBoard(hand, rp.pending.state.street),
      history: rp.steps.map((s) => ({ ...s.action })),
      state: rp.pending.state,
      legal: rp.pending.legal,
      actual: null
    });
  }
  return views;
}
