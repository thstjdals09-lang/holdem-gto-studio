import { useEffect, useMemo, useRef, useState } from "react";
import { COMBO_CARDS, comboToString } from "../engine/cards";
import { evaluate, describe } from "../engine/evaluator";
import { auxClient } from "../worker/client";
import type { DecisionView, NodeView } from "../worker/protocol";
import { db, newId, spotInput, type Drill, type SavedSpot, type TrainerRecord } from "./db";
import { MATCHUPS, type MatchupIndex } from "../lib/postflopLib";
import { walkCodes } from "../lib/preflopLib";
import { encodeIdx, libBase, loadMatchupIndex, loadPreflop } from "./lib";
import { PreflopTrainer } from "./PreflopTrainer";
import { Board, PlayingCard, Spinner, useHashRoute } from "./common";
import { actionColors, bb, pct, STREET_LABEL, seatLabels, SEAT_COLORS } from "./format";
import { decodePath, encodePath, store } from "./store";

type Step = { kind: "action"; index: number } | { kind: "card"; card: number };

interface HandState {
  heroSeat: number;
  combos: number[]; // 플레이어별 콤보
  path: Step[];
  view: NodeView | null;
  log: Array<{ who: "hero" | "villain" | "deal"; text: string }>;
  feedback: Feedback | null;
  finished: boolean;
  result?: string;
  revealed: boolean[];
}
interface Feedback {
  chosen: number;
  chosenLabel: string;
  bestIdx: number;
  bestLabel: string;
  evs: number[];
  strategy: number[];
  labels: string[];
  evLoss: number;
  evLossPot: number;
  verdict: "correct" | "inaccuracy" | "blunder";
  pot: number;
}

function sampleIndex(weights: ArrayLike<number>, rng = Math.random): number {
  let total = 0;
  for (let i = 0; i < weights.length; i++) total += weights[i];
  if (total <= 0) return -1;
  let r = rng() * total;
  for (let i = 0; i < weights.length; i++) {
    r -= weights[i];
    if (r <= 0) return i;
  }
  return weights.length - 1;
}

function verdictOf(evLossPot: number, freq: number): Feedback["verdict"] {
  if (evLossPot <= 0.01 || freq >= 0.3) return "correct";
  if (evLossPot <= 0.05) return "inaccuracy";
  return "blunder";
}

