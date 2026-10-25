# 홀덤 GTO 솔버 SDK (holdem-gto-solver) 1.0.0

웹앱·하이브리드 앱·Node 서버에 넣어 쓰는 텍사스 홀덤 GTO 엔진입니다. 서버 없이 사용자 기기에서 계산합니다.

- **미리 푼 라이브러리 조회**: 토너먼트 8맥스(앤티) 15·25·40·60bb 프리플랍 전체 트리, 40bb 포스트플랍 5개 매치업 72개 플랍. 플랍·턴은 저장된 솔루션, 리버는 그 자리에서 다시 풉니다.
- **커스텀 솔브**: 헤즈업 플랍·턴·리버. 사이즈 프리셋 3종 또는 직접 지정, 여러 코어 병렬, 노드 잠금, 저장·불러오기, 핸드·169 클래스별 전략·EV·에퀴티·EQR.
- **핸드 히스토리 분석**: PokerStars·GGPoker 텍스트를 넣으면 프리플랍·포스트플랍 결정을 정확/부정확/블런더와 EV 손실로 채점합니다.
- **기본 도구**: 레인지 문법, 에퀴티(레인지 대 레인지·핸드 대 핸드), ICM·버블 팩터, 족보·드로우 분류. 저수준 멀티웨이(3~6인) 솔버와 프리플랍 솔버도 들어 있습니다.

외부 솔버 코드나 데이터는 쓰지 않았고, 엔진은 전부 직접 작성한 TypeScript(Discounted CFR)입니다. 의존성은 없습니다.

## 파일

| 파일 | 용도 |
| --- | --- |
| `dist/gto.js` | 공개 API (브라우저·번들러·Deno 등, ES 모듈) |
| `dist/gto-node.js` | 공개 API + Node 전용 도우미 (`nodeSubPorts`, `fileFetch`) |
| `dist/gto-sub-worker.js` | 브라우저 병렬 솔브용 Web Worker 스크립트 |
| `dist/gto-sub-worker-node.js` | Node 병렬 솔브용 worker_threads 스크립트 |
| `dist/types/` | TypeScript 타입 선언 (`sdk/src/index.d.ts`가 진입점) |
| `examples/` | 브라우저 예제 페이지, Node 예제 2개 |
| `API.md` · `DATA.md` | API 레퍼런스 · 라이브러리 데이터 형식 |

## 설치

받은 폴더를 프로젝트 안에 두고 경로로 설치하거나(`npm install ./holdem-gto-solver`), `npm pack`으로 만든 `holdem-gto-solver-1.0.0.tgz`를 설치합니다. 패키지 이름으로 가져오면 Node는 `gto-node.js`, 번들러는 `gto.js`를 씁니다.

```ts
import { GtoLibrary, createSolve, browserSubPorts } from "holdem-gto-solver";
```

## 빠른 시작

### 1. 라이브러리 조회 (프리플랍 차트)

```ts
const lib = new GtoLibrary(); // 기본 데이터 주소: 공개 라이브러리 (CORS 허용)

// 40bb, BTN 까지 폴드 → BTN 차례
const v = await lib.preflopNode("mtt8-40", ["F", "F", "F", "F", "F"]);
v.actions; // [{ code:"F", label:"폴드", freq, ev }, { code:"R2.2", label:"오픈 2.2", freq, ev }]
v.hands;   // 169개: { hand:"A5s", weight, freq:[폴드, 오픈], ev:[…] } — 13×13 그리드에 바로 쓰는 형태
```

경로는 액션 코드 배열입니다. 결정 노드의 `actions[].code`를 이어 붙여 다음 노드로 갑니다(F 폴드, X 체크, C 콜, L 림프, R2.2 레이즈 총액, A 올인).

### 2. 포스트플랍 라이브러리 (플랍·턴·리버)

```ts
const spot = await lib.spot("m40-btn-bb", "Ks7d2c");
const flop = await spot.view([]);                                   // BB 차례
const turn = await spot.view([{ kind: "action", index: 0 }, { kind: "action", index: 0 }, { kind: "card", card: parseCard("9c") }]);
// 리버 노드는 그 자리에서 다시 풀어 river: { iterations, exploitabilityPct } 와 함께 돌려준다
```

`lib.flops(matchupId)`로 실제 생성된 플랍 목록을, `lib.index(matchupId)`로 플랍별 첫 액션 빈도·EV(리포트)를 받습니다. 라이브러리에 없는 플랍은 수트만 다른 같은 플랍을 `matchFlop`으로 찾을 수 있습니다.

### 3. 커스텀 솔브 (병렬)

```ts
// 앱이 dist/gto-sub-worker.js 를 정적 파일로 서비스한다고 가정 (예: public/gto-sub-worker.js)
const ports = browserSubPorts("/gto-sub-worker.js");              // 생략하면 코어 수 − 1 개
const s = await createSolve({
  board: "Ks7d2c", pot: 5.9, stack: 37.8,
  oopRange: "22+,A2s+,K2s+,Q4s+,J6s+,T6s+,96s+,85s+,75s+,64s+,54s,A2o+,K7o+,Q8o+,J8o+,T8o+,98o",
  ipRange: "22+,A2s+,K2s+,Q2s+,J4s+,T6s+,96s+,85s+,75s+,64s+,54s,A2o+,K5o+,Q8o+,J8o+,T8o+,98o",
  preset: "standard",                                                 // simple | standard | complex
  ports
});
await s.run({ targetExploitability: 0.5, maxIterations: 200, onProgress: (m) => console.log(m.iterations, m.exploitabilityPct) });
const root = await s.view([]);
root.analysis.actionFreq;              // 레인지 전체 액션 빈도
byClass(root, s.combos);               // 169 클래스별 빈도·EV·에퀴티·EQR (그리드용)

// 노드 잠금: BB 가 항상 체크한다고 고정하고 다시 푼다
await s.lock([], root.node.actions.map((a) => (a.type === "check" ? 1 : 0)));
await s.run({ targetExploitability: 0.5 });
s.close();                              // 워커 종료
```

