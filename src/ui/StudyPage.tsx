import { useEffect, useMemo, useState } from "react";
import { CLASS_COMBOS, COMBO_CLASS, classLabel, comboToString } from "../engine/cards";
import { solverClient } from "../worker/client";
import type { DecisionView, NodeView } from "../worker/protocol";
import { db, type SavedSpot } from "./db";
import { Board, CardPicker, Spinner, useHashRoute } from "./common";
import { RangeGrid, GridLegend, type GridMode } from "./RangeGrid";
import { actionColors, bb, pct, STREET_LABEL } from "./format";
import { decodePath, encodePath, store } from "./store";

type Step = { kind: "action"; index: number } | { kind: "card"; card: number };

export function StudyPage() {
  const { params, navigate } = useHashRoute();
  const spotId = params.get("spot");
  const path = useMemo(() => decodePath(params.get("path")), [params]);
  const [spot, setSpot] = useState<SavedSpot | null>(null);
  const [spots, setSpots] = useState<SavedSpot[]>([]);
  const [view, setView] = useState<NodeView | null>(null);
  const [history, setHistory] = useState<Array<{ label: string; kind: "action" | "card"; player?: 0 | 1 }>>([]);
  const [mode, setMode] = useState<GridMode>("strategy");
  const [selected, setSelected] = useState<number | null>(null);
  const [hover, setHover] = useState<number | null>(null);
  const [showOpp, setShowOpp] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    db.listSpots().then(setSpots);
  }, []);

  // 스팟 로드
  useEffect(() => {
    if (!spotId) return;
    let cancel = false;
    (async () => {
      setErr(null);
      const s = await db.getSpot(spotId);
      if (!s) {
        setErr("스팟을 찾을 수 없습니다");
        return;
      }
      if (cancel) return;
      setSpot(s);
      if (store.loadedSpotId !== spotId) {
        setLoading(true);
        await solverClient.call({ type: "spot.load", config: s.config, oop: s.oop, ip: s.ip, strategy: s.strategy, iterations: s.iterations });
        store.loadedSpotId = spotId;
        setLoading(false);
      }
    })().catch((e) => setErr(e.message));
    return () => {
      cancel = true;
    };
  }, [spotId]);

  // 노드 뷰
  useEffect(() => {
    if (!spot || store.loadedSpotId !== spotId) return;
    let cancel = false;
    setLoading(true);
    // 히스토리 라벨을 만들기 위해 경로의 각 접두사를 조회
    (async () => {
      const labels: Array<{ label: string; kind: "action" | "card"; player?: 0 | 1 }> = [];
      for (let i = 0; i < path.length; i++) {
        const v = await solverClient.call<NodeView>({ type: "node.view", path: path.slice(0, i) });
        const step = path[i];
        if (v.kind === "decision" && step.kind === "action") labels.push({ label: v.actions[step.index].label, kind: "action", player: v.player });
        else if (step.kind === "card") labels.push({ label: "23456789TJQKA"[step.card >> 2] + "♣♦♥♠"[step.card & 3], kind: "card" });
      }
      const v = await solverClient.call<NodeView>({ type: "node.view", path });
      if (cancel) return;
      setHistory(labels);
      setView(v);
      setLoading(false);
    })().catch((e) => {
      if (!cancel) {
        setErr(e.message);
        setLoading(false);
      }
    });
    return () => {
      cancel = true;
    };
  }, [spot, spotId, path, loading === false && store.loadedSpotId]);

  const go = (p: Step[]) => navigate("/study", { spot: spotId!, path: encodePath(p) });

  if (!spotId) {
    return (
      <div className="page">
        <h2>스터디</h2>
        <div className="card">
          <h3>저장된 스팟을 선택하세요</h3>
          {spots.length === 0 && (
            <div className="muted">
              아직 솔브한 스팟이 없습니다. <a href="#/solve">커스텀 솔브</a>에서 먼저 하나 만드세요.
            </div>
          )}
          <table className="tbl">
            <tbody>
              {spots.map((s) => (
                <tr key={s.id} className="clickable" onClick={() => navigate("/study", { spot: s.id })}>
                  <td>{s.name}</td>
                  <td>
                    <Board cards={s.config.board} slots={5} size="sm" />
                  </td>
                  <td className="muted">
                    {s.iterations}회 · {s.exploitabilityPct.toFixed(2)}%
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    );
  }

  return (
    <div className="page">
      <div className="row" style={{ justifyContent: "space-between" }}>
        <h2 style={{ margin: 0 }}>
          스터디 <span className="muted" style={{ fontSize: 14 }}>{spot?.name}</span>
        </h2>
        <div className="row">
          <select value={spotId} onChange={(e) => navigate("/study", { spot: e.target.value })}>
            {spots.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
          <button onClick={() => navigate("/trainer", { spot: spotId, path: encodePath(path) })}>이 스팟으로 트레이닝</button>
          <button
            onClick={() => {
              navigator.clipboard?.writeText(window.location.href);
            }}
          >
            링크 복사
          </button>
        </div>
      </div>
      {err && <div className="error">{err}</div>}
      {spot && (
        <div className="muted" style={{ margin: "6px 0 10px" }}>
          {spot.iterations}회 반복 · 익스플로잇어빌리티 {spot.exploitabilityPct.toFixed(2)}% · EV OOP {bb(spot.evOop)} / IP {bb(spot.evIp)} · 시작 팟 {spot.config.pot} · 스택 {spot.config.effStack}
          {spot.config.rakePct > 0 && ` · 레이크 ${spot.config.rakePct}%`}
        </div>
      )}
      {/* 히스토리 리본 */}
      <div className="ribbon" style={{ marginBottom: 10 }}>
        <span className="chip" onClick={() => go([])}>
          시작
        </span>
        {history.map((h, i) => (
          <span key={i} className={`chip ${h.kind === "card" ? "card" : h.player === 0 ? "oop" : "ip"}`} onClick={() => go(path.slice(0, i + 1))}>
            {h.kind === "action" ? `${h.player === 0 ? "OOP" : "IP"} ${h.label}` : h.label}
          </span>
        ))}
        {path.length > 0 && (
          <button className="ghost" onClick={() => go(path.slice(0, -1))}>
            ← 뒤로
          </button>
        )}
      </div>
      {loading && <Spinner text="노드 분석 중…" />}
      {view && view.kind === "decision" && <DecisionPanel view={view} mode={mode} setMode={setMode} selected={selected} setSelected={setSelected} hover={hover} setHover={setHover} showOpp={showOpp} setShowOpp={setShowOpp} onAction={(i) => go([...path, { kind: "action", index: i }])} />}
      {view && view.kind === "chance" && (
        <div className="grid2">
          <div className="card col">
            <h3>{STREET_LABEL[view.street]} 카드 선택 {view.allin && <span className="badge">양쪽 올인 런아웃</span>}</h3>
            <Board cards={view.board} size="sm" />
            <div className="muted">팟 {bb(view.pot)}</div>
            <CardPicker disabled={new Set(view.board)} onPick={(c) => go([...path, { kind: "card", card: c }])} />
          </div>
        </div>
      )}
      {view && view.kind === "terminal" && (
        <div className="card col">
          <h3>{view.type === "fold" ? "폴드로 종료" : "쇼다운"}</h3>
          <Board cards={view.board} size="sm" />
          <div className="tiles">
            <div className="tile">
              <div className="v">{bb(view.pot)}</div>
              <div className="k">최종 팟</div>
            </div>
            <div className="tile">
              <div className="v">{bb(view.evOop)}</div>
              <div className="k">OOP 기대 팟 지분 {view.type === "fold" && view.folder === 0 ? "(폴드)" : ""}</div>
            </div>
            <div className="tile">
              <div className="v">{bb(view.evIp)}</div>
              <div className="k">IP 기대 팟 지분 {view.type === "fold" && view.folder === 1 ? "(폴드)" : ""}</div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function DecisionPanel(props: {
  view: DecisionView;
  mode: GridMode;
  setMode: (m: GridMode) => void;
  selected: number | null;
  setSelected: (c: number | null) => void;
  hover: number | null;
  setHover: (c: number | null) => void;
  showOpp: boolean;
  setShowOpp: (v: boolean) => void;
  onAction: (i: number) => void;
}) {
  const { view, mode, setMode, selected, setSelected, hover, setHover, showOpp, setShowOpp, onAction } = props;
  const A = view.actions.length;
  const colors = actionColors(view.actions);
  const seat = view.player === 0 ? "OOP" : "IP";
  const bestIdx = view.actions.reduce((b, a, i) => (a.ev > view.actions[b].ev ? i : b), 0);
  const values = mode === "ev" ? view.classHandEv : mode === "eq" ? view.classEquity : mode === "eqr" ? view.classEqr : undefined;
  const focusCls = hover ?? selected;
  const focusCombos = focusCls !== null ? view.combos.filter((c) => COMBO_CLASS[c.combo] === focusCls && c.weight > 0) : [];
  return (
    <div className="grid3">
      <div className="col">
        <div className="card col">
          <h3>
            {STREET_LABEL[view.street]} · <b style={{ color: view.player === 0 ? "#60a5fa" : "#fb923c" }}>{seat}</b> 행동
          </h3>
          <Board cards={view.board} size="sm" />
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
          <div className="muted" style={{ fontSize: 12 }}>EV = 이 지점부터의 기대 순이익(bb). 빈도는 {seat} 전체 레인지 기준.</div>
        </div>
      </div>
      <div className="card col">
        <div className="tabs">
          {(["strategy", "ev", "eq", "eqr"] as GridMode[]).map((m) => (
            <button key={m} className={mode === m && !showOpp ? "active" : ""} onClick={() => { setMode(m); setShowOpp(false); }}>
              {m === "strategy" ? "전략" : m === "ev" ? "EV" : m === "eq" ? "에퀴티" : "EQR"}
            </button>
          ))}
          <button className={showOpp ? "active" : ""} onClick={() => setShowOpp(!showOpp)}>
            상대 레인지
          </button>
        </div>
        {showOpp ? (
          <>
            <RangeGrid mode="weight" weight={view.oppClassWeightNorm} onHover={setHover} onSelect={setSelected} selected={selected} size="lg" />
            <div className="muted" style={{ fontSize: 12 }}>
              상대({view.player === 0 ? "IP" : "OOP"})가 이 노드에 도달하는 레인지. 에퀴티 {pct(view.oppRangeEquity)}
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
            {mode !== "strategy" && <div className="muted" style={{ fontSize: 12 }}>{mode === "ev" ? "핸드별 기대 순이익(bb). 빨강=낮음, 초록=높음" : mode === "eq" ? "상대 레인지 대비 에퀴티(%)" : "에퀴티 실현(EQR) = 팟 지분 ÷ (에퀴티×팟). 1보다 크면 에퀴티 이상을 실현"}</div>}
          </>
        )}
      </div>
      <div className="card col">
        <h3>{focusCls !== null ? classLabel(focusCls) : "핸드 상세"} {focusCls !== null && <span className="muted">({CLASS_COMBOS[focusCls].length}콤보 중 {focusCombos.length}개 레인지 내)</span>}</h3>
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
