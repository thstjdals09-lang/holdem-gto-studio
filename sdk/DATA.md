# 라이브러리 데이터 형식

라이브러리 루트(`baseUrl`) 아래 구조입니다. 공개 사본: `https://thstjdals09-lang.github.io/gto-studio/lib/`

```
lib/
  eq169.bin                         169×169 프리플랍 올인 에퀴티 (float32, 행 = 내 클래스)
  preflop/<format>.json             프리플랍 전체 트리 (mtt8-15, mtt8-25, mtt8-40, mtt8-60, cash6-100)
  postflop/<matchup>/index.json     플랍별 요약 (리포트)
  postflop/<matchup>/<flop>/meta.json
  postflop/<matchup>/<flop>/flop.bin
  postflop/<matchup>/<flop>/t/<card>.bin   턴 카드별 (예: t/9c.bin)
```

## preflop/<format>.json

| 필드 | 설명 |
| --- | --- |
| `format` | 포맷 설정 (positions, stack, sb, bb, ante, openTo, 3벳·4벳 배수, 실현 모델 등) |
| `iterations`, `exploitabilityBb` | 반복 수, 최종 익스플로잇어빌리티 (bb) |
| `ev` | 자리별 기대값 (bb/핸드) |
| `nodes[]` | 결정 노드 |
| `terminals[]` | 터미널 `{ id, type: fold·flop·allin, pot, inv[], fold[], w }` |

결정 노드: `{ id, p, pot, inv[], fold[], call, lv, line, a, c, s, e }`

- `p`: 행동 자리 인덱스, `call`: 콜 금액, `lv`: 레이즈 단계 (0 오픈 전, 1 오픈 뒤 …)
- `a`: 액션 `[type, to, label, code]` 목록
- `c`: 액션별 자식. 숫자면 결정 노드 id, `"t12"`처럼 문자열이면 터미널 id
- `s`: 전략, 길이 A×169, 정수(÷1000 = 빈도). 인덱스 `a*169 + 클래스`
- `e`: 액션별 EV, 길이 A×169, 정수(÷100 = bb, 이 시점부터 순이익)

## postflop/<matchup>/<flop>/meta.json

| 필드 | 설명 |
| --- | --- |
| `config` | 트리 설정 (board, pot, effStack, 사이즈, 레이즈 상한…). 같은 설정으로 `buildTree` 하면 노드 순서가 같다 |
| `hands` | 슬롯 → 1326 콤보 번호 |
| `w0`, `w1` | 슬롯별 OOP·IP 시작 가중치 |
| `iterations`, `exploitabilityPct`, `evOop`, `evIp`, `eqOop` | 수렴 정보와 루트 기대값 |
| `root` | 루트·IP(체크 받음)의 액션 빈도·EV 요약 |

## flop.bin · t/<card>.bin

`buildTree(meta.config)`의 결정 노드 중 해당 스트리트 노드(flop.bin 은 플랍, t/*.bin 은 그 턴 카드의 턴 노드)를 id 순서대로 이어 붙인 것입니다. 노드마다 A = 액션 수, n = 슬롯 수일 때:

1. 전략 `uint8` A×n (÷255, 핸드별로 다시 정규화), 인덱스 `a*n + h`
2. EV `int16` 리틀 엔디언 A×n (÷100 = bb, 이 시점부터 순이익)

리버 노드는 저장하지 않습니다. `LibSpot`이 턴 끝 레인지로 리버 서브게임을 다시 풉니다(보통 1초 안팎, 익스플로잇 0.15% 목표).

## index.json

`{ matchup, pot, effStack, flops: [{ flop, iterations, exploitabilityPct, evOop, evIp, eqOop, root }] }`
