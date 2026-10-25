// 미리 풀어둔 솔루션 라이브러리 (프리플랍 전체 트리 + 포스트플랍 매치업) 조회와 핸드 히스토리 분석
import { NUM_CLASSES, classLabel, comboIndex } from "../../src/engine/cards";
import { RING_FORMATS, type RingConfig } from "../../src/engine/ring";
import { walkCodes, type PfLib } from "../../src/lib/preflopLib";
import { MATCHUPS, type Matchup, type MatchupIndex } from "../../src/lib/postflopLib";
import { LibSpot, setLibraryFetch, type LibraryFetch } from "../../src/worker/libspot";
import { parseAll, type ParsedHand } from "../../src/lib/hh";
import { analyzePreflop, matchFlop, pickFormat, verdictOf, type DecisionGrade, type HandAnalysis } from "../../src/lib/analyze";

/** 공개 라이브러리 기본 주소 (CORS 허용, GitHub Pages) */
export const DEFAULT_LIBRARY_URL = "https://thstjdals09-lang.github.io/gto-studio/lib/";

export interface FormatInfo {
  id: string;
  name: string;
  players: number;
  positions: string[];
  stack: number;
  ante: number;
  openTo: number[];
}

export interface PreflopAction {
  code: string; // 경로 코드 (F, X, C, L, R2.2, A)
  label: string;
  type: string; // fold | check | call | raise | allin
  to: number; // 이 액션 뒤 이 플레이어의 총 투자 (bb)
  freq: number; // 이 노드 레인지 전체 기준 빈도 (0~1)
  ev: number; // 레인지 평균 EV (bb, 이 시점부터 순이익)
}
export interface PreflopHand {
  hand: string; // 169 클래스 이름 (AA, AKs, AKo …)
  weight: number; // 이 노드에 도달하는 비율 (0~1, 콤보 수 대비)
  freq: number[]; // 액션별 빈도
  ev: number[]; // 액션별 EV (bb)
}
export interface PreflopNodeView {
  format: string;
  kind: "decision" | "terminal";
  /** 행동할 자리 (결정 노드) */
  position?: string;
  line: string;
  pot: number;
  toCall?: number;
  actions?: PreflopAction[];
  hands?: PreflopHand[];
  /** 자리별 도달 레인지 (169 클래스, 0~1) */
  ranges: Record<string, number[]>;
  /** 터미널: fold | flop | allin */
  terminalType?: string;
  /** 플랍 터미널이 포스트플랍 라이브러리 매치업이면 그 매치업 */
  matchup?: Matchup;
}

export interface LibraryOptions {
  /** 라이브러리 루트 (끝에 / 포함). 기본 DEFAULT_LIBRARY_URL */
  baseUrl?: string;
  /** 파일을 읽을 함수. Node 에서 로컬 파일을 읽거나 인증 헤더를 붙일 때 바꾼다 */
  fetch?: LibraryFetch;
}

export interface AnalyzedHand {
  hand: ParsedHand;
  format: string;
  analysis: HandAnalysis;
}

export class GtoLibrary {
  readonly baseUrl: string;
  private fetchFn: LibraryFetch;
  private pre = new Map<string, Promise<PfLib>>();
  private idx = new Map<string, Promise<MatchupIndex | null>>();
  private spots = new Map<string, Promise<LibSpot>>();

  constructor(opts: LibraryOptions = {}) {
    this.baseUrl = opts.baseUrl ?? DEFAULT_LIBRARY_URL;
    this.fetchFn = opts.fetch ?? ((u: string) => fetch(u));
    setLibraryFetch(this.fetchFn);
  }

  /** 프리플랍 포맷 목록 */
  formats(): FormatInfo[] {
    return RING_FORMATS.map((f: RingConfig) => ({ id: f.id, name: f.name, players: f.positions.length, positions: f.positions.slice(), stack: f.stack, ante: f.ante, openTo: f.openTo.slice() }));
  }

  /** 포스트플랍 라이브러리 매치업 목록 */
  matchups(): Matchup[] {
    return MATCHUPS.map((m) => ({ ...m, codes: m.codes.slice() }));
  }

