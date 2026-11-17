// 화면 공통 조각. 가져온 문자열은 모두 React 텍스트로만 넣는다(HTML 로 해석하지 않음).
import { STATUS_KO, type AmountUnit, type DecisionStatus } from "../types";

export function fmt(x: number | null | undefined, digits = 2): string {
  if (x === null || x === undefined || !Number.isFinite(x)) return "—";
  return x.toLocaleString("ko-KR", { maximumFractionDigits: digits });
}
export const pct = (x: number | null | undefined, digits = 1) => (x === null || x === undefined || !Number.isFinite(x) ? "—" : `${(x * 100).toFixed(digits)}%`);
export const unitKo = (u: AmountUnit) => (u === "bb" ? "BB" : "칩");

const SUIT: Record<string, [string, string]> = { c: ["♣", "클럽"], d: ["♦", "다이아"], h: ["♥", "하트"], s: ["♠", "스페이드"] };
export function Card({ c }: { c: string | null | undefined }) {
  if (!c) return <span className="card empty" aria-label="모르는 카드">?</span>;
  const [sym, name] = SUIT[c[1]] ?? ["?", "?"];
  return (
    <span className={`card${c[1] === "h" || c[1] === "d" ? " red" : ""}`} aria-label={`${name} ${c[0]}`}>
      {c[0]}
      {sym}
    </span>
  );
}
export function Cards({ cards, slots }: { cards: string[] | null | undefined; slots?: number }) {
  const list = cards ?? [];
  const n = Math.max(slots ?? 0, list.length);
  return (
    <span className="cards">
      {Array.from({ length: n }, (_, i) => (
        <Card key={i} c={list[i]} />
      ))}
    </span>
  );
}
export function StatusBadge({ s }: { s: DecisionStatus }) {
  return <span className={`badge b-${s}`}>{STATUS_KO[s]}</span>;
}
export function download(name: string, data: unknown) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
export function Notes({ kind, title, items }: { kind: "warn" | "bad" | "info" | "ok"; title: string; items: string[] }) {
  if (!items.length) return null;
  return (
    <div className={`note ${kind}`}>
      <strong>{title}</strong>
      <ul>
        {items.map((t, i) => (
          <li key={i}>{t}</li>
        ))}
      </ul>
    </div>
  );
}
