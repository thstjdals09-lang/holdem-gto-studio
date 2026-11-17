// 복기 도구의 데이터 계약. 문서: docs/review/DATA-CONTRACT.md (같은 내용을 사람이 읽는 형태로 적었다)
// 금액은 모두 hand.unit 단위(칩 또는 BB)다. 내부 계산은 정수 milli(× 1000)로 한다.

export const HAND_SCHEMA = "holdem-review-hand/1" as const;
export const REPORT_SCHEMA = "holdem-review-report/1" as const;
export const REVIEW_VERSION = "0.1.0";

export type Street = "preflop" | "flop" | "turn" | "river";
export const STREETS: readonly Street[] = ["preflop", "flop", "turn", "river"];
export const STREET_KO: Record<Street, string> = { preflop: "프리플랍", flop: "플랍", turn: "턴", river: "리버" };
export type AmountUnit = "chips" | "bb";
export type ActType = "fold" | "check" | "call" | "bet" | "raise";
export type ForcedKind = "sb" | "bb" | "ante" | "bb-ante";

export interface SeatRecord {
  /** 좌석 번호. 번호가 커지는 쪽이 시계 방향 */
  seat: number;
  name?: string;
  /** 블라인드·앤티를 내기 전 초기 스택. 모르면 null (0으로 채우지 않는다) */
  stack: number | null;
  /** 가져오기 참고값: 앤티를 낸 뒤 관측한 스택(블라인드 포함). 초기 스택으로 쓰지 않는다 */
  observedStackAfterAnte?: number;
}
/** 실제로 낸 금액. 스택이 모자라 덜 냈으면 낸 만큼 적는다 */
export interface ForcedBet {
  seat: number;
  kind: ForcedKind;
  amount: number;
}
export interface ActionRecord {
  street: Street;
  seat: number;
  type: ActType;
  /** 이번 액션으로 추가로 넣은 금액 */
  add?: number;
  /** 이번 액션 뒤 이 스트리트에서 그 자리가 넣은 누적 금액(목표액). 블라인드 포함 */
  to?: number;
  /** 기록에 올인 표시가 있으면 true */
  allIn?: boolean;
}
export interface ShowdownRecord {
  seat: number;
  cards: string[];
}
export interface SnapshotRecord {
  /** 이 번호의 액션 직전 상태 (0부터) */
  beforeAction: number;
  pot?: number;
  /** pot 이 이번 스트리트 베팅을 포함하는지. 모르면 생략(둘 다 대조) */
  potKind?: "total" | "settled";
  toCall?: number;
  /** 좌석 번호 → 남은 스택 */
  stacks?: Record<string, number>;
  label?: string;
}
export interface TournamentRecord {
  kind: "standard" | "satellite";
  /** 1위부터 지급액. 새틀라이트는 같은 티켓 값을 좌석 수만큼 */
  payouts: number[];
  /** 이 테이블 밖에 남은 모든 플레이어의 스택(핸드와 같은 단위). 이 테이블이 전체 필드면 [] */
  otherStacks: number[];
  payoutUnit?: string;
}
export interface HandRecord {
  schema: typeof HAND_SCHEMA;
  id: string;
  complete: boolean;
  source: { kind: "manual" | "json" | "lulu-decision-log" | "example"; detail?: string };
  unit: AmountUnit;
  /** unit 단위의 BB 크기. unit 이 bb 면 1. 모르면 null */
  bigBlind: number | null;
  buttonSeat: number;
  seats: SeatRecord[];
  hero: { seat: number; cards: string[] | null };
  forced: ForcedBet[];
  actions: ActionRecord[];
  board: { flop?: string[]; turn?: string; river?: string };
  showdown?: ShowdownRecord[];
  snapshots?: SnapshotRecord[];
  tournament?: TournamentRecord;
  /** 사용자가 직접 넣은 가정. 분석 결과에 "사용자 가정"으로 표시된다 */
  assumptions?: { ranges?: Record<string, string> };
  /** 가져오기에서 확인하지 못한 항목 */
  missing?: string[];
  notes?: string[];
}

export type IssueCategory = "format" | "amount" | "position" | "missing" | "data" | "range" | "ev";
export const CATEGORY_KO: Record<IssueCategory, string> = {
  format: "형식 오류",
  amount: "금액/단위 오류",
  position: "포지션·액션 재구성 오류",
  missing: "정보 부족으로 판단 불가",
  data: "맞지 않는 전략 자료",
  range: "범위 추정 문제",
  ev: "검증 가능한 EV 차이"
};
export interface Issue {
  severity: "error" | "warn";
  category: IssueCategory;
  code: string;
  message: string;
  actionIndex?: number;
}

export type DecisionStatus = "analyzed" | "approximate" | "unsupported" | "invalid";
export const STATUS_KO: Record<DecisionStatus, string> = { analyzed: "분석됨", approximate: "근사", unsupported: "미지원", invalid: "잘못된 입력" };