  /** 프리플랍 라이브러리 원본 JSON (포맷별 한 번만 받음) */
  preflop(formatId: string): Promise<PfLib> {
    let p = this.pre.get(formatId);
    if (!p) {
      p = this.fetchFn(`${this.baseUrl}preflop/${formatId}.json`).then((r) => {
        if (!r.ok) throw new Error(`프리플랍 라이브러리(${formatId})를 불러오지 못했습니다`);
        return r.json() as Promise<PfLib>;
      });
      p.catch(() => this.pre.delete(formatId));
      this.pre.set(formatId, p);
    }
    return p;
  }

  /**
   * 액션 코드 경로로 프리플랍 노드를 본다.
   * 예: ["F","F","F","F","F","R2.2","F"] = 8맥스에서 BTN 2.2bb 오픈, SB 폴드 → BB 차례
   */
  async preflopNode(formatId: string, codes: string[]): Promise<PreflopNodeView> {
    const lib = await this.preflop(formatId);
    const w = walkCodes(lib, codes);
    const P = lib.format.positions;
    const ranges: Record<string, number[]> = {};
    P.forEach((pos, i) => {
      const r = w.reach[i];
      ranges[pos] = Array.from({ length: NUM_CLASSES }, (_, c) => Math.round((r[c] / comboCount(c)) * 1e4) / 1e4);
    });
    const line = w.steps.map((s) => `${P[s.node.p]} ${s.node.a[s.action][2]}`).join(" · ");
    if (!w.node) {
      const t = w.terminal!;
      const m = MATCHUPS.find((x) => x.format === formatId && x.codes.length === codes.length && x.codes.every((c, i) => c === codes[i]));
      return { format: formatId, kind: "terminal", line, pot: t.pot, ranges, terminalType: t.type, matchup: m ? { ...m } : undefined };
    }
    const nd = w.node;
    const A = nd.a.length;
    const reach = w.reach[nd.p];
    let tot = 0;
    for (let c = 0; c < NUM_CLASSES; c++) tot += reach[c];
    const actions: PreflopAction[] = nd.a.map((a, ai) => {
      let f = 0;
      let e = 0;
      for (let c = 0; c < NUM_CLASSES; c++) {
        const x = (reach[c] * nd.s[ai * NUM_CLASSES + c]) / 1000;
        f += x;
        e += (x * nd.e[ai * NUM_CLASSES + c]) / 100;
      }
      return { code: a[3], label: a[2], type: a[0], to: a[1], freq: tot > 0 ? f / tot : 0, ev: f > 0 ? e / f : 0 };
    });
    const hands: PreflopHand[] = [];
    for (let c = 0; c < NUM_CLASSES; c++) {
      hands.push({
        hand: classLabel(c),
        weight: ranges[P[nd.p]][c],
        freq: Array.from({ length: A }, (_, ai) => nd.s[ai * NUM_CLASSES + c] / 1000),
        ev: Array.from({ length: A }, (_, ai) => nd.e[ai * NUM_CLASSES + c] / 100)
      });
    }
    return { format: formatId, kind: "decision", position: P[nd.p], line: nd.line, pot: nd.pot, toCall: nd.call, actions, hands, ranges };
  }

  /** 매치업 리포트 인덱스 (플랍별 첫 액션 빈도·EV·에퀴티) */
  index(matchupId: string): Promise<MatchupIndex | null> {
    let p = this.idx.get(matchupId);
    if (!p) {
      p = this.fetchFn(`${this.baseUrl}postflop/${matchupId}/index.json`)
        .then((r) => (r.ok ? (r.json() as Promise<MatchupIndex>) : null))
        .catch(() => null);
      this.idx.set(matchupId, p);
    }
    return p;
  }

  /** 실제로 생성된 플랍 목록 */
  async flops(matchupId: string): Promise<string[]> {
    return (await this.index(matchupId))?.flops.map((f) => f.flop) ?? [];
  }

