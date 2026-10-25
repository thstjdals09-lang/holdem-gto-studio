import { useEffect, useMemo, useState } from "react";
import { solverClient } from "../worker/client";
import type { NodeView } from "../worker/protocol";
import { DecisionPanel } from "./DecisionPanel";
import { db, spotInput, type SavedSpot } from "./db";
import { Board, CardPicker, Spinner, useHashRoute } from "./common";
import type { GridMode } from "./RangeGrid";
import { bb, STREET_LABEL, seatLabels, SEAT_COLORS } from "./format";
import { decodePath, encodePath, store } from "./store";

type Step = { kind: "action"; index: number } | { kind: "card"; card: number };

export function MySolvesPage() {
  const { params, navigate } = useHashRoute();
  const spotId = params.get("spot");
  const path = useMemo(() => decodePath(params.get("path")), [params]);
  const [spot, setSpot] = useState<SavedSpot | null>(null);
  const [spots, setSpots] = useState<SavedSpot[]>([]);
  const [view, setView] = useState<NodeView | null>(null);
  const [history, setHistory] = useState<Array<{ label: string; kind: "action" | "card"; player?: number }>>([]);
  const [mode, setMode] = useState<GridMode>("strategy");
  const [selected, setSelected] = useState<number | null>(null);
  const [hover, setHover] = useState<number | null>(null);
  const [showSeat, setShowSeat] = useState<number | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [readyId, setReadyId] = useState<string | null>(null);

  useEffect(() => {
    db.listSpots().then(setSpots);
  }, []);

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
        await solverClient.call({ type: "spot.load", ...spotInput(s), strategy: s.strategy, iterations: s.iterations });
        store.loadedSpotId = spotId;
      }
      if (!cancel) setReadyId(spotId);
    })().catch((e) => setErr(e.message));
    return () => {
      cancel = true;
    };
  }, [spotId]);

  useEffect(() => {
    if (!spot || readyId !== spotId) return;
    let cancel = false;
    setLoading(true);
    (async () => {
      const labels: Array<{ label: string; kind: "action" | "card"; player?: number }> = [];
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
      setShowSeat(null);
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
  }, [spot, spotId, path, readyId]);

  const go = (p: Step[]) => navigate("/mysolves", { spot: spotId!, path: encodePath(p) });

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
                <tr key={s.id} className="clickable" onClick={() => navigate("/mysolves", { spot: s.id })}>
                  <td>{s.name}</td>
                  <td>{s.players}인</td>
                  <td>
                    <Board cards={s.board} slots={5} size="sm" />
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

  const labels = seatLabels(spot?.players ?? 2);

  return (
    <div className="page">
      <div className="row" style={{ justifyContent: "space-between" }}>
        <h2 style={{ margin: 0 }}>
          스터디 <span className="muted" style={{ fontSize: 14 }}>{spot?.name}</span>
        </h2>
        <div className="row">
          <select value={spotId} onChange={(e) => navigate("/mysolves", { spot: e.target.value })}>
            {spots.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
          <button onClick={() => navigate("/trainer", { spot: spotId, path: encodePath(path) })}>이 스팟으로 트레이닝</button>
          <button onClick={() => navigator.clipboard?.writeText(window.location.href)}>링크 복사</button>
        </div>
      </div>
      {err && <div className="error">{err}</div>}
      {spot && (
        <div className="muted" style={{ margin: "6px 0 10px" }}>
          {spot.players}인 · {spot.iterations}회 반복 · 익스플로잇어빌리티 {spot.exploitabilityPct.toFixed(2)}% · EV {spot.ev.map((e, i) => `${labels[i]} ${bb(e)}`).join(" / ")} · 시작 팟 {spot.pot} · 스택 {spot.effStack}
        </div>
      )}
      <div className="ribbon" style={{ marginBottom: 10 }}>
        <span className="chip" onClick={() => go([])}>
          시작
        </span>
        {history.map((h, i) => (
          <span key={i} className={`chip ${h.kind === "card" ? "card" : ""}`} style={h.kind === "action" ? { borderColor: SEAT_COLORS[h.player ?? 0] } : undefined} onClick={() => go(path.slice(0, i + 1))}>
            {h.kind === "action" ? `${labels[h.player ?? 0]} ${h.label}` : h.label}
          </span>
        ))}
        {path.length > 0 && (
          <button className="ghost" onClick={() => go(path.slice(0, -1))}>
            ← 뒤로
          </button>
        )}
      </div>
      {loading && <Spinner text="노드 분석 중…" />}
      {view && view.kind === "decision" && (
        <DecisionPanel view={view} labels={labels} mode={mode} setMode={setMode} selected={selected} setSelected={setSelected} hover={hover} setHover={setHover} showSeat={showSeat} setShowSeat={setShowSeat} onAction={(i) => go([...path, { kind: "action", index: i }])} />
      )}
      {view && view.kind === "chance" && (
        <div className="grid2">
          <div className="card col">
            <h3>
              {STREET_LABEL[view.street]} 카드 선택 {view.allin && <span className="badge">올인 런아웃</span>}
            </h3>
            <Board cards={view.board} size="sm" />
            <div className="muted">
              팟 {bb(view.pot)} · 남은 플레이어: {view.active.map((a, i) => (a ? labels[i] : null)).filter(Boolean).join(", ")}
            </div>
            <CardPicker disabled={new Set(view.board)} onPick={(c) => go([...path, { kind: "card", card: c }])} />
          </div>
        </div>
      )}
      {view && view.kind === "terminal" && (
        <div className="card col">
          <h3>{view.type === "fold" ? `폴드로 종료 · 승자 ${labels[view.winner]}` : "쇼다운"}</h3>
          <Board cards={view.board} size="sm" />
          <div className="tiles">
            <div className="tile">
              <div className="v">{bb(view.pot)}</div>
              <div className="k">최종 팟</div>
            </div>
            {view.shares.map((s, i) => (
              <div className="tile" key={i}>
                <div className="v" style={{ color: SEAT_COLORS[i] }}>{bb(s)}</div>
                <div className="k">
                  {labels[i]} 기대 팟 지분 {view.active[i] ? "" : "(폴드)"}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

