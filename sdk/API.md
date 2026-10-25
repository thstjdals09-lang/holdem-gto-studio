# API 레퍼런스 — holdem-gto-solver 1.0.0

모든 금액 단위는 빅블라인드(bb)입니다. 카드 번호는 `rank*4 + suit`(랭크 2=0 … A=12, 수트 c d h s), 콤보 번호는 0~1325, 핸드 클래스는 0~168입니다. 변환은 `parseCard("As")`, `cardToString(c)`, `comboIndex(c1,c2)`, `comboToString(i)`, `classLabel(k)`, `COMBO_CLASS[i]`로 합니다.

## GtoLibrary — 미리 푼 솔루션

```ts
new GtoLibrary({ baseUrl?: string, fetch?: LibraryFetch })
```

| 메서드 | 반환 | 설명 |
| --- | --- | --- |
| `formats()` | `FormatInfo[]` | 프리플랍 포맷 (id, name, players, positions, stack, ante, openTo) |
| `matchups()` | `Matchup[]` | 포스트플랍 매치업 (id, name, format, codes, oop, ip, kind, flopSet) |
| `preflop(formatId)` | `Promise<PfLib>` | 프리플랍 라이브러리 원본 JSON (DATA.md) |
| `preflopNode(formatId, codes)` | `Promise<PreflopNodeView>` | 액션 코드 경로의 노드 |
| `index(matchupId)` | `Promise<MatchupIndex \| null>` | 플랍별 루트 액션 빈도·EV·에퀴티 (리포트용) |
| `flops(matchupId)` | `Promise<string[]>` | 생성된 플랍 목록 |
| `spot(matchupId, flop)` | `Promise<LibSpot>` | 포스트플랍 스팟 (아래) |
| `analyzeHands(text, { format?, postflop? })` | `Promise<{ hands: AnalyzedHand[], skipped }>` | 핸드 히스토리 채점 |

### PreflopNodeView

| 필드 | 설명 |
| --- | --- |
| `kind` | `"decision"` 또는 `"terminal"` |
| `position`, `toCall`, `pot`, `line` | 행동 자리, 콜 금액, 팟, 지나온 라인 |
| `actions[]` | `{ code, label, type, to, freq, ev }` — 레인지 전체 빈도와 평균 EV |
| `hands[]` | 169개 `{ hand, weight, freq[], ev[] }` — 핸드 클래스별 액션 빈도·EV(bb), weight 는 이 노드 도달 비율 |
| `ranges` | 자리별 도달 레인지 (169 클래스, 0~1) |
| `terminalType`, `matchup` | 터미널(fold·flop·allin)과, 플랍이면 해당 포스트플랍 매치업 |

EV는 "이 시점부터의 기대 순이익"이라 폴드는 0입니다.

### LibSpot — 포스트플랍 스팟

| 메서드 | 설명 |
| --- | --- |
| `view(path, onProgress?)` | 노드 보기. `NodeView` = `DecisionView` · `ChanceView` · `TerminalView`. 리버 경로는 즉석 재솔브하고 `river: { iterations, exploitabilityPct }`를 붙인다 |
| `runouts(path)` | 턴 찬스 노드에서 카드별 첫 결정의 액션 빈도·EV·에퀴티 (런아웃 리포트) |
| `analyzeLine(heroSeat, heroCombo, items)` | 실제 라인 채점 (analyzeHands 가 내부에서 사용) |

`path`는 `{ kind: "action", index }`(그 노드 actions 의 인덱스)와 `{ kind: "card", card }`의 배열입니다.

`DecisionView` 주요 필드: `player`(0 OOP, 1 IP), `street`(1 플랍 2 턴 3 리버), `board`, `pot`, `invested`, `toCall`, `actions[]`(`label, code, type, amount, freq, ev`), `classFreq`(169×A), `classEv`, `classWeightNorm`, `classEquity`, `classEqr`, `combos[]`(콤보별 `strategy, ev, equity, eqr, weight`), `rangeEv`, `rangeEquity`.

## createSolve — 커스텀 솔브 (헤즈업)

```ts
const s = await createSolve(spec: SolveSpec): Promise<SolveSession>
```

### SolveSpec