  /**
   * 포스트플랍 스팟. spot.view(path) 로 플랍·턴(저장된 솔루션)·리버(즉석 재솔브) 노드를 본다.
   * path 는 [{kind:"action",index}, {kind:"card",card}] 의 배열.
   */
  spot(matchupId: string, flop: string): Promise<LibSpot> {
    const key = `${matchupId}/${flop}`;
    let p = this.spots.get(key);
    if (!p) {
      p = LibSpot.load(this.baseUrl, matchupId, flop);
      p.catch(() => this.spots.delete(key));
      this.spots.set(key, p);
      if (this.spots.size > 12) {
        const first = this.spots.keys().next().value;
        if (first !== undefined && first !== key) this.spots.delete(first);
      }
    }
    return p;
  }

  /**
   * 핸드 히스토리(PokerStars·GGPoker 텍스트)를 분석한다.
   * 프리플랍은 포맷 라이브러리로, 라이브러리 매치업·플랍(수트 대칭 포함)이면 플랍·턴·리버까지 채점한다.
   * format 을 주지 않으면 토너먼트는 유효 스택에 가장 가까운 깊이, 캐시는 cash6-100.
   */
  async analyzeHands(text: string, opts: { format?: string; postflop?: boolean } = {}): Promise<{ hands: AnalyzedHand[]; skipped: number }> {
    const { hands, skipped } = parseAll(text);
    const ids = this.formats().map((f) => f.id);
    const avail = new Map<string, string[]>();
    for (const m of MATCHUPS) avail.set(m.id, await this.flops(m.id));
    const flopsOf = (id: string) => avail.get(id) ?? [];
    const out: AnalyzedHand[] = [];
    for (const h of hands) {
      if (!h.hero || !h.heroCards) continue;
      const format = opts.format ?? pickFormat(h, ids);
      const lib = await this.preflop(format);
      const res = analyzePreflop(h, lib, flopsOf);
      out.push({ hand: h, format, analysis: res.analysis });
      if (opts.postflop === false || !res.analysis.libFlop || !res.analysis.matchup) continue;
      const m = MATCHUPS.find((x) => x.id === res.analysis.matchup)!;
      const mf = matchFlop(h.board.slice(0, 3), flopsOf(m.id));
      if (!mf) continue;
      const roleOf = (name: string) => {
        const i = res.seatOf.get(name);
        if (i === undefined) return -1;
        const pos = lib.format.positions[i];
        return pos === m.oop ? 0 : pos === m.ip ? 1 : -1;
      };
      const heroRole = roleOf(h.hero) as 0 | 1;
      const items: Array<{ kind: "card"; card: number } | { kind: "action"; actor: 0 | 1; type: "fold" | "check" | "call" | "bet" | "raise"; amount: number; allin: boolean }> = [];
      (["flop", "turn", "river"] as const).forEach((st, si) => {
        if (si > 0) {
          const c = h.board[2 + si];
          if (c === undefined) return;
          items.push({ kind: "card", card: mf.map(c) });
        }
        for (const a of h.streets[st]) {
          const r = roleOf(a.player);
          if (r < 0) continue;
          items.push({ kind: "action", actor: r as 0 | 1, type: a.type, amount: a.amount, allin: a.allin });
        }
      });
      try {
        const spot = await this.spot(m.id, mf.flop);
        const r = await spot.analyzeLine(heroRole, comboIndex(mf.map(h.heroCards[0]), mf.map(h.heroCards[1])), items);
        for (const g of r.grades) {
          const dg: DecisionGrade = {
            street: g.street,
            label: `${g.street === "flop" ? "플랍" : g.street === "turn" ? "턴" : "리버"} · 팟 ${g.pot.toFixed(1)}`,
            chosen: g.chosen,
            best: g.best,
            freq: g.freq,
            evLoss: g.evLoss,
            verdict: verdictOf(g.evLoss, g.freq, g.pot, g.street),
            options: g.options,
            link: { fmt: lib.format.id, pf: res.pfPath, fl: mf.flop, pp: g.path }
          };
          res.analysis.decisions.push(dg);
        }
        if (r.note) res.analysis.note = r.note;
      } catch (e) {
        res.analysis.note = e instanceof Error ? e.message : String(e);
      }
      res.analysis.postflopPending = false;
    }
    return { hands: out, skipped };
  }
}

function comboCount(c: number): number {
  // 169 클래스 순서: classLabel 로 페어(6)·수딧(4)·오프수트(12) 판별
  const l = classLabel(c);
  return l.length === 2 ? 6 : l.endsWith("s") ? 4 : 12;
}
