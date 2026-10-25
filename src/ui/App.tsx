import { useEffect, useState } from "react";
import { useHashRoute } from "./common";
import { MATCHUPS, type MatchupIndex } from "../lib/postflopLib";
import { loadMatchupIndex } from "./lib";
import { SolvePage } from "./SolvePage";
import { StudyPage } from "./StudyPage";
import { MySolvesPage } from "./MySolvesPage";
import { TrainerPage } from "./TrainerPage";
import { CalcPage } from "./CalcPage";
import { RushPage } from "./RushPage";
import { ReportsPage } from "./ReportsPage";
import { AnalyzePage } from "./AnalyzePage";
import { PreflopPage } from "./PreflopPage";

const NAV: Array<[string, string]> = [
  ["/study", "스터디"],
  ["/trainer", "연습"],
  ["/analyze", "분석"],
  ["/reports", "리포트"],
  ["/solve", "솔버"],
  ["/mysolves", "내 솔브"],
  ["/calc", "도구"]
];

export function App() {
  const { path } = useHashRoute();
  return (
    <div className="app">
      <nav className="topnav">
        <a href="#/" className="brand">
          ♠ 홀덤 GTO 스튜디오
        </a>
        {NAV.map(([p, label]) => (
          <a key={p} href={"#" + p} className={path === p || (p === "/calc" && (path === "/rush" || path === "/hu-preflop")) ? "active" : ""}>
            {label}
          </a>
        ))}
      </nav>
      {path === "/" && <HomePage />}
      {path === "/study" && <StudyPage />}
      {path === "/mysolves" && <MySolvesPage />}
      {path === "/solve" && <SolvePage />}
      {path === "/trainer" && <TrainerPage />}
      {path === "/analyze" && <AnalyzePage />}
      {path === "/reports" && <ReportsPage />}
      {path === "/calc" && <ToolsPage />}
      {path === "/rush" && <RushPage />}
      {path === "/hu-preflop" && <PreflopPage />}
      <footer className="foot muted small">브라우저 안에서 모든 계산이 이뤄집니다 · 근사 솔루션 포함 · 학습용</footer>
    </div>
  );
}

function ToolsPage() {
  return (
    <>
      <div className="page" style={{ paddingBottom: 0 }}>
        <div className="row">
          <a href="#/calc" className="badge ok">
            에퀴티 · ICM 계산기
          </a>
          <a href="#/rush" className="badge">
            에퀴티 러시 (게임)
          </a>
          <a href="#/hu-preflop" className="badge">
            HU 프리플랍 랩
          </a>
        </div>
      </div>
      <CalcPage />
    </>
  );
}

function HomePage() {
  const go = (p: string) => (window.location.hash = p);
  const cards: Array<[string, string, string]> = [
    ["/study", "스터디", "미리 풀어둔 토너먼트 솔루션을 바로 탐색합니다. 8맥스 앤티 15·25·40·60bb 프리플랍 전체 트리, 그리고 40bb 주요 매치업의 플랍·턴(리버는 즉석 재솔브)."],
    ["/trainer", "연습", "스택 깊이별 프리플랍 오픈·리셔브·대응 퀴즈, 그리고 미리 푼 40bb 스팟에서 GTO 상대와 핸드를 끝까지 플레이하며 결정마다 채점."],
    ["/analyze", "분석", "토너먼트 핸드 히스토리를 붙여넣으면 스택에 가장 가까운 솔루션으로 프리플랍·포스트플랍 결정을 채점합니다(정확/부정확/블런더, EV 손실)."],
    ["/reports", "리포트", "매치업별로 모든 플랍의 첫 액션 빈도·EV·에퀴티를 보드 텍스처별로 집계합니다."],
    ["/solve", "솔버", "원하는 보드·레인지·사이즈로 2~6인 포스트플랍을 직접 풉니다."],
    ["/calc", "도구", "에퀴티 계산기, ICM·버블 팩터, 에퀴티 러시."]
  ];
  return (
    <div className="page">
      <div className="home-hero">
        <h1>
          홀덤 <span className="accent">GTO 스튜디오</span>
        </h1>
        <p className="muted">토너먼트 기준 스터디 · 연습 · 분석을 한곳에서. 서버 없이 브라우저가 직접 계산합니다.</p>
        <div className="row" style={{ justifyContent: "center" }}>
          <button className="primary" onClick={() => go("/study")}>
            스터디 시작
          </button>
          <button onClick={() => go("/trainer")}>프리플랍 연습</button>
          <button onClick={() => go("/analyze")}>내 핸드 분석</button>
        </div>
      </div>
      <div className="feature-cards">
        {cards.map(([p, t, d]) => (
          <div key={p} className="card" onClick={() => go(p)}>
            <h3>{t}</h3>
            <p className="small" style={{ margin: 0 }}>
              {d}
            </p>
          </div>
        ))}
      </div>
      <LibraryStatus />
      <div className="card" style={{ marginTop: 14 }}>
        <h3>솔루션에 대해</h3>
        <ul className="small muted" style={{ margin: 0, paddingLeft: 18 }}>
          <li>포스트플랍: 40bb 토너먼트 매치업을 헤즈업 Discounted CFR로 푼 단일 사이즈 트리(플랍 33%·레이즈 60%, 턴 66%, 리버 75%). 플랍당 익스플로잇어빌리티 약 0.2~0.3%(팟 대비).</li>
          <li>프리플랍: 8인 전체 트리를 169 핸드 클래스로 풀되, 플랍 이후 가치는 에퀴티×실현계수로 근사합니다. 실현계수는 이 앱의 포스트플랍 솔버로 직접 풀어 잰 SPR별 값입니다. 포스트플랍까지 함께 푼 상용 솔루션과는 차이가 있습니다.</li>
          <li>토너먼트 솔루션은 칩 EV 기준입니다. ICM(상금 구조) 압박은 반영하지 않으므로 버블·파이널 테이블에서는 도구 메뉴의 ICM 계산기로 보정하세요.</li>
          <li>라이브러리에 없는 보드·라인은 솔버 메뉴에서 직접 풀 수 있습니다.</li>
        </ul>
      </div>
    </div>
  );
}

function LibraryStatus() {
  const [idx, setIdx] = useState<Array<MatchupIndex | null>>([]);
  useEffect(() => {
    Promise.all(MATCHUPS.map((m) => loadMatchupIndex(m.id))).then(setIdx);
  }, []);
  return (
    <div className="card" style={{ marginTop: 14 }}>
      <h3>라이브러리 현황</h3>
      <table className="tbl">
        <thead>
          <tr>
            <th>포맷</th>
            <th>범위</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>프리플랍</td>
            <td>토너먼트 8맥스 앤티 15·25·40·60bb (전체 트리) · 캐시 6맥스 100bb (보조)</td>
          </tr>
          {MATCHUPS.map((m, i) => (
            <tr key={m.id} className="clickable" onClick={() => (window.location.hash = `/reports?m=${m.id}`)}>
              <td>{m.name}</td>
              <td>{idx[i] ? `플랍 ${idx[i]!.flops.length}개 (플랍·턴 저장, 리버 즉석 솔브)` : "준비 중"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
