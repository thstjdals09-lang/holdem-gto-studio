import { useState } from "react";
import { NUM_CLASSES, classLabel } from "../engine/cards";
import { heatColor } from "./format";

export type GridMode = "strategy" | "ev" | "eq" | "eqr" | "weight";

export interface RangeGridProps {
  /** 169*A 클래스별 액션 빈도 (strategy 모드) */
  classFreq?: Float32Array;
  actionCount?: number;
  colors?: string[];
  /** 169 클래스 가중치 0~1 (셀 불투명도) */
  weight: Float32Array;
  /** 169 값 (ev/eq/eqr 모드) */
  values?: Float32Array;
  mode: GridMode;
  valueRange?: [number, number];
  selected?: number | null;
  onSelect?: (cls: number) => void;
  onHover?: (cls: number | null) => void;
  /** 편집 모드: 드래그로 가중치 설정 */
  onPaint?: (cls: number) => void;
  size?: "sm" | "md" | "lg";
  formatValue?: (v: number) => string;
}

export function RangeGrid(props: RangeGridProps) {
  const { classFreq, actionCount = 0, colors = [], weight, values, mode, selected, onSelect, onHover, onPaint, size = "md", valueRange, formatValue } = props;
  const [painting, setPainting] = useState(false);
  let lo = 0;
  let hi = 1;
  if (values && mode !== "strategy" && mode !== "weight") {
    if (valueRange) [lo, hi] = valueRange;
    else {
      lo = Infinity;
      hi = -Infinity;
      for (let c = 0; c < NUM_CLASSES; c++) {
        if (weight[c] <= 0.001) continue;
        const v = values[c];
        if (!isFinite(v)) continue;
        if (v < lo) lo = v;
        if (v > hi) hi = v;
      }
      if (!isFinite(lo)) {
        lo = 0;
        hi = 1;
      }
    }
  }
  const cells = [];
  for (let c = 0; c < NUM_CLASSES; c++) {
    const w = weight[c];
    let background = "";
    let text = classLabel(c);
    let sub = "";
    if (mode === "strategy" && classFreq && actionCount > 0) {
      const stops: string[] = [];
      let acc = 0;
      for (let a = 0; a < actionCount; a++) {
        const f = classFreq[c * actionCount + a];
        if (f <= 0.0005) continue;
        const start = acc * 100;
        acc += f;
        stops.push(`${colors[a]} ${start.toFixed(2)}% ${(acc * 100).toFixed(2)}%`);
      }
      background = stops.length ? `linear-gradient(90deg, ${stops.join(", ")})` : "transparent";
    } else if (mode === "weight") {
      background = w > 0 ? `rgba(170,251,178,${0.15 + 0.85 * Math.min(1, w)})` : "transparent";
    } else if (values) {
      background = w > 0.001 ? heatColor(values[c], lo, hi) : "transparent";
      if (w > 0.001) sub = formatValue ? formatValue(values[c]) : values[c].toFixed(2);
    }
    const opacity = mode === "weight" ? 1 : w <= 0 ? 0.08 : 0.35 + 0.65 * Math.min(1, w);
    cells.push(
      <div
        key={c}
        className={`cell ${selected === c ? "selected" : ""} ${w <= 0 ? "empty" : ""}`}
        style={{ background, opacity }}
        onMouseDown={(e) => {
          if (onPaint) {
            e.preventDefault();
            setPainting(true);
            onPaint(c);
          }
        }}
        onMouseEnter={() => {
          onHover?.(c);
          if (painting && onPaint) onPaint(c);
        }}
        onMouseUp={() => setPainting(false)}
        onClick={() => onSelect?.(c)}
        title={`${text}${sub ? " " + sub : ""}`}
      >
        <span className="lbl">{text}</span>
        {sub && <span className="sub">{sub}</span>}
      </div>
    );
  }
  return (
    <div
      className={`range-grid ${size}`}
      onMouseLeave={() => {
        setPainting(false);
        onHover?.(null);
      }}
      onMouseUp={() => setPainting(false)}
    >
      {cells}
    </div>
  );
}

export function GridLegend({ actions, colors }: { actions: Array<{ label: string; freq?: number }>; colors: string[] }) {
  return (
    <div className="legend">
      {actions.map((a, i) => (
        <span key={i} className="legend-item">
          <i style={{ background: colors[i] }} />
          {a.label}
          {a.freq !== undefined && <b>{(a.freq * 100).toFixed(1)}%</b>}
        </span>
      ))}
    </div>
  );
}