export function TrainerPage() {
  const { params, navigate } = useHashRoute();
  const [spots, setSpots] = useState<SavedSpot[]>([]);
  const [spotId, setSpotId] = useState<string>(params.get("spot") ?? "");
  const [spot, setSpot] = useState<SavedSpot | null>(null);
  const [seatPref, setSeatPref] = useState<number>(-1);
  const [startPath] = useState<Step[]>(() => decodePath(params.get("path")));
  const [hand, setHand] = useState<HandState | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [records, setRecords] = useState<TrainerRecord[]>([]);
  const [drills, setDrills] = useState<Drill[]>([]);
  const [drillName, setDrillName] = useState("");
  const [activeDrill, setActiveDrill] = useState<Drill | null>(null);
  const [tab, setTab] = useState<"preflop" | "play" | "stats" | "drills">(params.get("spot") || params.get("m") ? "play" : "preflop");
  const autoNext = useRef(false);
  const [srcKind, setSrcKind] = useState<"lib" | "mine">(params.get("spot") ? "mine" : "lib");
  const [mid, setMid] = useState(params.get("m") ?? MATCHUPS[0].id);
  const [flopSel, setFlopSel] = useState(params.get("fl") ?? "random");
  const [libIdx, setLibIdx] = useState<MatchupIndex | null>(null);
  const [libFlop, setLibFlop] = useState<string | null>(null);
  const [pfPath, setPfPath] = useState<number[] | null>(null);
  const matchup = MATCHUPS.find((x) => x.id === mid) ?? MATCHUPS[0];
  const isLib = srcKind === "lib";
  const P = isLib ? 2 : spot?.players ?? 2;
  const labels = isLib ? [matchup.oop, matchup.ip] : seatLabels(P);
  const srcId = isLib ? `lib:${mid}/${libFlop ?? ""}` : spot?.id ?? "";
  const srcName = isLib ? `${matchup.name} ${libFlop ?? ""}` : spot?.name ?? "";
  useEffect(() => {
    loadMatchupIndex(mid).then(setLibIdx);
    loadPreflop(matchup.format).then((lib) => setPfPath(walkCodes(lib, matchup.codes).steps.map((s) => s.action)));
  }, [mid]);

  useEffect(() => {
    db.listSpots().then((s) => {
      setSpots(s);
      if (!spotId && s.length > 0) setSpotId(s[0].id);
    });
    db.listTrainer().then(setRecords);
    db.listDrills().then(setDrills);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!spotId || srcKind !== "mine") return;
    db.getSpot(spotId).then(async (s) => {
      if (!s) return;
      setSpot(s);
      setHand(null);
      if (store.auxSpotId !== spotId) {
        setBusy(true);
        try {
          await auxClient.call({ type: "spot.load", ...spotInput(s), strategy: s.strategy, iterations: s.iterations });
          store.auxSpotId = spotId;
        } catch (e) {
          setErr(e instanceof Error ? e.message : String(e));
        } finally {
          setBusy(false);
        }
      }
    });
  }, [spotId, srcKind]);

  const view = (p: Step[]) => auxClient.call<NodeView>({ type: "node.view", path: p });

  async function deal() {
    if (!isLib && !spot) return;
    setBusy(true);
    setErr(null);
    try {
      if (isLib) {
        const list = libIdx?.flops.map((f) => f.flop) ?? [];
        if (list.length === 0) throw new Error("이 매치업의 라이브러리가 아직 없습니다");
        const fl = flopSel === "random" ? list[Math.floor(Math.random() * list.length)] : flopSel;
        await auxClient.call({ type: "lib.load", baseUrl: libBase(), matchup: mid, flop: fl });
        store.auxSpotId = null;
        setLibFlop(fl);
      }
      const root = await view(isLib && flopSel === "random" ? [] : startPath);
      if (root.kind !== "decision") throw new Error("시작 지점이 결정 노드가 아닙니다. 스터디에서 결정 노드를 고르세요.");
      const heroSeat = seatPref < 0 || seatPref >= root.players ? Math.floor(Math.random() * root.players) : seatPref;
      // 플레이어별로 reach에 따라 샘플, 카드 충돌 제외 (히어로 먼저)
      const order = [heroSeat, ...Array.from({ length: root.players }, (_, i) => i).filter((i) => i !== heroSeat)];
      const combos = new Array<number>(root.players).fill(-1);
      const used = new Set<number>();
      for (const q of order) {
        const w = root.combos.map((c) => {
          const [a, b] = COMBO_CARDS[c.combo];
          if (used.has(a) || used.has(b)) return 0;
          return c.weights[q];
        });
        const idx = sampleIndex(w);
        if (idx < 0) throw new Error(`${labels[q]} 레인지에서 뽑을 핸드가 없습니다`);
        combos[q] = root.combos[idx].combo;
        const [a, b] = COMBO_CARDS[combos[q]];
        used.add(a);
        used.add(b);
      }
      const st: HandState = { heroSeat, combos, path: startPath.slice(), view: root, log: [], feedback: null, finished: false, revealed: new Array(root.players).fill(false) };
      await advance(st);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function advance(st: HandState) {
    let v = st.view ?? (await view(st.path));
    const lab = seatLabels(v.players);
    for (let guard = 0; guard < 60; guard++) {
      if (v.kind === "decision") {
        if (v.player === st.heroSeat) break;
        const dv = v;
        const entry = dv.combos.find((c) => c.combo === st.combos[dv.player]);
        const strat = entry ? entry.strategy : dv.actions.map((a) => a.freq);
        let ai = sampleIndex(strat);
        if (ai < 0) ai = 0;
        st.log.push({ who: "villain", text: `${lab[dv.player]} ${dv.actions[ai].label}` });
        st.path = [...st.path, { kind: "action", index: ai }];
        v = await view(st.path);
        continue;
      }
      if (v.kind === "chance") {
        const used = new Set<number>();
        for (const c of st.combos) {
          used.add(COMBO_CARDS[c][0]);
          used.add(COMBO_CARDS[c][1]);
        }
        const live = v.liveCards.filter((c) => !used.has(c));
        const c = live[Math.floor(Math.random() * live.length)];
        st.log.push({ who: "deal", text: `${STREET_LABEL[v.street]} ${"23456789TJQKA"[c >> 2]}${"♣♦♥♠"[c & 3]}` });
        st.path = [...st.path, { kind: "card", card: c }];
        v = await view(st.path);
        continue;
      }
      st.finished = true;
      if (v.type === "fold") {
        st.result = v.winner === st.heroSeat ? `모두 폴드. 팟 ${bb(v.pot)} 획득` : `폴드. 팟 ${bb(v.pot)}은 ${lab[v.winner]}에게`;
      } else {
        const scores = st.combos.map((c, i) => (v.kind === "terminal" && v.active[i] ? evaluate([...v.board, ...COMBO_CARDS[c]]) : -1));
        const best = Math.max(...scores);
        const winners = scores.map((s, i) => (s === best ? i : -1)).filter((i) => i >= 0);
        st.revealed = v.active.slice();
        const heroScore = scores[st.heroSeat];
        const heroDesc = heroScore >= 0 ? describe(heroScore) : "폴드";
        const others = v.active.map((a, i) => (a && i !== st.heroSeat ? `${lab[i]} ${comboToString(st.combos[i])} (${describe(scores[i])})` : null)).filter(Boolean).join(", ");
        if (!v.active[st.heroSeat]) st.result = `쇼다운 (나는 폴드). ${others}`;
        else if (winners.length === 1 && winners[0] === st.heroSeat) st.result = `쇼다운 승! ${heroDesc} vs ${others}. 팟 ${bb(v.pot)}`;
        else if (winners.includes(st.heroSeat)) st.result = `무승부 (${heroDesc}). ${others}`;
        else st.result = `쇼다운 패. ${heroDesc} vs ${others}`;
      }
      break;
    }
    st.view = v;
    setHand({ ...st });
  }

  async function act(i: number) {
    if (!hand || !hand.view || hand.view.kind !== "decision" || (!isLib && !spot)) return;
    const v = hand.view as DecisionView;
    const entry = v.combos.find((c) => c.combo === hand.combos[hand.heroSeat]);
    const evs = entry ? entry.ev : v.actions.map((a) => a.ev);
    const strategy = entry ? entry.strategy : v.actions.map((a) => a.freq);
    let bestIdx = 0;
    for (let k = 1; k < evs.length; k++) if (evs[k] > evs[bestIdx]) bestIdx = k;
    const evLoss = Math.max(0, evs[bestIdx] - evs[i]);
    const evLossPot = v.pot > 0 ? evLoss / v.pot : 0;
    const fb: Feedback = { chosen: i, chosenLabel: v.actions[i].label, bestIdx, bestLabel: v.actions[bestIdx].label, evs, strategy, labels: v.actions.map((a) => a.label), evLoss, evLossPot, verdict: verdictOf(evLossPot, strategy[i]), pot: v.pot };
    const rec: TrainerRecord = {
      id: newId(),
      at: Date.now(),
      spotId: srcId,
      spotName: srcName,
      heroSeat: hand.heroSeat,
      seatLabel: labels[hand.heroSeat],
      street: v.street,
      heroCombo: hand.combos[hand.heroSeat],
      chosen: v.actions[i].label,
      best: v.actions[bestIdx].label,
      evLoss,
      evLossPot: evLossPot * 100,
      verdict: fb.verdict,
      gtoFreq: strategy[i]
    };
    await db.putTrainer(rec);
    setRecords((r) => [rec, ...r]);
    if (activeDrill) {
      const d = { ...activeDrill, handsPlayed: activeDrill.handsPlayed + 1, correct: activeDrill.correct + (fb.verdict === "correct" ? 1 : 0), inaccuracy: activeDrill.inaccuracy + (fb.verdict === "inaccuracy" ? 1 : 0), blunder: activeDrill.blunder + (fb.verdict === "blunder" ? 1 : 0), evLossSum: activeDrill.evLossSum + evLossPot * 100 };
      setActiveDrill(d);
      await db.putDrill(d);
      setDrills(await db.listDrills());
    }
    const st: HandState = { ...hand, feedback: fb, log: [...hand.log, { who: "hero", text: `${labels[hand.heroSeat]} ${v.actions[i].label}` }], path: [...hand.path, { kind: "action", index: i }], view: null };
    setBusy(true);
    try {
      await advance(st);
    } finally {
      setBusy(false);
    }
  }

  const stats = useMemo(() => {
    const n = records.length;
    const correct = records.filter((r) => r.verdict === "correct").length;
    const inacc = records.filter((r) => r.verdict === "inaccuracy").length;
    const blunder = records.filter((r) => r.verdict === "blunder").length;
    const evLoss = records.reduce((a, r) => a + r.evLossPot, 0) / Math.max(1, n);
    const byStreet: Record<number, { n: number; c: number; ev: number }> = {};
    const bySeat: Record<string, { n: number; c: number; ev: number }> = {};
    for (const r of records) {
      const s = (byStreet[r.street] ??= { n: 0, c: 0, ev: 0 });
      s.n++;
      s.c += r.verdict === "correct" ? 1 : 0;
      s.ev += r.evLossPot;
      const key = r.seatLabel ?? (r.heroSeat === 0 ? "OOP" : "IP");
      const t = (bySeat[key] ??= { n: 0, c: 0, ev: 0 });
      t.n++;
      t.c += r.verdict === "correct" ? 1 : 0;
      t.ev += r.evLossPot;
    }
    return { n, correct, inacc, blunder, evLoss, byStreet, bySeat };
  }, [records]);

  useEffect(() => {
    if (hand?.finished && autoNext.current) {
      const t = setTimeout(() => deal(), 1800);
      return () => clearTimeout(t);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hand?.finished]);

  const dv = hand?.view && hand.view.kind === "decision" ? (hand.view as DecisionView) : null;
  const colors = dv ? actionColors(dv.actions) : [];
  const heroCards = hand ? COMBO_CARDS[hand.combos[hand.heroSeat]] : null;
  const activeNow = hand?.view && hand.view.kind !== "chance" ? hand.view.active : hand?.view?.active;

  return (
    <div className="page">
      <div className="row" style={{ justifyContent: "space-between" }}>
        <h2 style={{ margin: 0 }}>
          트레이너 <span className="muted" style={{ fontSize: 13 }}>GTO 상대와 플레이</span>
        </h2>
        <div className="tabs" style={{ margin: 0, borderBottom: "none" }}>
          {(["preflop", "play", "stats", "drills"] as const).map((t) => (
            <button key={t} className={tab === t ? "active" : ""} onClick={() => setTab(t)}>
              {t === "preflop" ? "프리플랍" : t === "play" ? "포스트플랍" : t === "stats" ? "통계" : "드릴"}
            </button>
          ))}
        </div>
      </div>
      {err && <div className="error">{err}</div>}
      {tab === "preflop" && (
        <div style={{ marginTop: 10 }}>
          <PreflopTrainer />
        </div>
      )}
      {tab === "play" && (
        <div className="grid2" style={{ marginTop: 10 }}>
          <div className="col">
            <div className="card row">
              <label className="col" style={{ fontSize: 12 }}>
                출처
                <select
                  value={srcKind}
                  onChange={(e) => {
                    setSrcKind(e.target.value as "lib" | "mine");
                    setHand(null);
                    setActiveDrill(null);
                  }}
                >
                  <option value="lib">라이브러리 (미리 푼 스팟)</option>
                  <option value="mine">내 솔브</option>
                </select>
              </label>
              {isLib ? (
                <>
                  <label className="col" style={{ fontSize: 12 }}>
                    매치업
                    <select
                      value={mid}
                      onChange={(e) => {
                        setMid(e.target.value);
                        setFlopSel("random");
                        setHand(null);
                      }}
                    >
                      {MATCHUPS.map((m) => (
                        <option key={m.id} value={m.id}>
                          {m.name}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="col" style={{ fontSize: 12 }}>
                    플랍
                    <select value={flopSel} onChange={(e) => setFlopSel(e.target.value)}>
                      <option value="random">무작위 ({libIdx?.flops.length ?? 0}개)</option>
                      {libIdx?.flops.map((f) => (
                        <option key={f.flop} value={f.flop}>
                          {f.flop}
                        </option>
                      ))}
                    </select>
                  </label>
                </>
              ) : (
                <label className="col" style={{ fontSize: 12 }}>
                  스팟
                  <select
                    value={spotId}
                    onChange={(e) => {
                      setSpotId(e.target.value);
                      setActiveDrill(null);
                    }}
                  >
                    {spots.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.name}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              <label className="col" style={{ fontSize: 12 }}>
                내 자리
                <select value={seatPref} onChange={(e) => setSeatPref(Number(e.target.value))}>
                  <option value={-1}>무작위</option>
                  {labels.map((l, i) => (
                    <option key={i} value={i}>
                      {l}
                    </option>
                  ))}
                </select>
              </label>
              <label className="row" style={{ fontSize: 12 }}>
                <input type="checkbox" onChange={(e) => (autoNext.current = e.target.checked)} /> 자동 다음 핸드
              </label>
              <button className="primary" disabled={(!isLib && !spot) || busy} onClick={deal}>
                {hand ? "다음 핸드" : "핸드 시작"}
              </button>
              {startPath.length > 0 && <span className="badge">스터디 지점에서 시작 ({startPath.length}단계)</span>}
              {activeDrill && <span className="badge ok">드릴: {activeDrill.name}</span>}
            </div>
            {!isLib && spots.length === 0 && (
              <div className="card muted">
                솔브된 스팟이 없습니다. <a href="#/solve">커스텀 솔브</a>에서 먼저 만드세요.
              </div>
            )}
            {hand && (
              <div className="card col">
                <div className="table-felt">
                  <div className="row" style={{ justifyContent: "center", gap: 18 }}>
                    {hand.combos.map((c, i) =>
                      i === hand.heroSeat ? null : (
                        <div className="seat" key={i} style={{ opacity: activeNow && !activeNow[i] ? 0.45 : 1 }}>
                          <span className="name" style={{ color: SEAT_COLORS[i] }}>
                            {labels[i]} {activeNow && !activeNow[i] ? "(폴드)" : ""}
                          </span>
                          <span>
                            {hand.finished && hand.revealed[i] ? (
                              <>
                                <PlayingCard card={COMBO_CARDS[c][0]} size="sm" />
                                <PlayingCard card={COMBO_CARDS[c][1]} size="sm" />
                              </>
                            ) : (
                              <>
                                <span className="pcard ghost sm">?</span>
                                <span className="pcard ghost sm">?</span>
                              </>
                            )}
                          </span>
                        </div>
                      )
                    )}
                  </div>
                  <div className="col" style={{ alignItems: "center" }}>
                    <Board cards={hand.view?.board ?? spot?.board ?? []} />
                    {isLib && libFlop && <div className="small muted">{matchup.name}</div>}
                    <div style={{ fontWeight: 700 }}>팟 {bb(hand.view?.pot ?? 0)} bb</div>
                  </div>
                  <div className="seat hero-hand">
                    <span>
                      {heroCards && (
                        <>
                          <PlayingCard card={heroCards[0]} />
                          <PlayingCard card={heroCards[1]} />
                        </>
                      )}
                    </span>
                    <span className="name" style={{ color: SEAT_COLORS[hand.heroSeat] }}>
                      나 ({labels[hand.heroSeat]})
                    </span>
                  </div>
                </div>
                <div className="muted" style={{ fontSize: 12 }}>
                  {hand.log.map((l, i) => (
                    <span key={i}>
                      {i > 0 && " → "}
                      <span style={{ color: l.who === "hero" ? "var(--accent)" : l.who === "deal" ? "#93c5fd" : undefined }}>{l.text}</span>
                    </span>
                  ))}
                </div>
                {dv && !hand.finished && (
                  <div className="col">
                    <h3>
                      {STREET_LABEL[dv.street]} · 내 차례 {dv.toCall > 0 && <span className="muted">(콜 {bb(dv.toCall)})</span>}
                    </h3>
                    <div className="row">
                      {dv.actions.map((a, i) => (
                        <button key={i} className="primary" style={{ background: colors[i], color: "#fff" }} disabled={busy} onClick={() => act(i)}>
                          {a.label}
                        </button>
                      ))}
                    </div>
                  </div>
                )}
                {hand.finished && <div className="card" style={{ background: "var(--bg3)" }}>{hand.result}</div>}
                {busy && <Spinner />}
              </div>
            )}
          </div>
          <div className="col">
            {hand?.feedback && (
              <FeedbackCard
                fb={hand.feedback}
                onStudy={() => {
                  const p = encodePath(hand.path.slice(0, -1));
                  if (isLib && libFlop && pfPath) navigate("/study", { fmt: matchup.format, pf: encodeIdx(pfPath), fl: libFlop, pp: p });
                  else navigate("/mysolves", { spot: spotId, path: p });
                }}
              />
            )}
            {!hand?.feedback && (
              <div className="card muted">
                <h3>채점 기준</h3>
                <ul style={{ margin: 0, paddingLeft: 18 }}>
                  <li>
                    <b style={{ color: "var(--accent)" }}>정확</b>: EV 손실 ≤ 팟의 1% 또는 GTO 빈도 ≥ 30%
                  </li>
                  <li>
                    <b style={{ color: "var(--warn)" }}>부정확</b>: EV 손실 ≤ 팟의 5%
                  </li>
                  <li>
                    <b style={{ color: "var(--danger)" }}>블런더</b>: EV 손실 &gt; 팟의 5%
                  </li>
                </ul>
                <p style={{ marginBottom: 0 }}>상대들은 솔브된 평균 전략으로 자기 핸드에 맞게 혼합 플레이합니다. 턴·리버 카드는 모든 핸드와 겹치지 않게 무작위로 나옵니다.</p>
              </div>
            )}
            <div className="card">
              <h3>세션 요약</h3>
              <div className="tiles">
                <div className="tile">
                  <div className="v">{stats.n}</div>
                  <div className="k">결정 수</div>
                </div>
                <div className="tile">
                  <div className="v">{stats.n ? pct(stats.correct / stats.n, 0) : "-"}</div>
                  <div className="k">정확도</div>
                </div>
                <div className="tile">
                  <div className="v">{stats.n ? stats.evLoss.toFixed(2) + "%" : "-"}</div>
                  <div className="k">평균 EV 손실 (팟 %)</div>
                </div>
                <div className="tile">
                  <div className="v" style={{ color: "var(--danger)" }}>{stats.blunder}</div>
                  <div className="k">블런더</div>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}
      {tab === "stats" && (
        <div className="col" style={{ marginTop: 10 }}>
          <div className="card">
            <div className="row" style={{ justifyContent: "space-between" }}>
              <h3>전체 통계 ({stats.n}결정)</h3>
              <button
                className="danger"
                onClick={async () => {
                  if (confirm("트레이너 기록을 모두 지울까요?")) {
                    await db.clearTrainer();
                    setRecords([]);
                  }
                }}
              >
                기록 초기화
              </button>
            </div>
            <div className="tiles">
              <div className="tile">
                <div className="v">{stats.n ? pct(stats.correct / stats.n, 0) : "-"}</div>
                <div className="k">정확</div>
              </div>
              <div className="tile">
                <div className="v">{stats.n ? pct(stats.inacc / stats.n, 0) : "-"}</div>
                <div className="k">부정확</div>
              </div>
              <div className="tile">
                <div className="v">{stats.n ? pct(stats.blunder / stats.n, 0) : "-"}</div>
                <div className="k">블런더</div>
              </div>
              <div className="tile">
                <div className="v">{stats.n ? stats.evLoss.toFixed(2) + "%" : "-"}</div>
                <div className="k">평균 EV 손실/결정 (팟 %)</div>
              </div>
            </div>
            <div className="grid2" style={{ marginTop: 10 }}>
              <table className="tbl">
                <thead>
                  <tr>
                    <th>스트리트</th>
                    <th>결정</th>
                    <th>정확도</th>
                    <th>평균 EV 손실</th>
                  </tr>
                </thead>
                <tbody>
                  {Object.entries(stats.byStreet).map(([s, v]) => (
                    <tr key={s}>
                      <td>{STREET_LABEL[Number(s)]}</td>
                      <td>{v.n}</td>
                      <td>{pct(v.c / v.n, 0)}</td>
                      <td>{(v.ev / v.n).toFixed(2)}%</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <table className="tbl">
                <thead>
                  <tr>
                    <th>자리</th>
                    <th>결정</th>
                    <th>정확도</th>
                    <th>평균 EV 손실</th>
                  </tr>
                </thead>
                <tbody>
                  {Object.entries(stats.bySeat).map(([s, v]) => (
                    <tr key={s}>
                      <td>{s}</td>
                      <td>{v.n}</td>
                      <td>{pct(v.c / v.n, 0)}</td>
                      <td>{(v.ev / v.n).toFixed(2)}%</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
          <div className="card">
            <h3>최근 결정</h3>
            <table className="tbl">
              <thead>
                <tr>
                  <th>시각</th>
                  <th>스팟</th>
                  <th>자리</th>
                  <th>스트리트</th>
                  <th>핸드</th>
                  <th>선택</th>
                  <th>최선</th>
                  <th>GTO 빈도</th>
                  <th>EV 손실</th>
                  <th>판정</th>
                </tr>
              </thead>
              <tbody>
                {records.slice(0, 50).map((r) => (
                  <tr key={r.id}>
                    <td className="muted">{new Date(r.at).toLocaleTimeString()}</td>
                    <td>{r.spotName}</td>
                    <td>{r.seatLabel ?? (r.heroSeat === 0 ? "OOP" : "IP")}</td>
                    <td>{STREET_LABEL[r.street]}</td>
                    <td>{comboToString(r.heroCombo)}</td>
                    <td>{r.chosen}</td>
                    <td>{r.best}</td>
                    <td>{pct(r.gtoFreq, 0)}</td>
                    <td>{r.evLossPot.toFixed(1)}%</td>
                    <td className={`verdict ${r.verdict}`} style={{ fontSize: 13 }}>
                      {r.verdict === "correct" ? "정확" : r.verdict === "inaccuracy" ? "부정확" : "블런더"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
      {tab === "drills" && (
        <div className="col" style={{ marginTop: 10 }}>
          <div className="card row">
            <input placeholder="드릴 이름 (예: K72r BTN vs BB 플랍)" value={drillName} onChange={(e) => setDrillName(e.target.value)} style={{ width: 280 }} />
            <button
              className="primary"
              disabled={isLib || !spot || drillName.trim().length < 2}
              onClick={async () => {
                const d: Drill = { id: newId(), name: drillName.trim(), spotId: spot!.id, heroSeat: seatPref, startPath, createdAt: Date.now(), handsPlayed: 0, correct: 0, inaccuracy: 0, blunder: 0, evLossSum: 0 };
                await db.putDrill(d);
                setDrills(await db.listDrills());
                setDrillName("");
                setActiveDrill(d);
                setTab("play");
              }}
            >
              현재 설정을 드릴로 저장
            </button>
            <span className="muted" style={{ fontSize: 12 }}>드릴 = 스팟 + 자리 + 시작 지점. 저장하면 결과가 드릴별로 집계됩니다.</span>
          </div>
          <div className="card">
            <table className="tbl">
              <thead>
                <tr>
                  <th>이름</th>
                  <th>스팟</th>
                  <th>자리</th>
                  <th>시작</th>
                  <th>핸드</th>
                  <th>정확도</th>
                  <th>평균 EV 손실</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {drills.map((d) => {
                  const sp = spots.find((s) => s.id === d.spotId);
                  const lab = seatLabels(sp?.players ?? 2);
                  return (
                    <tr key={d.id}>
                      <td>{d.name}</td>
                      <td>{sp?.name ?? "(삭제됨)"}</td>
                      <td>{d.heroSeat < 0 ? "무작위" : lab[d.heroSeat]}</td>
                      <td>{d.startPath.length === 0 ? "루트" : `${d.startPath.length}단계`}</td>
                      <td>{d.handsPlayed}</td>
                      <td>{d.handsPlayed ? pct(d.correct / d.handsPlayed, 0) : "-"}</td>
                      <td>{d.handsPlayed ? (d.evLossSum / d.handsPlayed).toFixed(2) + "%" : "-"}</td>
                      <td className="row">
                        <button
                          onClick={() => {
                            setActiveDrill(d);
                            setSpotId(d.spotId);
                            setSeatPref(d.heroSeat);
                            navigate("/trainer", { spot: d.spotId, path: encodePath(d.startPath) });
                            setTab("play");
                          }}
                        >
                          시작
                        </button>
                        <button
                          className="danger"
                          onClick={async () => {
                            await db.deleteDrill(d.id);
                            setDrills(await db.listDrills());
                          }}
                        >
                          삭제
                        </button>
                      </td>
                    </tr>
                  );
                })}
                {drills.length === 0 && (
                  <tr>
                    <td colSpan={8} className="muted">
                      저장된 드릴이 없습니다.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

function FeedbackCard({ fb, onStudy }: { fb: Feedback; onStudy: () => void }) {
  const labelOf = (v: Feedback["verdict"]) => (v === "correct" ? "정확!" : v === "inaccuracy" ? "부정확" : "블런더");
  return (
    <div className="card col">
      <div className={`verdict ${fb.verdict}`}>{labelOf(fb.verdict)}</div>
      <div>
        선택: <b>{fb.chosenLabel}</b> (GTO 빈도 {pct(fb.strategy[fb.chosen], 0)}) · 최선: <b>{fb.bestLabel}</b>
      </div>
      <div>
        EV 손실 <b>{bb(fb.evLoss)} bb</b> = 팟의 {(fb.evLossPot * 100).toFixed(1)}%
      </div>
      <table className="tbl">
        <thead>
          <tr>
            <th>액션</th>
            <th>GTO 빈도</th>
            <th>EV</th>
          </tr>
        </thead>
        <tbody>
          {fb.evs.map((e, i) => (
            <tr key={i} style={{ fontWeight: i === fb.bestIdx ? 700 : 400 }}>
              <td>
                {i === fb.chosen ? "▶ " : ""}
                {i === fb.bestIdx ? "★ " : ""}
                {fb.labels[i]}
              </td>
              <td>{pct(fb.strategy[i], 0)}</td>
              <td>{bb(e)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <button onClick={onStudy}>이 스팟 스터디에서 보기 →</button>
    </div>
  );
}