Vite에서는 `import workerUrl from "holdem-gto-solver/sub-worker?url"`로 워커 주소를 얻을 수도 있습니다. `ports`를 주지 않거나 리버(보드 5장)면 같은 스레드에서 풉니다.

### 4. 핸드 히스토리 분석

```ts
const { hands } = await lib.analyzeHands(text);    // 토너먼트는 유효 스택에 가장 가까운 깊이를 자동 선택
for (const h of hands) for (const d of h.analysis.decisions) console.log(d.label, d.chosen, d.best, d.evLoss, d.verdict);
```

### Node

```js
import { GtoLibrary, createSolve, nodeSubPorts, fileFetch } from "holdem-gto-solver/node";
const s = await createSolve({ ...spec, ports: nodeSubPorts() });          // worker_threads
const lib = new GtoLibrary({ baseUrl: "file:///D:/gto-data/lib/", fetch: fileFetch }); // 로컬 데이터
```

예제: `node examples/node/library.mjs`, `node examples/node/solve.mjs`. 브라우저 예제는 이 폴더를 정적 서버로 열고 `examples/browser/index.html`을 엽니다(예: `npx serve .` 또는 `python -m http.server`).

## 라이브러리 데이터

기본 주소는 `https://thstjdals09-lang.github.io/gto-studio/lib/`이고 GitHub Pages라 어느 도메인에서든 읽을 수 있습니다. 앱에서 직접 서비스하려면 같은 구조(`preflop/`, `postflop/`, `eq169.bin`)를 복사하고 `new GtoLibrary({ baseUrl })`로 바꿉니다. 프리플랍 5개 포맷은 약 50MB, 포스트플랍은 약 250MB이며 필요한 파일만 그때그때 받습니다(프리플랍 포맷 하나 3~18MB, 플랍 하나 25KB + 턴 카드당 수백 KB). 형식은 `DATA.md`에 있습니다.

| 종류 | 범위 |
| --- | --- |
| 프리플랍 | `mtt8-15` · `mtt8-25` · `mtt8-40` · `mtt8-60` (8맥스, 앤티 0.125bb), `cash6-100` (보조) |
| 포스트플랍 (40bb) | `m40-btn-bb` 24플랍, `m40-co-bb` · `m40-utg-bb` · `m40-sb-bb-limp` · `m40-bb-btn-3bp` 각 12플랍 |

## 성능

6코어 PC, Node 22, 40bb BTN vs BB K72 플랍(핸드 1025개, 단순 프리셋) 기준입니다.

| 방식 | 반복당 | 100회 |
| --- | --- | --- |
| 단일 스레드 | 7.7초 | 약 13분 |
| 병렬 워커 5개 | 2.3초 | 약 4분 |

턴은 수 초~수십 초, 리버는 1초 안팎입니다. 결과는 위 예제(`examples/node/solve.mjs`) 그대로이며, 60회에 익스플로잇 0.43%까지 수렴했습니다.

메모리는 리버 노드가 런아웃(플랍 기준 2,352개)마다 핸드별 배열을 가져서 트리 크기에 크게 좌우됩니다. 같은 스팟(핸드 1025개)의 플랍 전체 솔브 기준입니다. 병렬이면 워커들에 나뉩니다.

| 프리셋 | 사이즈 | 플랍 솔브 메모리 | 턴 솔브 메모리 |
| --- | --- | --- | --- |
| `simple` | 플랍 33%, 턴 66%, 리버 75% | 약 1.4GB | 수십 MB |
| `standard` | 플랍 IP 33·75%, 턴 66%, 리버 75% | 약 2GB | 수십 MB |
| `complex` | 스트리트마다 2~3사이즈 + 레이즈 | 수십 GB (플랍 불가) | 수백 MB |

`estimateSolve(spec)`로 미리 볼 수 있고, `createSolve`는 추정치가 `memoryLimitMb`(기본 2048)를 넘으면 풀기 전에 오류를 냅니다. 레인지가 좁으면 메모리도 비례해 줄어듭니다. 휴대폰에서는 플랍 전체 솔브 대신 라이브러리 조회와 턴·리버 솔브를 권합니다. 병렬 결과는 단일 스레드와 같은 알고리즘이며, 워커 1개일 때는 비트 단위로 같습니다(테스트로 확인).

## 정확도와 한계

- 포스트플랍 솔버는 헤즈업 Discounted CFR 풀 트리(카드 제거 정확)입니다. 익스플로잇어빌리티를 팟 대비 %로 직접 재서 보여 줍니다. 라이브러리는 평균 0.2~0.3%, 림프 팟만 0.5%입니다.
- 프리플랍은 169 핸드 클래스 전체 트리를 풀되 플랍 이후 가치를 에퀴티×실현계수로 근사합니다. 실현계수는 이 엔진의 포스트플랍 솔버로 직접 잰 SPR별 값입니다. 포스트플랍까지 함께 푼 상용 솔루션과 몇 %p 차이가 날 수 있습니다.
- 토너먼트 솔루션은 칩 EV 기준이며 ICM을 반영하지 않습니다(ICM 계산 함수는 제공). 스택은 모두 같다고 가정합니다.
- 노드 잠금은 헤즈업 포스트플랍 솔버에서만 됩니다. 멀티웨이 솔버는 3인까지 쇼다운이 정확하고 4인 이상은 근사입니다.

## 라이선스

`LICENSE`를 보세요. 저작권자의 허락 없이 재배포·판매할 수 없습니다.
