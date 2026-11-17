// 전략 자료 연결: 원본 프리플랍 JSON 을 검증하고, 핸드의 조건(인원·블라인드·앤티·스택·베팅 경로)이 자료와 정확히 같을 때만 쓴다.
// 가까운 스택·가까운 베팅 크기로 바꾸지 않는다. 맞지 않으면 그 이유를 돌려준다.
// 자료 해석(원본 코드 대조): s[a*169+c]/1000 = 빈도, e[a*169+c]/100 = 그 노드에서 폴드 = 0 기준 EV(BB),
// a[i][1] = 이 액션 뒤 그 자리의 프리플랍 누적 투자액(블라인드 포함, 앤티 제외). 자료의 stack 은 앤티를 낸 뒤 남은 스택이다
// (ring.ts: stackLeft = cfg.stack − invested, 앤티는 팟에만 더함).
import { NUM_CLASSES } from "../engine/cards";
import { CLASS_N, type PfLib, type PfLibNode, type PfLibTerminal } from "../lib/preflopLib";
import provenance from "./provenance.json";
import type { NormalizedAction } from "./types";
import type { DecisionView } from "./knowledge";
import { sha256Hex } from "./hand-history";

export const TOL_BB = 0.005;
export const MTT_DEPTHS = [6, 10, 15, 25, 40, 60];
export interface LoadedLibrary {
  id: string;
  lib: PfLib;
  sha256: string;
  bytes: number;
  manifestSha: string | null;
  manifestMatch: boolean | null;
}
export type LibraryLoader = (id: string) => Promise<LoadedLibrary>;
type Manifest = { files: Record<string, { sha256: string }> };

/** 자료 구조 검사. 문제 목록이 비어 있어야 쓴다 */
export function validateLibrary(raw: unknown, id: string): string[] {
  const p: string[] = [];
  const lib = raw as PfLib & { classes?: number };
  if (!lib || typeof lib !== "object" || !lib.format || !Array.isArray(lib.nodes) || !Array.isArray(lib.terminals)) return ["자료 형식이 아닙니다 (format·nodes·terminals 필요)"];
  if (lib.format.id !== id) p.push(`format.id ${lib.format.id} 이 파일 이름 ${id} 와 다릅니다`);
  if (lib.classes !== undefined && lib.classes !== NUM_CLASSES) p.push("169 핸드 클래스 자료가 아닙니다");
  const N = lib.format.positions?.length ?? 0;
  if (N < 2 || N > 8) p.push("자리 수가 2~8 이 아닙니다");
  if (!(lib.iterations > 0) || !Number.isFinite(lib.exploitabilityBb)) p.push("반복 수·익스플로잇 값이 없습니다");
  lib.nodes.forEach((n: PfLibNode, i: number) => {
    if (p.length > 20) return;
    const A = n.a?.length ?? 0;
    if (n.id !== i) p.push(`노드 ${i}: id 가 ${n.id}`);
    if (!(n.p >= 0 && n.p < N)) p.push(`노드 ${i}: 행동 자리 ${n.p} 가 범위 밖`);
    if (!A || n.c?.length !== A || n.s?.length !== A * NUM_CLASSES || n.e?.length !== A * NUM_CLASSES) {
      p.push(`노드 ${i}: 액션·자식·전략·EV 배열 길이가 맞지 않습니다`);
      return;
    }
    for (let c = 0; c < NUM_CLASSES; c++) {
      let sum = 0;
      for (let a = 0; a < A; a++) {
        const v = n.s[a * NUM_CLASSES + c];
        if (!Number.isInteger(v) || v < 0 || v > 1000) {
          p.push(`노드 ${i}: 빈도 값 ${v} 이 0~1000 정수가 아닙니다`);
          return;
        }
        if (!Number.isFinite(n.e[a * NUM_CLASSES + c])) {
          p.push(`노드 ${i}: EV 값이 숫자가 아닙니다`);
          return;
        }
        sum += v;
      }
      if (Math.abs(sum - 1000) > A) {
        p.push(`노드 ${i} 클래스 ${c}: 빈도 합 ${sum} ≠ 1000`);
        return;
      }
    }
    for (const x of n.a) if (!["fold", "check", "call", "raise", "allin"].includes(x[0]) || !Number.isFinite(x[1])) p.push(`노드 ${i}: 알 수 없는 액션 ${x[0]}`);
    for (const ch of n.c) {
      if (typeof ch === "number") {
        if (!(ch > i && ch < lib.nodes.length)) p.push(`노드 ${i}: 자식 ${ch} 이 뒤쪽 노드가 아닙니다(순환·손상)`);
      } else if (!/^t\d+$/.test(ch) || !lib.terminals[Number(ch.slice(1))]) p.push(`노드 ${i}: 터미널 ${ch} 이 없습니다`);
    }
  });
  lib.terminals.forEach((t: PfLibTerminal, i: number) => {
    if (t.id !== i || !["fold", "flop", "allin"].includes(t.type) || t.inv?.length !== N || t.fold?.length !== N) p.push(`터미널 ${i} 손상`);
  });
  return p.slice(0, 20);
}

