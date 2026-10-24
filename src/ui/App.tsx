import { useEffect, useState } from "react";
import { useHashRoute } from "./common";
import { SolvePage } from "./SolvePage";
import { StudyPage } from "./StudyPage";
import { TrainerPage } from "./TrainerPage";
import { PreflopPage } from "./PreflopPage";
import { CalcPage } from "./CalcPage";
import { RushPage } from "./RushPage";
import { db } from "./db";

const NAV = [
  ["/", "홈"],
  ["/study", "스터디"],
  ["/solve", "커스텀 솔브"],
  ["/trainer", "트레이너"],
  ["/preflop", "프리플랍 랩"],
  ["/calc", "계산기"],
  ["/rush", "에퀴티 러시"]
] as const;

export function App() {
  const { path } = useHashRoute();
  return (
    <div className="app">
      <nav className="topnav">
        <span className="brand">♠ 홀덤 GTO 스튜디오</span>
        {NAV.map(([p, label]) => (
          <a key={p} href={"#" + p} className={path === p ? "active" : ""}>
            {label}
          </a>
        ))}
        <span style={{ marginLeft: "auto" }} className="muted">
          v0.1 · 브라우저 안에서 전부 계산 · 서버 없음
        </span>
      </nav>
      {path === "/" && <HomePage />}
      {path === "/study" && <StudyPage />}
      {path === "/solve" && <SolvePage />}
      {path === "/trainer" && <TrainerPage />}
      {path === "/preflop" && <PreflopPage />}
      {path === "/calc" && <CalcPage />}
      {path === "/rush" && <RushPage />}
    </div>
  );
}

function HomePage() {
  const [count, setCount] = useState<number | null>(null);
  useEffect(() => {
    db.listSpots().then((s) => setCount(s.length)).catch(() => setCount(0));
  }, []);
  const go = (p: string) => (window.location.hash = p);
  return (
    <div className="page">
      <div className="home-hero">
        <h1>
          내 손으로 돌리는 <span className="accent">홀덤 GTO 솔버</span>
        </h1>
        <p className="muted">서버도, 구독도 없습니다. 레인지와 보드를 넣으면 브라우저가 Discounted CFR로 균형 전략을 계산하고, 그 전략으로 스터디·트레이닝까지 이어집니다.</p>
        <div className="row" style={{ justifyContent: "center" }}>
          <button className="primary" onClick={() => go("/solve")}>
            첫 스팟 솔브하기
          </button>
          <button onClick={() => go("/study")}>저장된 스팟 {count ?? "…"}개 보기</button>
        </div>
      </div>
      <div className="feature-cards">
        <div className="card" onClick={() => go("/solve")}>
          <h3>커스텀 솔브</h3>
          <p>2~6인, 플랍·턴·리버 시작, 스트리트별 벳/레이즈 사이즈, 레이크, 올인 임계값, 동크 설정. 트리 크기와 메모리를 먼저 추정하고 빠름/표준/깊음 프리셋으로 멈춥니다.</p>
        </div>
        <div className="card" onClick={() => go("/study")}>
          <h3>스터디</h3>
          <p>13×13 그리드에 전략·EV·에퀴티·EQR을 겹쳐 보고, 액션 리본으로 트리를 오가며, 콤보 단위 빈도와 EV를 확인합니다. URL 하나로 스팟이 재현됩니다.</p>
        </div>
        <div className="card" onClick={() => go("/trainer")}>
          <h3>트레이너 · 드릴</h3>
          <p>솔브된 스팟에서 GTO 상대와 플레이. 정확/부정확/블런더와 EV 손실(팟 %)로 채점하고 스트리트·자리별 통계, 드릴 저장을 지원합니다.</p>
        </div>
        <div className="card" onClick={() => go("/preflop")}>
          <h3>프리플랍 랩 (HU 근사)</h3>
          <p>스택·오픈·3벳·4벳 사이즈를 정해 헤즈업 프리플랍 전략을 계산하고, 그 레인지를 그대로 포스트플랍 솔브로 넘깁니다.</p>
        </div>
        <div className="card" onClick={() => go("/calc")}>
          <h3>에퀴티 · ICM 계산기</h3>
          <p>레인지 vs 레인지 에퀴티(핸드별 히트맵), Malmuth-Harville ICM과 버블 팩터 행렬.</p>
        </div>
        <div className="card" onClick={() => go("/rush")}>
          <h3>에퀴티 러시</h3>
          <p>15초 안에 핸드 에퀴티를 맞히는 감각 훈련 게임.</p>
        </div>
      </div>
      <div className="card" style={{ marginTop: 14 }}>
        <h3>엔진</h3>
        <ul style={{ margin: 0, paddingLeft: 18 }} className="muted">
          <li>2~6인 포스트플랍 Discounted CFR(α=1.5, β=0, γ=2), 교대 업데이트, 1326 콤보 벡터화. 3인까지는 상대 두 명의 카드 충돌을 포함-배제로 정확히 계산, 4인 이상은 상대 간 겹침을 무시하는 근사</li>
          <li>익스플로잇어빌리티 = 양쪽 최적 응답 이득의 평균(팟 %). 리버 clairvoyance 이론값(블러프 1/3, MDF 50%) 검증 통과</li>
          <li>모든 계산은 Web Worker에서 실행, 결과는 이 기기의 IndexedDB에만 저장</li>
        </ul>
      </div>
    </div>
  );
}
