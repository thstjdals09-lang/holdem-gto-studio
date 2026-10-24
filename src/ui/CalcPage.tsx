import { useMemo, useState } from "react";
import { COMBO_CLASS, CLASS_COMBOS, NUM_CLASSES, parseCards } from "../engine/cards";
import { parseRange, classWeights } from "../engine/range";
import { icmEquities, bubbleFactors } from "../engine/icm";
import { auxClient } from "../worker/client";
import type { EquityResult } from "../engine/equity";
import { BoardInput, Spinner } from "./common";
import { RangeEditor } from "./RangeEditor";
import { RangeGrid } from "./RangeGrid";
import { pct } from "./format";

export function CalcPage() {
  const [tab, setTab] = useState<"equity" | "icm">("equity");
  return (
    <div className="page">
      <div className="tabs">
        <button className={tab === "equity" ? "active" : ""} onClick={() => setTab("equity")}>
          에퀴티 계산기
        </button>
        <button className={tab === "icm" ? "active" : ""} onClick={() => setTab("icm")}>
          ICM 계산기
        </button>
      </div>
      {tab === "equity" ? <EquityCalc /> : <IcmCalc />}
    </div>
  );
}

function EquityCalc() {
  const [a, setA] = useState("22+,A2s+,K9s+,Q9s+,J9s+,T9s,98s,87s,ATo+,KJo+");
  const [b, setB] = useState("QQ+,AK");
  const [boardText, setBoardText] = useState("");
  const [board, setBoard] = useState<number[] | null>([]);
  const [res, setRes] = useState<EquityResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function run() {
    setBusy(true);
    setErr(null);
    try {
      const w0 = parseRange(a);
      const w1 = parseRange(b);
      const bd = boardText.trim() === "" ? [] : parseCards(boardText);
      const r = await auxClient.call<EquityResult>({ type: "equity", oop: w0, ip: w1, board: bd, samples: 600 });
      setRes(r);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }
  const classEq = useMemo(() => {
    if (!res) return null;
    const out = new Float32Array(NUM_CLASSES);
    const w = classWeights(parseRange(a));
    for (let c = 0; c < NUM_CLASSES; c++) {
      let s = 0;
      let n = 0;
      for (const i of CLASS_COMBOS[c]) {
        if (res.perCombo0[i] > 0) {
          s += res.perCombo0[i];
          n++;
        }
      }
      out[c] = n ? s / n : 0;
    }
    return { eq: out, w };
  }, [res, a]);
  void COMBO_CLASS;
  return (
    <div className="grid2">
      <div className="col">
        <div className="card">
          <RangeEditor label="레인지 A" value={a} onChange={setA} />
        </div>
        <div className="card">
          <RangeEditor label="레인지 B" value={b} onChange={setB} />
        </div>
      </div>
      <div className="col">
        <div className="card col">
          <h3>보드 (비우면 프리플랍, 600보드 샘플링)</h3>
          <BoardInput value={boardText} min={0} max={5} onChange={(v, cards) => { setBoardText(v); setBoard(cards); }} />
          <button className="primary" onClick={run} disabled={busy}>
            계산
          </button>
          {busy && <Spinner />}
          {err && <div className="error">{err}</div>}
          {res && (
            <>
              <div className="tiles">
                <div className="tile">
                  <div className="v">{pct(res.equity0)}</div>
                  <div className="k">A 에퀴티</div>
                </div>
                <div className="tile">
                  <div className="v">{pct(res.equity1)}</div>
                  <div className="k">B 에퀴티</div>
                </div>
                <div className="tile">
                  <div className="v">{pct(res.tie)}</div>
                  <div className="k">무승부</div>
                </div>
                <div className="tile">
                  <div className="v">{res.boards.toLocaleString()}</div>
                  <div className="k">{res.exact ? "완전 열거 보드" : "샘플 보드"}</div>
                </div>
              </div>
              {classEq && (
                <>
                  <h3>레인지 A 핸드별 에퀴티</h3>
                  <RangeGrid mode="eq" weight={classEq.w} values={classEq.eq} valueRange={[0.2, 0.8]} formatValue={(v) => (v * 100).toFixed(0)} />
                </>
              )}
            </>
          )}
          {board === null && <div className="muted">보드를 확인하세요</div>}
        </div>
      </div>
    </div>
  );
}

function IcmCalc() {
  const [stacks, setStacks] = useState("12000, 8000, 5000, 3000, 2000");
  const [payouts, setPayouts] = useState("500, 300, 200");
  const nums = (s: string) => s.split(/[\s,]+/).map(Number).filter((x) => isFinite(x) && x > 0);
  const st = nums(stacks);
  const py = nums(payouts);
  const eq = useMemo(() => (st.length >= 2 && py.length >= 1 ? icmEquities(st, py) : null), [stacks, payouts]);
  const bf = useMemo(() => (st.length >= 2 && py.length >= 1 && st.length <= 10 ? bubbleFactors(st, py) : null), [stacks, payouts]);
  const total = st.reduce((x, y) => x + y, 0);
  const prize = py.reduce((x, y) => x + y, 0);
  return (
    <div className="grid2">
      <div className="card col">
        <h3>입력</h3>
        <label className="col" style={{ fontSize: 12 }}>
          스택 (쉼표 구분, 최대 10명)
          <input value={stacks} onChange={(e) => setStacks(e.target.value)} />
        </label>
        <label className="col" style={{ fontSize: 12 }}>
          상금 (1위부터)
          <input value={payouts} onChange={(e) => setPayouts(e.target.value)} />
        </label>
        <div className="muted" style={{ fontSize: 12 }}>Malmuth-Harville ICM. 버블 팩터 = 상대와 올인 대결에서 (지면 잃는 상금 기대값) ÷ (이기면 얻는 상금 기대값). 1보다 크면 칩 EV보다 더 보수적으로 플레이해야 합니다.</div>
      </div>
      <div className="card col">
        {eq && (
          <table className="tbl">
            <thead>
              <tr>
                <th>#</th>
                <th>스택</th>
                <th>칩 비율</th>
                <th>ICM $</th>
                <th>ICM 비율</th>
                <th>칩 대비</th>
              </tr>
            </thead>
            <tbody>
              {st.map((s, i) => (
                <tr key={i}>
                  <td>{i + 1}</td>
                  <td>{s.toLocaleString()}</td>
                  <td>{pct(s / total)}</td>
                  <td>{eq[i].toFixed(1)}</td>
                  <td>{pct(eq[i] / prize)}</td>
                  <td className={eq[i] / prize > s / total ? "warn" : ""}>{((eq[i] / prize / (s / total)) * 100).toFixed(0)}%</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {bf && (
          <>
            <h3>버블 팩터 (행: 나, 열: 상대)</h3>
            <table className="tbl">
              <thead>
                <tr>
                  <th></th>
                  {st.map((_, j) => (
                    <th key={j}>#{j + 1}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {st.map((_, i) => (
                  <tr key={i}>
                    <th>#{i + 1}</th>
                    {st.map((_, j) => (
                      <td key={j} style={{ color: bf[i][j] > 1.5 ? "var(--danger)" : bf[i][j] > 1.15 ? "var(--warn)" : undefined }}>
                        {i === j ? "-" : bf[i][j].toFixed(2)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}
      </div>
    </div>
  );
}