| 필드 | 기본 | 설명 |
| --- | --- | --- |
| `board` | — | `"Ks7d2c"` 등 3~5장 |
| `pot`, `stack` | — | 시작 팟, 유효 스택 (bb) |
| `oopRange`, `ipRange` | — | 레인지 문자열(아래) 또는 1326 가중치 `Float32Array` |
| `preset` | `"simple"` | `simple` · `standard` · `complex` (README 표) |
| `sizes` | — | `{ oop?, ip? }` 각 `{ flop, turn, river }` = `{ bet: number[], raise: number[], donk?: number[] }` (팟 대비 %). 주면 프리셋보다 우선 |
| `maxRaisesByStreet` | 프리셋 | `[플랍, 턴, 리버]` 벳+레이즈 최대 횟수 |
| `allinThresholdPct` | 67 | 남은 스택의 이 % 이상이면 올인으로 바꿈 |
| `includeAllin` | false | 사이즈 목록에 올인을 항상 추가 |
| `allowDonk` | true | 이전 스트리트 공격자가 IP일 때 OOP 리드 허용 |
| `rakePct`, `rakeCap` | 0 | 레이크 (콜된 부분에만) |
| `ports` | — | 병렬 통로 (`browserSubPorts`, `nodeSubPorts`, `LocalSubPort`) |
| `memoryLimitMb` | 2048 | 추정 메모리 상한 |

레인지 문법: `AA, KK-TT, 77+, AKs, AQo+, KJs-K9s, A5s:0.5, AsKd` (쉼표·공백 구분, `:가중치` 0~1).

### SolveSession

| 멤버 | 설명 |
| --- | --- |
| `hands`, `combos` | 핸드 슬롯 수, 슬롯 → 콤보 번호 |
| `threads`, `iterations`, `config` | 워커 수, 반복 수, 트리 설정 |
| `run({ targetExploitability=0.3, maxIterations=300, maxMs?, checkEvery=10, onProgress?, signal? })` | 목표(팟 대비 %)에 닿거나 상한까지 푼다. 이어서 다시 부를 수 있다 |
| `metrics()` | `{ iterations, exploitabilityPct, evOop, evIp, brOop, brIp, elapsedMs }` |
| `view(path)` | `{ node, reach: [oop, ip], analysis? }` — `node`는 `{ kind, street, pot, invested, player?, toCall?, actions?, board }` |
| `lock(path, strategy, allRunouts?)` | 노드 잠금. `strategy`는 액션별 빈도 배열(레인지 전체 동일) 또는 슬롯 기준 `Float32Array(A×hands)` |
| `unlock(path, allRunouts?)`, `clearLocks()` | 잠금 해제 |
| `exportStrategy()`, `importStrategy(data, iterations)` | 정규화 전략 저장·불러오기 (불러온 세션은 보기 전용) |
| `close()` | 워커 종료 |

`analysis` 필드: `strategy`(A×hands), `ev`(A×hands, 이 시점부터 순이익), `handEv`, `equity`, `eqr`, `reachP`, `reachO`, `S`(상대 비충돌 질량), `actionFreq[]`, `actionEv[]`, `rangeEv`, `rangeEquity`. 인덱스는 `액션 a × hands + 슬롯 h`.

### 보조 함수

| 함수 | 설명 |
| --- | --- |
| `byClass(view, combos)` | 169 클래스별 `{ hand, weight, freq[], ev[], equity, eqr }` (13×13 그리드) |
| `byCombo(view, combos)` | 콤보별 같은 행 |
| `estimateSolve(spec)` | `{ decisionNodes, hands, bytes }` |
| `presetSizings(preset)`, `treeConfigOf(spec)` | 프리셋 사이즈, 스펙 → 트리 설정 |
| `browserSubPorts(workerUrl, count?)` | Web Worker 병렬 통로 |
| `nodeSubPorts(count?, workerFile?)` | worker_threads 병렬 통로 (`/node` 진입점) |
| `fileFetch` | `file://` 라이브러리 읽기 (`/node` 진입점) |

## 핸드 히스토리

`analyzeHands` 결과의 `analysis`: `position`, `cards`, `net`(bb), `preflopLine`, `vpip`, `pfr`, `threeBet`, `matchup`, `libFlop`, `note`, `decisions[]`. 결정은 `{ street, label, chosen, best, freq, evLoss, verdict, options[{ label, freq, ev }], link }`이고, `verdict`는 `correct`·`inaccuracy`·`blunder`입니다. 프리플랍은 EV 손실 0.05/0.3bb, 포스트플랍은 팟의 1%/5%를 기준으로 나누며, GTO 빈도 30% 이상인 선택은 정확으로 봅니다. `link`의 `pf`·`fl`·`pp`는 이 SDK의 경로(프리플랍 인덱스, 라이브러리 플랍, 포스트플랍 경로)입니다.

## 저수준 API

`PostflopSolver`, `ParallelPostflopSolver`, `buildTree`, `MultiSolver`(3~6인), `RingSolver`·`buildRingTree`·`RING_FORMATS`(프리플랍), `rangeVsRange`, `handVsHand`, `icmEquities`, `bubbleFactors`, `classifyMade`, `classifyDraw`, `parseHandHistories`, `analyzePreflop`, `matchFlop`, `pickFormat` 등도 그대로 내보냅니다. 타입 선언(`dist/types`)에 주석이 있습니다.