export async function loadLibraryFromText(id: string, text: string): Promise<LoadedLibrary> {
  const sha = await sha256Hex(text);
  const raw = JSON.parse(text);
  const problems = validateLibrary(raw, id);
  if (problems.length) throw new Error(`자료 ${id} 검증 실패: ${problems.slice(0, 3).join(" / ")}`);
  const m = (provenance as Manifest).files[`${id}.json`];
  return { id, lib: raw as PfLib, sha256: sha, bytes: text.length, manifestSha: m?.sha256 ?? null, manifestMatch: m ? m.sha256 === sha : null };
}

const r3 = (x: number) => Math.round(x * 1000) / 1000;
/** 이 핸드에 정확히 맞는 자료 id. 하나라도 다르면 null 과 이유 */
export function libraryCandidate(view: DecisionView): { id: string | null; reasons: string[]; conditions: string[] } {
  const reasons: string[] = [];
  const n = view.seats.length;
  const cash = n === 6;
  if (n !== 8 && n !== 6) reasons.push(`인원 ${n}명: 프리플랍 자료는 8명(토너먼트 앤티)·6명(캐시 100BB)만 있습니다`);
  const bb = view.bigBlind;
  if (!bb) {
    reasons.push("BB 크기를 몰라 BB 단위로 바꿀 수 없습니다");
    return { id: null, reasons, conditions: [] };
  }
  const sbSeat = view.order[n - 2];
  const bbSeat = view.order[n - 1];
  const f = (seat: number, kind: string) => view.forced.filter((x) => x.seat === seat && x.kind === kind).reduce((a, x) => a + x.amount, 0) / bb;
  if (n === 2) reasons.push("헤즈업 자료가 없습니다");
  if (Math.abs(f(sbSeat, "sb") - 0.5) > TOL_BB || Math.abs(f(bbSeat, "bb") - 1) > TOL_BB) reasons.push(`블라인드 ${r3(f(sbSeat, "sb"))}/${r3(f(bbSeat, "bb"))}BB: 자료는 SB 0.5·BB 1`);
  const anteOf = (seat: number) => f(seat, "ante");
  const bbAnte = view.forced.some((x) => x.kind === "bb-ante");
  const wantAnte = cash ? 0 : 0.125;
  if (bbAnte) reasons.push("BB 앤티: 자료는 개인 앤티(자리마다 0.125BB) 기준이라 팟·BB 스택이 다릅니다");
  if (view.seats.some((s) => Math.abs(anteOf(s.seat) - wantAnte) > TOL_BB)) reasons.push(`앤티: 자료는 자리마다 ${wantAnte}BB (기록: ${[...new Set(view.seats.map((s) => r3(anteOf(s.seat))))].join("·")}BB)`);
  const behind = view.seats.map((s) => r3(s.start / bb - anteOf(s.seat)));
  const depth = behind[0];
  const depths = cash ? [100] : MTT_DEPTHS;
  if (behind.some((x) => Math.abs(x - depth) > TOL_BB)) reasons.push(`스택이 같지 않습니다 (앤티 뒤 ${view.seats.map((s, i) => `${s.position} ${behind[i]}`).join(", ")}BB). 자료는 전원 같은 스택이고 불균등 스택을 하나로 줄이지 않습니다`);
  else if (!depths.some((d) => Math.abs(d - depth) <= TOL_BB)) reasons.push(`앤티 뒤 스택 ${depth}BB 는 자료 깊이(${depths.join("·")}BB)에 없습니다. 가까운 깊이로 바꾸지 않습니다`);
  const id = reasons.length ? null : cash ? "cash6-100" : `mtt8-${Math.round(depth)}`;
  const conditions = id ? [`${n}명`, "SB 0.5BB · BB 1BB", cash ? "앤티 없음" : "개인 앤티 0.125BB", `앤티 뒤 스택 전원 ${Math.round(depth)}BB`, `금액 허용 오차 ±${TOL_BB}BB (표시 반올림용)`] : [];
  return { id, reasons, conditions };
}

