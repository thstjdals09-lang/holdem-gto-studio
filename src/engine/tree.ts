// 포스트플랍 베팅 트리 빌더. 단위는 bb(실수). 플레이어 0 = OOP, 1 = IP.
import { cardToString } from "./cards";

export type Street = 1 | 2 | 3; // 1 플랍, 2 턴, 3 리버
export const STREET_NAMES: Record<Street, string> = { 1: "플랍", 2: "턴", 3: "리버" };

export interface SizingSet {
  bet: number[]; // 팟 대비 %
  raise: number[]; // 팟(콜 포함) 대비 %
  donk?: number[]; // OOP 리드(donk) 사이즈. 비어 있으면 bet 사용
}
export interface StreetSizings {
  flop: SizingSet;
  turn: SizingSet;
  river: SizingSet;
}
export interface TreeConfig {
  board: number[]; // 3~5장
  pot: number; // 시작 팟 (bb)
  effStack: number; // 유효 스택 (bb, 각 플레이어가 더 넣을 수 있는 금액)
  rakePct: number; // 0~
  rakeCap: number; // bb, 0 = 캡 없음
  oop: StreetSizings;
  ip: StreetSizings;
  allinThresholdPct: number; // 벳/레이즈가 남은 스택의 이 % 이상이면 올인으로 치환. 0 = 끔
  maxRaisesPerStreet: number; // 스트리트당 벳+레이즈 최대 횟수 (예: 3 → 벳, 레이즈, 리레이즈)
  maxRaisesByStreet?: [number, number, number]; // [플랍, 턴, 리버] 개별 상한 (있으면 우선)
  allowDonk: boolean; // 이전 스트리트 어그레서가 IP일 때 OOP가 리드할 수 있는지
  includeAllin: boolean; // 사이즈 목록에 올인을 항상 추가
}

export type ActionType = "fold" | "check" | "call" | "bet" | "raise" | "allin";
export interface Action {
  type: ActionType;
  amount: number; // 이 액션으로 플레이어가 추가로 넣는 금액
  label: string; // 표시용 (예: "벳 75%", "레이즈 8.5")
  code: string; // URL용 짧은 코드 (F, X, C, B75, R50, A)
}

export interface DecisionNode {
  kind: "decision";
  id: number; // decisionNodes 배열 인덱스
  player: 0 | 1;
  street: Street;
  pot: number;
  invested: [number, number];
  toCall: number;
  actions: Action[];
  children: TreeNode[];
}
export interface ChanceNode {
  kind: "chance";
  id: number;
  street: Street; // 딜되는 스트리트 (2 턴, 3 리버)
  pot: number;
  invested: [number, number];
  children: (TreeNode | null)[]; // 카드 0..51 별 자식 (죽은 카드는 null)
  allin: boolean; // 양쪽 올인 상태의 런아웃
}
export interface TerminalNode {
  kind: "terminal";
  id: number;
  type: "fold" | "showdown";
  pot: number;
  invested: [number, number];
  folder: -1 | 0 | 1;
}
export type TreeNode = DecisionNode | ChanceNode | TerminalNode;

export interface GameTree {
  root: TreeNode;
  config: TreeConfig;
  startStreet: Street;
  decisionNodes: DecisionNode[];
  chanceNodes: ChanceNode[];
  terminals: TerminalNode[];
}

export interface TreeEstimate {
  decision: number;
  chance: number;
  terminal: number;
  actionSlots: number; // Σ actions over decision nodes
}

function round2(x: number): number {
  return Math.round(x * 100) / 100;
}

interface BuildState {
  street: Street;
  pot: number;
  invested: [number, number];
  toAct: 0 | 1;
  toCall: number;
  raises: number; // 이 스트리트의 벳+레이즈 수
  lastAggressor: -1 | 0 | 1; // 이 스트리트의 마지막 어그레서
  prevStreetAggressor: -1 | 0 | 1;
  checked: boolean; // 이 스트리트에서 OOP가 체크했는지 (IP 체크 시 스트리트 종료 판정용)
  dealt: number[]; // 보드 (시작 보드 + 런아웃)
}

export function streetOfBoard(n: number): Street {
  if (n === 3) return 1;
  if (n === 4) return 2;
  if (n === 5) return 3;
  throw new Error(`보드는 3~5장이어야 합니다 (현재 ${n}장)`);
}

function sizingsFor(cfg: TreeConfig, player: 0 | 1, street: Street): SizingSet {
  const s = player === 0 ? cfg.oop : cfg.ip;
  return street === 1 ? s.flop : street === 2 ? s.turn : s.river;
}

