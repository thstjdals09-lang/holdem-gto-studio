import { useEffect, useMemo, useState } from "react";
import { CLASS_COMBOS, NUM_CLASSES, classLabel, parseCards } from "../engine/cards";
import { rangeToString } from "../engine/range";
import { postflopOrder } from "../engine/ring";
import { CLASS_N, reachToCombos, walkIdx, type PfLib, type PfLibNode } from "../lib/preflopLib";
import type { Matchup, MatchupIndex } from "../lib/postflopLib";
import { libClient } from "../worker/client";
import type { NodeView } from "../worker/protocol";
import { Board, CardPicker, Spinner, useHashRoute } from "./common";
import { DecisionPanel } from "./DecisionPanel";
import { RangeGrid, GridLegend, type GridMode } from "./RangeGrid";
import { actionColors, bb, pct, STREET_LABEL, SEAT_COLORS } from "./format";
import { decodeIdx, encodeIdx, findMatchup, flopTexture, DEFAULT_FORMAT, FORMAT_LIST, libBase, loadMatchupIndex, loadPreflop } from "./lib";
import { decodePath, encodePath, store } from "./store";

type Step = { kind: "action"; index: number } | { kind: "card"; card: number };

export function StudyPage() {
  const { params, navigate } = useHashRoute();
  const fmt = params.get("fmt") ?? DEFAULT_FORMAT;
  const pfStr = params.get("pf");
  const pf = useMemo(() => decodeIdx(pfStr), [pfStr]);
  const flop = params.get("fl");
  const ppStr = params.get("pp");
  const [lib, setLib] = useState<PfLib | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    setLib(null);
    setErr(null);
    loadPreflop(fmt).then(setLib, (e) => setErr(e.message));
  }, [fmt]);

  const walk = useMemo(() => {
    if (!lib) return null;
    try {
      return walkIdx(lib, pf);
    } catch {
      return walkIdx(lib, []);
    }
  }, [lib, pf]);

  const go = (o: { fmt?: string; pf?: number[]; fl?: string | null; pp?: Step[] }) => {
    const q: Record<string, string> = { fmt: o.fmt ?? fmt };
    const p = o.pf ?? pf;
    if (p.length) q.pf = encodeIdx(p);
    const fl = o.fl === undefined ? flop : o.fl;
    if (fl) q.fl = fl;
    const pp = o.pp ?? (o.fl === undefined ? decodePath(ppStr) : []);
    if (fl && pp.length) q.pp = encodePath(pp);
    navigate("/study", q);
  };

  return (
    <div className="page">
      <div className="study-top">
        <select value={fmt} onChange={(e) => go({ fmt: e.target.value, pf: [], fl: null })}>
          {FORMAT_LIST.map((f) => (
            <option key={f.id} value={f.id}>
              {f.name}
            </option>
          ))}
        </select>
        {lib && (
          <span className="muted small">
            스택 {lib.format.stack}bb · 오픈 {lib.format.openTo[0]}bb · 3벳 IP {lib.format.threeBetIP}x / OOP {lib.format.threeBetOOP}x · 4벳 {lib.format.fourBet}x {lib.format.ante > 0 ? `· 앤티 ${lib.format.ante}bb` : ""} · <span className="badge">프리플랍 근사 솔루션</span>
          </span>
        )}
        <button className="ghost" onClick={() => navigator.clipboard?.writeText(window.location.href)}>
          링크 복사
        </button>
      </div>
      {err && <div className="error">{err}</div>}
      {!lib && !err && <Spinner text="솔루션 불러오는 중…" />}
      {lib && walk && (
        <>
          <SeatStrip lib={lib} pf={pf} onJump={(k) => go({ pf: pf.slice(0, k), fl: null })} />
          {flop && walk.terminal?.type === "flop" ? (
            <PostflopView lib={lib} pf={pf} flop={flop} path={decodePath(ppStr)} onPath={(p) => go({ pp: p })} onBack={() => go({ fl: null })} />
          ) : walk.node ? (
            <PreflopNodeView lib={lib} node={walk.node} reach={walk.reach} onAction={(a) => go({ pf: [...pf, a], fl: null })} />
          ) : walk.terminal ? (
            <TerminalPanel lib={lib} pf={pf} reach={walk.reach} onFlop={(f) => go({ fl: f })} />
          ) : null}
        </>
      )}
    </div>
  );
}

