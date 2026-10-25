// 실현율 맞춤: calib-realization 결과(.cache/calib/<포맷>.jsonl)로 프리플랍 터미널 모델의
// IP/OOP 실현 비율 ρ, 에퀴티 양극화 기울기 s, 플레이어빌리티 배수 k 를 포맷(=SPR)별로 맞춘다.
import { existsSync, readFileSync } from "node:fs";
import { COMBO_CLASS, NUM_CLASSES, classLabel, parseCards } from "../src/engine/cards";
import { buildHandSet } from "../src/engine/solver";
import { EquityCalc, oppMass } from "../src/engine/handeq";
import { buildCompat, playability } from "../src/engine/ring";
import { reachToCombos, walkCodes, type PfLib } from "../src/lib/preflopLib";

const n = NUM_CLASSES;
const b = readFileSync("public/lib/eq169.bin");
const eq = new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
const cp = buildCompat();
const play = Float64Array.from({ length: n }, (_, c) => playability(c));
const fids = process.argv.slice(2).length ? process.argv.slice(2) : ["mtt8-15", "mtt8-40", "cash6-100"];
const losses: Array<{ fid: string; spr: number; loss: (rho: number, slope: number, k: number) => number }> = [];

for (const fid of fids) {
  const path = `.cache/calib/${fid}.jsonl`;
  if (!existsSync(path)) continue;
  const recs = readFileSync(path, "utf-8").trim().split("\n").map((l) => JSON.parse(l));
  const lib: PfLib = JSON.parse(readFileSync(`public/lib/preflop/${fid}.json`, "utf-8"));
  const N = lib.format.positions.length;
  const btn = N - 3;
  const walk = walkCodes(lib, [...Array(btn).fill("F"), `R${lib.format.openTo[btn]}`, "F", "C"]);
  const rO = walk.reach[N - 1]; // BB (OOP)
  const rI = walk.reach[btn]; // BTN (IP)
  // 기록에 에퀴티가 없으면(구버전 측정) 플랍별로 직접 계산
  const w0 = reachToCombos(rO, 0.004);
  const w1 = reachToCombos(rI, 0.004);
  for (const r of recs) {
    if (r.oop.eqn.some((x: number) => x > 0)) continue;
    const board = parseCards(r.flop);
    const hs = buildHandSet(board, w0, w1);
    const calc = new EquityCalc(hs);
    const sw = [new Float32Array(hs.n), new Float32Array(hs.n)];
    for (let h = 0; h < hs.n; h++) {
      sw[0][h] = w0[hs.combo[h]];
      sw[1][h] = w1[hs.combo[h]];
    }
    for (const p of [0, 1]) {
      const opp = sw[1 - p];
      const S = oppMass(hs, opp);
      const e = calc.equity(board, opp);
      const key = p === 0 ? "oop" : "ip";
      const den = new Array(n).fill(0);
      const eqn = new Array(n).fill(0);
      for (let h = 0; h < hs.n; h++) {
        const w = sw[p][h] * S[h];
        if (!(w > 0)) continue;
        const c = COMBO_CLASS[hs.combo[h]];
        den[c] += w;
        eqn[c] += w * e[h];
      }
      // 측정 때의 질량(den)과 같은 기준인지 확인 후 에퀴티만 채움
      for (let c = 0; c < n; c++) r[key].eqn[c] = r[key].den[c] > 0 && den[c] > 0 ? (eqn[c] / den[c]) * r[key].den[c] : 0;
    }
  }
  const pot = recs[0].pot;
  const spr = recs[0].eff / pot;
  // 측정값: 클래스별 팟 몫과 에퀴티 (플랍 합산)
  const meas = (key: "oop" | "ip") => {
    const num = new Float64Array(n), den = new Float64Array(n), eqn = new Float64Array(n);
    for (const r of recs) for (let c = 0; c < n; c++) {
      num[c] += r[key].num[c];
      den[c] += r[key].den[c];
      eqn[c] += r[key].eqn[c];
    }
    const share = new Float64Array(n), e = new Float64Array(n);
    for (let c = 0; c < n; c++) if (den[c] > 0) {
      share[c] = num[c] / den[c] / pot;
      e[c] = eqn[c] / den[c];
    }
    return { share, e, w: den };
  };
  const mO = meas("oop");
  const mI = meas("ip");
  // 모델: 클래스 i(자기) vs 상대 레인지 rq 의 팟 몫과 에퀴티
  const model = (isIP: boolean, rq: Float64Array, rho: number, slope: number, k: number) => {
    const bSelf = isIP ? Math.sqrt(rho) : 1 / Math.sqrt(rho);
    const bOpp = isIP ? 1 / Math.sqrt(rho) : Math.sqrt(rho);
    const kS = (isIP ? 0.6 : 1.0) * k;
    const kO = (isIP ? 1.0 : 0.6) * k;
    const share = new Float64Array(n), e = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      const Ri = bSelf * (1 + kS * (play[i] - 1));
      let v = 0, m = 0, ev = 0;
      for (let j = 0; j < n; j++) {
        const w = rq[j] * cp[i * n + j];
        if (!(w > 0)) continue;
        const x = eq[i * n + j];
        const fe = Math.max(0.2, 1 + slope * (x - 0.5));
        const fo = Math.max(0.2, 1 + slope * (0.5 - x));
        const xp = (x * fe) / (x * fe + (1 - x) * fo);
        const Rj = bOpp * (1 + kO * (play[j] - 1));
        v += w * ((xp * Ri) / (xp * Ri + (1 - xp) * Rj));
        ev += w * x;
        m += w;
      }
      share[i] = m > 0 ? v / m : 0;
      e[i] = m > 0 ? ev / m : 0;
    }
    return { share, e };
  };
  // 목적함수: 실현율(EQR) 오차를 에퀴티²·질량으로 가중 (플랍 표본의 에퀴티 잡음 제거)
  const loss = (rho: number, slope: number, k: number) => {
    let L = 0, W = 0;
    for (const [isIP, meas, rq] of [[false, mO, rI], [true, mI, rO]] as const) {
      const md = model(isIP, rq, rho, slope, k);
      for (let c = 0; c < n; c++) {
        const w = meas.w[c];
        if (!(w > 0) || meas.e[c] < 0.02 || md.e[c] < 0.02) continue;
        const d = (md.share[c] / md.e[c] - meas.share[c] / meas.e[c]) * meas.e[c];
        L += w * d * d;
        W += w;
      }
    }
    return Math.sqrt(L / W);
  };
  losses.push({ fid, spr, loss });
  if (process.env.POOLED_ONLY) continue;
  let best = { rho: 1, slope: 0, k: 1, L: Infinity };
  for (const k of [0, 0.5, 1, 1.5, 2, 3])
    for (let rho = 1; rho <= 1.9001; rho += 0.05)
      for (let slope = 0; slope <= 3.0001; slope += 0.2) {
        const L = loss(rho, slope, k);
        if (L < best.L) best = { rho, slope, k, L };
      }
  // 세밀 탐색
  const c0 = { ...best };
  for (let rho = c0.rho - 0.05; rho <= c0.rho + 0.0501; rho += 0.01)
    for (let slope = Math.max(0, c0.slope - 0.2); slope <= c0.slope + 0.2001; slope += 0.04)
      for (const k of [c0.k - 0.25, c0.k, c0.k + 0.25].filter((x) => x >= 0)) {
        const L = loss(rho, slope, k);
        if (L < best.L) best = { rho, slope, k, L };
      }
  const L0 = loss(1, 0, 0);
  const totW = (m: typeof mO) => m.w.reduce((a, x) => a + x, 0);
  const avgEqr = (m: typeof mO) => { let s = 0, e = 0; for (let c = 0; c < n; c++) { s += m.w[c] * m.share[c]; e += m.w[c] * m.e[c]; } return s / e; };
  console.log(`${fid} SPR=${spr.toFixed(2)} 플랍 ${recs.length}개 | 최적 ρ=${best.rho.toFixed(2)} 기울기=${best.slope.toFixed(2)} k=${best.k} 오차=${best.L.toFixed(4)} (보정 없음 ${L0.toFixed(4)}) | 평균 EQR OOP ${avgEqr(mO).toFixed(3)} IP ${avgEqr(mI).toFixed(3)} (질량 ${totW(mO).toFixed(0)}/${totW(mI).toFixed(0)})`);
  const md = model(false, rI, best.rho, best.slope, best.k);
  const show = ["AA", "KK", "AKs", "AKo", "QJs", "T9s", "76s", "A5s", "K9o", "Q6o", "J4o", "72o", "22"];
  console.log("  BB 클래스 EQR 측정/모델:", show.map((h) => { const c = Array.from({ length: n }, (_, i) => i).find((i) => classLabel(i) === h)!; return mO.w[c] > 0 ? `${h} ${(mO.share[c] / mO.e[c]).toFixed(2)}/${(md.share[c] / md.e[c]).toFixed(2)}` : `${h} -`; }).join(" "));
}