export function buildTree(cfg: TreeConfig): GameTree {
  const decisionNodes: DecisionNode[] = [];
  const chanceNodes: ChanceNode[] = [];
  const terminals: TerminalNode[] = [];
  const startStreet = streetOfBoard(cfg.board.length);
  const stackOf = (st: BuildState, p: 0 | 1) => cfg.effStack - st.invested[p];

  function terminal(st: BuildState, type: "fold" | "showdown", folder: -1 | 0 | 1): TerminalNode {
    const t: TerminalNode = {
      kind: "terminal",
      id: terminals.length,
      type,
      pot: st.pot,
      invested: [st.invested[0], st.invested[1]],
      folder
    };
    terminals.push(t);
    return t;
  }

  function nextStreet(st: BuildState, allin: boolean): TreeNode {
    if (st.street === 3) return terminal(st, "showdown", -1);
    const next = (st.street + 1) as Street;
    const node: ChanceNode = {
      kind: "chance",
      id: chanceNodes.length,
      street: next,
      pot: st.pot,
      invested: [st.invested[0], st.invested[1]],
      children: new Array(52).fill(null),
      allin
    };
    chanceNodes.push(node);
    const dead = new Set(st.dealt);
    // 자식은 카드별로 구조가 동일하므로 하나만 만들고 공유 (전략 배열은 노드별이므로 공유 불가)
    // → 솔버가 카드별 reach 마스크로 구분한다. 여기서는 구조 공유를 위해 대표 자식 하나를 만들고 모든 카드에 연결.
    const childState: BuildState = {
      street: next,
      pot: st.pot,
      invested: [st.invested[0], st.invested[1]],
      toAct: 0,
      toCall: 0,
      raises: 0,
      lastAggressor: -1,
      prevStreetAggressor: st.lastAggressor,
      checked: false,
      dealt: st.dealt
    };
    const child = allin ? nextStreet(childState, true) : decision(childState);
    for (let c = 0; c < 52; c++) if (!dead.has(c)) node.children[c] = child;
    return node;
  }

  function sizeActions(st: BuildState, player: 0 | 1): Action[] {
    const out: Action[] = [];
    const stack = stackOf(st, player);
    const oppStack = stackOf(st, player === 0 ? 1 : 0);
    const siz = sizingsFor(cfg, player, st.street);
    const maxPut = Math.min(stack, st.toCall + oppStack); // 상대가 콜할 수 있는 한도까지만 의미 있음
    if (stack <= 0) return out;
    const cap = cfg.maxRaisesByStreet ? cfg.maxRaisesByStreet[st.street - 1] : cfg.maxRaisesPerStreet;
    const canRaise = st.raises < cap;
    const amounts: Array<{ amt: number; type: ActionType; pct: number }> = [];
    if (st.toCall === 0) {
      let list = siz.bet;
      if (player === 0 && st.street !== startStreet && st.prevStreetAggressor === 1) {
        if (!cfg.allowDonk) list = [];
        else if (siz.donk && siz.donk.length > 0) list = siz.donk;
      }
      if (canRaise) {
        for (const pct of list) {
          let amt = round2((pct / 100) * st.pot);
          if (amt < 1) amt = 1;
          amounts.push({ amt, type: "bet", pct });
        }
      }
    } else if (canRaise && stack > st.toCall) {
      for (const pct of siz.raise) {
        // 콜 후 팟 기준 레이즈 금액
        const potAfterCall = st.pot + st.toCall;
        let raiseBy = round2((pct / 100) * potAfterCall);
        if (raiseBy < st.toCall) raiseBy = st.toCall; // 최소 레이즈
        amounts.push({ amt: round2(st.toCall + raiseBy), type: "raise", pct });
      }
    }
    const seen = new Set<number>();
    let hasAllin = false;
    for (const a of amounts) {
      let amt = a.amt;
      let type: ActionType = a.type;
      if (amt >= maxPut || (cfg.allinThresholdPct > 0 && amt >= (cfg.allinThresholdPct / 100) * stack)) {
        amt = maxPut;
        type = "allin";
      }
      amt = round2(amt);
      if (amt <= st.toCall) continue;
      if (seen.has(amt)) continue;
      seen.add(amt);
      if (type === "allin") hasAllin = true;
      const label =
        type === "allin"
          ? `올인 ${amt}`
          : a.type === "bet"
            ? `벳 ${a.pct}% (${amt})`
            : `레이즈 ${a.pct}% (${amt})`;
      const code = type === "allin" ? "A" : a.type === "bet" ? `B${a.pct}` : `R${a.pct}`;
      out.push({ type, amount: amt, label, code });
    }
    if (cfg.includeAllin && !hasAllin && canRaise && maxPut > st.toCall && !seen.has(round2(maxPut))) {
      out.push({ type: "allin", amount: round2(maxPut), label: `올인 ${round2(maxPut)}`, code: "A" });
    }
    out.sort((x, y) => x.amount - y.amount);
    return out;
  }

  function decision(st: BuildState): TreeNode {
    const player = st.toAct;
    const node: DecisionNode = {
      kind: "decision",
      id: decisionNodes.length,
      player,
      street: st.street,
      pot: st.pot,
      invested: [st.invested[0], st.invested[1]],
      toCall: st.toCall,
      actions: [],
      children: []
    };
    decisionNodes.push(node);
    const opp: 0 | 1 = player === 0 ? 1 : 0;
    const stack = stackOf(st, player);

    if (st.toCall > 0) {
      // 폴드
      node.actions.push({ type: "fold", amount: 0, label: "폴드", code: "F" });
      node.children.push(terminal(st, "fold", player));
      // 콜
      const callAmt = round2(Math.min(st.toCall, stack));
      node.actions.push({ type: "call", amount: callAmt, label: `콜 ${callAmt}`, code: "C" });
      const inv: [number, number] = [st.invested[0], st.invested[1]];
      inv[player] = round2(inv[player] + callAmt);
      const st2: BuildState = { ...st, invested: inv, pot: round2(st.pot + callAmt), toCall: 0 };
      const bothAllin = cfg.effStack - inv[0] <= 1e-9 || cfg.effStack - inv[1] <= 1e-9;
      node.children.push(nextStreet(st2, bothAllin));
    } else {
      // 체크
      node.actions.push({ type: "check", amount: 0, label: "체크", code: "X" });
      if (player === 1 || st.checked) {
        // IP 체크 → 스트리트 종료 (OOP가 먼저 체크한 뒤) / 또는 OOP 체크 후 IP 체크
        node.children.push(nextStreet({ ...st }, false));
      } else {
        node.children.push(decision({ ...st, toAct: 1, checked: true }));
      }
    }
    // 벳 / 레이즈 / 올인
    for (const a of sizeActions(st, player)) {
      node.actions.push(a);
      const inv: [number, number] = [st.invested[0], st.invested[1]];
      inv[player] = round2(inv[player] + a.amount);
      const newToCall = round2(inv[player] - inv[opp]);
      node.children.push(
        decision({
          ...st,
          invested: inv,
          pot: round2(st.pot + a.amount),
          toAct: opp,
          toCall: newToCall,
          raises: st.raises + 1,
          lastAggressor: player
        })
      );
    }
    return node;
  }

  // 체크 노드: IP가 체크하면 스트리트 종료인데, 위 로직에서 player===1 체크는 항상 종료로 처리됨.
  // (IP가 OOP의 벳에 "체크"할 수는 없으므로 toCall===0인 IP 노드는 항상 OOP 체크 이후다)
  const root = decision({
    street: startStreet,
    pot: cfg.pot,
    invested: [0, 0],
    toAct: 0,
    toCall: 0,
    raises: 0,
    lastAggressor: -1,
    prevStreetAggressor: -1,
    checked: false,
    dealt: cfg.board
  });
  return { root, config: cfg, startStreet, decisionNodes, chanceNodes, terminals };
}

