import { useEffect, useMemo, useState } from "react";
import { CLASS_COMBOS, NUM_CLASSES } from "../engine/cards";
import { classWeights, parseRange, rangeToString, totalCombos, type RangeWeights } from "../engine/range";
import { RangeGrid } from "./RangeGrid";

export const SAMPLE_RANGES: Record<string, string> = {
  "예시: 6맥스 오픈 (타이트)": "22+,A2s+,K9s+,Q9s+,J9s+,T9s,98s,87s,76s,65s,ATo+,KJo+,QJo",
  "예시: BB 디펜스 (넓게)": "22+,A2s+,K2s+,Q4s+,J6s+,T6s+,96s+,85s+,75s+,64s+,53s+,43s,A2o+,K8o+,Q9o+,J9o+,T9o,98o",
  "예시: 3벳 (폴라)": "QQ+,AKs,AKo,A5s-A2s,KQs:0.5,76s:0.5,65s:0.5",
  "예시: 올 랜덤 100%": "22+,A2s+,K2s+,Q2s+,J2s+,T2s+,92s+,82s+,72s+,62s+,52s+,42s+,32s,A2o+,K2o+,Q2o+,J2o+,T2o+,92o+,82o+,72o+,62o+,52o+,42o+,32o"
};

export function RangeEditor({ value, onChange, label }: { value: string; onChange: (text: string) => void; label: string }) {
  const [text, setText] = useState(value);
  const [brush, setBrush] = useState(1);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => setText(value), [value]);
  const weights: RangeWeights = useMemo(() => {
    try {
      const w = parseRange(text);
      setError(null);
      return w;
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      return new Float32Array(1326);
    }
  }, [text]);
  const cw = useMemo(() => classWeights(weights), [weights]);
  const combos = useMemo(() => totalCombos(weights), [weights]);

  const paint = (cls: number) => {
    const w = new Float32Array(weights);
    for (const i of CLASS_COMBOS[cls]) w[i] = brush;
    const t = rangeToString(w);
    setText(t);
    onChange(t);
  };
  const commit = (t: string) => {
    setText(t);
    try {
      parseRange(t);
      onChange(t);
    } catch {
      /* 입력 중 오류는 표시만 */
    }
  };
  return (
    <div className="range-editor">
      <div className="re-head">
        <b>{label}</b>
        <span className="muted">{combos.toFixed(1)} 콤보 ({((combos / 1326) * 100).toFixed(1)}%)</span>
      </div>
      <RangeGrid mode="weight" weight={cw} onPaint={paint} size="sm" />
      <div className="re-tools">
        <label>
          브러시 가중치 {Math.round(brush * 100)}%
          <input type="range" min={0} max={100} step={5} value={Math.round(brush * 100)} onChange={(e) => setBrush(Number(e.target.value) / 100)} />
        </label>
        <select
          value=""
          onChange={(e) => {
            if (e.target.value) commit(SAMPLE_RANGES[e.target.value]);
          }}
        >
          <option value="">예시 레인지 불러오기…</option>
          {Object.keys(SAMPLE_RANGES).map((k) => (
            <option key={k} value={k}>
              {k}
            </option>
          ))}
        </select>
        <button type="button" className="ghost" onClick={() => commit("")}>
          지우기
        </button>
      </div>
      <textarea value={text} onChange={(e) => commit(e.target.value)} rows={3} spellCheck={false} placeholder="예: 22+,A2s+,KTs+,AJo+ (가중치는 KK:0.5 처럼)" />
      {error && <div className="error">{error}</div>}
    </div>
  );
}

export function emptyClassWeights(): Float32Array {
  return new Float32Array(NUM_CLASSES);
}
