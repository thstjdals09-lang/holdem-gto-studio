import { useMemo, useState } from "react";
import { cardToString, comboIndex } from "../engine/cards";
import { analyzePreflop, matchFlop, pickFormat, verdictOf, type DecisionGrade, type HandAnalysis } from "../lib/analyze";
import { parseAll, type ParsedHand } from "../lib/hh";
import { MATCHUPS } from "../lib/postflopLib";
import { SAMPLE_HANDS, SAMPLE_HANDS_MTT } from "../lib/sampleHands";
import { auxClient } from "../worker/client";
import { Board, Spinner, useHashRoute } from "./common";
import { bb, pct } from "./format";
import { encodeIdx, FORMAT_LIST, libBase, loadMatchupIndex, loadPreflop } from "./lib";
import { encodePath, store } from "./store";

interface Row {
  hand: ParsedHand;
  an: HandAnalysis;
}

const VERDICT_KO = { correct: "정확", inaccuracy: "부정확", blunder: "블런더" } as const;

export function AnalyzePage() {
  const { navigate } = useHashRoute();
  const [text, setText] = useState("");
  const [fmt, setFmt] = useState("auto");
  const [rows, setRows] = useState<Row[]>([]);
  const [skipped, setSkipped] = useState(0);
  const [busy, setBusy] = useState<string | null>(null);
  const [sel, setSel] = useState<string | null>(null);
  const [filter, setFilter] = useState<"all" | "mistakes" | "postflop">("all");

  async function run(src: string) {
    const { hands, skipped } = parseAll(src);
    setSkipped(skipped);
    const out: Row[] = [];
    setBusy(`프리플랍 분석 중… (${hands.length}핸드)`);
    // 실제로 생성된 라이브러리 플랍 목록
    const avail = new Map<string, string[]>();
    for (const m of MATCHUPS) avail.set(m.id, (await loadMatchupIndex(m.id))?.flops.map((f) => f.flop) ?? []);
    const flopsOf = (id: string) => avail.get(id) ?? [];
    for (const h of hands) {
      if (!h.hero || !h.heroCards) continue;
      const f = fmt !== "auto" ? fmt : pickFormat(h, FORMAT_LIST.map((x) => x.id));
      const lib = await loadPreflop(f);
      const res = analyzePreflop(h, lib, flopsOf);
      out.push({ hand: h, an: res.analysis });
      // 포스트플랍 (라이브러리 스팟)
      if (res.analysis.libFlop && res.analysis.matchup) {
        const m = MATCHUPS.find((x) => x.id === res.analysis.matchup)!;
        const mf = matchFlop(h.board.slice(0, 3), flopsOf(m.id))!;
        const roleOf = (name: string) => {
          const idx = res.seatOf.get(name);
          if (idx === undefined) return -1;
          const pos = lib.format.positions[idx];
          return pos === m.oop ? 0 : pos === m.ip ? 1 : -1;
        };
        const heroRole = roleOf(h.hero) as 0 | 1;
        const items: Array<{ kind: "card"; card: number } | { kind: "action"; actor: 0 | 1; type: "fold" | "check" | "call" | "bet" | "raise"; amount: number; allin: boolean }> = [];
        const streets: Array<"flop" | "turn" | "river"> = ["flop", "turn", "river"];
        streets.forEach((st, si) => {
          if (si > 0) {
            const c = h.board[2 + si];
            if (c === undefined) return;
            items.push({ kind: "card", card: mf.map(c) });
          }
          for (const a of h.streets[st]) {
            const r = roleOf(a.player);
            if (r < 0) continue;
            items.push({ kind: "action", actor: r as 0 | 1, type: a.type, amount: a.amount, allin: a.allin });
          }
        });
        const heroCombo = comboIndex(mf.map(h.heroCards[0]), mf.map(h.heroCards[1]));
        setBusy(`포스트플랍 분석 중… #${h.id}`);
        try {
          const r = await auxClient.call<{ grades: Array<{ street: "flop" | "turn" | "river"; board: number[]; pot: number; chosen: string; best: string; freq: number; evLoss: number; options: Array<{ label: string; freq: number; ev: number }>; path: Array<{ kind: "action"; index: number } | { kind: "card"; card: number }> }>; note: string }>({
            type: "lib.analyze",
            baseUrl: libBase(),
            matchup: m.id,
            flop: mf.flop,
            heroSeat: heroRole,
            heroCombo,
            items
          });
          store.auxSpotId = null;
          for (const g of r.grades) {
            const dg: DecisionGrade = {
              street: g.street,
              label: `${g.street === "flop" ? "플랍" : g.street === "turn" ? "턴" : "리버"} · 팟 ${bb(g.pot, 1)}`,
              chosen: g.chosen,
              best: g.best,
              freq: g.freq,
              evLoss: g.evLoss,
              verdict: verdictOf(g.evLoss, g.freq, g.pot, g.street),
              options: g.options,
              link: { fmt: lib.format.id, pf: res.pfPath, fl: mf.flop, pp: g.path }
            };
            res.analysis.decisions.push(dg);
          }
          if (r.note) res.analysis.note = r.note;
        } catch (e) {
          res.analysis.note = e instanceof Error ? e.message : String(e);
        }
        res.analysis.postflopPending = false;
      }
      setRows(out.slice());
    }
    setRows(out);
    setBusy(null);
  }

  const stats = useMemo(() => {
    const n = rows.length;
    const net = rows.reduce((s, r) => s + r.an.net, 0);
    const vpip = rows.filter((r) => r.an.vpip).length;
    const pfr = rows.filter((r) => r.an.pfr).length;
    const opp3 = rows.filter((r) => r.an.threeBetOpp).length;
    const tb = rows.filter((r) => r.an.threeBet).length;
    const decs = rows.flatMap((r) => r.an.decisions);
    const correct = decs.filter((d) => d.verdict === "correct").length;
    const loss = decs.reduce((s, d) => s + d.evLoss, 0);
    const byPos = new Map<string, { n: number; net: number; loss: number; d: number }>();
    for (const r of rows) {
      const x = byPos.get(r.an.position) ?? { n: 0, net: 0, loss: 0, d: 0 };
      x.n++;
      x.net += r.an.net;
      x.loss += r.an.decisions.reduce((s, d) => s + d.evLoss, 0);
      x.d += r.an.decisions.length;
      byPos.set(r.an.position, x);
    }
    return { n, net, vpip, pfr, opp3, tb, decs: decs.length, correct, loss, byPos };
  }, [rows]);

  const shown = rows.filter((r) => (filter === "mistakes" ? r.an.decisions.some((d) => d.verdict !== "correct") : filter === "postflop" ? r.an.decisions.some((d) => d.street !== "preflop") : true));
  const selRow = rows.find((r) => r.hand.id === sel) ?? null;

  return (
    <div className="page">
      <h2>핸드 분석</h2>
      <div className="grid2">
        <div className="card col">
          <h3>핸드 히스토리 붙여넣기 / 파일 올리기</h3>
          <textarea rows={8} value={text} onChange={(e) => setText(e.target.value)} placeholder="PokerStars / GGPoker 핸드 히스토리 텍스트 (여러 핸드 가능)" spellCheck={false} />
          <div className="row">
            <input
              type="file"
              accept=".txt"
              multiple
              onChange={async (e) => {
                const files = Array.from(e.target.files ?? []);
                const texts = await Promise.all(files.map((f) => f.text()));
                setText(texts.join("\n\n"));
              }}
            />
            <select value={fmt} onChange={(e) => setFmt(e.target.value)}>
              <option value="auto">포맷 자동 (토너먼트는 스택에 가장 가까운 깊이)</option>
              {FORMAT_LIST.map((f) => (
                <option key={f.id} value={f.id}>
                  {f.name}
                </option>
              ))}
            </select>
          </div>
          <div className="row">
            <button className="primary" disabled={!!busy || !text.trim()} onClick={() => run(text)}>
              분석하기
            </button>
            <button
              onClick={() => {
                setText(SAMPLE_HANDS_MTT);
                run(SAMPLE_HANDS_MTT);
              }}
              disabled={!!busy}
            >
              토너먼트 예시로 해보기
            </button>
            <button
              className="ghost"
              onClick={() => {
                setText(SAMPLE_HANDS);
                run(SAMPLE_HANDS);
              }}
              disabled={!!busy}
            >
              캐시 예시
            </button>
            {rows.length > 0 && (
              <button className="ghost" onClick={() => setRows([])}>
                결과 지우기
              </button>
            )}
          </div>
          {busy && <Spinner text={busy} />}
          <div className="muted small">
            프리플랍은 선택한 포맷의 프리플랍 솔루션으로, 플랍 이후는 라이브러리에 있는 매치업·플랍(수트만 다른 보드 포함)일 때 결정마다 채점합니다. 라이브러리 트리에 없는 사이즈·라인은 그 지점에서 분석을 멈춥니다. 파일은 서버로 보내지 않고 이 브라우저에서만 처리합니다.
          </div>
        </div>
        <div className="card col">
          <h3>요약</h3>
          <div className="tiles">
            <div className="tile">
              <div className="v">{stats.n}</div>
              <div className="k">핸드 {skipped > 0 ? `(제외 ${skipped})` : ""}</div>
            </div>
            <div className="tile">
              <div className="v" style={{ color: stats.net >= 0 ? "var(--accent)" : "var(--danger)" }}>
                {stats.net >= 0 ? "+" : ""}
                {bb(stats.net, 1)}
              </div>
              <div className="k">순이익 (bb)</div>
            </div>
            <div className="tile">
              <div className="v">{stats.n ? pct(stats.vpip / stats.n, 0) : "-"}</div>
              <div className="k">VPIP</div>
            </div>
            <div className="tile">
              <div className="v">{stats.n ? pct(stats.pfr / stats.n, 0) : "-"}</div>
              <div className="k">PFR</div>
            </div>
            <div className="tile">
              <div className="v">{stats.opp3 ? pct(stats.tb / stats.opp3, 0) : "-"}</div>
              <div className="k">3벳</div>
            </div>
            <div className="tile">
              <div className="v">{stats.decs ? pct(stats.correct / stats.decs, 0) : "-"}</div>
              <div className="k">GTO 정확도 ({stats.decs}결정)</div>
            </div>
            <div className="tile">
              <div className="v">{bb(stats.loss, 2)}</div>
              <div className="k">총 EV 손실 (bb)</div>
            </div>
          </div>
          {stats.byPos.size > 0 && (
            <table className="tbl">
              <thead>
                <tr>
                  <th>자리</th>
                  <th>핸드</th>
                  <th>순이익</th>
                  <th>결정</th>
                  <th>EV 손실</th>
                </tr>
              </thead>
              <tbody>
                {Array.from(stats.byPos.entries()).map(([p, x]) => (
                  <tr key={p}>
                    <td>{p}</td>
                    <td>{x.n}</td>
                    <td>{bb(x.net, 1)}</td>
                    <td>{x.d}</td>
                    <td>{bb(x.loss)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
      {rows.length > 0 && (
        <div className="grid2" style={{ marginTop: 14 }}>
          <div className="card col">
            <div className="row" style={{ justifyContent: "space-between" }}>
              <h3 style={{ margin: 0 }}>핸드 목록</h3>
              <select value={filter} onChange={(e) => setFilter(e.target.value as typeof filter)}>
                <option value="all">전체</option>
                <option value="mistakes">실수 있는 핸드</option>
                <option value="postflop">포스트플랍 분석된 핸드</option>
              </select>
            </div>
            <table className="tbl">
              <thead>
                <tr>
                  <th>#</th>
                  <th>자리</th>
                  <th>핸드</th>
                  <th>보드</th>
                  <th>결과</th>
                  <th>결정</th>
                  <th>EV 손실</th>
                </tr>
              </thead>
              <tbody>
                {shown.map((r) => {
                  const worst = r.an.decisions.reduce<DecisionGrade | null>((w, d) => (!w || d.evLoss > w.evLoss ? d : w), null);
                  const loss = r.an.decisions.reduce((s, d) => s + d.evLoss, 0);
                  return (
                    <tr key={r.hand.id} className="clickable" onClick={() => setSel(r.hand.id)} style={{ background: sel === r.hand.id ? "var(--bg3)" : undefined }}>
                      <td className="small muted">{r.hand.id.slice(-6)}</td>
                      <td>{r.an.position}</td>
                      <td>{r.an.cards}</td>
                      <td>{r.hand.board.length ? <Board cards={r.hand.board} slots={r.hand.board.length} size="sm" /> : <span className="muted">-</span>}</td>
                      <td style={{ color: r.an.net >= 0 ? "var(--accent)" : "var(--danger)" }}>{bb(r.an.net, 1)}</td>
                      <td>
                        {r.an.decisions.length}
                        {worst && worst.verdict !== "correct" && <span className={`verdict ${worst.verdict}`} style={{ fontSize: 12, marginLeft: 6 }}>{VERDICT_KO[worst.verdict]}</span>}
                      </td>
                      <td>{bb(loss)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <div className="card col">
            {!selRow && <div className="muted">왼쪽에서 핸드를 고르세요.</div>}
            {selRow && (
              <>
                <h3>
                  #{selRow.hand.id} · {selRow.an.position} · {selRow.an.cards} · {bb(selRow.an.net, 1)}bb
                </h3>
                <div className="small muted">{selRow.an.preflopLine}</div>
                {selRow.hand.board.length > 0 && <Board cards={selRow.hand.board} slots={selRow.hand.board.length} size="sm" />}
                {selRow.an.libFlop && (
                  <div className="small">
                    라이브러리 매칭: <b>{MATCHUPS.find((m) => m.id === selRow.an.matchup)?.name}</b> · 플랍 {selRow.an.libFlop} (수트 대칭)
                  </div>
                )}
                {selRow.an.note && <div className="warn small">{selRow.an.note}</div>}
                {selRow.an.decisions.length === 0 && <div className="muted">채점된 결정이 없습니다.</div>}
                {selRow.an.decisions.map((d, i) => (
                  <div key={i} className="card" style={{ background: "var(--bg3)" }}>
                    <div className="row" style={{ justifyContent: "space-between" }}>
                      <b>{d.street === "preflop" ? "프리플랍" : d.label}</b>
                      <span className={`verdict ${d.verdict}`} style={{ fontSize: 14 }}>
                        {VERDICT_KO[d.verdict]}
                      </span>
                    </div>
                    {d.street === "preflop" && <div className="small muted">{d.label}</div>}
                    <div className="small">
                      선택 <b>{d.chosen}</b> (GTO {pct(d.freq, 0)}) · 최선 <b>{d.best}</b> · EV 손실 <b>{bb(d.evLoss)}bb</b>
                    </div>
                    <div className="small muted">{d.options.map((o) => `${o.label} ${pct(o.freq, 0)} (EV ${bb(o.ev)})`).join(" · ")}</div>
                    {d.link && (
                      <button
                        className="ghost"
                        style={{ marginTop: 6 }}
                        onClick={() => {
                          const q: Record<string, string> = { fmt: d.link!.fmt };
                          if (d.link!.pf.length) q.pf = encodeIdx(d.link!.pf);
                          if (d.link!.fl) q.fl = d.link!.fl;
                          if (d.link!.pp && d.link!.pp.length) q.pp = encodePath(d.link!.pp);
                          navigate("/study", q);
                        }}
                      >
                        스터디에서 이 지점 보기 →
                      </button>
                    )}
                  </div>
                ))}
                <details>
                  <summary className="small muted">원문 보기</summary>
                  <pre className="small" style={{ whiteSpace: "pre-wrap" }}>{selRow.hand.raw}</pre>
                </details>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

export { cardToString };