// ---------------- 자리 막대 ----------------
function SeatStrip({ lib, pf, onJump }: { lib: PfLib; pf: number[]; onJump: (k: number) => void }) {
  const N = lib.format.positions.length;
  const w = walkIdx(lib, pf);
  const cur = w.node ?? null;
  const inv = cur ? cur.inv : w.terminal!.inv;
  const fold = cur ? cur.fold : w.terminal!.fold;
  const acts: Array<Array<{ label: string; step: number; type: string }>> = Array.from({ length: N }, () => []);
  w.steps.forEach((s, k) => {
    const a = s.node.a[s.action];
    acts[s.node.p].push({ label: a[0] === "fold" ? "폴드" : a[0] === "check" ? "체크" : a[0] === "call" ? (s.node.lv === 0 ? "림프" : "콜") : a[0] === "allin" ? `올인` : `${a[1]}`, step: k, type: a[0] });
  });
  const pot = cur ? cur.pot : w.terminal!.pot;
  return (
    <div className="seat-strip">
      {lib.format.positions.map((name, i) => {
        const isActor = cur && cur.p === i;
        const folded = fold[i] === 1;
        return (
          <div key={i} className={`seat-box ${isActor ? "actor" : ""} ${folded ? "folded" : ""}`}>
            <div className="seat-name">{name}</div>
            <div className="seat-stack">{bb(lib.format.stack - inv[i], 1)}</div>
            <div className="seat-acts">
              {acts[i].map((a, k) => (
                <span key={k} className={`act-chip ${a.type}`} onClick={() => onJump(a.step)} title="이 시점으로 돌아가기">
                  {a.label}
                </span>
              ))}
              {isActor && <span className="act-chip pending">?</span>}
            </div>
          </div>
        );
      })}
      <div className="seat-box pot-box">
        <div className="seat-name">팟</div>
        <div className="seat-stack">{bb(pot, 1)}</div>
        {pf.length > 0 && (
          <span className="act-chip" onClick={() => onJump(0)}>
            처음으로
          </span>
        )}
      </div>
    </div>
  );
}

