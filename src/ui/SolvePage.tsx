import { useEffect, useMemo, useRef, useState } from "react";
import { parseCards } from "../engine/cards";
import { parseRange } from "../engine/range";
import type { TreeConfig } from "../engine/tree";
import type { MultiTreeConfig } from "../engine/multi";
import { solverClient } from "../worker/client";
import type { EstimateResult, SolveProgress, SpotInput } from "../worker/protocol";
import { db, newId, type SavedSpot } from "./db";
import { Board, BoardInput, fmtBytes, fmtMs, numList, useHashRoute } from "./common";
import { RangeEditor } from "./RangeEditor";
import { store } from "./store";
import { bb, seatLabels, SEAT_COLORS } from "./format";

const PRESETS = {
  quick: { label: "빠름", targetExploit: 1.0, maxIters: 300, maxMs: 60_000, desc: "익스플로잇 1% · 300회 · 1분" },
  standard: { label: "표준", targetExploit: 0.5, maxIters: 1000, maxMs: 5 * 60_000, desc: "0.5% · 1000회 · 5분" },
  deep: { label: "깊음", targetExploit: 0.2, maxIters: 3000, maxMs: 20 * 60_000, desc: "0.2% · 3000회 · 20분" }
} as const;
type PresetKey = keyof typeof PRESETS;

const MEMORY_LIMIT = 1.2 * 1024 * 1024 * 1024;

const DEFAULT_RANGES: Record<number, string[]> = {
  2: ["22+,A2s+,K2s+,Q4s+,J6s+,T6s+,96s+,85s+,75s+,64s+,53s+,A2o+,K8o+,Q9o+,J9o+,T9o", "22+,A2s+,K9s+,Q9s+,J9s+,T9s,98s,87s,76s,65s,ATo+,KJo+,QJo"],
  3: ["22+,A2s+,K5s+,Q8s+,J8s+,T8s+,97s+,86s+,75s+,65s,A7o+,KTo+,QTo+,JTo", "22+,A2s+,K2s+,Q4s+,J6s+,T6s+,96s+,85s+,75s+,64s+,53s+,A2o+,K8o+,Q9o+,J9o+,T9o", "22+,A2s+,K9s+,Q9s+,J9s+,T9s,98s,87s,76s,65s,ATo+,KJo+,QJo"],
  4: ["22+,A2s+,K5s+,Q8s+,J8s+,T8s+,97s+,86s+,75s+,A7o+,KTo+,QTo+,JTo", "22+,A2s+,K2s+,Q4s+,J6s+,T6s+,96s+,85s+,75s+,64s+,A2o+,K8o+,Q9o+,J9o+,T9o", "44+,A8s+,KTs+,QTs+,JTs,T9s,98s,AJo+,KQo", "22+,A2s+,K9s+,Q9s+,J9s+,T9s,98s,87s,76s,65s,ATo+,KJo+,QJo"],
  5: ["22+,A2s+,K5s+,Q8s+,J8s+,T8s+,97s+,86s+,A7o+,KTo+,QTo+", "22+,A2s+,K2s+,Q4s+,J6s+,T6s+,96s+,85s+,75s+,A2o+,K8o+,Q9o+,J9o+", "55+,A9s+,KTs+,QTs+,JTs,AJo+,KQo", "44+,A8s+,KTs+,QTs+,JTs,T9s,98s,AJo+,KQo", "22+,A2s+,K9s+,Q9s+,J9s+,T9s,98s,87s,76s,ATo+,KJo+,QJo"],
  6: ["22+,A2s+,K5s+,Q8s+,J8s+,T8s+,97s+,A7o+,KTo+,QTo+", "22+,A2s+,K2s+,Q4s+,J6s+,T6s+,96s+,85s+,A2o+,K8o+,Q9o+,J9o+", "66+,ATs+,KJs+,QJs,AQo+", "55+,A9s+,KTs+,QTs+,JTs,AJo+,KQo", "44+,A8s+,KTs+,QTs+,JTs,T9s,98s,AJo+,KQo", "22+,A2s+,K9s+,Q9s+,J9s+,T9s,98s,87s,ATo+,KJo+,QJo"]
};

