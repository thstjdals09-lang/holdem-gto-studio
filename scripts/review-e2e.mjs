// 복기 앱 전체 흐름 시험: 별도 임시 프로필의 헤드리스 크롬을 DevTools 프로토콜로 움직인다 (추가 패키지 없음).
// 사용: (앱을 띄운 뒤) node scripts/review-e2e.mjs [주소] [결과 폴더]
//   기본 주소 http://localhost:4189/review.html (npm run review:preview), 크롬 경로는 CHROME 환경 변수로 바꿀 수 있다.
// 세로 휴대폰(390×844)에서 가져오기 → 재생 → 분석 → 보고서 저장 → 새로고침 뒤 유지, 가로(844×390) 화면,
// 양식 편집기 입력, 루루 기록 보완, 가져온 문자열의 안전한 표시, 다른 핸드 선택 시 이전 계산 폐기를 확인한다.
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const url = process.argv[2] ?? "http://localhost:4189/review.html";
const outDir = resolve(process.argv[3] ?? "e2e-out");
const chromePath = process.env.CHROME ?? "C:/Program Files/Google/Chrome/Application/chrome.exe";
mkdirSync(outDir, { recursive: true });
for (const f of readdirSync(outDir)) if (f.endsWith(".json") && f.startsWith("review-")) rmSync(join(outDir, f));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const profile = mkdtempSync(join(tmpdir(), "review-e2e-"));
const port = 9300 + Math.floor(Math.random() * 400);
const chrome = spawn(chromePath, ["--headless=new", `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, "--no-first-run", "--no-default-browser-check", "about:blank"], { stdio: "ignore" });

const checks = [];
const errors = [];
const check = (name, ok, detail = "") => {
  checks.push({ name, ok: !!ok, detail });
  console.log(`${ok ? "통과" : "실패"} · ${name}${detail ? ` — ${detail}` : ""}`);
};

async function json(path) {
  for (let i = 0; i < 150; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}${path}`);
      if (r.ok) return r.json();
    } catch {
      /* 아직 안 떴다 */
    }
    await sleep(100);
  }
  throw new Error("크롬 디버깅 포트에 붙지 못했습니다");
}

let ws;
let seq = 0;
const pending = new Map();
const send = (method, params = {}) =>
  new Promise((res, rej) => {
    const id = ++seq;
    pending.set(id, (d) => (d.error ? rej(new Error(`${method}: ${d.error.message}`)) : res(d.result)));
    ws.send(JSON.stringify({ id, method, params }));
  });
async function ev(expr) {
  const r = await send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
  return r.result.value;
}
const HELPERS = `window.__t = {
  btn(text, within) { const root = within ? document.querySelector(within) : document; const b = [...root.querySelectorAll('button')].find((x) => x.textContent.trim().startsWith(text) && !x.disabled); if (!b) throw new Error('버튼 없음: ' + text); b.click(); return true; },
  has(text) { return document.body.innerText.includes(text); },
  label(el) { const lab = el.closest('label'); return el.getAttribute('aria-label') || (lab ? [...lab.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent).join('').trim() : ''); },
  set(name, value) { const el = [...document.querySelectorAll('input,textarea,select')].find((e) => this.label(e) === name); if (!el) throw new Error('입력 없음: ' + name); const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : el.tagName === 'SELECT' ? HTMLSelectElement.prototype : HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, value); el.dispatchEvent(new Event(el.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true })); return true; },
  overflow() { return document.documentElement.scrollWidth - window.innerWidth; }
};`;
async function waitText(text, ms = 20000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (await ev(`document.body.innerText.includes(${JSON.stringify(text)})`)) return true;
    await sleep(100);
  }
  return false;
}
async function load() {
  await send("Page.navigate", { url });
  for (let i = 0; i < 100 && !(await ev("document.readyState === 'complete' && !!document.querySelector('h1')").catch(() => false)); i++) await sleep(100);
  await ev(HELPERS);
}
const click = async (text, within) => {
  await ev(`__t.btn(${JSON.stringify(text)}, ${JSON.stringify(within ?? null)})`);
  await sleep(120);
};
const setv = async (name, value) => {
  await ev(`__t.set(${JSON.stringify(name)}, ${JSON.stringify(value)})`);
  await sleep(60);
};
async function shot(name) {
  const r = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
  writeFileSync(join(outDir, name), Buffer.from(r.data, "base64"));
}
const portrait = () => send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 2, mobile: true, screenOrientation: { type: "portraitPrimary", angle: 0 } });
const landscape = () => send("Emulation.setDeviceMetricsOverride", { width: 844, height: 390, deviceScaleFactor: 2, mobile: true, screenOrientation: { type: "landscapePrimary", angle: 90 } });

