import { useEffect, useMemo, useState } from "react";
import { parseCards } from "../engine/cards";
import { MATCHUPS, type MatchupIndex } from "../lib/postflopLib";
import { walkCodes } from "../lib/preflopLib";
import { Board, Spinner, useHashRoute } from "./common";
import { actionColors, bb, pct } from "./format";
import { encodeIdx, flopTexture, loadMatchupIndex, loadPreflop } from "./lib";

type Group = "none" | "high" | "suits" | "paired" | "connected";
type SortKey = "flop" | "oopBet" | "ipBet" | "evOop" | "evIp" | "eqOop";

export function ReportsPage() {
  const { params, navigate } = useHashRoute();
  const mid = params.get("m") ?? MATCHUPS[0].id;
  const m = MATCHUPS.find((x) => x.id === mid) ?? MATCHUPS[0];
  const [idx, setIdx] = useState<MatchupIndex | null>(null);
  const [loading, setLoading] = useState(true);
  const [group, setGroup] = useState<Group>("high");
  const [sort, setSort] = useState<SortKey>("flop");
  const [desc, setDesc] = useState(false);
  const [pfPath, setPfPath] = useState<number[] | null>(null);

  useEffect(() => {
    setLoading(true);
    setIdx(null);
    loadMatchupIndex(m.id).then((x) => {
      setIdx(x);
      setLoading(false);
    });
    loadPreflop(m.format).then((lib) => {
      const w = walkCodes(lib, m.codes);
      setPfPath(w.steps.map((s) => s.action));
    });
  }, [m.id]);

  const rows = useMemo(() => {
    if (!idx) return [];
    return idx.flops.map((f) => {
      const tex = flopTexture(f.flop);
      const sumBet = (arr: Array<{ label: string; freq: number }>) => arr.filter((a) => !a.label.startsWith("체크") && !a.label.startsWith("폴드") && !a.label.startsWith("콜")).reduce((s, a) => s + a.freq, 0);
      return { ...f, tex, oopBet: sumBet(f.root.oop), ipBet: sumBet(f.root.ipVsCheck) };
    });
  }, [idx]);

  const sorted = useMemo(() => {
    const r = rows.slice();
    const val = (x: (typeof rows)[number]) => (sort === "flop" ? 0 : (x as any)[sort] as number);
    if (sort !== "flop") r.sort((a, b) => (desc ? val(b) - val(a) : val(a) - val(b)));
    return r;
  }, [rows, sort, desc]);

  const groups = useMemo(() => {
    const key = (x: (typeof rows)[number]) => (group === "high" ? x.tex.high : group === "suits" ? x.tex.suits : group === "paired" ? (x.tex.paired ? "페어 보드" : "언페어") : group === "connected" ? (x.tex.connected ? "연결된 보드" : "연결 약함") : "전체");
    const map = new Map<string, typeof rows>();
    for (const r of rows) {
      const k = key(r);
      if (!map.has(k)) map.set(k, []);
      map.get(k)!.push(r);
    }
    return Array.from(map.entries()).map(([k, list]) => {
      const avg = (f: (x: (typeof rows)[number]) => number) => list.reduce((s, x) => s + f(x), 0) / list.length;
      return { k, n: list.length, oopBet: avg((x) => x.oopBet), ipBet: avg((x) => x.ipBet), evOop: avg((x) => x.evOop), evIp: avg((x) => x.evIp), eqOop: avg((x) => x.eqOop) };
    });
  }, [rows, group]);

  const ipActs = rows[0]?.root.ipVsCheck ?? [];
  const oopActs = rows[0]?.root.oop ?? [];
  const ipColors = actionColors(ipActs.map((a) => ({ type: a.label.startsWith("체크") ? "check" : a.label.startsWith("올인") ? "allin" : "bet" })));
  const oopColors = actionColors(oopActs.map((a) => ({ type: a.label.startsWith("체크") ? "check" : a.label.startsWith("올인") ? "allin" : "bet" })));
  const th = (k: SortKey, label: string) => (
    <th
      style={{ cursor: "pointer" }}
      onClick={() => {
        if (sort === k) setDesc(!desc);
        else {
          setSort(k);
          setDesc(true);
        }
      }}
    >
      {label} {sort === k ? (desc ? "▼" : "▲") : ""}
    </th>
  );

  return (
    <div className="page">
      <h2>집계 리포트</h2>
      <div className="row" style={{ marginBottom: 10 }}>
        <select value={m.id} onChange={(e) => navigate("/reports", { m: e.target.value })}>
          {MATCHUPS.map((x) => (
            <option key={x.id} value={x.id}>
              {x.name}
            </option>
          ))}
        </select>
        {idx && (
          <span className="muted small">
            플랍 {idx.flops.length}개 · 팟 {idx.pot}bb · 유효 스택 {idx.effStack}bb · 플랍 IP 33% 벳 / 체크레이즈 1사이즈, 턴 66%, 리버 75%
          </span>
        )}
      </div>
      {loading && <Spinner text="리포트 불러오는 중…" />}
      {!loading && (!idx || idx.flops.length === 0) && <div className="card muted">이 매치업의 라이브러리가 아직 생성되지 않았습니다.</div>}
      {idx && idx.flops.length > 0 && (
        <>
          <div className="card col">
            <div className="row" style={{ justifyContent: "space-between" }}>
              <h3 style={{ margin: 0 }}>보드 그룹별 평균</h3>
              <div className="tabs" style={{ margin: 0, border: "none" }}>
                {(
                  [
                    ["high", "하이카드"],
                    ["suits", "수트"],
                    ["paired", "페어"],
                    ["connected", "연결성"]
                  ] as Array<[Group, string]>
                ).map(([g, l]) => (
                  <button key={g} className={group === g ? "active" : ""} onClick={() => setGroup(g)}>
                    {l}
                  </button>
                ))}
              </div>
            </div>
            <table className="tbl">
              <thead>
                <tr>
                  <th>그룹</th>
                  <th>플랍 수</th>
                  <th>{m.oop} 첫 액션 벳</th>
                  <th>{m.ip} 체크 받고 벳</th>
                  <th>EV {m.oop}</th>
                  <th>EV {m.ip}</th>
                  <th>에퀴티 {m.oop}</th>
                </tr>
              </thead>
              <tbody>
                {groups.map((g) => (
                  <tr key={g.k}>
                    <td>{g.k}</td>
                    <td>{g.n}</td>
                    <td>
                      <BarPct v={g.oopBet} color="#ef4444" />
                    </td>
                    <td>
                      <BarPct v={g.ipBet} color="#ef4444" />
                    </td>
                    <td>{bb(g.evOop)}</td>
                    <td>{bb(g.evIp)}</td>
                    <td>{pct(g.eqOop)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="card col" style={{ marginTop: 12 }}>
            <h3>플랍별 (클릭하면 스터디로)</h3>
            <table className="tbl">
              <thead>
                <tr>
                  {th("flop", "플랍")}
                  <th>텍스처</th>
                  {th("oopBet", `${m.oop} 첫 액션`)}
                  {th("ipBet", `${m.ip} 체크 받고`)}
                  {th("evOop", `EV ${m.oop}`)}
                  {th("evIp", `EV ${m.ip}`)}
                  {th("eqOop", `에퀴티 ${m.oop}`)}
                  <th>정확도</th>
                </tr>
              </thead>
              <tbody>
                {sorted.map((r) => (
                  <tr
                    key={r.flop}
                    className="clickable"
                    onClick={() => {
                      if (!pfPath) return;
                      navigate("/study", { fmt: m.format, pf: encodeIdx(pfPath), fl: r.flop });
                    }}
                  >
                    <td>
                      <Board cards={parseCards(r.flop)} slots={3} size="sm" />
                    </td>
                    <td className="small muted">
                      {r.tex.suits}
                      {r.tex.paired ? " · 페어" : ""}
                      {r.tex.connected ? " · 연결" : ""}
                    </td>
                    <td>
                      <StackBar items={r.root.oop} colors={oopColors} />
                    </td>
                    <td>
                      <StackBar items={r.root.ipVsCheck} colors={ipColors} />
                    </td>
                    <td>{bb(r.evOop)}</td>
                    <td>{bb(r.evIp)}</td>
                    <td>{pct(r.eqOop)}</td>
                    <td className="small muted">{r.exploitabilityPct.toFixed(2)}%</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="legend">
              {ipActs.map((a, i) => (
                <span key={i} className="legend-item">
                  <i style={{ background: ipColors[i] }} />
                  {a.label}
                </span>
              ))}
            </div>
          </div>
        </>
      )}
    </div>
  );
}

function BarPct({ v, color }: { v: number; color: string }) {
  return (
    <div className="row" style={{ gap: 6, flexWrap: "nowrap" }}>
      <div className="bar" style={{ width: 120 }}>
        <span style={{ width: `${v * 100}%`, background: color }} />
      </div>
      <span className="small">{pct(v, 0)}</span>
    </div>
  );
}

function StackBar({ items, colors }: { items: Array<{ label: string; freq: number }>; colors: string[] }) {
  return (
    <div className="bar" style={{ width: 160 }} title={items.map((a) => `${a.label} ${pct(a.freq, 1)}`).join(" · ")}>
      {items.map((a, i) => (
        <span key={i} style={{ width: `${a.freq * 100}%`, background: colors[i] }} />
      ))}
    </div>
  );
}
