import { cardToPretty, rankOf, suitOf, RANKS } from "../engine/cards";

export const ACTION_COLORS = {
  fold: "#3b82f6",
  check: "#22c55e",
  call: "#4ade80",
  bet: ["#f87171", "#ef4444", "#dc2626", "#b91c1c"],
  raise: ["#fb923c", "#f97316", "#ea580c", "#c2410c"],
  allin: "#7f1d1d"
};

/** 액션 목록에 색을 배정 (벳/레이즈는 크기 순으로 진하게) */
export function actionColors(actions: Array<{ type: string }>): string[] {
  let bet = 0;
  let raise = 0;
  const nBet = actions.filter((a) => a.type === "bet").length;
  const nRaise = actions.filter((a) => a.type === "raise").length;
  return actions.map((a) => {
    switch (a.type) {
      case "fold":
        return ACTION_COLORS.fold;
      case "check":
        return ACTION_COLORS.check;
      case "call":
        return ACTION_COLORS.call;
      case "allin":
        return ACTION_COLORS.allin;
      case "bet": {
        const idx = nBet <= 1 ? 1 : Math.min(3, Math.round((bet / (nBet - 1)) * 3));
        bet++;
        return ACTION_COLORS.bet[idx];
      }
      case "raise": {
        const idx = nRaise <= 1 ? 1 : Math.min(3, Math.round((raise / (nRaise - 1)) * 3));
        raise++;
        return ACTION_COLORS.raise[idx];
      }
      default:
        return "#888";
    }
  });
}

export function pct(x: number, digits = 1): string {
  if (!isFinite(x)) return "-";
  return (x * 100).toFixed(digits) + "%";
}
export function bb(x: number, digits = 2): string {
  if (!isFinite(x)) return "-";
  return x.toFixed(digits);
}
export function suitClass(card: number): string {
  return ["suit-c", "suit-d", "suit-h", "suit-s"][suitOf(card)];
}
export function cardLabel(card: number): string {
  return cardToPretty(card);
}
export function rankChar(card: number): string {
  return RANKS[rankOf(card)];
}

/** 0~1 값을 색으로 (낮음=빨강, 중간=회색, 높음=초록) */
export function heatColor(v: number, lo: number, hi: number): string {
  if (!isFinite(v) || hi <= lo) return "rgba(120,120,120,0.35)";
  const t = Math.max(0, Math.min(1, (v - lo) / (hi - lo)));
  // 빨강(0) → 회색(0.5) → 초록(1)
  const r = t < 0.5 ? 220 : Math.round(220 - (t - 0.5) * 2 * 160);
  const g = t < 0.5 ? Math.round(80 + t * 2 * 100) : 190;
  const b = 80;
  return `rgb(${r},${g},${b})`;
}

export const STREET_LABEL: Record<number, string> = { 1: "플랍", 2: "턴", 3: "리버" };
export const SEAT_LABEL = ["OOP", "IP"];
