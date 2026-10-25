import { useEffect, useMemo, useState } from "react";
import { CLASS_COMBOS, COMBO_CARDS, NUM_CLASSES, classLabel } from "../engine/cards";
import { CLASS_N, walkIdx, type PfLib, type PfLibNode } from "../lib/preflopLib";
import { PlayingCard, Spinner } from "./common";
import { actionColors, bb, pct } from "./format";
import { DEFAULT_FORMAT, FORMAT_LIST, loadPreflop } from "./lib";
import { db, newId, type TrainerRecord } from "./db";

type Scenario = "rfi" | "vsOpen" | "vs3bet" | "all";
const SCENARIOS: Array<[Scenario, string]> = [
  ["rfi", "오픈 (RFI)"],
  ["vsOpen", "오픈에 대응"],
  ["vs3bet", "3벳에 대응"],
  ["all", "전체 무작위"]
];

interface Deal {
  path: number[];
  node: PfLibNode;
  cls: number;
  combo: number;
  reachMass: number;
}
interface Result {
  chosen: number;
  best: number;
  evLoss: number;
  verdict: "correct" | "inaccuracy" | "blunder";
}

/** 시나리오에 맞는 결정 노드 목록과 각 노드의 도달 질량 (루트부터 평균 전략으로) */
function collectSpots(lib: PfLib, sc: Scenario, seat: number): Array<{ path: number[]; node: PfLibNode; mass: number }> {
  const out: Array<{ path: number[]; node: PfLibNode; mass: number }> = [];
  const N = lib.format.positions.length;
  const rec = (node: PfLibNode, path: number[], probOthers: number) => {
    const match = (sc === "rfi" && node.lv === 0) || (sc === "vsOpen" && node.lv === 1) || (sc === "vs3bet" && node.lv === 2) || (sc === "all" && node.lv <= 3);
    if (match && (seat < 0 || node.p === seat) && probOthers > 1e-4) out.push({ path, node, mass: probOthers });
    if (node.lv > 3 || path.length > 12) return;
    const w = walkIdx(lib, path);
    const r = w.reach[node.p];
    node.a.forEach((_, a) => {
      // 이 액션이 선택될 평균 확률 (자리 레인지 전체 기준)
      let tot = 0;
      let f = 0;
      for (let c = 0; c < NUM_CLASSES; c++) {
        tot += r[c];
        f += r[c] * (node.s[a * NUM_CLASSES + c] / 1000);
      }
      const pa = tot > 0 ? f / tot : 0;
      const c = node.c[a];
      if (typeof c === "number" && pa > 1e-3) rec(lib.nodes[c], [...path, a], probOthers * pa);
    });
  };
  void N;
  rec(lib.nodes[0], [], 1);
  return out;
}

function pick<T>(items: T[], weight: (x: T) => number): T | null {
  let tot = 0;
  for (const x of items) tot += weight(x);
  if (tot <= 0) return null;
  let r = Math.random() * tot;
  for (const x of items) {
    r -= weight(x);
    if (r <= 0) return x;
  }
  return items[items.length - 1];
}

