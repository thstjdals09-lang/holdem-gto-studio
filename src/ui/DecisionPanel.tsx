import { useMemo, useState } from "react";
import { CLASS_COMBOS, COMBO_CARDS, COMBO_CLASS, classLabel, comboToString } from "../engine/cards";
import { classifyDraw, classifyMade, DRAW_ORDER, MADE_ORDER } from "../engine/categories";
import type { DecisionView } from "../worker/protocol";
import { Board } from "./common";
import { RangeGrid, GridLegend, type GridMode } from "./RangeGrid";
import { actionColors, bb, pct, STREET_LABEL, SEAT_COLORS } from "./format";

export function DecisionPanel(props: {
  view: DecisionView;
  labels: string[];
  mode: GridMode;
  setMode: (m: GridMode) => void;
  selected: number | null;
  setSelected: (c: number | null) => void;
  hover: number | null;
  setHover: (c: number | null) => void;
  showSeat: number | null;
  setShowSeat: (v: number | null) => void;
  onAction: (i: number) => void;
}) {
  const { view, labels, mode, setMode, selected, setSelected, hover, setHover, showSeat, setShowSeat, onAction } = props;
  const A = view.actions.length;
  const colors = actionColors(view.actions);
  const seat = labels[view.player];
  const bestIdx = view.actions.reduce((b, a, i) => (a.ev > view.actions[b].ev ? i : b), 0);
  const values = mode === "ev" ? view.classHandEv : mode === "eq" ? view.classEquity : mode === "eqr" ? view.classEqr : undefined;
  const focusCls = hover ?? selected;
  const focusCombos = focusCls !== null ? view.combos.filter((c) => COMBO_CLASS[c.combo] === focusCls && c.weight > 0) : [];
  const others = labels.map((_, i) => i).filter((i) => i !== view.player);
  const [bd, setBd] = useState(false);
  return (
    <div className="grid3">
      <div className="col">
        <div className="card col">
          <h3>
            {STREET_LABEL[view.street]} · <b style={{ color: SEAT_COLORS[view.player] }}>{seat}</b> 행동
          </h3>
          <Board cards={view.board} size="sm" />
          {view.players > 2 && (
            <div className="row" style={{ fontSize: 12 }}>
              {labels.map((l, i) => (
                <span key={i} className={`badge ${view.active[i] ? "ok" : ""}`} style={{ borderColor: view.active[i] ? SEAT_COLORS[i] : undefined, opacity: view.active[i] ? 1 : 0.5 }}>
                  {l} {view.active[i] ? (view.allin[i] ? "올인" : `투자 ${bb(view.invested[i])}`) : "폴드"}
                </span>
              ))}
            </div>
          )}
          <div className="tiles">
            <div className="tile">
              <div className="v">{bb(view.pot)}</div>
              <div className="k">팟 (bb)</div>
            </div>
            <div className="tile">
              <div className="v">{bb(view.toCall)}</div>
              <div className="k">콜 금액</div>
            </div>
            <div className="tile">
              <div className="v">{bb(view.rangeEv)}</div>
              <div className="k">{seat} 레인지 EV (여기서부터)</div>
            </div>
            <div className="tile">
              <div className="v">{pct(view.rangeEquity)}</div>
              <div className="k">{seat} 레인지 에퀴티</div>
            </div>
          </div>
        </div>
        <div className="card col">
          <h3>액션 (클릭하면 다음 노드로)</h3>
          <div className="actions">
            {view.actions.map((a, i) => (
              <button key={i} className={`action-btn ${i === bestIdx ? "best" : ""}`} onClick={() => onAction(i)}>
                <i style={{ background: colors[i] }} />
                <span>{a.label}</span>
                <span className="freq">{pct(a.freq)}</span>
                <span className="ev">EV {bb(a.ev)}</span>
              </button>
            ))}
          </div>
          <div className="muted" style={{ fontSize: 12 }}>
            EV = 이 지점부터의 기대 순이익(bb). 빈도는 {seat} 전체 레인지 기준.
          </div>
        </div>
      </div>
      <div className="card col">
        <div className="tabs">
          {(["strategy", "ev", "eq", "eqr"] as GridMode[]).map((m) => (
            <button
              key={m}
              className={mode === m && showSeat === null && !bd ? "active" : ""}
              onClick={() => {
                setMode(m);
                setShowSeat(null);
                setBd(false);
              }}
            >
              {m === "strategy" ? "전략" : m === "ev" ? "EV" : m === "eq" ? "에퀴티" : "EQR"}
            </button>
          ))}
          <button className={bd ? "active" : ""} onClick={() => setBd(true)}>
            분류
          </button>
          {others.map((i) => (
            <button
              key={i}
              className={showSeat === i && !bd ? "active" : ""}
              onClick={() => {
                setShowSeat(i);
                setBd(false);
              }}
              style={{ color: SEAT_COLORS[i] }}
            >
              {labels[i]} 레인지
            </button>
          ))}
        </div>
        {bd ? (
          <Breakdown view={view} colors={colors} />
        ) : showSeat !== null ? (
          <>
            <RangeGrid mode="weight" weight={view.seatWeightNorm[showSeat]} onHover={setHover} onSelect={setSelected} selected={selected} size="lg" />
            <div className="muted" style={{ fontSize: 12 }}>
              {labels[showSeat]}가 이 노드에 도달하는 레인지(평균 전략 반영) {view.active[showSeat] ? "" : "· 이미 폴드"}
            </div>
          </>
        ) : (
          <>
            <RangeGrid
              mode={mode}
              classFreq={view.classFreq}
              actionCount={A}
              colors={colors}
              weight={view.classWeightNorm}
              values={values}
              onHover={setHover}
              onSelect={setSelected}
              selected={selected}
              size="lg"
              formatValue={(v) => (mode === "ev" ? v.toFixed(1) : mode === "eq" ? (v * 100).toFixed(0) : v.toFixed(2))}
            />
            {mode === "strategy" && <GridLegend actions={view.actions} colors={colors} />}
            {mode !== "strategy" && <div className="muted" style={{ fontSize: 12 }}>{mode === "ev" ? "핸드별 기대 순이익(bb). 빨강=낮음, 초록=높음" : mode === "eq" ? "남은 상대 레인지 대비 에퀴티(%)" : "에퀴티 실현(EQR) = 팟 지분 ÷ (에퀴티×팟)"}</div>}
          </>
        )}
      </div>
      <div className="card col">
        <h3>
          {focusCls !== null ? classLabel(focusCls) : "핸드 상세"} {focusCls !== null && <span className="muted">({CLASS_COMBOS[focusCls].length}콤보 중 {focusCombos.length}개 레인지 내)</span>}
        </h3>
        {focusCls === null && <div className="muted">그리드의 핸드에 마우스를 올리거나 클릭하세요.</div>}
        {focusCls !== null && focusCombos.length > 0 && (
          <div className="combo-table">
            <table className="tbl">
              <thead>
                <tr>
                  <th>콤보</th>
                  <th>비중</th>
                  <th>EQ</th>
                  <th>EV</th>
                  {view.actions.map((a, i) => (
                    <th key={i} style={{ color: colors[i] }}>
                      {a.code}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {focusCombos.map((c) => (
                  <tr key={c.combo}>
                    <td>{comboToString(c.combo)}</td>
                    <td>{(c.weight * 100).toFixed(0)}%</td>
                    <td>{pct(c.equity, 0)}</td>
                    <td>{bb(c.handEv)}</td>
                    {c.strategy.map((f, i) => (
                      <td key={i} title={`EV ${bb(c.ev[i])}`}>
                        {f > 0.005 ? (f * 100).toFixed(0) + "%" : "·"}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="muted" style={{ fontSize: 11, marginTop: 6 }}>각 액션 칸에 마우스를 올리면 그 액션의 EV가 보입니다.</div>
          </div>
        )}
        {focusCls !== null && (
          <div className="col" style={{ marginTop: 8 }}>
            <h3>클래스 평균</h3>
            <div className="tiles">
              <div className="tile">
                <div className="v">{pct(view.classEquity[focusCls], 0)}</div>
                <div className="k">에퀴티</div>
              </div>
              <div className="tile">
                <div className="v">{bb(view.classHandEv[focusCls])}</div>
                <div className="k">EV</div>
              </div>
              <div className="tile">
                <div className="v">{view.classEqr[focusCls].toFixed(2)}</div>
                <div className="k">EQR</div>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function Breakdown({ view, colors }: { view: DecisionView; colors: string[] }) {
  const data = useMemo(() => {
    const A = view.actions.length;
    type Acc = { w: number; s: number[]; ev: number; eq: number };
    const mk = (): Acc => ({ w: 0, s: new Array(A).fill(0), ev: 0, eq: 0 });
    const made = new Map<string, Acc>();
    const draws = new Map<string, Acc>();
    let total = 0;
    for (const c of view.combos) {
      if (c.weight <= 0) continue;
      const hole = COMBO_CARDS[c.combo];
      const m = classifyMade(hole, view.board);
      const d = classifyDraw(hole, view.board);
      for (const [map, key] of [
        [made, m],
        [draws, d]
      ] as Array<[Map<string, Acc>, string]>) {
        const a = map.get(key) ?? mk();
        a.w += c.weight;
        for (let i = 0; i < A; i++) a.s[i] += c.weight * c.strategy[i];
        a.ev += c.weight * c.handEv;
        a.eq += c.weight * c.equity;
        map.set(key, a);
      }
      total += c.weight;
    }
    const rows = (map: Map<string, Acc>, order: readonly string[]) =>
      order
        .filter((k) => map.has(k))
        .map((k) => {
          const a = map.get(k)!;
          return { k, w: a.w, share: total > 0 ? a.w / total : 0, s: a.s.map((x) => x / a.w), ev: a.ev / a.w, eq: a.eq / a.w };
        });
    return { made: rows(made, MADE_ORDER), draws: view.board.length < 5 ? rows(draws, DRAW_ORDER) : [] };
  }, [view]);
  const table = (rows: typeof data.made, title: string) => (
    <table className="tbl">
      <thead>
        <tr>
          <th>{title}</th>
          <th>콤보</th>
          <th>비중</th>
          <th>전략</th>
          <th>EV</th>
          <th>에퀴티</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.k}>
            <td>{r.k}</td>
            <td>{r.w.toFixed(1)}</td>
            <td>{pct(r.share, 1)}</td>
            <td>
              <div className="bar" style={{ width: 140 }} title={view.actions.map((a, i) => `${a.label} ${pct(r.s[i], 0)}`).join(" · ")}>
                {r.s.map((f, i) => (
                  <span key={i} style={{ width: `${f * 100}%`, background: colors[i] }} />
                ))}
              </div>
            </td>
            <td>{bb(r.ev)}</td>
            <td>{pct(r.eq, 0)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
  return (
    <div className="col">
      {table(data.made, "완성 핸드")}
      {data.draws.length > 0 && table(data.draws, "드로우")}
      <GridLegend actions={view.actions} colors={colors} />
    </div>
  );
}