try {
  const list = await json("/json/list");
  const page = list.find((t) => t.type === "page");
  ws = new WebSocket(page.webSocketDebuggerUrl);
  ws.onmessage = (m) => {
    const d = JSON.parse(m.data);
    if (d.id && pending.has(d.id)) {
      pending.get(d.id)(d);
      pending.delete(d.id);
    } else if (d.method === "Runtime.exceptionThrown") errors.push(d.params.exceptionDetails.exception?.description ?? d.params.exceptionDetails.text);
    else if (d.method === "Runtime.consoleAPICalled" && d.params.type === "error") errors.push(d.params.args.map((a) => a.value ?? a.description).join(" "));
  };
  await new Promise((r) => (ws.onopen = r));
  await send("Page.enable");
  await send("Runtime.enable");
  await send("Browser.setDownloadBehavior", { behavior: "allow", downloadPath: outDir });
  await portrait();
  await load();
  check("앱이 열린다", await ev("__t.has('핸드 복기')"));

  // ---- 가져오기(붙여넣기) → 재생 → 분석 → 저장 (세로) ----
  const aa = readFileSync("examples/review/ex-aa-bb160-fold.json", "utf8");
  await setv("JSON 붙여넣기", aa);
  await click("붙여넣은 내용 가져오기");
  check("JSON 붙여넣기 가져오기", await waitText("핸드 1개를 가져왔습니다"));
  check("세로 화면 가로 넘침 없음(목록)", (await ev("__t.overflow()")) <= 0, `${await ev("__t.overflow()")}px`);
  await click("ex-aa-bb160-fold");
  check("핸드 선택 → 재생 화면", await waitText("재생 ·"));
  await click("끝");
  check("재생 끝: 폴드로 종료", await waitText("모두 폴드해 핸드가 끝났습니다"));
  await click("처음");
  await click("다음");
  check("한 단계씩 재생: 다음 액션 표시", await waitText("다음 액션"));
  await shot("mobile-replay.png");
  await click("판단 분석");
  await click("분석");
  check("분석 결과(자료 일치, 폴드의 EV 차이 8.78BB)", (await waitText("판정")) && (await waitText("8.78")));
  check("추가 콜 160 표시", await ev("__t.has('160')"));
  check("세로 화면 가로 넘침 없음(분석)", (await ev("__t.overflow()")) <= 0, `${await ev("__t.overflow()")}px`);
  await shot("mobile-analysis.png");
  await click("이 핸드 보고서 저장(JSON)");
  let saved = null;
  for (let i = 0; i < 50 && !saved; i++) {
    saved = readdirSync(outDir).find((f) => f === "review-ex-aa-bb160-fold.json");
    if (!saved) await sleep(100);
  }
  const rep = saved ? JSON.parse(readFileSync(join(outDir, saved), "utf8")) : null;
  check("보고서 JSON 파일 저장", rep?.schema === "holdem-review-report/1" && rep.decisions?.[0]?.status === "analyzed", saved ?? "파일 없음");

  await load();
  check("새로고침 뒤 핸드·분석 결과 유지", (await waitText("ex-aa-bb160-fold")) && (await ev("__t.has('분석됨')")));

  // ---- 가로 화면 ----
  await landscape();
  await click("ex-aa-bb160-fold");
  await click("판단 분석");
  check("가로 화면 분석 표시", await waitText("판정"));
  check("가로 화면 가로 넘침 없음", (await ev("__t.overflow()")) <= 0, `${await ev("__t.overflow()")}px`);
  await shot("landscape-analysis.png");
  await portrait();

  // ---- 양식 편집기로 새 핸드 입력 (6명 100BB, HJ 2.5BB 오픈 → 모두 폴드) ----
  await click("핸드 목록·가져오기");
  await click("새 핸드 직접 입력");
  check("편집기 열림", await waitText("새 핸드 입력"));
  await setv("내 카드 (예: AsKd)", "AsKd");
  await click("폴드"); // LJ
  check("다음 차례가 내 자리(HJ)", await waitText("다음 차례: HJ"));
  await setv("금액", "250");
  await click("레이즈");
  for (let i = 0; i < 4; i++) await click("폴드"); // CO, BTN, SB, BB
  check("편집기: 핸드 종료 인식", await waitText("핸드가 끝났습니다"));
  await shot("mobile-editor.png");
  await click("저장");
  check("편집기 저장 → 재생", await waitText("재생 ·"));
  await click("판단 분석");
  await click("분석");
  check("직접 입력 핸드가 cash6-100 자료와 일치해 분석됨", (await waitText("cash6-100")) && (await waitText("자료 EV 가 가장 큰 액션")));

  // ---- 루루 판단 기록(합성 샘플) 가져오기 → 보완 → 재생 ----
  await click("핸드 목록·가져오기");
  await click("루루 기록 샘플(합성)");
  check("루루 기록 읽기 전용 가져오기", await waitText("읽기 전용으로 가져왔습니다"));
  await click("lulu-G-synthetic:1");
  check("보완 전에는 재생되지 않음(초기 스택 없음)", await waitText("초기 스택을 모릅니다"));
  await click("편집");
  await click("이 값으로 보완해 저장");
  check("보완 뒤 재생, 관측 팟 불일치 표시", (await waitText("기록 스냅샷 대조")) && (await ev("__t.has('불일치')")));

  // ---- 가져온 문자열은 HTML 로 해석하지 않는다 ----
  const evil = JSON.parse(aa);
  evil.id = '<img src=x onerror="window.__xss=1">';
  evil.seats[0].name = "<script>window.__xss=2</script>";
  evil.notes = ['<b onmouseover="window.__xss=3">메모</b>'];
  await click("핸드 목록·가져오기");
  await setv("JSON 붙여넣기", JSON.stringify(evil));
  await click("붙여넣은 내용 가져오기");
  await click("<img");
  await sleep(300);
  check("가져온 문자열의 안전한 표시", (await ev("window.__xss === undefined && !document.querySelector('img[src=\"x\"]') && !document.querySelector('#root script')")) && (await ev("__t.has('<img src=x')")));

  // ---- 계산 중 다른 핸드를 고르면 이전 결과를 보여 주지 않는다 ----
  await click("핸드 목록·가져오기");
  await click("예제 불러오기");
  await waitText("예제 6개를 가져왔습니다");
  await ev(`(()=>{ const d=[...document.querySelectorAll('details')].find(x=>x.textContent.includes('계산 설정')); d.open = true; })()`);
  await setv("표본 수", "100000");
  await click("ex-k4o-filled");
  await click("판단 분석");
  await click("분석");
  const runningShown = await waitText("계산 중", 3000);
  await click("ex-library-25bb");
  await click("판단 분석");
  await sleep(3000);
  const libText = await ev("document.querySelector('main').innerText");
  check("계산 중 다른 핸드 선택: 이전 결과·진행 표시 없음", runningShown && libText.includes("아직 분석하지 않았습니다") && !libText.includes("128.875") && !libText.includes("계산 중"));
  await click("ex-k4o-filled");
  await click("판단 분석");
  check("취소된 핸드에는 결과가 남지 않음", await waitText("아직 분석하지 않았습니다", 3000));

  check("화면 오류 없음", errors.length === 0, errors.slice(0, 3).join(" / "));
} catch (e) {
  check("시험 진행", false, e.message);
} finally {
  try {
    await send("Browser.close");
  } catch {
    chrome.kill();
  }
  await sleep(500);
  try {
    rmSync(profile, { recursive: true, force: true });
  } catch {
    /* 크롬이 늦게 닫히면 남을 수 있다 */
  }
  const failed = checks.filter((c) => !c.ok).length;
  writeFileSync(join(outDir, "e2e-result.json"), JSON.stringify({ url, at: new Date().toISOString(), passed: checks.length - failed, failed, checks, consoleErrors: errors }, null, 2));
  console.log(`\n${checks.length - failed}/${checks.length} 통과 → ${join(outDir, "e2e-result.json")}`);
  if (!existsSync(outDir)) mkdirSync(outDir);
  process.exit(failed ? 1 : 0);
}
