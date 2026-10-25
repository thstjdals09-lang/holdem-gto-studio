// 커스텀 플랍 솔브 (Node, 병렬): node examples/node/solve.mjs
// 40bb 토너먼트 BTN 오픈 vs BB 콜 레인지를 라이브러리에서 가져와 K72 플랍을 푼다.
import { GtoLibrary, createSolve, nodeSubPorts, byClass, NUM_CLASSES, classLabel } from "../../dist/gto-node.js";

const lib = new GtoLibrary(); // 기본: 공개 라이브러리 (GitHub Pages)

// 1) 프리플랍 라이브러리에서 플랍 직전 레인지 가져오기 (BTN 2.2bb 오픈, SB 폴드, BB 콜)
const node = await lib.preflopNode("mtt8-40", ["F", "F", "F", "F", "F", "R2.2", "F", "C"]);
console.log(`프리플랍 라인: ${node.line} → ${node.terminalType}, 팟 ${node.pot}bb, 매치업 ${node.matchup?.name ?? "-"}`);
const toText = (w) =>
  Array.from({ length: NUM_CLASSES }, (_, c) => (w[c] > 0.004 ? `${classLabel(c)}:${w[c].toFixed(3)}` : null))
    .filter(Boolean)
    .join(",");

// 2) 병렬 커스텀 솔브 (코어 수 − 1 개 워커)
const ports = nodeSubPorts();
const session = await createSolve({
  board: "Ks7d2c",
  pot: node.pot,
  stack: 40 - 2.2,
  oopRange: toText(node.ranges.BB),
  ipRange: toText(node.ranges.BTN),
  preset: "simple",
  ports
});
console.log(`핸드 ${session.hands}개, 워커 ${session.threads}개로 풉니다…`);
const t0 = Date.now();
const m = await session.run({
  targetExploitability: 0.5,
  maxIterations: 60,
  checkEvery: 10,
  onProgress: (x) => console.log(`  반복 ${x.iterations} · 익스플로잇 ${x.exploitabilityPct.toFixed(2)}% · ${((Date.now() - t0) / 1000).toFixed(0)}초`)
});
console.log(`완료: 익스플로잇 ${m.exploitabilityPct.toFixed(2)}% (팟 대비), OOP EV ${m.evOop.toFixed(2)}bb`);

// 3) 루트(BB) → BB 체크 뒤 BTN 의 전략
const root = await session.view([]);
const x = root.node.actions.findIndex((a) => a.type === "check");
const ip = await session.view([{ kind: "action", index: x }]);
console.log(`BB: ${root.node.actions.map((a, i) => `${a.label} ${(root.analysis.actionFreq[i] * 100).toFixed(1)}%`).join(" / ")}`);
console.log(`BTN(체크 받음): ${ip.node.actions.map((a, i) => `${a.label} ${(ip.analysis.actionFreq[i] * 100).toFixed(1)}%`).join(" / ")}`);

// 4) 핸드 클래스별 BTN 전략 (13×13 그리드에 쓰는 형태)
const rows = byClass(ip, session.combos);
const bet = ip.node.actions.findIndex((a) => a.type === "bet");
for (const hand of ["AA", "AKo", "KQs", "77", "T9s", "A5s", "J4o"]) {
  const r = rows.find((x) => x.hand === hand);
  if (r) console.log(`  ${hand.padEnd(4)} 벳 ${(r.freq[bet] * 100).toFixed(0).padStart(3)}% · 에퀴티 ${(r.equity * 100).toFixed(0)}% · EQR ${r.eqr.toFixed(2)}`);
}

session.close();
