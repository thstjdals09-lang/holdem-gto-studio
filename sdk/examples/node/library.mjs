// 라이브러리 조회와 핸드 분석 (Node): node examples/node/library.mjs
import { GtoLibrary } from "../../dist/gto-node.js";

const lib = new GtoLibrary(); // 공개 라이브러리. 로컬 사본은 { baseUrl: "file:///.../lib/", fetch: fileFetch }

// 1) 프리플랍: 25bb 에서 CO 2bb 오픈을 받은 BTN
const v = await lib.preflopNode("mtt8-25", ["F", "F", "F", "F", "R2"]);
console.log(`[${v.format}] ${v.position} 차례 · ${v.line} · 콜 금액 ${v.toCall}bb`);
for (const a of v.actions) console.log(`  ${a.label.padEnd(10)} ${(a.freq * 100).toFixed(1).padStart(5)}%  EV ${a.ev.toFixed(2)}bb`);
for (const h of ["AA", "AJs", "KQo", "66", "A5s"]) {
  const r = v.hands.find((x) => x.hand === h);
  console.log(`  ${h.padEnd(4)} ` + v.actions.map((a, i) => `${a.code} ${(r.freq[i] * 100).toFixed(0)}%`).join(" · "));
}

// 2) 포스트플랍 라이브러리: 40bb BTN vs BB, K72 플랍 루트
const spot = await lib.spot("m40-btn-bb", "Ks7d2c");
const root = await spot.view([]);
console.log(`\n[m40-btn-bb Ks7d2c] ${root.player === 0 ? "BB" : "BTN"} 차례 · 팟 ${root.pot}bb`);
for (const a of root.actions) console.log(`  ${a.label.padEnd(10)} ${(a.freq * 100).toFixed(1).padStart(5)}%  EV ${a.ev.toFixed(2)}bb`);

// 3) 핸드 히스토리 분석
const hh = `PokerStars Hand #250000100001: Tournament #3600000001, $10+$1 USD Hold'em No Limit - Level VIII (200/400) - 2026/10/20 21:10:00 ET
Table '3600000001 1' 8-max Seat #6 is the button
Seat 1: Ann (16000 in chips)
Seat 2: Ben (16000 in chips)
Seat 3: Cal (16000 in chips)
Seat 4: Dan (16000 in chips)
Seat 5: Eve (16000 in chips)
Seat 6: Hero (16000 in chips)
Seat 7: Gus (16000 in chips)
Seat 8: Hal (16000 in chips)
Ann: posts the ante 50
Ben: posts the ante 50
Cal: posts the ante 50
Dan: posts the ante 50
Eve: posts the ante 50
Hero: posts the ante 50
Gus: posts the ante 50
Hal: posts the ante 50
Gus: posts small blind 200
Hal: posts big blind 400
*** HOLE CARDS ***
Dealt to Hero [Ah Qd]
Ann: folds
Ben: folds
Cal: folds
Dan: folds
Eve: folds
Hero: raises 480 to 880
Gus: folds
Hal: calls 480
*** FLOP *** [Kh 7s 2d]
Hal: checks
Hero: bets 780
Hal: calls 780
*** TURN *** [Kh 7s 2d] [5c]
Hal: checks
Hero: bets 2590
Hal: folds
Uncalled bet (2590) returned to Hero
Hero collected 3920 from pot
*** SUMMARY ***`;
const res = await lib.analyzeHands(hh);
for (const { hand, format, analysis } of res.hands) {
  console.log(`\n#${hand.id} ${analysis.position} ${analysis.cards} (${format}) ${analysis.note ?? ""}`);
  for (const d of analysis.decisions) console.log(`  ${d.label.padEnd(28)} 선택 ${d.chosen} · 최선 ${d.best} · EV 손실 ${d.evLoss.toFixed(2)}bb · ${d.verdict}`);
}
