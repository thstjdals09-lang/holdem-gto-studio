// 4. 여러 핸드의 오류 유형 집계. 정확히 분석한 핸드와 미지원 핸드를 따로 센다. 모델이 다른 EV 는 더하지 않는다.
import { aggregate } from "../review-report";
import { STATUS_KO, type HandReport } from "../types";
import { fmt } from "./common";

export function SummaryView({ reports, total, onOpen }: { reports: HandReport[]; total: number; onOpen: (handId: string) => void }) {
  const a = aggregate(reports);
  return (
    <div className="stack">
      <h2>여러 핸드 집계</h2>
      <p className="small muted">분석한 핸드 {a.hands}개 / 목록 {total}개. 분석하지 않은 핸드는 세지 않습니다. 각 칸의 기준은 DATA-CONTRACT.md 에 있습니다.</p>
      <dl className="kv">
        <div><dt>모든 판단이 '분석됨'</dt><dd>{a.handsAnalyzed}</dd></div>
        <div><dt>근사 포함</dt><dd>{a.handsApproximate}</dd></div>
        <div><dt>미지원 판단 포함</dt><dd>{a.handsUnsupported}</dd></div>
        <div><dt>잘못된 입력</dt><dd>{a.handsInvalid}</dd></div>
        <div><dt>내 판단 없음</dt><dd>{a.handsNoDecision}</dd></div>
        <div><dt>판단 수</dt><dd>{a.decisions}</dd></div>
      </dl>
      <div className="row">
        {Object.entries(a.byStatus).map(([k, v]) => (
          <span key={k} className={`badge b-${k}`}>{STATUS_KO[k as keyof typeof STATUS_KO]} {v}</span>
        ))}
      </div>
      <div className="table-wrap">
        <table>
          <thead><tr><th>유형</th><th className="num">판단</th><th className="num">핸드</th></tr></thead>
          <tbody>
            {a.categories.map((c) => (
              <tr key={c.key} className={c.decisions || c.hands ? "" : "dim"}><td>{c.label}</td><td className="num">{c.decisions}</td><td className="num">{c.hands}</td></tr>
            ))}
          </tbody>
        </table>
      </div>
      <h3>검증 가능한 EV 차이 (오차 기준을 넘는 것만)</h3>
      {a.evLosses.length === 0 ? (
        <p className="small muted">없음</p>
      ) : (
        <div className="table-wrap">
          <table>
            <thead><tr><th>핸드</th><th>스트리트</th><th className="num">차이</th><th className="num">BB 환산</th><th>모델</th><th>설명</th></tr></thead>
            <tbody>
              {a.evLosses.map((x, i) => (
                <tr key={i}>
                  <td><button className="ghost mono" onClick={() => onOpen(x.handId)}>{x.handId}</button></td>
                  <td>{x.street} #{x.decisionIndex + 1}</td>
                  <td className="num">{fmt(x.evLoss)} {x.unit}</td>
                  <td className="num">{x.evLossBb === null ? "BB 크기 모름" : fmt(x.evLossBb)}</td>
                  <td>{x.model}</td>
                  <td className="small">{x.text}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="small muted">모델(자료 추상 게임 / 닫힌 올인 칩 EV)과 범위 출처가 다른 값은 합계를 내지 않습니다. 사용자 가정 범위로 계산한 차이는 가정이 바뀌면 달라집니다.</p>
    </div>
  );
}
