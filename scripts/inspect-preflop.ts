import { readFileSync } from "node:fs";
import { NUM_CLASSES, classLabel } from "../src/engine/cards";
import { CLASS_N, walkCodes, type PfLib } from "../src/lib/preflopLib";
const id = process.argv[2] ?? "cash6-100";
const lib: PfLib = JSON.parse(readFileSync(`public/lib/preflop/${id}.json`, "utf-8"));
const P = lib.format.positions;
function report(codes: string[]) {
  const w = walkCodes(lib, codes);
  const nd = w.node!;
  const r = w.reach[nd.p];
  let tot = 0;
  for (let i = 0; i < NUM_CLASSES; i++) tot += r[i];
  const parts = nd.a.map((a, ai) => {
    let f = 0;
    for (let i = 0; i < NUM_CLASSES; i++) f += r[i] * nd.s[ai * NUM_CLASSES + i] / 1000;
    return `${a[2]} ${(100 * f / tot).toFixed(1)}%`;
  });
  const total1326 = (tot / 1326 * 100).toFixed(1);
  console.log(`${P[nd.p]} @ [${nd.line}] (도달 레인지 ${total1326}%): ${parts.join(" | ")}`);
  return nd;
}
const N = P.length;
for (let k = 0; k < N - 1; k++) report(Array(k).fill("F"));
const btn = Array(N - 3).fill("F");
const op = lib.format.openTo[N - 3];
report([...btn, `R${op}`]);
report([...btn, `R${op}`, "F"]);
report([...btn, `R${op}`, "F", "R10"].slice(0, N + 1));
// 클래스 샘플: BTN RFI
const nd = walkCodes(lib, btn).node!;
const show = ["AA", "A5s", "K9o", "Q8o", "J7s", "T8o", "97s", "75s", "54s", "22", "A2o", "K2s"];
console.log("BTN RFI 샘플:", show.map((h) => { const c = Array.from({ length: 169 }, (_, i) => i).find((i) => classLabel(i) === h)!; return `${h}:${(nd.s[1 * 169 + c] / 10).toFixed(0)}%`; }).join(" "));
const n0 = lib.nodes[0];
const utg = ["AA","AKs","AQo","AJo","ATs","A5s","KQo","KJs","T9s","76s","22","55","A9o"];
console.log("UTG RFI 샘플:", utg.map((h) => { const c = Array.from({ length: 169 }, (_, i) => i).find((i) => classLabel(i) === h)!; return `${h}:${(n0.s[1 * 169 + c] / 10).toFixed(0)}%`; }).join(" "));
console.log("EV by seat:", lib.ev.map((e, i) => `${P[i]} ${e.toFixed(3)}`).join(", "), "expl", lib.exploitabilityBb);
