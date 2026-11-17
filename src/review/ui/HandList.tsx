// 1. 핸드 목록과 가져오기 (핸드 JSON / 루루 판단 기록 / 예제)
import { useState } from "react";
import { EXAMPLES, LULU_SAMPLE_TEXT } from "../examples";
import { importLuluLog, MAX_IMPORT_BYTES, parseHandsJson, validateHand } from "../hand-history";
import type { HandRecord, HandReport, Issue } from "../types";
import { Cards, StatusBadge, download } from "./common";

const SOURCE_KO: Record<HandRecord["source"]["kind"], string> = { manual: "직접 입력", json: "JSON", "lulu-decision-log": "루루 기록", example: "예제" };

export function handStatus(r: HandReport | undefined) {
  if (!r) return null;
  const st = r.decisions.map((d) => d.status);
  if (r.issues.some((i) => i.severity === "error") || st.includes("invalid")) return "invalid" as const;
  if (!st.length) return null;
  if (st.every((s) => s === "analyzed")) return "analyzed" as const;
  if (st.every((s) => s === "analyzed" || s === "approximate")) return "approximate" as const;
  return "unsupported" as const;
}

export function HandList(props: {
  hands: HandRecord[];
  reports: Record<string, HandReport>;
  selected: string | null;
  stale: Set<string>;
  onSelect: (id: string) => void;
  onAdd: (hands: HandRecord[]) => void;
  onNew: () => void;
}) {
  return (
    <ul className="list" aria-label="핸드 목록">
      {props.hands.map((h) => {
        const r = props.reports[h.id];
        const st = handStatus(r);
        return (
          <li key={h.id}>
            <button aria-current={props.selected === h.id} onClick={() => props.onSelect(h.id)}>
              <span className="row" style={{ justifyContent: "space-between" }}>
                <strong className="mono" style={{ fontSize: 13 }}>{h.id}</strong>
                {st ? <StatusBadge s={st} /> : <span className="badge b-plain">분석 전</span>}
              </span>
              <span className="row small muted">
                <Cards cards={h.hero.cards} slots={2} />
                <span>
                  {h.seats.length}명 · {SOURCE_KO[h.source.kind]} · {h.complete ? "완료" : "미완료"}
                  {props.stale.has(h.id) ? " · 입력이 바뀜" : ""}
                </span>
              </span>
            </button>
          </li>
        );
      })}
      {!props.hands.length && <li className="muted small">아직 핸드가 없습니다. 오른쪽에서 가져오거나 새로 입력하세요.</li>}
    </ul>
  );
}

export function ImportPanel(props: { hands: HandRecord[]; reports: Record<string, HandReport>; onAdd: (hands: HandRecord[]) => void; onNew: () => void; onDeleteAll: () => void }) {
  const [text, setText] = useState("");
  const [mode, setMode] = useState<"hand" | "lulu">("hand");
  const [msg, setMsg] = useState<{ ok: string; issues: string[] } | null>(null);
  const run = (t: string, m: "hand" | "lulu") => {
    if (m === "lulu") {
      const r = importLuluLog(t);
      props.onAdd(r.hands);
      setMsg({ ok: `루루 판단 기록: 판단 ${r.events}개 → 핸드 ${r.hands.length}개를 읽기 전용으로 가져왔습니다. 블라인드·앤티·초기 스택은 비어 있어 '편집'에서 보완해야 재생됩니다.`, issues: r.issues.map((i) => i.message) });
      return;
    }
    const r = parseHandsJson(t);
    props.onAdd(r.hands);
    setMsg({ ok: `핸드 ${r.hands.length}개를 가져왔습니다.`, issues: r.issues.map((i: Issue & { item: number }) => `#${i.item + 1}: ${i.message}`) });
  };
  const onFile = async (f: File | undefined) => {
    if (!f) return;
    if (f.size > MAX_IMPORT_BYTES) return setMsg({ ok: "", issues: ["5MB 보다 큰 파일은 받지 않습니다"] });
    run(await f.text(), mode);
  };
  return (
    <div className="stack">
      <h2>가져오기</h2>
      <div className="row">
        <button className="primary" onClick={props.onNew}>새 핸드 직접 입력</button>
        <label className="field">
          형식
          <select value={mode} onChange={(e) => setMode(e.target.value as "hand" | "lulu")}>
            <option value="hand">핸드 JSON (DATA-CONTRACT.md)</option>
            <option value="lulu">루루 판단 기록 JSON (읽기 전용)</option>
          </select>
        </label>
        <label className="field">
          파일
          <input type="file" accept=".json,application/json" onChange={(e) => void onFile(e.target.files?.[0])} />
        </label>
      </div>
      <textarea aria-label="JSON 붙여넣기" placeholder={mode === "hand" ? '{"schema":"holdem-review-hand/1", ...} 또는 [핸드, 핸드]' : '{"schema":1,"events":[...]} (판단 기록 저장 파일)'} value={text} onChange={(e) => setText(e.target.value)} />
      <div className="row">
        <button onClick={() => run(text, mode)} disabled={!text.trim()}>붙여넣은 내용 가져오기</button>
        <button
          onClick={() => {
            const hands = EXAMPLES.map((e) => validateHand(e.data).hand).filter((h): h is HandRecord => !!h);
            props.onAdd(hands);
            setMsg({ ok: `예제 ${hands.length}개를 가져왔습니다 (사용자 사례 1~3 포함).`, issues: [] });
          }}
        >
          예제 불러오기
        </button>
        <button onClick={() => run(LULU_SAMPLE_TEXT, "lulu")}>루루 기록 샘플(합성)</button>
      </div>
      {msg && (
        <div className={`note ${msg.issues.length ? "warn" : "ok"}`} role="status">
          {msg.ok}
          {msg.issues.length > 0 && (
            <ul>
              {msg.issues.slice(0, 12).map((t, i) => (
                <li key={i}>{t}</li>
              ))}
              {msg.issues.length > 12 && <li>… 외 {msg.issues.length - 12}개</li>}
            </ul>
          )}
        </div>
      )}
      <h3>내보내기</h3>
      <div className="row">
        <button onClick={() => download("holdem-review-hands.json", { hands: props.hands })} disabled={!props.hands.length}>모든 핸드 JSON</button>
        <button onClick={() => download("holdem-review-reports.json", { reports: Object.values(props.reports) })} disabled={!Object.keys(props.reports).length}>모든 분석 보고서 JSON</button>
        <button className="danger" onClick={() => confirm("이 브라우저에 저장된 핸드와 보고서를 모두 지울까요?") && props.onDeleteAll()} disabled={!props.hands.length}>모두 지우기</button>
      </div>
      <p className="small muted">핸드와 보고서는 이 브라우저(localStorage)에만 저장됩니다. 외부로 보내지 않습니다. 루루 판단 기록은 공식 핸드 기록이 아니며, 기록에서 확인되지 않은 값은 채우지 않습니다.</p>
    </div>
  );
}