export function PreflopTrainer() {
  const [fmt, setFmt] = useState(DEFAULT_FORMAT);
  const [lib, setLib] = useState<PfLib | null>(null);
  const [sc, setSc] = useState<Scenario>("rfi");
  const [seat, setSeat] = useState(-1);
  const [deal, setDeal] = useState<Deal | null>(null);
  const [res, setRes] = useState<Result | null>(null);
  const [history, setHistory] = useState<Array<{ ok: boolean; evLoss: number; verdict: string }>>([]);
  useEffect(() => {
    setLib(null);
    setDeal(null);
    loadPreflop(fmt).then(setLib);
  }, [fmt]);
  const spots = useMemo(() => (lib ? collectSpots(lib, sc, seat) : []), [lib, sc, seat]);

  function next() {
    if (!lib) return;
    const s = pick(spots, (x) => x.mass);
    if (!s) return;
    const w = walkIdx(lib, s.path);
    const r = w.reach[s.node.p];
    const cls = pick(Array.from({ length: NUM_CLASSES }, (_, i) => i), (c) => r[c])!;
    const combos = CLASS_COMBOS[cls];
    const combo = combos[Math.floor(Math.random() * combos.length)];
    setDeal({ path: s.path, node: s.node, cls, combo, reachMass: r[cls] / CLASS_N[cls] });
    setRes(null);
  }
  useEffect(() => {
    if (spots.length) next();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [spots]);

  async function choose(a: number) {
    if (!deal || !lib || res) return;
    const n = deal.node;
    const evs = n.a.map((_, i) => n.e[i * NUM_CLASSES + deal.cls] / 100);
    let best = 0;
    for (let i = 1; i < evs.length; i++) if (evs[i] > evs[best]) best = i;
    const evLoss = Math.max(0, evs[best] - evs[a]);
    const freq = n.s[a * NUM_CLASSES + deal.cls] / 1000;
    const verdict: Result["verdict"] = freq >= 0.3 || evLoss <= 0.05 ? "correct" : evLoss <= 0.3 ? "inaccuracy" : "blunder";
    setRes({ chosen: a, best, evLoss, verdict });
    setHistory((h) => [{ ok: verdict === "correct", evLoss, verdict }, ...h]);
    const rec: TrainerRecord = {
      id: newId(),
      at: Date.now(),
      spotId: `pf:${fmt}`,
      spotName: `프리플랍 ${lib.format.name}`,
      heroSeat: n.p,
      seatLabel: lib.format.positions[n.p],
      street: 0,
      heroCombo: deal.combo,
      chosen: n.a[a][2],
      best: n.a[best][2],
      evLoss,
      evLossPot: n.pot > 0 ? (evLoss / n.pot) * 100 : 0,
      verdict,
      gtoFreq: freq
    };
    await db.putTrainer(rec);
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.tagName === "INPUT" || (e.target as HTMLElement)?.tagName === "TEXTAREA" || (e.target as HTMLElement)?.tagName === "SELECT") return;
      if (!deal) return;
      const k = Number(e.key);
      if (!res && k >= 1 && k <= deal.node.a.length) {
        e.preventDefault();
        choose(k - 1);
      } else if (res && (e.key === "Enter" || e.key === " ")) {
        e.preventDefault();
        next();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  if (!lib) return <Spinner text="프리플랍 솔루션 불러오는 중…" />;
  const n = deal?.node;
  const colors = n ? actionColors(n.a.map((a) => ({ type: a[0] }))) : [];
  const correct = history.filter((h) => h.ok).length;
  const avgLoss = history.length ? history.reduce((s, h) => s + h.evLoss, 0) / history.length : 0;
  const lineSteps = deal ? walkIdx(lib, deal.path).steps : [];
  return (
    <div className="grid2">
      <div className="col">
        <div className="card row">
          <select value={fmt} onChange={(e) => setFmt(e.target.value)}>
            {FORMAT_LIST.map((f) => (
              <option key={f.id} value={f.id}>
                {f.name}
              </option>
            ))}
          </select>
          <select value={sc} onChange={(e) => setSc(e.target.value as Scenario)}>
            {SCENARIOS.map(([k, l]) => (
              <option key={k} value={k}>
                {l}
              </option>
            ))}
          </select>
          <select value={seat} onChange={(e) => setSeat(Number(e.target.value))}>
            <option value={-1}>모든 자리</option>
            {lib.format.positions.map((p, i) => (
              <option key={i} value={i}>
                {p}
              </option>
            ))}
          </select>
          <button className="primary" onClick={next}>
            다음 문제
          </button>
          <span className="muted small">{spots.length}개 상황</span>
        </div>
        {deal && n && (
          <div className="card col">
            <div className="row">
              {lineSteps.length === 0 ? (
                <span className="muted">당신이 첫 번째로 행동합니다</span>
              ) : (
                lineSteps.map((s, i) => (
                  <span key={i} className={`act-chip ${s.node.a[s.action][0]}`}>
                    {lib.format.positions[s.node.p]} {s.node.a[s.action][2]}
                  </span>
                ))
              )}
            </div>
            <div className="table-felt" style={{ minHeight: 160 }}>
              <div style={{ fontWeight: 700 }}>팟 {bb(n.pot, 1)}bb · 콜 {bb(n.call, 1)}bb</div>
              <div className="seat hero-hand">
                <span>
                  <PlayingCard card={COMBO_CARDS[deal.combo][0]} />
                  <PlayingCard card={COMBO_CARDS[deal.combo][1]} />
                </span>
                <span className="name">
                  나 ({lib.format.positions[n.p]}) · 스택 {bb(lib.format.stack - n.inv[n.p], 1)}bb
                </span>
              </div>
            </div>
            <div className="row">
              {n.a.map((a, i) => (
                <button key={i} className="primary" style={{ background: colors[i], color: "#fff", opacity: res && res.chosen !== i && res.best !== i ? 0.5 : 1 }} onClick={() => choose(i)} disabled={!!res}>
                  <span className="kbd" style={{ marginRight: 6, color: "#fff", borderColor: "rgba(255,255,255,.5)" }}>{i + 1}</span>
                  {a[2]}
                </button>
              ))}
            </div>
            <div className="muted small">단축키: 숫자 1~{n.a.length}로 선택, Enter·Space로 다음 문제</div>
          </div>
        )}
      </div>
      <div className="col">
        {res && deal && n && (
          <div className="card col">
            <div className={`verdict ${res.verdict}`}>{res.verdict === "correct" ? "정확!" : res.verdict === "inaccuracy" ? "부정확" : "블런더"}</div>
            <div>
              {classLabel(deal.cls)}: 선택 <b>{n.a[res.chosen][2]}</b> · 최선 <b>{n.a[res.best][2]}</b> · EV 손실 <b>{bb(res.evLoss)}bb</b>
            </div>
            <table className="tbl">
              <thead>
                <tr>
                  <th>액션</th>
                  <th>GTO 빈도</th>
                  <th>EV (bb)</th>
                </tr>
              </thead>
              <tbody>
                {n.a.map((a, i) => (
                  <tr key={i} style={{ fontWeight: i === res.best ? 700 : 400 }}>
                    <td>
                      {i === res.chosen ? "▶ " : ""}
                      {a[2]}
                    </td>
                    <td>{pct(n.s[i * NUM_CLASSES + deal.cls] / 1000, 0)}</td>
                    <td>{bb(n.e[i * NUM_CLASSES + deal.cls] / 100)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <button className="primary" onClick={next}>
              다음 문제 →
            </button>
          </div>
        )}
        <div className="card">
          <h3>이번 세션</h3>
          <div className="tiles">
            <div className="tile">
              <div className="v">{history.length}</div>
              <div className="k">문제</div>
            </div>
            <div className="tile">
              <div className="v">{history.length ? pct(correct / history.length, 0) : "-"}</div>
              <div className="k">정확도</div>
            </div>
            <div className="tile">
              <div className="v">{history.length ? bb(avgLoss) : "-"}</div>
              <div className="k">평균 EV 손실 (bb)</div>
            </div>
          </div>
          <div className="muted small" style={{ marginTop: 8 }}>
            채점: GTO 빈도 30% 이상 또는 EV 손실 0.05bb 이하 = 정확, 0.3bb 이하 = 부정확, 그 이상 = 블런더. 상황은 실제 게임에서 나오는 빈도대로, 핸드는 그 자리 레인지에서 뽑습니다.
          </div>
        </div>
      </div>
    </div>
  );
}
