# 홀덤 GTO 스튜디오

GTO Wizard처럼 **미리 풀어둔 솔루션을 바로 탐색**하고, 그 솔루션으로 연습·분석까지 하는 홀덤 학습 웹앱입니다. 서버 없이 브라우저가 모든 계산을 합니다. 엔진은 전부 이 저장소에서 TypeScript로 새로 작성했습니다(외부 솔버 코드·데이터 없음).

배포: https://thstjdals09-lang.github.io/gto-studio/ (공개 저장소 `thstjdals09-lang/gto-studio`에는 빌드 결과물과 라이브러리 데이터만 올라갑니다)

## 메뉴

| 메뉴 | 내용 |
| --- | --- |
| 스터디 | 포맷 선택 → 자리 막대(자리별 스택·액션) → 13×13 전략 그리드·EV·레인지 → 플랍 도달 시 라이브러리 플랍 선택 → 플랍·턴(저장된 솔루션)·리버(즉석 재솔브) 탐색. 핸드 분류(브레이크다운) 탭, 턴 런아웃 리포트, URL 공유 |
| 연습 | 프리플랍 퀴즈(오픈/오픈 대응/3벳 대응, 실전 빈도대로 출제), 포스트플랍 트레이너(라이브러리 스팟 또는 내 솔브에서 GTO 상대와 끝까지 플레이), 통계·드릴 |
| 분석 | PokerStars·GGPoker 핸드 히스토리 붙여넣기 → 프리플랍 결정과 라이브러리 플랍(수트만 다른 보드 포함)의 플랍·턴·리버 결정을 정확/부정확/블런더와 EV 손실로 채점. VPIP·PFR·3벳·자리별 요약 |
| 리포트 | 매치업별 모든 플랍의 첫 액션 빈도·EV·에퀴티, 하이카드·수트·페어·연결성별 평균 |
| 솔버 | 2~6인 포스트플랍 커스텀 솔브 (보드·레인지·사이즈·레이크) |
| 도구 | 에퀴티 계산기, ICM·버블 팩터, 에퀴티 러시, HU 프리플랍 랩 |

## 라이브러리

| 종류 | 범위 | 방법 |
| --- | --- | --- |
| 프리플랍 | **토너먼트 8맥스 앤티 15·25·40·60bb**, 캐시 6맥스 100bb(보조) | `src/engine/ring.ts`: 169 핸드 클래스 DCFR, 칩 EV 기준(ICM 미반영). 오픈·림프·콜·3벳(25bb 이하 리셔브 포함)·4벳·올인 트리, 자발적 참여 3명 상한, 올인에는 3인까지 콜 가능. 플랍 이후 가치는 에퀴티×실현계수 근사이고, 실현계수는 자체 포스트플랍 솔버로 15·40·100bb BTN vs BB 플랍 25개를 풀어 측정한 SPR별 값(IP/OOP 비율 1.06→1.18→1.34, 약한 핸드일수록 덜 실현하는 기울기, 플레이어빌리티)으로 보간. 3인 팟은 쌍별 승률 곱을 핸드별로 정규화하고 지수 0.65로 보정(3인 몬테카를로 대비 오차 약 0.02~0.03) |
| 포스트플랍 | 토너먼트 40bb: BTN 오픈 vs BB 콜 24플랍, CO·UTG 오픈 vs BB 콜, SB 림프 vs BB 체크, BTN 오픈·BB 3벳·BTN 콜 각 12플랍 | `src/engine/solver.ts`: 헤즈업 DCFR 풀 트리. 플랍 33% 벳·60% 레이즈(SRP는 오픈한 쪽만 벳, 3벳·림프 팟은 양쪽), 턴 66%, 리버 75%(턴·리버 레이즈 없음). 레인지는 프리플랍 라이브러리에서 그대로 가져옴. 플랍당 100회 또는 익스플로잇어빌리티 0.2%(보조 매치업 80회·0.3%)에서 정지 |

플랍·턴 노드는 콤보별 전략(1바이트)과 EV(2바이트)로 저장되고, 리버는 브라우저가 그 지점 레인지로 리버 서브게임을 재솔브합니다(`src/worker/libspot.ts`).

## 솔버 SDK (공유용)

`sdk/`는 이 엔진을 다른 앱에 넣어 쓰는 독립 패키지(holdem-gto-solver)입니다. 라이브러리 조회, 핸드 분석, 병렬 커스텀 솔브, 노드 잠금, 저장·불러오기를 API로 제공합니다. `npm run sdk:build`로 빌드하고 `npm run sdk:pack`으로 `release/holdem-gto-solver-<버전>.tgz`를 만듭니다. 배포본은 비공개 저장소 `thstjdals09-lang/gto-solver-sdk`의 릴리스에 있습니다. 사용법은 `sdk/README.md`, `sdk/API.md`, `sdk/DATA.md`를 보세요.

## 행동 결정 모델

