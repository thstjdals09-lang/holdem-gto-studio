// 홀덤 GTO 솔버 SDK — 공개 API (브라우저·Node 공용, DOM 의존 없음)
export const VERSION = "1.0.0";

// 상위 API
export { GtoLibrary, DEFAULT_LIBRARY_URL, type LibraryOptions, type FormatInfo, type PreflopNodeView, type PreflopAction, type PreflopHand, type AnalyzedHand } from "./library";
export { createSolve, estimateSolve, presetSizings, treeConfigOf, byClass, byCombo, type SolveSpec, type SolveSession, type RunOptions, type SizePreset, type HandRow } from "./session";
export { browserSubPorts } from "./browser";

// 카드·레인지·평가
export { parseCard, parseCards, cardToString, cardsToString, comboIndex, comboToString, classLabel, classOfCombo, COMBO_CARDS, COMBO_CLASS, CLASS_COMBOS, NUM_COMBOS, NUM_CLASSES, RANKS, SUITS } from "../../src/engine/cards";
export { parseRange, rangeToString, emptyRange, totalCombos, classWeights, removeBoard, type RangeWeights } from "../../src/engine/range";
export { evaluate, categoryOf, describe as describeHand, CATEGORY_NAMES } from "../../src/engine/evaluator";
export { rangeVsRange, handVsHand, type EquityResult } from "../../src/engine/equity";
export { classifyMade, classifyDraw, MADE_ORDER, DRAW_ORDER } from "../../src/engine/categories";
export { icmEquities, bubbleFactors, requiredEquityWithBubble } from "../../src/engine/icm";

// 트리·솔버 (저수준)
export { buildTree, type TreeConfig, type SizingSet, type StreetSizings, type GameTree, type TreeNode, type DecisionNode, type ChanceNode, type TerminalNode, type Action } from "../../src/engine/tree";
export { PostflopSolver, buildHandSet, type PathStep, type SolverMetrics, type DecisionAnalysis, type HandSet } from "../../src/engine/solver";
export { ParallelPostflopSolver, LocalSubPort, MessageSubPort, serveSubRequests, handleSubRequest, type SubPort, type MessageEndpoint, type ParallelView, type NodeInfo, type NodeAnalysis } from "../../src/engine/parallel";
export { MultiSolver, buildMultiTree, type MultiTreeConfig } from "../../src/engine/multi";

// 프리플랍 (링 솔버·라이브러리 형식)
export { RingSolver, buildRingTree, buildCompat, RING_FORMATS, REALIZATION_TABLE, realizationAt, MW_EXPONENT, type RingConfig } from "../../src/engine/ring";
export { walkCodes, walkIdx, strategyOf, reachToCombos, seatIndex, type PfLib, type PfLibNode, type PfWalk } from "../../src/lib/preflopLib";

// 포스트플랍 라이브러리
export { MATCHUPS, FLOPS, FLOPS_SMALL, flopsFor, treeConfigFor, type Matchup, type FlopMeta, type MatchupIndex } from "../../src/lib/postflopLib";
export { LibSpot, setLibraryFetch, type LibraryFetch } from "../../src/worker/libspot";
export type { NodeView, DecisionView, ChanceView, TerminalView, ActionView, ComboView } from "../../src/worker/protocol";

// 핸드 히스토리
export { parseAll as parseHandHistories, parseHand, positionNames, type ParsedHand, type HHAction, type HHSeat } from "../../src/lib/hh";
export { analyzePreflop, matchFlop, pickFormat, verdictOf, type HandAnalysis, type DecisionGrade, type Verdict } from "../../src/lib/analyze";
