import { useEffect, useMemo, useState } from "react";
import { RANKS, SUITS, makeCard, parseCards } from "../engine/cards";
import { cardLabel, suitClass } from "./format";

export function PlayingCard({ card, size }: { card: number; size?: "sm" }) {
  return <span className={`pcard ${suitClass(card)} ${size ?? ""}`}>{cardLabel(card)}</span>;
}
export function GhostCard({ size }: { size?: "sm" }) {
  return <span className={`pcard ghost ${size ?? ""}`}>?</span>;
}
export function Board({ cards, slots = 5, size }: { cards: number[]; slots?: number; size?: "sm" }) {
  const out = [];
  for (let i = 0; i < slots; i++) out.push(cards[i] !== undefined ? <PlayingCard key={i} card={cards[i]} size={size} /> : <GhostCard key={i} size={size} />);
  return <span className="board">{out}</span>;
}

export function BoardInput({ value, onChange, min = 3, max = 5 }: { value: string; onChange: (v: string, cards: number[] | null) => void; min?: number; max?: number }) {
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    try {
      const cards = value.trim() === "" ? [] : parseCards(value);
      if (cards.length < min || cards.length > max) {
        setErr(`보드는 ${min}~${max}장이어야 합니다`);
        onChange(value, null);
      } else {
        setErr(null);
        onChange(value, cards);
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      onChange(value, null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);
  let cards: number[] = [];
  try {
    cards = parseCards(value);
  } catch {
    cards = [];
  }
  return (
    <div className="col">
      <div className="row">
        <input value={value} onChange={(e) => onChange(e.target.value, null)} placeholder="예: Ks7d2c 또는 Ks 7d 2c Th" style={{ width: 200 }} spellCheck={false} />
        <Board cards={cards} slots={max} size="sm" />
        <button
          type="button"
          className="ghost"
          onClick={() => {
            const deck: number[] = [];
            for (let c = 0; c < 52; c++) deck.push(c);
            for (let i = deck.length - 1; i > 0; i--) {
              const j = Math.floor(Math.random() * (i + 1));
              [deck[i], deck[j]] = [deck[j], deck[i]];
            }
            const n = Math.max(min, 3);
            onChange(deck.slice(0, n).map((c) => RANKS[c >> 2] + SUITS[c & 3]).join(""), null);
          }}
        >
          랜덤 플랍
        </button>
      </div>
      {err && <div className="error">{err}</div>}
    </div>
  );
}

/** 13x4 카드 선택기 */
export function CardPicker({ disabled, onPick, highlight }: { disabled: Set<number>; onPick: (card: number) => void; highlight?: (card: number) => string | undefined }) {
  const rows = [];
  for (let s = 3; s >= 0; s--) {
    const cells = [];
    for (let r = 12; r >= 0; r--) {
      const c = makeCard(r, s);
      cells.push(
        <button key={c} className={suitClass(c)} disabled={disabled.has(c)} onClick={() => onPick(c)} style={{ background: highlight?.(c) }}>
          {cardLabel(c)}
        </button>
      );
    }
    rows.push(cells);
  }
  return <div className="card-picker">{rows.flat()}</div>;
}

export function useHashRoute(): { path: string; params: URLSearchParams; navigate: (path: string, params?: Record<string, string>) => void } {
  const [hash, setHash] = useState(window.location.hash);
  useEffect(() => {
    const h = () => setHash(window.location.hash);
    window.addEventListener("hashchange", h);
    return () => window.removeEventListener("hashchange", h);
  }, []);
  const { path, params } = useMemo(() => {
    const raw = hash.replace(/^#/, "") || "/";
    const q = raw.indexOf("?");
    return { path: q >= 0 ? raw.slice(0, q) : raw, params: new URLSearchParams(q >= 0 ? raw.slice(q + 1) : "") };
  }, [hash]);
  const navigate = (p: string, prm?: Record<string, string>) => {
    const sp = new URLSearchParams(prm ?? {});
    const s = sp.toString();
    window.location.hash = p + (s ? "?" + s : "");
  };
  return { path, params, navigate };
}

export function Spinner({ text }: { text?: string }) {
  return <span className="muted">⏳ {text ?? "계산 중…"}</span>;
}

export function numList(s: string): number[] {
  return s
    .split(/[\s,]+/)
    .map((x) => parseFloat(x))
    .filter((x) => isFinite(x) && x > 0);
}

export function fmtBytes(b: number): string {
  if (b < 1024 * 1024) return (b / 1024).toFixed(0) + " KB";
  if (b < 1024 * 1024 * 1024) return (b / 1024 / 1024).toFixed(0) + " MB";
  return (b / 1024 / 1024 / 1024).toFixed(2) + " GB";
}

export function fmtMs(ms: number): string {
  if (ms < 1000) return ms.toFixed(0) + "ms";
  if (ms < 60000) return (ms / 1000).toFixed(1) + "초";
  return (ms / 60000).toFixed(1) + "분";
}
