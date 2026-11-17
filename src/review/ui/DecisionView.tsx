// 3. 선택한 의사결정 시점의 분석. 실행 지시가 아니라 끝난 판의 복기 결과만 보여 준다.
import { useEffect, useState } from "react";
import { CATEGORY_KO, STREET_KO, type DecisionAnalysis, type HandReport, type RangeTrace } from "../types";
import { Cards, Notes, StatusBadge, fmt, pct } from "./common";

const VERDICT_KIND: Record<DecisionAnalysis["verdict"]["kind"], string> = { best: "ok", mixed: "ok", "within-noise": "info", "ev-loss": "bad", unknown: "warn" };

function RangeBox({ r }: { r: RangeTrace }) {
  return (
    <div className="panel stack" style={{ padding: 10 }}>
      <div className="row" style={{ justifyContent: "space-between" }}>
        <strong>{r.position}({r.seat}) 범위</strong>
        <span className={`badge ${r.source === "library" ? "b-analyzed" : r.source === "user" ? "b-approximate" : "b-unsupported"}`}>{r.source === "library" ? "자료 경로 조건화" : r.source === "user" ? "사용자 가정" : "출처 없음"}</span>
      </div>
      <div className="small muted">{r.sourceDetail}</div>
      {r.steps.length > 0 && (
        <div className="small">
          조건화: {r.steps.map((s, i) => <span key={i}>{i ? " → " : ""}{s.label} ({fmt(s.massBefore, 1)} → {fmt(s.massAfter, 1)} 콤보)</span>)}
        </div>
      )}
      {r.source !== "none" && (
        <div className="small">
          블로커({r.blockedCards.join(" ")}) 뺀 뒤 {fmt(r.combos, 1)} 콤보 · 상위: {r.top.slice(0, 10).map((t) => `${t.hand} ${fmt(t.weight, 1)}`).join(", ")}
        </div>
      )}
      {r.notes.map((n, i) => <div key={i} className="small muted">{n}</div>)}
    </div>
  );
}