export interface PotLayer {
  amount: number;
  eligible: number[];
}
export interface SeatView {
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
}
/** 의사결정 직전 상태 (금액은 hand.unit) */
export interface StateView {
  street: Street;
  seats: SeatView[];
  pot: number;
  /** 지난 스트리트까지 정산된 팟 */
  potSettled: number;
  currentBet: number;
  toAct: number | null;
}
export interface LegalView {
  seat: number;
  toCall: number;
  callAdd: number;
  canCheck: boolean;
  canCall: boolean;
  canBet: boolean;
  canRaise: boolean;
  /** 베팅·레이즈 최소 목표액 (올인이 더 작으면 올인 금액) */
  minTo: number | null;
  maxTo: number;
  /** 재레이즈가 막힌 이유 (짧은 올인 등) */
  raiseBlockedBy?: string;
}
export interface NormalizedAction {
  index: number;
  street: Street;
  seat: number;
  position: string;
  type: ActType;
  add: number;
  to: number;
  allIn: boolean;
  /** 벳·레이즈가 최소 레이즈 이상(재오픈)인지. 짧은 올인이면 false */
  fullRaise: boolean;
}

export interface RangeStep {
  street: Street;
  label: string;
  massBefore: number;
  massAfter: number;
}
export interface RangeTrace {
  seat: number;
  position: string;
  source: "library" | "user" | "none";
  sourceDetail: string;
  conditioned: boolean;
  steps: RangeStep[];
  blockedCards: string[];
  combos: number;
  top: Array<{ hand: string; weight: number }>;
  notes: string[];
}

export interface OptionView {
  label: string;
  type: string;
  to?: number;
  add?: number;
  /** 이 모델에서 내 핸드의 빈도 (0~1). 계산하지 않았으면 null */
  freq: number | null;
  /** 이 시점에서 폴드 = 0 으로 둔 EV. 계산하지 않았으면 null */
  ev: number | null;
  evSe?: number | null;
  isActual: boolean;
}
export interface IcmScenario {
  label: string;
  prob: number;
  heroStack: number;
  heroEquity: number;
}
export interface IcmDecision {
  method: "exact" | "monte-carlo";
  samples?: number;
  fieldSize: number;
  prizePool: number;
  payoutUnit: string;
  foldEquity: number;
  callEquity: number;
  callEquitySe: number;
  diff: number;
  scenarios: IcmScenario[];
  chipEvBb: number | null;
  verdict: string;
  assumptions: string[];
}
export interface Verdict {
  kind: "best" | "mixed" | "within-noise" | "ev-loss" | "unknown";
  evLoss?: number;
  text: string;
}
export interface DecisionAnalysis {
  status: DecisionStatus;
  decisionIndex: number;
  street: Street;
  seat: number;
  position: string;
  viewHash: string;
  heroCards: string[] | null;
  board: string[];
  state: StateView;
  legal: LegalView | null;
  pots: PotLayer[];
  metrics: { pot: number; toCall: number; potOdds: number | null; effStack: number; spr: number | null; potBb: number | null; toCallBb: number | null };
  actual: { type: string; add: number; to: number; allIn: boolean; label: string } | null;
  method: "preflop-library" | "allin-closed" | "none";
  evUnit: string;
  options: OptionView[];
  verdict: Verdict;
  ranges: RangeTrace[];
  data?: { formatId: string; sha256: string; manifestMatch: boolean | null; iterations: number; exploitabilityBb: number; generatedAt: string; conditions: string[] };
  icm?: IcmDecision;
  icmUnavailable?: string;
  quality: { ms: number; method: string; samples?: number; seed?: number; enumeration?: boolean; notes: string[] };
  assumptions: string[];
  limitations: string[];
  unsupportedReasons: string[];
  categories: IssueCategory[];
}
export interface OutcomeView {
  known: boolean;
  reason?: string;
  ended: "fold" | "showdown" | "runout" | "incomplete";
  board: string[];
  shown: ShowdownRecord[];
  awards: Array<{ seat: number; amount: number }>;
  finalStacks: Array<{ seat: number; stack: number }>;
  heroNet: number | null;
  conservation: { start: number; end: number; ok: boolean } | null;
}
export interface SnapshotCheck {
  beforeAction: number;
  field: string;
  recorded: number;
  reconstructed: number;
  ok: boolean;
  note?: string;
}
export interface AnalyzeOptions {
  seed: number;
  samples: number;
  icmSamples: number;
}
export const DEFAULT_OPTIONS: AnalyzeOptions = { seed: 1, samples: 20000, icmSamples: 20000 };
export interface HandReport {
  schema: typeof REPORT_SCHEMA;
  handId: string;
  inputHash: string;
  modelVersion: string;
  createdAt: string;
  options: AnalyzeOptions;
  unit: AmountUnit;
  bigBlind: number | null;
  issues: Issue[];
  replay: {
    ok: boolean;
    ended: OutcomeView["ended"];
    steps: number;
    refunds: Array<{ seat: number; amount: number; street: Street }>;
    snapshotChecks: SnapshotCheck[];
    conservationOk: boolean;
  };
  decisions: DecisionAnalysis[];
  /** 사후 결과. 판단 분석에 쓰지 않는다 */
  outcome: OutcomeView;
  ms: number;
}
