// SDK 브라우저 예제. 앱에서는 "../../dist/gto.js" 대신 패키지 경로(holdem-gto-solver)를 쓴다.
import { GtoLibrary, createSolve, browserSubPorts, byClass, estimateSolve } from "../../dist/gto.js";

const $ = (id) => document.getElementById(id);
const lib = new GtoLibrary(); // 기본 공개 라이브러리
const WORKER = new URL("../../dist/gto-sub-worker.js", import.meta.url);
const RANKS = "AKQJT98765432";
const log = (m) => ($("log").textContent = m);

function colorOf(type, i, n) {
  if (type === "fold") return "var(--fold)";
  if (type === "check" || type === "call") return "var(--call)";
  if (type === "allin") return "var(--allin)";
  return n > 1 && i % 2 === 1 ? "var(--raise2)" : "var(--raise)";
}

function renderActs(el, actions) {
  el.innerHTML = "";
  actions.forEach((a, i) => {
    const d = document.createElement("div");
    d.className = "act";
    d.innerHTML = `<span class="dot" style="background:${colorOf(a.type, i, actions.length)}"></span>${a.label} <b>${(a.freq * 100).toFixed(1)}%</b> <span class="muted">EV ${a.ev.toFixed(2)}</span>`;
    el.appendChild(d);
  });
}

/** rows: [{hand, weight, freq[]}] , actions: [{type}] */
function renderGrid(el, rows, actions) {
  const map = new Map(rows.map((r) => [r.hand, r]));
  el.innerHTML = "";
  for (let i = 0; i < 13; i++)
    for (let j = 0; j < 13; j++) {
      const label = i === j ? RANKS[i] + RANKS[j] : i < j ? RANKS[i] + RANKS[j] + "s" : RANKS[j] + RANKS[i] + "o";
      const r = map.get(label);
      const cell = document.createElement("div");
      cell.className = "cell" + (!r || r.weight < 0.01 ? " dim" : "");
      const bars = document.createElement("div");
      bars.className = "bars";
      if (r)
        r.freq.forEach((f, k) => {
          const b = document.createElement("div");
          b.style.width = `${f * 100}%`;
          b.style.background = colorOf(actions[k].type, k, actions.length);
          bars.appendChild(b);
        });
      cell.appendChild(bars);
      const s = document.createElement("span");
      s.textContent = label;
      cell.appendChild(s);
      cell.title = r ? `${label}: ` + actions.map((a, k) => `${a.label} ${(r.freq[k] * 100).toFixed(0)}%`).join(", ") : label;
      el.appendChild(cell);
    }
}

// 1) 프리플랍
for (const f of lib.formats()) $("pf-format").add(new Option(f.name, f.id, f.id === "mtt8-40", f.id === "mtt8-40"));
async function showPreflop() {
  const codes = $("pf-codes").value.split(",").map((s) => s.trim()).filter(Boolean);
  try {
    const v = await lib.preflopNode($("pf-format").value, codes);
    if (v.kind === "terminal") {
      $("pf-title").textContent = `${v.line} → ${v.terminalType} (팟 ${v.pot}bb)${v.matchup ? ` · 포스트플랍 라이브러리: ${v.matchup.name}` : ""}`;
      $("pf-acts").innerHTML = "";
      $("pf-grid").innerHTML = "";
      return;
    }
    $("pf-title").textContent = `${v.position} 차례 · ${v.line || "시작"} · 팟 ${v.pot}bb · 다음 코드: ${v.actions.map((a) => a.code).join(", ")}`;
    renderActs($("pf-acts"), v.actions);
    renderGrid($("pf-grid"), v.hands, v.actions);
  } catch (e) {
    $("pf-title").textContent = String(e.message ?? e);
  }
}
$("pf-go").onclick = showPreflop;

// 2) 포스트플랍 라이브러리
for (const m of lib.matchups()) $("pl-match").add(new Option(m.name, m.id));
async function loadFlops() {
  const flops = await lib.flops($("pl-match").value);
  $("pl-flop").innerHTML = "";
  for (const f of flops) $("pl-flop").add(new Option(f, f));
}
$("pl-match").onchange = loadFlops;
$("pl-go").onclick = async () => {
  try {
    const spot = await lib.spot($("pl-match").value, $("pl-flop").value);
    const v = await spot.view([]);
    $("pl-title").textContent = `${v.player === 0 ? "OOP" : "IP"} 차례 · 팟 ${v.pot}bb · 레인지 에퀴티 ${(v.rangeEquity * 100).toFixed(1)}%`;
    renderActs($("pl-acts"), v.actions);
  } catch (e) {
    $("pl-title").textContent = String(e.message ?? e);
  }
};

// 3) 커스텀 솔브
let session = null;
$("cs-threads").value = Math.max(1, (navigator.hardwareConcurrency || 4) - 1);
async function solveAndShow() {
  const t0 = performance.now();
  const m = await session.run({
    targetExploitability: 0.5,
    maxIterations: 300,
    checkEvery: 10,
    onProgress: (x) => {
      $("cs-status").textContent = `반복 ${x.iterations} · 익스플로잇 ${x.exploitabilityPct.toFixed(2)}% · ${((performance.now() - t0) / 1000).toFixed(1)}초`;
      $("cs-bar").style.width = `${Math.min(100, (0.5 / Math.max(0.5, x.exploitabilityPct)) * 100)}%`;
    }
  });
  const v = await session.view([]);
  renderActs(
    $("cs-acts"),
    v.node.actions.map((a, i) => ({ ...a, freq: v.analysis.actionFreq[i], ev: v.analysis.actionEv[i] }))
  );
  renderGrid($("cs-grid"), byClass(v, session.combos), v.node.actions);
  $("cs-lock").disabled = false;
  return m;
}
$("cs-go").onclick = async () => {
  session?.close();
  const spec = { board: $("cs-board").value.trim(), pot: Number($("cs-pot").value), stack: Number($("cs-stack").value), oopRange: $("cs-oop").value, ipRange: $("cs-ip").value, preset: $("cs-preset").value };
  const est = estimateSolve(spec);
  log(`트리 결정 노드 ${est.decisionNodes}개 · 핸드 ${est.hands}개 · 메모리 약 ${(est.bytes / 1048576).toFixed(0)}MB`);
  session = await createSolve({ ...spec, ports: browserSubPorts(WORKER, Number($("cs-threads").value)) });
  await solveAndShow();
};
$("cs-lock").onclick = async () => {
  const v = await session.view([]);
  await session.lock([], v.node.actions.map((a) => (a.type === "check" ? 1 : 0)));
  $("cs-status").textContent = "잠금 뒤 다시 푸는 중…";
  await solveAndShow();
  const ip = await session.view([{ kind: "action", index: v.node.actions.findIndex((a) => a.type === "check") }]);
  log(`잠금 뒤 IP(체크 받음): ` + ip.node.actions.map((a, i) => `${a.label} ${(ip.analysis.actionFreq[i] * 100).toFixed(1)}%`).join(" / "));
};

showPreflop();
loadFlops();
