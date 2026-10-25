import { useEffect, useMemo, useState } from "react";
import { CLASS_COMBOS, NUM_CLASSES, classLabel } from "../engine/cards";
import { rangeToString } from "../engine/range";
import type { PreflopConfig } from "../engine/preflop";
import { auxClient } from "../worker/client";
import type { PfView, SolveProgress } from "../worker/protocol";
import { db } from "./db";
import { numList, useHashRoute } from "./common";
import { RangeGrid, GridLegend } from "./RangeGrid";
import { actionColors, bb, pct } from "./format";
import { store } from "./store";

const MATRIX_KEY = "pf-equity-matrix-v1-300";

export function PreflopPage() {
  const { navigate } = useHashRoute();
  const [stack, setStack] = useState(25);
  const [openSizes, setOpenSizes] = useState("2.5");
  const [threeBet, setThreeBet] = useState("3");
  const [fourBet, setFourBet] = useState("2.3");
  const [maxRaises, setMaxRaises] = useState(3);
  const [allowLimp, setAllowLimp] = useState(true);
  const [includeAllin, setIncludeAllin] = useState(true);
  const [iters, setIters] = useState(600);
  const [matrix, setMatrix] = useState<Float32Array | null>(null);
  const [matrixProgress, setMatrixProgress] = useState<number | null>(null);
  const [progress, setProgress] = useState<SolveProgress | null>(null);
  const [solved, setSolved] = useState(false);
  const [running, setRunning] = useState(false);
  const [path, setPath] = useState<number[]>([]);
  const [labels, setLabels] = useState<Array<{ label: string; player: 0 | 1 }>>([]);
  const [view, setView] = useState<PfView | null>(null);
  const [selected, setSelected] = useState<number | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    db.getKV<Float32Array>(MATRIX_KEY).then((m) => {
      if (m && m.length === NUM_CLASSES * NUM_CLASSES) setMatrix(m);
    });
  }, []);

  async function ensureMatrix(): Promise<Float32Array> {
    if (matrix) return matrix;
    setMatrixProgress(0);
    const m = await auxClient.call<Float32Array>({ type: "preflop.matrix", samplesPerPair: 300 }, (p) => setMatrixProgress(p.iterations / 1000));
    await db.putKV(MATRIX_KEY, m);
    setMatrix(m);
    setMatrixProgress(null);
    return m;
  }

  const config: PreflopConfig = useMemo(
    () => ({ stackBb: stack, sbPosts: 0.5, bbPosts: 1, openSizes: numList(openSizes), threeBetMult: numList(threeBet), fourBetMult: numList(fourBet), maxRaises, allowLimp, includeAllin }),
    [stack, openSizes, threeBet, fourBet, maxRaises, allowLimp, includeAllin]
  );

  async function solve() {
    setRunning(true);
    setErr(null);
    setSolved(false);
    try {
      const m = await ensureMatrix();
      await auxClient.call({ type: "preflop.solve", config, matrix: m, iters, batch: 25 }, (p) => setProgress(p));
      setSolved(true);
      setPath([]);
      setLabels([]);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setRunning(false);
    }
  }

  useEffect(() => {
    if (!solved) return;
    auxClient.call<PfView>({ type: "preflop.view", path }).then(setView).catch((e) => setErr(e.message));
  }, [solved, path]);

  const colors = view ? actionColors(view.actions) : [];

  function sendToPostflop() {
    if (!view) return;
    // SB = IP(포스트플랍), BB = OOP
    const actorIsSb = view.player === 0;
    const toText = (cw: Float32Array) => {
      const w = new Float32Array(1326);
      for (let c = 0; c < NUM_CLASSES; c++) for (const i of CLASS_COMBOS[c]) w[i] = Math.min(1, cw[c]);
      return rangeToString(w);
    };
    const actorText = toText(view.classWeightNorm);
    const oppText = toText(view.oppClassWeightNorm);
    const sbText = actorIsSb ? actorText : oppText;
    const bbText = actorIsSb ? oppText : actorText;
    const pot = view.pot;
    const inv = Math.max(view.invested[0], view.invested[1]);
    store.setPendingSolve({ players: 2, rangeTexts: [bbText, sbText], pot, effStack: Math.max(1, stack - inv), note: `프리플랍 랩 ${labels.map((l) => l.label).join(" → ") || "루트"} 이후 (BB=OOP, SB=IP)` });
    navigate("/solve");
  }

  return (
    <div className="page">
      <h2>
        프리플랍 랩 <span className="badge warn">HU 근사: 에퀴티 기준, 포스트플랍 플레이 미반영</span>
      </h2>
      <div className="grid2">
        <div className="card col">
          <h3>설정 (SB vs BB, 헤즈업)</h3>
          <div className="form-grid">
            <label>
              스택 (bb)
              <input type="number" value={stack} onChange={(e) => setStack(Number(e.target.value))} />
            </label>
            <label>
              오픈 사이즈 (bb, 공백 구분)
              <input value={openSizes} onChange={(e) => setOpenSizes(e.target.value)} />
            </label>
            <label>
              3벳 배수
              <input value={threeBet} onChange={(e) => setThreeBet(e.target.value)} />
            </label>
            <label>
              4벳+ 배수
              <input value={fourBet} onChange={(e) => setFourBet(e.target.value)} />
            </label>
            <label>
              최대 레이즈 수
              <input type="number" min={1} max={4} value={maxRaises} onChange={(e) => setMaxRaises(Number(e.target.value))} />
            </label>
            <label>
              반복 횟수
              <input type="number" min={50} step={50} value={iters} onChange={(e) => setIters(Number(e.target.value))} />
            </label>
          </div>
          <div className="row">
            <label className="row">
              <input type="checkbox" checked={allowLimp} onChange={(e) => setAllowLimp(e.target.checked)} /> 림프 허용
            </label>
            <label className="row">
              <input type="checkbox" checked={includeAllin} onChange={(e) => setIncludeAllin(e.target.checked)} /> 올인 포함
            </label>
          </div>
          <div className="row">
            <button className="primary" disabled={running} onClick={solve}>
              {running ? "솔빙 중…" : "프리플랍 솔브"}
            </button>
            {matrix ? <span className="badge ok">에퀴티 행렬 준비됨 (169×169)</span> : <span className="badge">첫 실행 시 에퀴티 행렬 계산 (약 10~30초, 1회만)</span>}
          </div>
          {matrixProgress !== null && (
            <div className="col">
              <div className="muted">클래스 간 에퀴티 행렬 계산 중 {(matrixProgress * 100).toFixed(0)}%</div>
              <div className="progress">
                <div style={{ width: `${matrixProgress * 100}%` }} />
              </div>
            </div>
          )}
          {progress && (
            <div className="tiles">
              <div className="tile">
                <div className="v">{progress.iterations}</div>
                <div className="k">반복</div>
              </div>
              <div className="tile">
                <div className="v">{progress.exploitabilityPct.toFixed(2)}%</div>
                <div className="k">익스플로잇어빌리티</div>
              </div>
              <div className="tile">
                <div className="v">{bb(progress.evOop)} / {bb(progress.evIp)}</div>
                <div className="k">EV SB / BB (bb)</div>
              </div>
            </div>
          )}
          {err && <div className="error">{err}</div>}
          <div className="muted" style={{ fontSize: 12 }}>
            쇼다운 가치는 169×169 클래스 에퀴티(몬테카를로 300샘플/쌍)로 평가하고 카드 제거는 클래스 단위로 정확히 반영합니다. 포지션 이점·포스트플랍 플레이는 모델링하지 않으므로 실제보다 콜 레인지가 넓게 나올 수 있습니다. 결과를 "포스트플랍으로 보내기"로 넘겨 플랍부터는 정밀 솔브하세요.
          </div>
        </div>
        <div className="card col">
          {!view && <div className="muted">솔브하면 SB의 첫 액션 차트가 여기에 나옵니다.</div>}
          {view && (
            <>
              <div className="ribbon">
                <span className="chip" onClick={() => { setPath([]); setLabels([]); }}>
                  시작
                </span>
                {labels.map((l, i) => (
                  <span key={i} className={`chip ${l.player === 0 ? "ip" : "oop"}`} onClick={() => { setPath(path.slice(0, i + 1)); setLabels(labels.slice(0, i + 1)); }}>
                    {l.player === 0 ? "SB" : "BB"} {l.label}
                  </span>
                ))}
              </div>
              {view.isTerminal ? (
                <div className="card" style={{ background: "var(--bg3)" }}>
                  {view.terminalType === "fold" ? "폴드로 종료" : "쇼다운(올인/콜)"} · 팟 {bb(view.pot)}
                </div>
              ) : (
                <>
                  <h3>
                    <b style={{ color: view.player === 0 ? "#fb923c" : "#60a5fa" }}>{view.player === 0 ? "SB" : "BB"}</b> 행동 · 팟 {bb(view.pot)} {view.toCall > 0 && `· 콜 ${bb(view.toCall)}`}
                  </h3>
                  <RangeGrid mode="strategy" classFreq={view.classFreq} actionCount={view.actions.length} colors={colors} weight={view.classWeightNorm} size="lg" selected={selected} onSelect={setSelected} />
                  <GridLegend actions={view.actions} colors={colors} />
                  <div className="actions">
                    {view.actions.map((a, i) => (
                      <button key={i} className="action-btn" onClick={() => { setPath([...path, i]); setLabels([...labels, { label: a.label, player: view.player }]); }}>
                        <i style={{ background: colors[i] }} />
                        <span>{a.label}</span>
                        <span className="freq">{pct(a.freq)}</span>
                        <span className="ev">EV {bb(a.ev)}</span>
                      </button>
                    ))}
                  </div>
                  {selected !== null && (
                    <div className="muted" style={{ fontSize: 12 }}>
                      {classLabel(selected)}: {view.actions.map((a, i) => `${a.code} ${(view.classFreq[selected * view.actions.length + i] * 100).toFixed(0)}% (EV ${bb(view.classEv[selected * view.actions.length + i])})`).join(" · ")}
                    </div>
                  )}
                  <button onClick={sendToPostflop}>이 지점의 레인지로 포스트플랍 솔브 설정 →</button>
                </>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