export function SolvePage() {
  const { navigate } = useHashRoute();
  const pending = useMemo(() => store.takePendingSolve(), []);
  const [name, setName] = useState("");
  const [players, setPlayers] = useState(pending?.players ?? 2);
  const [boardText, setBoardText] = useState(pending?.board ?? "Ks7d2c");
  const [board, setBoard] = useState<number[] | null>(() => {
    try {
      return parseCards(pending?.board ?? "Ks7d2c");
    } catch {
      return null;
    }
  });
  const [pot, setPot] = useState(pending?.pot ?? 5.5);
  const [effStack, setEffStack] = useState(pending?.effStack ?? 97.5);
  const [rakePct, setRakePct] = useState(0);
  const [rakeCap, setRakeCap] = useState(0);
  const [rangeTexts, setRangeTexts] = useState<string[]>(() => {
    const d = DEFAULT_RANGES[2].concat(DEFAULT_RANGES[6].slice(2));
    if (pending) pending.rangeTexts.forEach((t, i) => (d[i] = t));
    return d;
  });
  const [oopBet, setOopBet] = useState({ flop: "33 75", turn: "66", river: "75" });
  const [ipBet, setIpBet] = useState({ flop: "33 75", turn: "66", river: "75" });
  const [raise, setRaise] = useState("50");
  const [allowDonk, setAllowDonk] = useState(false);
  const [includeAllin, setIncludeAllin] = useState(true);
  const [maxRaises, setMaxRaises] = useState(2);
  const [allinThreshold, setAllinThreshold] = useState(67);
  const [preset, setPreset] = useState<PresetKey>("quick");
  const [estimate, setEstimate] = useState<EstimateResult | null>(null);
  const [estErr, setEstErr] = useState<string | null>(null);
  const [progress, setProgress] = useState<SolveProgress | null>(null);
  const [running, setRunning] = useState(false);
  const [spots, setSpots] = useState<SavedSpot[]>([]);
  const [savedId, setSavedId] = useState<string | null>(null);
  const estTimer = useRef<number | null>(null);
  const labels = seatLabels(players);

  function changePlayers(n: number) {
    setPlayers(n);
    setRangeTexts((prev) => {
      const next = prev.slice();
      const d = DEFAULT_RANGES[n];
      for (let i = 0; i < n; i++) next[i] = d[i];
      return next;
    });
    if (n > 2) setMaxRaises((m) => Math.min(m, 2));
  }

  const input: SpotInput | null = useMemo(() => {
    if (!board) return null;
    const mk = (s: string) => ({ bet: numList(s), raise: numList(raise) });
    let ranges: Float32Array[];
    try {
      ranges = rangeTexts.slice(0, players).map((t) => parseRange(t));
    } catch {
      return null;
    }
    if (players === 2) {
      const config: TreeConfig = {
        board,
        pot,
        effStack,
        rakePct,
        rakeCap,
        oop: { flop: mk(oopBet.flop), turn: mk(oopBet.turn), river: mk(oopBet.river) },
        ip: { flop: mk(ipBet.flop), turn: mk(ipBet.turn), river: mk(ipBet.river) },
        allinThresholdPct: allinThreshold,
        maxRaisesPerStreet: maxRaises,
        allowDonk,
        includeAllin
      };
      return { players, config, ranges };
    }
    const mconfig: MultiTreeConfig = {
      board,
      pot,
      effStack,
      rakePct,
      rakeCap,
      players,
      sizes: { flop: mk(oopBet.flop), turn: mk(oopBet.turn), river: mk(oopBet.river) },
      allinThresholdPct: allinThreshold,
      maxRaisesPerStreet: maxRaises,
      includeAllin
    };
    return { players, mconfig, ranges };
  }, [board, pot, effStack, rakePct, rakeCap, oopBet, ipBet, raise, allinThreshold, maxRaises, allowDonk, includeAllin, players, rangeTexts]);

  const rangeErr = useMemo(() => {
    try {
      rangeTexts.slice(0, players).forEach((t) => parseRange(t));
      return null;
    } catch (e) {
      return e instanceof Error ? e.message : String(e);
    }
  }, [rangeTexts, players]);

  useEffect(() => {
    db.listSpots().then(setSpots);
  }, [savedId]);

  useEffect(() => {
    if (estTimer.current) window.clearTimeout(estTimer.current);
    if (!input) {
      setEstimate(null);
      return;
    }
    estTimer.current = window.setTimeout(() => {
      solverClient
        .call<EstimateResult>({ type: "estimate", ...input })
        .then((r) => {
          setEstimate(r);
          setEstErr(null);
        })
        .catch((e) => setEstErr(e.message));
    }, 350);
  }, [input]);

  const tooBig = estimate ? estimate.bytes > MEMORY_LIMIT : false;
  const canSolve = !!input && !running && !tooBig && (estimate?.hands ?? 0) > 0;

  async function solve() {
    if (!input) return;
    setRunning(true);
    setProgress(null);
    setSavedId(null);
    const p = PRESETS[preset];
    try {
      await solverClient.call({ type: "solve.start", ...input, targetExploitPct: p.targetExploit, maxIters: p.maxIters, maxMs: p.maxMs, batch: players > 2 ? 5 : 10 }, (pr) => setProgress(pr));
      await save(input);
    } catch (e) {
      setEstErr(e instanceof Error ? e.message : String(e));
    } finally {
      setRunning(false);
    }
  }
  async function continueSolve() {
    if (!input) return;
    setRunning(true);
    const p = PRESETS[preset];
    try {
      await solverClient.call({ type: "solve.continue", targetExploitPct: p.targetExploit / 2, maxIters: (progress?.iterations ?? 0) + p.maxIters, maxMs: p.maxMs, batch: 10 }, (pr) => setProgress(pr));
      await save(input);
    } finally {
      setRunning(false);
    }
  }
  async function save(inp: SpotInput) {
    const ex = await solverClient.call<{ strategy: Float32Array; iterations: number; metrics: { exploitabilityPct: number; ev: number[] } }>({ type: "spot.export" });
    const id = savedId ?? newId();
    const spot: SavedSpot = {
      id,
      name: name.trim() || `${players}인 ${boardText.toUpperCase()} 팟${pot} 스택${effStack}`,
      createdAt: Date.now(),
      players,
      config: inp.config,
      mconfig: inp.mconfig,
      rangeTexts: rangeTexts.slice(0, players),
      ranges: inp.ranges,
      strategy: ex.strategy,
      iterations: ex.iterations,
      exploitabilityPct: ex.metrics.exploitabilityPct,
      ev: ex.metrics.ev,
      board: board!,
      pot,
      effStack
    };
    await db.putSpot(spot);
    store.loadedSpotId = id;
    setSavedId(id);
  }

  return (
    <div className="page">
      <h2>커스텀 솔브</h2>
      {pending && <div className="card" style={{ marginBottom: 12 }}>프리플랍 랩에서 가져온 설정: {pending.note}</div>}
      <div className="grid2">
        <div className="card col">
          <h3>스팟</h3>
          <div className="row">
            <label className="col" style={{ fontSize: 12 }}>
              플레이어 수
              <select value={players} onChange={(e) => changePlayers(Number(e.target.value))}>
                {[2, 3, 4, 5, 6].map((n) => (
                  <option key={n} value={n}>
                    {n}인 {n === 2 ? "(헤즈업)" : n === 3 ? "(3웨이, 정확)" : "(근사)"}
                  </option>
                ))}
              </select>
            </label>
            <label className="col" style={{ fontSize: 12, flex: 1 }}>
              이름 (비우면 자동)
              <input value={name} onChange={(e) => setName(e.target.value)} placeholder="예: BTN vs BB SRP K72r" />
            </label>
          </div>
          <BoardInput
            value={boardText}
            onChange={(v, cards) => {
              setBoardText(v);
              setBoard(cards);
            }}
          />
          <div className="form-grid">
            <label>
              팟 (bb)
              <input type="number" step="0.5" value={pot} onChange={(e) => setPot(Number(e.target.value))} />
            </label>
            <label>
              유효 스택 (bb{players > 2 ? ", 전원 동일" : ""})
              <input type="number" step="1" value={effStack} onChange={(e) => setEffStack(Number(e.target.value))} />
            </label>
            <label>
              레이크 %
              <input type="number" step="0.5" value={rakePct} onChange={(e) => setRakePct(Number(e.target.value))} />
            </label>
            <label>
              레이크 캡 (bb, 0=없음)
              <input type="number" step="0.5" value={rakeCap} onChange={(e) => setRakeCap(Number(e.target.value))} />
            </label>
          </div>
          <h3>베팅 트리 (팟 대비 %)</h3>
          <div className="form-grid">
            <label>
              {players === 2 ? "OOP 플랍 벳" : "플랍 벳 (전원)"}
              <input value={oopBet.flop} onChange={(e) => setOopBet({ ...oopBet, flop: e.target.value })} />
            </label>
            <label>
              {players === 2 ? "OOP 턴 벳" : "턴 벳 (전원)"}
              <input value={oopBet.turn} onChange={(e) => setOopBet({ ...oopBet, turn: e.target.value })} />
            </label>
            <label>
              {players === 2 ? "OOP 리버 벳" : "리버 벳 (전원)"}
              <input value={oopBet.river} onChange={(e) => setOopBet({ ...oopBet, river: e.target.value })} />
            </label>
            {players === 2 && (
              <>
                <label>
                  IP 플랍 벳
                  <input value={ipBet.flop} onChange={(e) => setIpBet({ ...ipBet, flop: e.target.value })} />
                </label>
                <label>
                  IP 턴 벳
                  <input value={ipBet.turn} onChange={(e) => setIpBet({ ...ipBet, turn: e.target.value })} />
                </label>
                <label>
                  IP 리버 벳
                  <input value={ipBet.river} onChange={(e) => setIpBet({ ...ipBet, river: e.target.value })} />
                </label>
              </>
            )}
            <label>
              레이즈 사이즈 (%)
              <input value={raise} onChange={(e) => setRaise(e.target.value)} />
            </label>
            <label>
              스트리트당 최대 벳+레이즈
              <input type="number" min={1} max={4} value={maxRaises} onChange={(e) => setMaxRaises(Number(e.target.value))} />
            </label>
            <label>
              올인 임계값 (남은 스택 %)
              <input type="number" min={0} max={100} value={allinThreshold} onChange={(e) => setAllinThreshold(Number(e.target.value))} />
            </label>
          </div>
          <div className="row">
            {players === 2 && (
              <label className="row">
                <input type="checkbox" checked={allowDonk} onChange={(e) => setAllowDonk(e.target.checked)} /> OOP 동크벳 허용
              </label>
            )}
            <label className="row">
              <input type="checkbox" checked={includeAllin} onChange={(e) => setIncludeAllin(e.target.checked)} /> 올인 항상 포함
            </label>
          </div>
          {players > 2 && (
            <div className="muted" style={{ fontSize: 12 }}>
              멀티웨이: 자리 순서는 포스트플랍 액션 순서({labels.join(" → ")})입니다. 3인까지는 상대 두 명의 카드 충돌을 정확히 계산하고, 4인 이상은 상대 간 겹침을 무시하는 근사입니다. 폴드한 플레이어의 카드 제거는 반영하지 않습니다. 3인 이상에서는 CFR이 내시 균형을 보장하지 않으므로 결과를 "균형 근사"로 보세요.
            </div>
          )}
          <h3>정확도 프리셋</h3>
          <div className="row">
            {(Object.keys(PRESETS) as PresetKey[]).map((k) => (
              <button key={k} className={preset === k ? "primary" : ""} onClick={() => setPreset(k)}>
                {PRESETS[k].label} <span className="muted" style={{ fontSize: 11 }}>{PRESETS[k].desc}</span>
              </button>
            ))}
          </div>
          <div className="card" style={{ background: "var(--bg3)" }}>
            {estErr && <div className="error">{estErr}</div>}
            {rangeErr && <div className="error">레인지 오류: {rangeErr}</div>}
            {estimate ? (
              <div className="tiles">
                <div className="tile">
                  <div className="v">{estimate.decisionNodes.toLocaleString()}</div>
                  <div className="k">결정 노드(런아웃 포함)</div>
                </div>
                <div className="tile">
                  <div className="v">{estimate.hands}</div>
                  <div className="k">핸드 콤보</div>
                </div>
                <div className="tile">
                  <div className={`v ${tooBig ? "error" : ""}`}>{fmtBytes(estimate.bytes)}</div>
                  <div className="k">예상 메모리 {tooBig ? "(한도 초과)" : ""}</div>
                </div>
                <div className="tile">
                  <div className="v">{estimate.estSecondsPerIter < 1 ? (estimate.estSecondsPerIter * 1000).toFixed(0) + "ms" : estimate.estSecondsPerIter.toFixed(1) + "s"}</div>
                  <div className="k">반복당 예상 시간</div>
                </div>
              </div>
            ) : (
              <span className="muted">트리 크기 추정 중…</span>
            )}
            {tooBig && <div className="warn" style={{ marginTop: 8 }}>트리가 너무 큽니다. 벳 사이즈 수를 줄이거나, 턴/리버 보드로 시작하거나, 최대 레이즈 수를 줄이세요. (한도 {fmtBytes(MEMORY_LIMIT)})</div>}
            {board && board.length === 3 && estimate && estimate.bytes > 300 * 1024 * 1024 && !tooBig && <div className="warn" style={{ marginTop: 8 }}>플랍 솔브는 브라우저에서 느릴 수 있습니다. 먼저 "빠름"으로 시도하세요.</div>}
            {players > 2 && estimate && estimate.estSecondsPerIter > 5 && <div className="warn" style={{ marginTop: 8 }}>멀티웨이는 반복당 비용이 큽니다. 리버/턴 시작, 단일 사이즈, 최대 레이즈 1을 권합니다.</div>}
          </div>
          <div className="row">
            <button className="primary" disabled={!canSolve} onClick={solve}>
              {running ? "솔빙 중…" : "솔브 시작"}
            </button>
            {running && (
              <button className="danger" onClick={() => solverClient.stop()}>
                중단
              </button>
            )}
            {!running && progress && <button onClick={continueSolve}>이어서 더 정밀하게</button>}
            {savedId && <button onClick={() => navigate("/mysolves", { spot: savedId })}>스터디에서 열기 →</button>}
          </div>
          {progress && (
            <div className="col">
              <div className="progress">
                <div style={{ width: `${Math.min(100, (progress.iterations / PRESETS[preset].maxIters) * 100)}%` }} />
              </div>
              <div className="tiles">
                <div className="tile">
                  <div className="v">{progress.iterations}</div>
                  <div className="k">반복</div>
                </div>
                <div className="tile">
                  <div className="v">{progress.exploitabilityPct.toFixed(2)}%</div>
                  <div className="k">익스플로잇어빌리티 (팟 %)</div>
                </div>
                <div className="tile">
                  <div className="v" style={{ fontSize: 15 }}>{progress.ev.map((e, i) => `${labels[i]} ${bb(e)}`).join(" · ")}</div>
                  <div className="k">EV (bb, 여기서부터 순이익)</div>
                </div>
                <div className="tile">
                  <div className="v">{fmtMs(progress.elapsedMs)}</div>
                  <div className="k">경과 {progress.done ? `· ${progress.reason}` : ""}</div>
                </div>
              </div>
            </div>
          )}
        </div>
        <div className="col">
          {labels.map((lab, i) => (
            <div className="card" key={i}>
              <RangeEditor
                label={`${lab} 레인지 ${i === 0 ? "(먼저 행동)" : i === players - 1 ? "(마지막 행동)" : ""}`}
                value={rangeTexts[i]}
                onChange={(t) =>
                  setRangeTexts((prev) => {
                    const next = prev.slice();
                    next[i] = t;
                    return next;
                  })
                }
              />
            </div>
          ))}
        </div>
      </div>

      <div className="card" style={{ marginTop: 14 }}>
        <h3>저장된 스팟 ({spots.length})</h3>
        {spots.length === 0 && <div className="muted">아직 없습니다. 위에서 솔브하면 자동 저장됩니다.</div>}
        {spots.length > 0 && (
          <table className="tbl">
            <thead>
              <tr>
                <th>이름</th>
                <th>인원</th>
                <th>보드</th>
                <th>팟/스택</th>
                <th>반복</th>
                <th>익스플로잇</th>
                <th>EV</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {spots.map((s) => (
                <tr key={s.id}>
                  <td>{s.name}</td>
                  <td>{s.players}인</td>
                  <td>
                    <Board cards={s.board} slots={5} size="sm" />
                  </td>
                  <td>
                    {s.pot} / {s.effStack}
                  </td>
                  <td>{s.iterations}</td>
                  <td>{s.exploitabilityPct.toFixed(2)}%</td>
                  <td>{s.ev.map((e, i) => <span key={i} style={{ color: SEAT_COLORS[i], marginRight: 6 }}>{bb(e)}</span>)}</td>
                  <td className="row">
                    <button onClick={() => navigate("/mysolves", { spot: s.id })}>스터디</button>
                    <button onClick={() => navigate("/trainer", { spot: s.id })}>트레이너</button>
                    <button
                      onClick={() => {
                        changePlayers(s.players);
                        setBoardText(s.board.map((c) => "23456789TJQKA"[c >> 2] + "cdhs"[c & 3]).join(""));
                        setPot(s.pot);
                        setEffStack(s.effStack);
                        setRangeTexts((prev) => {
                          const next = prev.slice();
                          s.rangeTexts.forEach((t, i) => (next[i] = t));
                          return next;
                        });
                        setName(s.name);
                      }}
                    >
                      설정 복사
                    </button>
                    <button
                      className="danger"
                      onClick={async () => {
                        if (confirm(`"${s.name}" 스팟을 삭제할까요?`)) {
                          await db.deleteSpot(s.id);
                          setSpots(await db.listSpots());
                        }
                      }}
                    >
                      삭제
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