지금 상황을 주면 내 차례의 액션별 빈도·EV와 추천 액션을 2.5초 안에 돌려줍니다 (`src/lib/decide.ts`, SDK 에서는 `GtoLibrary.decide()`). 2~8명, 15·25·40·60bb.

```bash
npm run decide -- 상황.json
```

```json
{
  "players": 8, "hero": "BTN", "cards": "AsKd", "stack": 40,
  "preflop": [
    { "pos": "UTG", "type": "fold" }, { "pos": "UTG1", "type": "fold" }, { "pos": "LJ", "type": "fold" },
    { "pos": "HJ", "type": "fold" }, { "pos": "CO", "type": "fold" },
    { "pos": "BTN", "type": "raise", "to": 2.2 }, { "pos": "SB", "type": "fold" }, { "pos": "BB", "type": "call" }
  ],
  "board": "Ks7d2c",
  "flop": [{ "pos": "BB", "type": "check" }]
}
```

액션은 내 차례 직전까지만 넣습니다. `to`는 그 스트리트에서 그 자리가 넣은 총액(bb)입니다. 8명보다 적으면 앞자리부터 비어 있는 것으로 봅니다(6명이면 LJ가 첫 자리).

| 스트리트 | 방법 | 믿을 만한 정도 |
| --- | --- | --- |
| 프리플랍 | 미리 푼 8맥스 라이브러리 조회 | 라이브러리와 같음 |
| 리버 | 넘어온 레인지로 끝까지 풀기 | 주어진 레인지 안에서는 수렴 (익스플로잇 0.1% 안팎) |
| 플랍·턴 | 지금 스트리트만 풀고 뒤는 에퀴티×실현 모델 (`src/engine/street.ts`) | 근사. 만든 패를 콜보다 레이즈로 고르는 편향이 있고, 그 레인지가 리버로 넘어감 |

3명 이상 팟은 나와 주 상대 한 명의 승부로 줄여 풉니다. 결과의 `notes`에 그 결정에 쓰인 근사가 적혀 나옵니다.

## 생성

```bash
npm install
node_modules/.bin/esbuild scripts/gen-preflop.ts --bundle --platform=node --format=esm --outfile=.cache/gen-preflop.mjs
# (선택) 실현율 재측정: 포맷별 BTN vs BB 플랍을 풀어 핸드별 실제 팟 몫을 기록한 뒤 표를 맞춘다
node_modules/.bin/esbuild scripts/calib-realization.ts --bundle --platform=node --format=esm --outfile=.cache/calib.mjs
node .cache/calib.mjs mtt8-40 8 30 12 0 1      # 포맷, 플랍 수, 반복, 시드, 샤드
node_modules/.bin/esbuild scripts/fit-realization.ts --bundle --platform=node --format=esm --outfile=.cache/fit.mjs
POOLED_ONLY=1 node .cache/fit.mjs              # 출력된 표를 ring.ts 의 REALIZATION_TABLE 에 넣는다
node .cache/gen-preflop.mjs "" 300            # 프리플랍 5개 포맷 (에퀴티 행렬 포함, 포맷당 10~40분)
node_modules/.bin/esbuild scripts/gen-postflop.ts --bundle --platform=node --format=esm --outfile=.cache/gen-postflop.mjs
bash scripts/run-postflop.sh 0 4 &            # 샤드 0..3 병렬 (6코어 기준 수 시간)
node_modules/.bin/esbuild scripts/gen-index.ts --bundle --platform=node --format=esm --outfile=.cache/gen-index.mjs && node .cache/gen-index.mjs
```

포스트플랍 데이터(`public/lib/postflop/`, 약 250MB)는 소스 저장소에 넣지 않고 배포 저장소에만 올립니다.

## 개발

```bash
npm run dev      # http://localhost:5188
npm test         # vitest (엔진·파서·분석·라이브러리 스팟)
npm run build
bash scripts/deploy-pages.sh   # 빌드 후 gto-studio 저장소로 배포
```

## 한계

- 프리플랍은 포스트플랍을 직접 풀지 않는 근사라 상용 솔루션과 차이가 있습니다. 실현계수는 측정값이지만 플랍 표본이 작습니다.
- 토너먼트 솔루션은 칩 EV 기준이며 ICM(상금 구조)을 반영하지 않습니다. 스택은 모두 같다고 가정합니다.
- 포스트플랍 라이브러리는 단일 사이즈 트리이고 플랍 수가 제한적입니다. 그 밖의 보드·라인은 솔버 메뉴에서 직접 풉니다.
- 분석기는 라이브러리 트리에 없는 사이즈·라인에서 채점을 멈춥니다. 토너먼트 핸드는 유효 스택에 가장 가까운 깊이(15·25·40·60bb)로, 8인보다 적은 테이블은 뒷자리 기준으로 맞춰 근사합니다.
- 멀티웨이 커스텀 솔브는 4인 이상 쇼다운이 근사이고 번칭 효과를 반영하지 않습니다.

## 라이선스

저작권자(thstjdals09-lang)가 모든 권리를 보유합니다. GTO Wizard와 무관한 독자 구현입니다.