function Decision({ d, report }: { d: DecisionAnalysis; report: HandReport }) {
  const bb = report.bigBlind;
  const toBb = (x: number | null) => (x !== null && bb && report.unit !== "bb" ? ` (${fmt(x / bb)}BB)` : "");
  const evIsChips = d.method === "allin-closed";
  return (
    <div className="stack">
      <div className="row" style={{ justifyContent: "space-between" }}>
        <h2>
          {STREET_KO[d.street]} · {d.position}({d.seat}) · 액션 #{d.decisionIndex + 1}
        </h2>
        <StatusBadge s={d.status} />
      </div>
      <div className="row">
        <div><div className="small muted">그때 내 카드</div><Cards cards={d.heroCards} slots={2} /></div>
        <div><div className="small muted">그때 공개 보드</div>{d.board.length ? <Cards cards={d.board} /> : <span className="small muted">없음 (프리플랍)</span>}</div>
        <div className="grow"><div className="small muted">실제 선택</div><strong>{d.actual ? d.actual.label : "기록 없음 (기록이 이 판단에서 끝남)"}</strong></div>
      </div>
      <dl className="kv">
        <div><dt>팟</dt><dd>{fmt(d.metrics.pot)}{toBb(d.metrics.pot)}</dd></div>
        <div><dt>추가 콜</dt><dd>{fmt(d.metrics.toCall)}{toBb(d.metrics.toCall)}</dd></div>
        <div><dt>팟 오즈(필요 승률)</dt><dd>{pct(d.metrics.potOdds)}</dd></div>
        <div><dt>유효 스택</dt><dd>{fmt(d.metrics.effStack)}{toBb(d.metrics.effStack)}</dd></div>
        {d.metrics.spr !== null && <div><dt>SPR</dt><dd>{fmt(d.metrics.spr)}</dd></div>}
        {d.legal?.minTo !== null && d.legal?.minTo !== undefined && <div><dt>최소 목표액</dt><dd>{fmt(d.legal.minTo)}</dd></div>}
      </dl>
      {d.legal?.raiseBlockedBy && <div className="small muted">레이즈 불가: {d.legal.raiseBlockedBy}</div>}
      <div className="table-wrap">
        <table>
          <thead><tr><th>자리</th><th className="num">남은 스택</th><th className="num">이번 스트리트</th><th className="num">누적</th><th>상태</th></tr></thead>
          <tbody>
            {d.state.seats.map((s) => (
              <tr key={s.seat} className={s.folded ? "dim" : s.seat === d.seat ? "actual" : ""}>
                <td>{s.position}({s.seat}){s.seat === d.seat ? " 나" : ""}</td>
                <td className="num">{fmt(s.stack)}</td><td className="num">{fmt(s.streetIn)}</td><td className="num">{fmt(s.totalIn)}</td>
                <td>{s.folded ? "폴드" : s.allIn ? "올인" : ""}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="small">
        현재 팟 층:{" "}
        {d.pots.map((l, i) => (
          <span key={i} className="badge b-plain" style={{ marginRight: 4 }}>{i === 0 ? "메인" : `사이드 ${i}`} {fmt(l.amount)} · {l.eligible.length}명</span>
        ))}
      </div>

      <div className={`note ${VERDICT_KIND[d.verdict.kind]}`}>
        <strong>판정</strong>: {d.verdict.text || (d.status === "unsupported" ? "이 판단은 계산하지 않았습니다 (아래 이유)" : "—")}
        {d.categories.length > 0 && <div className="small">분류: {d.categories.map((c) => CATEGORY_KO[c]).join(" · ")}</div>}
      </div>

      {d.options.length > 0 && (
        <div className="panel stack">
          <h3 style={{ margin: 0 }}>행동별 빈도·EV</h3>
          <div className="small muted">EV 단위: {d.evUnit}</div>
          <div className="table-wrap">
            <table>
              <thead><tr><th>행동</th><th className="num">목표액</th><th className="num">빈도</th><th className="num">EV</th>{evIsChips && bb && report.unit !== "bb" ? <th className="num">EV(BB)</th> : null}<th className="num">표준오차</th></tr></thead>
              <tbody>
                {d.options.map((o, i) => (
                  <tr key={i} className={o.isActual ? "actual" : ""}>
                    <td>{o.label}{o.isActual ? " ← 실제" : ""}</td>
                    <td className="num">{o.to !== undefined ? fmt(o.to) : o.add !== undefined ? `+${fmt(o.add)}` : "—"}</td>
                    <td className="num">{o.freq === null ? "계산 안 함" : pct(o.freq)}</td>
                    <td className="num">{o.ev === null ? "—" : fmt(o.ev, 3)}</td>
                    {evIsChips && bb && report.unit !== "bb" ? <td className="num">{o.ev === null ? "—" : fmt(o.ev / bb, 3)}</td> : null}
                    <td className="num">{o.evSe === undefined || o.evSe === null ? "—" : fmt(o.evSe, 3)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {!d.options.some((o) => o.isActual) && d.actual && <div className="small muted">실제 선택은 이 표의 행동과 정확히 같지 않아 EV 를 계산하지 않았습니다 (가까운 행동의 EV 를 가져오지 않음).</div>}
        </div>
      )}

      {d.icm && (
        <div className="panel stack">
          <h3 style={{ margin: 0 }}>대회 ICM 시나리오 (칩 EV 와 별개)</h3>
          <dl className="kv">
            <div><dt>폴드 지분</dt><dd>{fmt(d.icm.foldEquity, 3)}</dd></div>
            <div><dt>콜 지분</dt><dd>{fmt(d.icm.callEquity, 3)} ± {fmt(d.icm.callEquitySe, 3)}</dd></div>
            <div><dt>차이 (콜 − 폴드)</dt><dd>{fmt(d.icm.diff, 3)} {d.icm.payoutUnit}</dd></div>
            <div><dt>칩 EV</dt><dd>{d.icm.chipEvBb === null ? "—" : `${fmt(d.icm.chipEvBb)}BB`}</dd></div>
            <div><dt>남은 인원 · 상금 합</dt><dd>{d.icm.fieldSize}명 · {fmt(d.icm.prizePool)}</dd></div>
            <div><dt>계산</dt><dd>{d.icm.method === "exact" ? "정확" : `표본 ${d.icm.samples}`}</dd></div>
          </dl>
          <div className="note info">{d.icm.verdict}</div>
          <div className="table-wrap">
            <table>
              <thead><tr><th>시나리오</th><th className="num">확률</th><th className="num">내 스택</th><th className="num">내 지분</th></tr></thead>
              <tbody>
                {d.icm.scenarios.map((s, i) => (
                  <tr key={i}><td>{s.label}</td><td className="num">{pct(s.prob)}</td><td className="num">{fmt(s.heroStack)}</td><td className="num">{fmt(s.heroEquity, 3)}</td></tr>
                ))}
              </tbody>
            </table>
          </div>
          <Notes kind="info" title="ICM 가정" items={d.icm.assumptions} />
        </div>
      )}
      {d.icmUnavailable && <div className="small muted">ICM: {d.icmUnavailable}</div>}

      {d.ranges.length > 0 && (
        <div className="stack">
          <h3 style={{ margin: 0 }}>사용한 상대 범위와 출처</h3>
          {d.ranges.map((r) => <RangeBox key={r.seat} r={r} />)}
        </div>
      )}
      {d.data && (
        <Notes kind="info" title={`적용한 자료 ${d.data.formatId}.json · SHA-256 ${d.data.sha256.slice(0, 16)}… ${d.data.manifestMatch ? "(출처 목록과 일치)" : d.data.manifestMatch === false ? "(출처 목록과 다름!)" : ""}`} items={[...d.data.conditions, `반복 ${d.data.iterations}회 · 익스플로잇 ${d.data.exploitabilityBb.toExponential(2)}BB · 생성 ${d.data.generatedAt}`]} />
      )}
      <Notes kind="warn" title="미지원 사유와 필요한 조건" items={d.unsupportedReasons} />
      <Notes kind="info" title="가정" items={d.assumptions} />
      <Notes kind="warn" title="근사·한계" items={d.limitations} />
      <div className="small muted">
        계산: {d.quality.method} · {d.quality.ms}ms{d.quality.samples ? ` · 표본 ${d.quality.samples.toLocaleString()}` : ""}
        {d.quality.seed !== undefined ? ` · 시드 ${d.quality.seed}` : ""}
        {d.quality.notes.map((n, i) => <div key={i}>{n}</div>)}
        <div className="mono">판단 입력 해시 {d.viewHash.slice(0, 24)}…</div>
      </div>
    </div>
  );
}

export function AnalysisView(props: { report: HandReport | null; stale: boolean; running: { done: number; total: number } | null; onRun: () => void; onCancel: () => void; onDownload: () => void }) {
  const { report } = props;
  const [i, setI] = useState(0);
  useEffect(() => setI(0), [report?.handId, report?.inputHash]);
  const d = report?.decisions[Math.min(i, (report?.decisions.length ?? 1) - 1)];
  return (
    <div className="stack">
      <div className="row">
        <button className="primary" onClick={props.onRun} disabled={!!props.running}>{report ? "다시 분석" : "분석"}</button>
        {props.running && <button onClick={props.onCancel}>계산 취소</button>}
        {report && <button onClick={props.onDownload}>이 핸드 보고서 저장(JSON)</button>}
        {props.running && <span className="small muted" role="status">계산 중… {props.running.done}/{props.running.total}</span>}
      </div>
      {props.stale && <div className="note warn">핸드 입력이 분석 뒤에 바뀌었습니다. 아래 결과는 이전 입력 기준입니다 — 다시 분석하세요.</div>}
      {!report && !props.running && <p className="muted">아직 분석하지 않았습니다.</p>}
      {report && (
        <>
          <div className="small muted">
            입력 해시 <span className="mono">{report.inputHash.slice(0, 16)}…</span> · 모델 {report.modelVersion} · 시드 {report.options.seed} · 표본 {report.options.samples.toLocaleString()} · {report.ms}ms · {new Date(report.createdAt).toLocaleString("ko-KR")}
          </div>
          <Notes kind="bad" title="기록 오류" items={report.issues.filter((x) => x.severity === "error").map((x) => x.message)} />
          {report.decisions.length === 0 ? (
            <p className="muted">분석할 내 판단이 없습니다 (재구성 실패 또는 내 차례 없음).</p>
          ) : (
            <div className="steps" role="tablist" aria-label="내 판단 시점">
              {report.decisions.map((x, k) => (
                <button key={k} role="tab" aria-selected={k === i} aria-current={k === i} onClick={() => setI(k)}>
                  {STREET_KO[x.street]} #{x.decisionIndex + 1} {x.actual ? x.actual.type : "—"} · <StatusBadge s={x.status} />
                </button>
              ))}
            </div>
          )}
          {d && <Decision d={d} report={report} />}
        </>
      )}
    </div>
  );
}
