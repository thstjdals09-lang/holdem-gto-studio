// 5. 데이터·모델·검증 상태. 자료 해시는 이 브라우저에서 직접 다시 계산해 출처 목록과 비교할 수 있다.
import { useState } from "react";
import { sha256Hex } from "../hand-history";
import provenance from "../provenance.json";
import { REVIEW_VERSION } from "../types";
import { fmt } from "./common";

type Files = Record<string, { sha256: string; bytes: number; formatId: string; name: string; players: number; stackBb: number; anteBb: number; iterations: number; exploitabilityBb: number; generatedAt: string; nodes: number; lastCommit: string }>;

export function StatusView({ libBase }: { libBase: string }) {
  const files = provenance.files as Files;
  const [check, setCheck] = useState<Record<string, string>>({});
  const verify = async () => {
    for (const f of Object.keys(files)) {
      setCheck((c) => ({ ...c, [f]: "확인 중" }));
      try {
        const r = await fetch(`${libBase}${f}`);
        if (!r.ok) throw new Error(String(r.status));
        const h = await sha256Hex(await r.text());
        setCheck((c) => ({ ...c, [f]: h === files[f].sha256 ? "일치" : `다름 (${h.slice(0, 12)}…)` }));
      } catch (e) {
        setCheck((c) => ({ ...c, [f]: `읽기 실패: ${(e as Error).message}` }));
      }
    }
  };
  return (
    <div className="stack">
      <h2>데이터·모델·검증 상태</h2>
      <dl className="kv">
        <div><dt>복기 도구 버전</dt><dd>{REVIEW_VERSION}</dd></div>
        <div><dt>기준 저장소 커밋</dt><dd className="mono">{provenance.baseCommit.slice(0, 12)}</dd></div>
        <div><dt>자료 수</dt><dd>{Object.keys(files).length}</dd></div>
      </dl>
      <p className="small">저장소: <span className="mono">{provenance.repository}</span> · 생성기: {provenance.generator}</p>
      <p className="small">라이선스: {provenance.license}</p>
      <div className="row">
        <button onClick={() => void verify()}>이 브라우저에서 자료 해시 다시 계산</button>
      </div>
      <div className="table-wrap">
        <table>
          <thead><tr><th>파일</th><th>조건</th><th className="num">반복</th><th className="num">익스플로잇(BB)</th><th>생성</th><th>SHA-256</th><th>확인</th></tr></thead>
          <tbody>
            {Object.entries(files).map(([f, m]) => (
              <tr key={f}>
                <td className="mono">{f}</td>
                <td>{m.players}명 · 앤티 뒤 {m.stackBb}BB · 앤티 {m.anteBb}</td>
                <td className="num">{m.iterations}</td>
                <td className="num">{m.exploitabilityBb.toExponential(2)}</td>
                <td className="small">{m.generatedAt.slice(0, 10)} · {m.lastCommit.slice(0, 7)}</td>
                <td className="mono">{m.sha256.slice(0, 16)}…</td>
                <td>{check[f] ?? "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <h3>모델별 지원 범위</h3>
      <div className="table-wrap">
        <table>
          <thead><tr><th>분석</th><th>쓰는 조건</th><th>상태 표시</th><th>한계</th></tr></thead>
          <tbody>
            <tr><td>프리플랍 자료 조회</td><td>8명 개인 앤티 0.125BB(6·10·15·25·40·60BB) 또는 6명 캐시 100BB, SB 0.5·BB 1, 전원 같은 스택, 베팅 경로가 트리와 정확히 같음</td><td>분석됨</td><td>제한 추상 게임(정해진 크기·3명 상한), 포스트플랍은 승률×실현 근사, 칩 EV</td></tr>
            <tr><td>닫힌 올인 콜</td><td>콜하면 더 베팅이 없음 + 상대마다 범위 출처(자료 경로 또는 사용자 가정)</td><td>근사</td><td>범위가 정확해야 결론이 맞음. 프리플랍·다인은 표본(표준오차 표시)</td></tr>
            <tr><td>ICM 시나리오</td><td>닫힌 올인 + 지급 구조 + 테이블 밖 전체 스택</td><td>(판단과 별도)</td><td>Malmuth-Harville, 균형 전략 해 아님</td></tr>
            <tr><td>그 밖의 포스트플랍 결정</td><td>—</td><td>미지원</td><td>이 도구는 포스트플랍 전략을 풀지 않습니다 (MODEL-LIMITATIONS.md)</td></tr>
          </tbody>
        </table>
      </div>
      <p className="small muted">테스트 명령과 결과는 TEST-RESULTS.md, 자료 해석(빈도·EV 스케일, 금액 의미)은 DATA-CONTRACT.md 에 있습니다. 자료 {fmt(Object.values(files).reduce((a, m) => a + m.bytes, 0) / 1048576, 1)}MB 는 필요할 때만 한 개씩 읽습니다.</p>
    </div>
  );
}