// ---------------- 프리플랍 노드 ----------------
function PreflopNodeView({ lib, node, reach, onAction }: { lib: PfLib; node: PfLibNode; reach: Float64Array[]; onAction: (a: number) => void }) {
  const [mode, setMode] = useState<"strategy" | "ev" | "ranges">("strategy");
  const [hover, setHover] = useState<number | null>(null);
  const [sel, setSel] = useState<number | null>(null);
  const A = node.a.length;
  const N = lib.format.positions.length;
  const r = reach[node.p];
  const actions = node.a.map((a) => ({ type: a[0], label: a[2] }));
  const colors = actionColors(actions);
  const classFreq = useMemo(() => {
    const f = new Float32Array(NUM_CLASSES * A);
    for (let c = 0; c < NUM_CLASSES; c++) for (let a = 0; a < A; a++) f[c * A + a] = node.s[a * NUM_CLASSES + c] / 1000;
    return f;
  }, [node]);
  const weight = useMemo(() => Float32Array.from({ length: NUM_CLASSES }, (_, c) => r[c] / CLASS_N[c]), [r]);
  const handEv = useMemo(() => Float32Array.from({ length: NUM_CLASSES }, (_, c) => {
    let v = 0;
    for (let a = 0; a < A; a++) v += (node.s[a * NUM_CLASSES + c] / 1000) * (node.e[a * NUM_CLASSES + c] / 100);
    return v;
  }), [node]);
  let total = 0;
  for (let c = 0; c < NUM_CLASSES; c++) total += r[c];
  const stats = node.a.map((a, ai) => {
    let combos = 0;
    let ev = 0;
    for (let c = 0; c < NUM_CLASSES; c++) {
      const w = r[c] * (node.s[ai * NUM_CLASSES + c] / 1000);
      combos += w;
      ev += w * (node.e[ai * NUM_CLASSES + c] / 100);
    }
    return { freq: total > 0 ? combos / total : 0, combos, ev: combos > 0 ? ev / combos : 0 };
  });
  const focus = hover ?? sel;
  return (
    <div className="study-grid">
      <div className="card col">
        <div className="row" style={{ justifyContent: "space-between" }}>
          <h3 style={{ margin: 0 }}>
            <b style={{ color: "var(--accent)" }}>{lib.format.positions[node.p]}</b> 행동 · {node.call > 0 ? `콜 ${bb(node.call, 1)}` : "오픈 기회"}
          </h3>
          <div className="tabs" style={{ margin: 0, border: "none" }}>
            <button className={mode === "strategy" ? "active" : ""} onClick={() => setMode("strategy")}>
              전략
            </button>
            <button className={mode === "ev" ? "active" : ""} onClick={() => setMode("ev")}>
              EV
            </button>
            <button className={mode === "ranges" ? "active" : ""} onClick={() => setMode("ranges")}>
              레인지
            </button>
          </div>
        </div>
        {mode === "ranges" ? (
          <div className="ranges-wrap">
            {lib.format.positions.map((name, i) =>
              node.fold[i] ? null : (
                <div key={i} className="mini-range">
                  <div className="small" style={{ color: i === node.p ? "var(--accent)" : undefined }}>
                    {name} {((Array.from(reach[i]).reduce((a, b) => a + b, 0) / 1326) * 100).toFixed(1)}%
                  </div>
                  <RangeGrid mode="weight" weight={Float32Array.from({ length: NUM_CLASSES }, (_, c) => reach[i][c] / CLASS_N[c])} size="sm" />
                </div>
              )
            )}
          </div>
        ) : (
          <>
            <RangeGrid
              mode={mode === "ev" ? "ev" : "strategy"}
              classFreq={classFreq}
              actionCount={A}
              colors={colors}
              weight={weight}
              values={mode === "ev" ? handEv : undefined}
              size="lg"
              selected={sel}
              onSelect={setSel}
              onHover={setHover}
              formatValue={(v) => v.toFixed(2)}
            />
            {mode === "strategy" ? <GridLegend actions={actions.map((a, i) => ({ label: a.label, freq: stats[i].freq }))} colors={colors} /> : <div className="muted small">핸드별 기대 순이익(bb, 이 시점 기준, 폴드 = 0)</div>}
          </>
        )}
      </div>
      <div className="col">
        <div className="card col">
          <h3>액션</h3>
          <div className="actions">
            {node.a.map((a, i) => (
              <button key={i} className="action-btn" onClick={() => onAction(i)}>
                <i style={{ background: colors[i] }} />
                <span>{a[2]}</span>
                <span className="freq">{pct(stats[i].freq)}</span>
                <span className="ev">
                  {stats[i].combos.toFixed(0)}콤보 · EV {bb(stats[i].ev)}
                </span>
              </button>
            ))}
          </div>
          <div className="muted small">빈도·콤보는 {lib.format.positions[node.p]}가 이 지점에 도달하는 레인지 기준. EV는 bb, 이 시점부터의 기대 순이익.</div>
        </div>
        <div className="card col">
          <h3>{focus !== null ? `${classLabel(focus)} · ${CLASS_COMBOS[focus].length}콤보 (레인지 ${(weight[focus] * 100).toFixed(0)}%)` : "핸드 상세"}</h3>
          {focus === null && <div className="muted">그리드의 핸드에 마우스를 올리세요.</div>}
          {focus !== null && (
            <table className="tbl">
              <thead>
                <tr>
                  <th>액션</th>
                  <th>빈도</th>
                  <th>EV (bb)</th>
                </tr>
              </thead>
              <tbody>
                {node.a.map((a, i) => (
                  <tr key={i}>
                    <td>
                      <i className="dot" style={{ background: colors[i] }} /> {a[2]}
                    </td>
                    <td>{pct(node.s[i * NUM_CLASSES + focus] / 1000, 0)}</td>
                    <td>{bb(node.e[i * NUM_CLASSES + focus] / 100)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <div className="muted small">
            모든 자리 EV: {lib.ev.map((e, i) => `${lib.format.positions[i]} ${e >= 0 ? "+" : ""}${e.toFixed(2)}`).join(" · ")} (bb/핸드)
          </div>
          {N > 0 && null}
        </div>
      </div>
    </div>
  );
}

// ---------------- 터미널 (플랍 도달 / 폴드 / 올인) ----------------
function TerminalPanel({ lib, pf, reach, onFlop }: { lib: PfLib; pf: number[]; reach: Float64Array[]; onFlop: (f: string) => void }) {
  const { navigate } = useHashRoute();
  const w = walkIdx(lib, pf);
  const t = w.terminal!;
  const codes = w.steps.map((s) => s.node.a[s.action][3]);
  const matchup = findMatchup(lib.format.id, codes);
  const [idx, setIdx] = useState<MatchupIndex | null>(null);
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    setIdx(null);
    if (!matchup) return;
    setLoading(true);
    loadMatchupIndex(matchup.id).then((x) => {
      setIdx(x);
      setLoading(false);
    });
  }, [matchup?.id]);
  const alive = lib.format.positions.map((_, i) => i).filter((i) => !t.fold[i]);
  if (t.type === "fold") {
    return (
      <div className="card">
        <h3>핸드 종료 · {lib.format.positions[t.w]} 승리 (팟 {bb(t.pot, 1)})</h3>
      </div>
    );
  }
  const ordered = alive.slice().sort((a, b) => postflopOrder(lib.format, a) - postflopOrder(lib.format, b));
  const sendCustom = (board?: string) => {
    const texts = ordered.map((i) => rangeToString(reachToCombos(reach[i], 0.004)));
    const eff = Math.min(...ordered.map((i) => lib.format.stack - t.inv[i]));
    store.setPendingSolve({ players: ordered.length, rangeTexts: texts, seatNames: ordered.map((i) => lib.format.positions[i]), pot: t.pot, effStack: Math.round(eff * 100) / 100, board, note: `${lib.format.name} · ${ordered.map((i) => lib.format.positions[i]).join(" vs ")} · 팟 ${bb(t.pot, 1)}` });
    navigate("/solve");
  };
  return (
    <div className="col">
      <div className="card col">
        <h3>
          {t.type === "allin" ? "올인 · 쇼다운" : "플랍 도달"} · {ordered.map((i) => lib.format.positions[i]).join(" vs ")} · 팟 {bb(t.pot, 1)}bb · 유효 스택 {bb(Math.min(...ordered.map((i) => lib.format.stack - t.inv[i])), 1)}bb
        </h3>
        <div className="ranges-wrap">
          {ordered.map((i) => (
            <div key={i} className="mini-range">
              <div className="small">
                {lib.format.positions[i]} {((Array.from(reach[i]).reduce((a, b) => a + b, 0) / 1326) * 100).toFixed(1)}%
              </div>
              <RangeGrid mode="weight" weight={Float32Array.from({ length: NUM_CLASSES }, (_, c) => reach[i][c] / CLASS_N[c])} size="sm" />
            </div>
          ))}
        </div>
      </div>
      {t.type === "flop" && (
        <div className="card col">
          <div className="row" style={{ justifyContent: "space-between" }}>
            <h3 style={{ margin: 0 }}>플랍 선택 {matchup && <span className="badge ok">{matchup.name}</span>}</h3>
            <button onClick={() => sendCustom()}>이 레인지로 커스텀 솔브 →</button>
          </div>
          {!matchup && <div className="muted">이 라인은 미리 풀린 포스트플랍 라이브러리가 없습니다. 위 버튼으로 원하는 보드를 직접 솔브하세요{ordered.length > 2 ? " (멀티웨이 솔버)" : ""}.</div>}
          {loading && <Spinner text="플랍 목록 불러오는 중…" />}
          {matchup && idx && idx.flops.length === 0 && <div className="muted">라이브러리 생성 중입니다. 잠시 후 다시 확인하세요.</div>}
          {matchup && idx && idx.flops.length > 0 && <FlopPicker idx={idx} matchup={matchup} onPick={onFlop} />}
        </div>
      )}
    </div>
  );
}

function FlopPicker({ idx, matchup, onPick }: { idx: MatchupIndex; matchup: Matchup; onPick: (f: string) => void }) {
  return (
    <div className="flop-grid">
      {idx.flops.map((f) => {
        const tex = flopTexture(f.flop);
        const ipBet = f.root.ipVsCheck.filter((a) => a.label.startsWith("벳") || a.label.startsWith("올인")).reduce((s, a) => s + a.freq, 0);
        const oopBet = f.root.oop.filter((a) => a.label.startsWith("벳") || a.label.startsWith("올인")).reduce((s, a) => s + a.freq, 0);
        return (
          <button key={f.flop} className="flop-tile" onClick={() => onPick(f.flop)}>
            <Board cards={parseCards(f.flop)} slots={3} size="sm" />
            <div className="small muted">
              {tex.suits}
              {tex.paired ? " · 페어" : ""}
            </div>
            <div className="small">
              {matchup.oop} 벳 {pct(oopBet, 0)} · {matchup.ip} 벳 {pct(ipBet, 0)}
            </div>
            <div className="small muted">
              에퀴티 {matchup.oop} {pct(f.eqOop, 0)}
            </div>
          </button>
        );
      })}
    </div>
  );
}

// ---------------- 포스트플랍 (라이브러리) ----------------
function PostflopView({ lib, pf, flop, path, onPath, onBack }: { lib: PfLib; pf: number[]; flop: string; path: Step[]; onPath: (p: Step[]) => void; onBack: () => void }) {
  const w = walkIdx(lib, pf);
  const codes = w.steps.map((s) => s.node.a[s.action][3]);
  const matchup = findMatchup(lib.format.id, codes);
  const [ready, setReady] = useState<string | null>(null);
  const [view, setView] = useState<NodeView | null>(null);
  const [labels, setLabels] = useState<Array<{ label: string; kind: "action" | "card"; player?: number }>>([]);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [mode, setMode] = useState<GridMode>("strategy");
  const [sel, setSel] = useState<number | null>(null);
  const [hover, setHover] = useState<number | null>(null);
  const [showSeat, setShowSeat] = useState<number | null>(null);
  const key = matchup ? `${matchup.id}/${flop}` : "";
  const pathKey = encodePath(path);

  useEffect(() => {
    if (!matchup) return;
    setErr(null);
    setBusy("스팟 불러오는 중…");
    libClient
      .call({ type: "lib.load", baseUrl: libBase(), matchup: matchup.id, flop })
      .then(() => setReady(key))
      .catch((e) => setErr(e.message))
      .finally(() => setBusy(null));
  }, [key]);

  useEffect(() => {
    if (ready !== key) return;
    let cancel = false;
    (async () => {
      setBusy("노드 분석 중…");
      const ls: Array<{ label: string; kind: "action" | "card"; player?: number }> = [];
      for (let i = 0; i < path.length; i++) {
        const v = await libClient.call<NodeView>({ type: "node.view", path: path.slice(0, i) });
        const st = path[i];
        if (v.kind === "decision" && st.kind === "action") ls.push({ label: v.actions[st.index].label, kind: "action", player: v.player });
        else if (st.kind === "card") ls.push({ label: "23456789TJQKA"[st.card >> 2] + "♣♦♥♠"[st.card & 3], kind: "card" });
      }
      const v = await libClient.call<NodeView>({ type: "node.view", path }, (p) => !cancel && setBusy(`리버 즉석 솔브 중… ${p.iterations}회 · ${p.exploitabilityPct.toFixed(2)}%`));
      if (cancel) return;
      setLabels(ls);
      setView(v);
      setShowSeat(null);
      setBusy(null);
    })().catch((e) => {
      if (!cancel) {
        setErr(e.message);
        setBusy(null);
      }
    });
    return () => {
      cancel = true;
    };
  }, [ready, key, pathKey]);

  if (!matchup) return <div className="card error">이 라인의 라이브러리가 없습니다.</div>;
  const seatNames = [matchup.oop, matchup.ip];
  return (
    <div className="col">
      <div className="row ribbon">
        <button className="ghost" onClick={onBack}>
          ← 플랍 목록
        </button>
        <Board cards={parseCards(flop)} slots={3} size="sm" />
        <span className="chip" onClick={() => onPath([])}>
          플랍
        </span>
        {labels.map((h, i) => (
          <span key={i} className={`chip ${h.kind === "card" ? "card" : ""}`} style={h.kind === "action" ? { borderColor: SEAT_COLORS[h.player ?? 0] } : undefined} onClick={() => onPath(path.slice(0, i + 1))}>
            {h.kind === "action" ? `${seatNames[h.player ?? 0]} ${h.label}` : h.label}
          </span>
        ))}
        {path.length > 0 && (
          <button className="ghost" onClick={() => onPath(path.slice(0, -1))}>
            ← 뒤로
          </button>
        )}
        {view?.river && <span className="badge">리버 즉석 솔브 {view.river.iterations}회 · {view.river.exploitabilityPct.toFixed(2)}%</span>}
        {view?.kind === "decision" && (
          <a className="badge ok" href={`#/trainer?m=${matchup.id}&fl=${flop}${path.length ? `&path=${encodePath(path)}` : ""}`}>
            이 스팟 연습하기 →
          </a>
        )}
      </div>
      {err && <div className="error">{err}</div>}
      {busy && <Spinner text={busy} />}
      {view && view.kind === "decision" && <DecisionPanel view={view} labels={seatNames} mode={mode} setMode={setMode} selected={sel} setSelected={setSel} hover={hover} setHover={setHover} showSeat={showSeat} setShowSeat={setShowSeat} onAction={(i) => onPath([...path, { kind: "action", index: i }])} />}
      {view && view.kind === "chance" && view.street === 2 && <RunoutReport path={path} seatNames={seatNames} onPick={(c) => onPath([...path, { kind: "card", card: c }])} />}
      {view && view.kind === "chance" && (
        <div className="card col" style={{ maxWidth: 640 }}>
          <h3>
            {STREET_LABEL[view.street]} 카드 선택 {view.allin && <span className="badge">올인 런아웃</span>} · 팟 {bb(view.pot)}
          </h3>
          <Board cards={view.board} size="sm" />
          <CardPicker disabled={new Set(view.board)} onPick={(c) => onPath([...path, { kind: "card", card: c }])} />
          <div className="row">
            <button
              onClick={() => {
                const live = view.liveCards;
                onPath([...path, { kind: "card", card: live[Math.floor(Math.random() * live.length)] }]);
              }}
            >
              무작위 카드
            </button>
          </div>
        </div>
      )}
      {view && view.kind === "terminal" && (
        <div className="card col">
          <h3>{view.type === "fold" ? `폴드로 종료 · ${seatNames[view.winner]} 승리` : "쇼다운"}</h3>
          <Board cards={view.board} size="sm" />
          <div className="tiles">
            <div className="tile">
              <div className="v">{bb(view.pot)}</div>
              <div className="k">최종 팟</div>
            </div>
            {view.shares.map((s, i) => (
              <div className="tile" key={i}>
                <div className="v" style={{ color: SEAT_COLORS[i] }}>{bb(s)}</div>
                <div className="k">{seatNames[i]} 기대 팟 지분</div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------- 턴 런아웃 리포트 ----------------
interface RunoutRow {
  card: number;
  player: number;
  labels: string[];
  types: string[];
  freqs: number[];
  evs: number[];
  rangeEv: number;
  equity: number;
}
function RunoutReport({ path, seatNames, onPick }: { path: Step[]; seatNames: string[]; onPick: (c: number) => void }) {
  const [rows, setRows] = useState<RunoutRow[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [sortBy, setSortBy] = useState<"card" | "ev" | "agg">("card");
  const key = encodePath(path);
  useEffect(() => setRows(null), [key]);
  const run = async () => {
    setBusy(true);
    try {
      setRows(await libClient.call<RunoutRow[]>({ type: "lib.runouts", path }));
    } finally {
      setBusy(false);
    }
  };
  if (!rows)
    return (
      <div className="card row">
        <span className="muted">턴 카드 49장 각각의 첫 액션 전략·EV·에퀴티를 한 번에 봅니다.</span>
        <button onClick={run} disabled={busy}>
          {busy ? "계산 중…" : "턴 런아웃 리포트"}
        </button>
      </div>
    );
  if (rows.length === 0) return null;
  const colors = actionColors(rows[0].types.map((t) => ({ type: t })));
  const agg = (r: RunoutRow) => r.freqs.reduce((s, f, i) => s + (r.types[i] === "bet" || r.types[i] === "raise" || r.types[i] === "allin" ? f : 0), 0);
  const sorted = rows.slice().sort((a, b) => (sortBy === "ev" ? b.rangeEv - a.rangeEv : sortBy === "agg" ? agg(b) - agg(a) : (b.card >> 2) - (a.card >> 2) || (a.card & 3) - (b.card & 3)));
  const avg = (f: (r: RunoutRow) => number) => rows.reduce((s, r) => s + f(r), 0) / rows.length;
  return (
    <div className="card col">
      <div className="row" style={{ justifyContent: "space-between" }}>
        <h3 style={{ margin: 0 }}>
          턴 런아웃 리포트 · {seatNames[rows[0].player]} 첫 액션 (평균 벳 {pct(avg(agg), 0)} · EV {bb(avg((r) => r.rangeEv))})
        </h3>
        <div className="tabs" style={{ margin: 0, border: "none" }}>
          {(
            [
              ["card", "카드순"],
              ["agg", "벳 빈도순"],
              ["ev", "EV순"]
            ] as const
          ).map(([k, l]) => (
            <button key={k} className={sortBy === k ? "active" : ""} onClick={() => setSortBy(k)}>
              {l}
            </button>
          ))}
        </div>
      </div>
      <div className="runout-grid">
        {sorted.map((r) => (
          <button key={r.card} className="runout-cell" onClick={() => onPick(r.card)} title={r.labels.map((l, i) => `${l} ${pct(r.freqs[i], 0)}`).join(" · ")}>
            <Board cards={[r.card]} slots={1} size="sm" />
            <div className="bar" style={{ minWidth: 0, width: "100%", height: 10 }}>
              {r.freqs.map((f, i) => (
                <span key={i} style={{ width: `${f * 100}%`, background: colors[i] }} />
              ))}
            </div>
            <div className="small">EV {bb(r.rangeEv, 2)}</div>
            <div className="small muted">EQ {pct(r.equity, 0)}</div>
          </button>
        ))}
      </div>
      <GridLegend actions={rows[0].labels.map((l) => ({ label: l }))} colors={colors} />
    </div>
  );
}