// 통합 맞춤: 기울기·플레이어빌리티 배수는 모든 SPR 공유, IP/OOP 비율 ρ 만 SPR별
{
  const rhos: number[] = [];
  for (let r = 0.9; r <= 1.9001; r += 0.02) rhos.push(r);
  let best = { slope: 0, k: 0, L: Infinity, rho: [] as number[] };
  for (const k of (process.env.FIT_KS ?? "0,0.5,1,1.5,2,2.5,3,4").split(",").map(Number))
    for (let slope = 0; slope <= 2.0001; slope += 0.1) {
      let tot = 0;
      const rr: number[] = [];
      for (const f of losses) {
        let bl = Infinity;
        let br = 1;
        for (const r of rhos) {
          const L = f.loss(r, slope, k);
          if (L < bl) {
            bl = L;
            br = r;
          }
        }
        tot += bl * bl;
        rr.push(br);
      }
      if (tot < best.L) best = { slope, k, L: tot, rho: rr };
    }
  console.log(`통합 맞춤: 기울기=${best.slope.toFixed(2)} k=${best.k} | ` + losses.map((f, i) => `${f.fid}(SPR ${f.spr.toFixed(2)}) ρ=${best.rho[i].toFixed(2)} 오차=${f.loss(best.rho[i], best.slope, best.k).toFixed(4)} (보정 없음 ${f.loss(1, 0, 0).toFixed(4)})`).join(" | "));
  console.log("REALIZATION_TABLE = " + JSON.stringify(losses.map((f, i) => ({ spr: Number(f.spr.toFixed(2)), ratio: Number(best.rho[i].toFixed(2)), slope: Number(best.slope.toFixed(2)), play: best.k }))));
}
