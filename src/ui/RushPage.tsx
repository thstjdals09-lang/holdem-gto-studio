import { useEffect, useRef, useState } from "react";
import { shuffledDeck } from "../engine/cards";
import { auxClient } from "../worker/client";
import { Board, PlayingCard } from "./common";

interface Round {
  h0: [number, number];
  h1: [number, number];
  board: number[];
  truth: number | null;
}
interface Result {
  guess: number;
  truth: number;
  score: number;
}

const ROUND_SECONDS = 15;

export function RushPage() {
  const [round, setRound] = useState<Round | null>(null);
  const [guess, setGuess] = useState(50);
  const [results, setResults] = useState<Result[]>([]);
  const [timeLeft, setTimeLeft] = useState(ROUND_SECONDS);
  const [last, setLast] = useState<Result | null>(null);
  const [stage, setStage] = useState<"random" | "preflop" | "flop" | "turn">("random");
  const timer = useRef<number | null>(null);
  const truthRef = useRef<Promise<number> | null>(null);

  function newRound() {
    const deck = shuffledDeck([]);
    const stages: Array<0 | 3 | 4> = stage === "random" ? [0, 3, 4] : stage === "preflop" ? [0] : stage === "flop" ? [3] : [4];
    const n = stages[Math.floor(Math.random() * stages.length)];
    const r: Round = { h0: [deck[0], deck[1]], h1: [deck[2], deck[3]], board: deck.slice(4, 4 + n), truth: null };
    setRound(r);
    setLast(null);
    setGuess(50);
    setTimeLeft(ROUND_SECONDS);
    truthRef.current = auxClient.call<{ equity0: number }>({ type: "handVsHand", h0: r.h0, h1: r.h1, board: r.board, samples: 30000 }).then((x) => x.equity0 * 100);
    if (timer.current) window.clearInterval(timer.current);
    timer.current = window.setInterval(() => setTimeLeft((t) => t - 1), 1000);
  }

  useEffect(() => {
    if (timeLeft <= 0 && round && !last) submit();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [timeLeft]);
  useEffect(() => () => { if (timer.current) window.clearInterval(timer.current); }, []);

  async function submit() {
    if (!round || !truthRef.current) return;
    if (timer.current) window.clearInterval(timer.current);
    const truth = await truthRef.current;
    const diff = Math.abs(truth - guess);
    const score = Math.max(0, Math.round(100 - diff * 4));
    const res = { guess, truth, score };
    setLast(res);
    setResults((r) => [res, ...r].slice(0, 50));
  }

  const total = results.reduce((a, r) => a + r.score, 0);
  const avgDiff = results.length ? results.reduce((a, r) => a + Math.abs(r.truth - r.guess), 0) / results.length : 0;

  return (
    <div className="page">
      <h2>
        에퀴티 러시 <span className="muted" style={{ fontSize: 13 }}>핸드 A의 에퀴티를 {ROUND_SECONDS}초 안에 맞히세요</span>
      </h2>
      <div className="grid2">
        <div className="card col">
          <div className="row">
            <label className="row" style={{ fontSize: 12 }}>
              단계
              <select value={stage} onChange={(e) => setStage(e.target.value as typeof stage)}>
                <option value="random">무작위</option>
                <option value="preflop">프리플랍</option>
                <option value="flop">플랍</option>
                <option value="turn">턴</option>
              </select>
            </label>
            <button className="primary" onClick={newRound}>
              {round ? "다음 문제" : "시작"}
            </button>
            {round && !last && <span className={`badge ${timeLeft <= 5 ? "warn" : ""}`}>⏱ {Math.max(0, timeLeft)}초</span>}
          </div>
          {round && (
            <div className="table-felt">
              <div className="seat">
                <span className="name">핸드 B</span>
                <span>
                  <PlayingCard card={round.h1[0]} />
                  <PlayingCard card={round.h1[1]} />
                </span>
              </div>
              <Board cards={round.board} />
              <div className="seat hero-hand">
                <span>
                  <PlayingCard card={round.h0[0]} />
                  <PlayingCard card={round.h0[1]} />
                </span>
                <span className="name">핸드 A (이 핸드의 에퀴티?)</span>
              </div>
            </div>
          )}
          {round && !last && (
            <div className="col">
              <div className="row" style={{ justifyContent: "center", fontSize: 28, fontWeight: 800 }}>{guess}%</div>
              <input type="range" min={0} max={100} value={guess} onChange={(e) => setGuess(Number(e.target.value))} />
              <div className="row" style={{ justifyContent: "center" }}>
                {[-10, -5, -1, +1, +5, +10].map((d) => (
                  <button key={d} onClick={() => setGuess((g) => Math.max(0, Math.min(100, g + d)))}>
                    {d > 0 ? "+" + d : d}
                  </button>
                ))}
                <button className="primary" onClick={submit}>
                  확정
                </button>
              </div>
            </div>
          )}
          {last && (
            <div className="card" style={{ background: "var(--bg3)" }}>
              <div className={`verdict ${Math.abs(last.truth - last.guess) <= 3 ? "correct" : Math.abs(last.truth - last.guess) <= 8 ? "inaccuracy" : "blunder"}`}>+{last.score}점</div>
              <div>
                정답 <b>{last.truth.toFixed(1)}%</b> · 내 답 {last.guess}% · 오차 {Math.abs(last.truth - last.guess).toFixed(1)}%p
              </div>
            </div>
          )}
        </div>
        <div className="card col">
          <h3>기록</h3>
          <div className="tiles">
            <div className="tile">
              <div className="v">{results.length}</div>
              <div className="k">문제</div>
            </div>
            <div className="tile">
              <div className="v">{total}</div>
              <div className="k">총점</div>
            </div>
            <div className="tile">
              <div className="v">{avgDiff.toFixed(1)}%p</div>
              <div className="k">평균 오차</div>
            </div>
          </div>
          <table className="tbl">
            <tbody>
              {results.slice(0, 15).map((r, i) => (
                <tr key={i}>
                  <td>정답 {r.truth.toFixed(1)}%</td>
                  <td>답 {r.guess}%</td>
                  <td>+{r.score}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="muted" style={{ fontSize: 12 }}>점수 = 100 − 오차(%p)×4. 프리플랍은 3만 보드 샘플링, 플랍·턴은 완전 열거입니다.</div>
        </div>
      </div>
    </div>
  );
}
