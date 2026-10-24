import { useEffect, useMemo, useRef, useState } from "react";
import { parseCards } from "../engine/cards";
import { parseRange } from "../engine/range";
import type { TreeConfig } from "../engine/tree";
import { solverClient } from "../worker/client";
import type { EstimateResult, SolveProgress } from "../worker/protocol";
import { db, newId, type SavedSpot } from "./db";
import { BoardInput, fmtBytes, fmtMs, numList, useHashRoute } from "./common";
import { RangeEditor } from "./RangeEditor";
import { store } from "./store";
import { bb } from "./format";

const PRESETS = {
  quick: { label: "빠름", targetExploit: 1.0, maxIters: 300, maxMs: 60_000, desc: "익스플로잇 1% · 300회 · 1분" },
  standard: { label: "표준", targetExploit: 0.5, maxIters: 1000, maxMs: 5 * 60_000, desc: "0.5% · 1000회 · 5분" },
  deep: { label: "깊음", targetExploit: 0.2, maxIters: 3000, maxMs: 20 * 60_000, desc: "0.2% · 3000회 · 20분" }
} as const;
type PresetKey = keyof typeof PRESETS;

const MEMORY_LIMIT = 1.2 * 1024 * 1024 * 1024;

export function SolvePage() {
  const { navigate } = useHashRoute();
  const pending = useMemo(() => store.takePendingSolve(), []);
  const [name, setName] = useState("");
  const [boardText, setBoardText] = useState("Ks7d2c");
  const [board, setBoard] = useState<number[] | null>(parseCards("Ks7d2c"));
  const [pot, setPot] = useState(pending?.pot ?? 5.5);
  const [effStack, setEffStack] = useState(pending?.effStack ?? 97.5);
  const [rakePct, setRakePct] = useState(0);
  const [rakeCap, setRakeCap] = useState(0);
  const [oopText, setOopText] = useState(pending?.oopText ?? "22+,A2s+,K2s+,Q4s+,J6s+,T6s+,96s+,85s+,75s+,64s+,53s+,A2o+,K8o+,Q9o+,J9o+,T9o");
  const [ipText, setIpText] = useState(pending?.ipText ?? "22+,A2s+,K9s+,Q9s+,J9s+,T9s,98s,87s,76s,65s,ATo+,KJo+,QJo");
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

  const config: TreeConfig | null = useMemo(() => {
    if (!board) return null;
    const mk = (s: string) => ({ bet: numList(s), raise: numList(raise) });
    return {
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
  }, [board, pot, effStack, rakePct, rakeCap, oopBet, ipBet, raise, allinThreshold, maxRaises, allowDonk, includeAllin]);

  const ranges = useMemo(() => {
    try {
      return { oop: parseRange(oopText), ip: parseRange(ipText), err: null as string | null };
    } catch (e) {
      return { oop: null, ip: null, err: e instanceof Error ? e.message : String(e) };
    }
  }, [oopText, ipText]);

  useEffect(() => {
    db.listSpots().then(setSpots);
  }, [savedId]);

  useEffect(() => {
    if (estTimer.current) window.clearTimeout(estTimer.current);
    if (!config || !ranges.oop || !ranges.ip) {
      setEstimate(null);
      return;
    }
    estTimer.current = window.setTimeout(() => {
      solverClient
        .call<EstimateResult>({ type: "estimate", config, oop: ranges.oop!, ip: ranges.ip! })
        .then((r) => {
          setEstimate(r);
          setEstErr(null);
        })
        .catch((e) => setEstErr(e.message));
    }, 350);
  }, [config, ranges]);

  const tooBig = estimate ? estimate.bytes > MEMORY_LIMIT : false;
  const canSolve = !!config && !!ranges.oop && !!ranges.ip && !running && !tooBig && (estimate?.hands ?? 0) > 0;

  async function solve() {
    if (!config || !ranges.oop || !ranges.ip) return;
    setRunning(true);
    setProgress(null);
    setSavedId(null);
    store.lastConfig = config;
    const p = PRESETS[preset];
    try {
      await solverClient.call({ type: "solve.start", config, oop: ranges.oop, ip: ranges.ip, targetExploitPct: p.targetExploit, maxIters: p.maxIters, maxMs: p.maxMs, batch: 10 }, (pr) => setProgress(pr));
      await save();
    } catch (e) {
      setEstErr(e instanceof Error ? e.message : String(e));
    } finally {
      setRunning(false);
    }
  }
  async function continueSolve() {
    setRunning(true);
    const p = PRESETS[preset];
    try {
      await solverClient.call({ type: "solve.continue", targetExploitPct: p.targetExploit / 2, maxIters: (progress?.iterations ?? 0) + p.maxIters, maxMs: p.maxMs, batch: 10 }, (pr) => setProgress(pr));
      await save();
    } finally {
      setRunning(false);
    }
  }
  async function save() {
    if (!config || !ranges.oop || !ranges.ip) return;
    const ex = await solverClient.call<{ strategy: Float32Array; iterations: number; metrics: { exploitabilityPct: number; evOop: number; evIp: number } }>({ type: "spot.export" });
    const id = savedId ?? newId();
    const spot: SavedSpot = {
      id,
      name: name.trim() || `${boardText.toUpperCase()} 팟${pot} 스택${effStack}`,
      createdAt: Date.now(),
      config,
      oopText,
      ipText,
      oop: ranges.oop,
      ip: ranges.ip,
      strategy: ex.strategy,
      iterations: ex.iterations,
      exploitabilityPct: ex.metrics.exploitabilityPct,
      evOop: ex.metrics.evOop,
      evIp: ex.metrics.evIp
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
          <label className="col" style={{ fontSize: 12 }}>
            이름 (비우면 자동)
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="예: BTN vs BB SRP K72r" />
          </label>
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
              유효 스택 (bb)
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
              OOP 플랍 벳
              <input value={oopBet.flop} onChange={(e) => setOopBet({ ...oopBet, flop: e.target.value })} />
            </label>
            <label>
              OOP 턴 벳
              <input value={oopBet.turn} onChange={(e) => setOopBet({ ...oopBet, turn: e.target.value })} />
            </label>
            <label>
              OOP 리버 벳
              <input value={oopBet.river} onChange={(e) => setOopBet({ ...oopBet, river: e.target.value })} />
            </label>
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
            <label className="row">
              <input type="checkbox" checked={allowDonk} onChange={(e) => setAllowDonk(e.target.checked)} /> OOP 동크벳 허용
            </label>
            <label className="row">
              <input type="checkbox" checked={includeAllin} onChange={(e) => setIncludeAllin(e.target.checked)} /> 올인 항상 포함
            </label>
          </div>
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
            {ranges.err && <div className="error">레인지 오류: {ranges.err}</div>}
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
            {tooBig && <div className="warn" style={{ marginTop: 8 }}>트리가 너무 큽니다. 벳 사이즈 수를 줄이거나, 턴/리버 보드로 시작하거나, 올인 임계값을 낮추세요. (한도 {fmtBytes(MEMORY_LIMIT)})</div>}
            {board && board.length === 3 && estimate && estimate.bytes > 300 * 1024 * 1024 && !tooBig && <div className="warn" style={{ marginTop: 8 }}>플랍 솔브는 브라우저에서 느릴 수 있습니다. 먼저 "빠름"으로 시도하세요.</div>}
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
            {!running && progress && (
              <button onClick={continueSolve}>이어서 더 정밀하게</button>
            )}
            {savedId && (
              <button onClick={() => navigate("/study", { spot: savedId })}>스터디에서 열기 →</button>
            )}
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
                  <div className="v">{bb(progress.evOop)} / {bb(progress.evIp)}</div>
                  <div className="k">EV OOP / IP (bb)</div>
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
          <div className="card">
            <RangeEditor label="OOP 레인지 (먼저 행동)" value={oopText} onChange={setOopText} />
          </div>
          <div className="card">
            <RangeEditor label="IP 레인지 (나중에 행동)" value={ipText} onChange={setIpText} />
          </div>
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
                <th>보드</th>
                <th>팟/스택</th>
                <th>반복</th>
                <th>익스플로잇</th>
                <th>EV OOP/IP</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {spots.map((s) => (
                <tr key={s.id}>
                  <td>{s.name}</td>
                  <td>{s.config.board.map((c) => "23456789TJQKA"[c >> 2] + "cdhs"[c & 3]).join(" ")}</td>
                  <td>
                    {s.config.pot} / {s.config.effStack}
                  </td>
                  <td>{s.iterations}</td>
                  <td>{s.exploitabilityPct.toFixed(2)}%</td>
                  <td>
                    {bb(s.evOop)} / {bb(s.evIp)}
                  </td>
                  <td className="row">
                    <button onClick={() => navigate("/study", { spot: s.id })}>스터디</button>
                    <button onClick={() => navigate("/trainer", { spot: s.id })}>트레이너</button>
                    <button
                      onClick={() => {
                        setBoardText(s.config.board.map((c) => "23456789TJQKA"[c >> 2] + "cdhs"[c & 3]).join(""));
                        setPot(s.config.pot);
                        setEffStack(s.config.effStack);
                        setOopText(s.oopText);
                        setIpText(s.ipText);
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