/** 카드 공유 구조를 고려한 실제 노드 수 추정 (런아웃 카드 수를 곱함) */
export function estimateTree(cfg: TreeConfig): TreeEstimate & { bytesPerHandSlot: number } {
  const tree = buildTree(cfg);
  const startStreet = tree.startStreet;
  const remaining = 52 - cfg.board.length;
  // 각 결정 노드가 몇 개의 런아웃 아래에 복제되는지: 턴 노드 ×remaining, 리버 노드 ×remaining×(remaining-1)
  let decision = 0;
  let actionSlots = 0;
  for (const n of tree.decisionNodes) {
    let mult = 1;
    if (n.street > startStreet) mult *= remaining;
    if (n.street > startStreet + 1) mult *= remaining - 1;
    decision += mult;
    actionSlots += mult * n.actions.length;
  }
  let chance = 0;
  for (const n of tree.chanceNodes) {
    let mult = 1;
    if (n.street > startStreet + 1) mult *= remaining;
    chance += mult;
  }
  let terminal = 0;
  for (const n of tree.terminals) {
    // 터미널은 전략 저장이 없으므로 대략치만
    terminal += 1;
  }
  return { decision, chance, terminal, actionSlots, bytesPerHandSlot: 8 };
}

export function actionLineLabel(actions: Action[]): string {
  return actions.map((a) => a.label).join(" → ");
}

export function describeBoard(board: number[]): string {
  return board.map(cardToString).join(" ");
}