export interface PreflopWalk {
  ok: boolean;
  reasons: string[];
  node: PfLibNode | null;
  terminal: PfLibTerminal | null;
  reach: Float64Array[];
  steps: Array<{ p: number; label: string; massBefore: number; massAfter: number }>;
  /** 내 액션을 자료 액션 번호로 (없으면 -1) */
  actualIndex: number;
}

function matchAction(node: PfLibNode, a: NormalizedAction, bb: number): number {
  const ok = node.a
    .map((x, i) => ({ x, i }))
    .filter(({ x }) => {
      if (a.type === "fold") return x[0] === "fold";
      if (a.type === "check") return x[0] === "check";
      if (a.type === "call") return x[0] === "call";
      return (x[0] === "raise" || x[0] === "allin") && Math.abs(x[1] - a.to / bb) <= TOL_BB;
    });
  return ok.length === 1 ? ok[0].i : -1;
}

/** 프리플랍 액션을 자료 트리로 따라가며 자리별 reach 를 관측 액션의 빈도로 조건화한다 */
export function walkPreflop(lib: PfLib, view: DecisionView, actions: NormalizedAction[]): PreflopWalk {
  const N = lib.format.positions.length;
  const bb = view.bigBlind!;
  const reach = Array.from({ length: N }, () => Float64Array.from(CLASS_N));
  const steps: PreflopWalk["steps"] = [];
  const reasons: string[] = [];
  let node: PfLibNode | null = lib.nodes[0];
  let terminal: PfLibTerminal | null = null;
  const name = (p: number) => lib.format.positions[p];
  for (const a of actions) {
    if (a.street !== "preflop") break;
    if (!node) {
      reasons.push(`${a.position} ${a.type}: 자료 트리가 이미 끝났습니다`);
      break;
    }
    const p = view.order.indexOf(a.seat);
    if (p !== node.p) {
      reasons.push(`자료 트리 차례는 ${name(node.p)} 인데 기록은 ${a.position} 입니다`);
      break;
    }
    const ai = matchAction(node, a, bb);
    if (ai < 0) {
      reasons.push(`${a.position} ${a.type}${a.type === "raise" || a.type === "bet" ? ` ${r3(a.to / bb)}BB` : ""} 는 자료 트리에 없습니다 (이 노드의 액션: ${node.a.map((x) => x[2]).join(", ")}). 가까운 크기로 바꾸지 않습니다`);
      break;
    }
    let before = 0;
    let after = 0;
    for (let c = 0; c < NUM_CLASSES; c++) {
      before += reach[p][c];
      reach[p][c] *= node.s[ai * NUM_CLASSES + c] / 1000;
      after += reach[p][c];
    }
    steps.push({ p, label: `${name(p)} ${node.a[ai][2]}`, massBefore: before, massAfter: after });
    const ch: number | string = node.c[ai];
    if (typeof ch === "string") {
      terminal = lib.terminals[Number(ch.slice(1))];
      node = null;
    } else node = lib.nodes[ch];
  }
  return { ok: reasons.length === 0, reasons, node, terminal, reach, steps, actualIndex: -1 };
}

export { matchAction };
