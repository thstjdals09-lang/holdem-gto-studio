// 복기 앱 화면 틀: 목록·재생·분석·집계·상태. 계산은 워커에서 하고, 다른 핸드를 고르면 이전 결과를 보여 주지 않는다.
import { useEffect, useMemo, useRef, useState } from "react";
import { ReviewClient } from "../client";
import { canonicalJson, sha256Hex } from "../hand-history";
import { DEFAULT_OPTIONS, type AnalyzeOptions, type HandRecord, type HandReport } from "../types";
import { download } from "./common";
import { AnalysisView } from "./DecisionView";
import { Editor } from "./Editor";
import { HandList, ImportPanel } from "./HandList";
import { ReplayView } from "./Replay";
import { StatusView } from "./Status";
import { loadHands, loadReports, saveHands, saveReports } from "./store";
import { SummaryView } from "./Summary";

type Tab = "list" | "replay" | "analysis" | "summary" | "status" | "edit";
const TABS: Array<[Tab, string]> = [
  ["list", "핸드 목록·가져오기"],
  ["replay", "재생"],
  ["analysis", "판단 분석"],
  ["summary", "집계"],
  ["status", "데이터·모델 상태"]
];
const LIB_BASE = new URL("lib/preflop/", document.baseURI).href;

export function App() {
  const [hands, setHands] = useState<HandRecord[]>(loadHands);
  const [reports, setReports] = useState<Record<string, HandReport>>(loadReports);
  const [sel, setSel] = useState<string | null>(() => loadHands()[0]?.id ?? null);
  const [tab, setTab] = useState<Tab>("list");
  const [editing, setEditing] = useState<HandRecord | null>(null);
  const [options, setOptions] = useState<AnalyzeOptions>(DEFAULT_OPTIONS);
  const [running, setRunning] = useState<{ handId: string; done: number; total: number } | null>(null);
  const [hashes, setHashes] = useState<Record<string, string>>({});
  const [saveWarn, setSaveWarn] = useState("");
  const client = useRef<ReviewClient | null>(null);
  if (!client.current) client.current = new ReviewClient(() => new Worker(new URL("../worker.ts", import.meta.url), { type: "module" }) as never, LIB_BASE);
  useEffect(() => () => client.current?.dispose(), []);

  const hand = hands.find((h) => h.id === sel) ?? null;
  useEffect(() => setSaveWarn(saveHands(hands) ? "" : "이 브라우저에 저장하지 못했습니다(용량·차단). 내보내기로 보관하세요."), [hands]);
  useEffect(() => {
    if (!saveReports(reports)) setSaveWarn("분석 보고서를 이 브라우저에 저장하지 못했습니다. 보고서 JSON 으로 보관하세요.");
  }, [reports]);
  // 핸드 입력 해시: 보고서가 지금 입력으로 만든 것인지 확인한다
  useEffect(() => {
    let live = true;
    void Promise.all(hands.map(async (h) => [h.id, await sha256Hex(canonicalJson(h))] as const)).then((xs) => live && setHashes(Object.fromEntries(xs)));
    return () => {
      live = false;
    };
  }, [hands]);
  const stale = useMemo(() => new Set(Object.entries(reports).filter(([id, r]) => hashes[id] && r.inputHash !== hashes[id]).map(([id]) => id)), [reports, hashes]);

  const select = (id: string) => {
    if (running && running.handId !== id) {
      client.current!.cancel(); // 다른 핸드를 고르면 이전 계산을 버린다
      setRunning(null);
    }
    setSel(id);
    if (tab === "list" || tab === "edit") setTab("replay");
  };
  const addHands = (list: HandRecord[]) => {
    if (!list.length) return;
    setHands((prev) => {
      const ids = new Set(prev.map((h) => h.id));
      const added = list.map((h) => {
        let id = h.id;
        for (let k = 2; ids.has(id); k++) id = `${h.id}-${k}`; // 같은 id 는 덮어쓰지 않는다
        ids.add(id);
        return { ...h, id };
      });
      if (!sel) setSel(added[0].id);
      return [...prev, ...added];
    });
  };
  const analyze = (h: HandRecord) => {
    const { result } = client.current!.analyze(h, options, (done, total) => setRunning({ handId: h.id, done, total }));
    setRunning({ handId: h.id, done: 0, total: 0 });
    void result.then((o) => {
      if (o.status === "stale") return;
      setRunning((r) => (r?.handId === h.id ? null : r));
      if (o.status === "done") setReports((prev) => ({ ...prev, [h.id]: o.report }));
      else if (o.status === "error") setSaveWarn(`분석 실패: ${o.message}`);
    });
  };
  const report = hand ? reports[hand.id] ?? null : null;

  return (
    <div className="app">
      <header className="top">
        <h1>핸드 복기</h1>
        <span className="sub">끝난 핸드를 그 시점 정보로만 다시 봅니다 · 로컬 전용 · 실시간 게임과 연결하지 않음</span>
      </header>
      <nav className="tabs" role="tablist" aria-label="화면">
        {TABS.map(([k, label]) => (
          <button key={k} role="tab" aria-selected={tab === k} onClick={() => setTab(k)} disabled={(k === "replay" || k === "analysis") && !hand}>
            {label}
          </button>
        ))}
      </nav>
      {saveWarn && <div className="note warn" role="alert" style={{ marginBottom: 8 }}>{saveWarn}</div>}
      <div className="layout">
        <aside className="side panel stack">
          <div className="row" style={{ justifyContent: "space-between" }}>
            <strong>핸드 {hands.length}개</strong>
            {hand && (
              <span className="row">
                <button onClick={() => { setEditing(hand); setTab("edit"); }}>편집</button>
                <button className="danger" onClick={() => { if (!confirm(`${hand.id} 를 지울까요?`)) return; client.current!.cancel(); setRunning(null); setHands((p) => p.filter((x) => x.id !== hand.id)); setReports((p) => { const n = { ...p }; delete n[hand.id]; return n; }); setSel(null); }}>삭제</button>
              </span>
            )}
          </div>
          <HandList hands={hands} reports={reports} selected={sel} stale={stale} onSelect={select} onAdd={addHands} onNew={() => { setEditing(null); setTab("edit"); }} />
          <details>
            <summary>계산 설정</summary>
            <div className="fields" style={{ marginTop: 6 }}>
              <label className="field">시드<input inputMode="numeric" value={options.seed} onChange={(e) => setOptions({ ...options, seed: Math.max(0, Math.floor(Number(e.target.value) || 0)) })} /></label>
              <label className="field">표본 수<select value={options.samples} onChange={(e) => setOptions({ ...options, samples: Number(e.target.value), icmSamples: Number(e.target.value) })}>{[5000, 20000, 50000, 100000].map((x) => <option key={x} value={x}>{x.toLocaleString()}</option>)}</select></label>
            </div>
            <p className="small muted">같은 시드·표본이면 같은 결과가 나옵니다. 결과는 입력·설정·자료 해시로 캐시됩니다.</p>
          </details>
        </aside>
        <main className="panel">
          {tab === "list" && <ImportPanel hands={hands} reports={reports} onAdd={addHands} onNew={() => { setEditing(null); setTab("edit"); }} onDeleteAll={() => { client.current!.cancel(); setRunning(null); setHands([]); setReports({}); setSel(null); }} />}
          {tab === "edit" && (
            <Editor
              key={editing?.id ?? "new"}
              initial={editing}
              onCancel={() => setTab(hand ? "replay" : "list")}
              onSave={(h, replaceId) => {
                if (replaceId) {
                  setHands((p) => p.map((x) => (x.id === replaceId ? h : x)));
                  if (replaceId !== h.id) setReports((p) => { const n = { ...p }; delete n[replaceId]; return n; });
                } else addHands([h]);
                setSel(h.id);
                setEditing(null);
                setTab("replay");
              }}
            />
          )}
          {tab === "replay" && hand && <ReplayView hand={hand} />}
          {tab === "analysis" && hand && (
            <AnalysisView
              report={report}
              stale={stale.has(hand.id)}
              running={running?.handId === hand.id ? running : null}
              onRun={() => analyze(hand)}
              onCancel={() => { client.current!.cancel(); setRunning(null); }}
              onDownload={() => report && download(`review-${hand.id}.json`, report)}
            />
          )}
          {tab === "summary" && <SummaryView reports={hands.map((h) => reports[h.id]).filter((r): r is HandReport => !!r && !stale.has(r.handId))} total={hands.length} onOpen={(id) => { setSel(id); setTab("analysis"); }} />}
          {tab === "status" && <StatusView libBase={LIB_BASE} />}
        </main>
      </div>
    </div>
  );
}
