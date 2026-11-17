// 완료 핸드 편집기. 액션은 재구성 엔진이 알려 주는 '다음 차례'에 맞춰 넣고, 금액은 추가액/목표액을 골라 적는다.
import { useMemo, useState } from "react";
import { completeLuluHand, normCard, validateHand } from "../hand-history";
import { positionNames, replay } from "../replay-state";
import { HAND_SCHEMA, STREET_KO, type ActionRecord, type ForcedBet, type HandRecord } from "../types";
import { Notes, fmt } from "./common";
import { actText } from "./Replay";

interface Draft {
  id: string;
  unit: "chips" | "bb";
  bigBlind: string;
  complete: boolean;
  seats: Array<{ seat: number; name: string; stack: string }>;
  button: number;
  hero: number;
  heroCards: string;
  sb: string;
  bb: string;
  anteKind: "none" | "ante" | "bb-ante";
  ante: string;
  forcedOverride: ForcedBet[] | null;
  actions: ActionRecord[];
  flop: string;
  turn: string;
  river: string;
  showdown: Record<string, string>;
  tKind: "none" | "standard" | "satellite";
  payouts: string;
  others: string;
  payoutUnit: string;
  ranges: Record<string, string>;
  keep: Pick<HandRecord, "source" | "missing" | "notes" | "snapshots">;
}

const num = (s: string): number | null => (s.trim() === "" ? null : Number(s.replace(/,/g, "")));
const nums = (s: string) => s.split(/[\s,]+/).filter(Boolean).map(Number);
function cardsOf(s: string): string[] | null {
  const t = s.replace(/[\s,]+/g, "");
  if (!t) return [];
  if (t.length % 2) return null;
  const out: string[] = [];
  for (let i = 0; i < t.length; i += 2) {
    const c = normCard(t.slice(i, i + 2));
    if (!c) return null;
    out.push(c);
  }
  return out;
}

export function newDraft(): Draft {
  return {
    id: `hand-${Date.now().toString(36)}`,
    unit: "chips",
    bigBlind: "100",
    complete: true,
    seats: Array.from({ length: 6 }, (_, i) => ({ seat: i + 1, name: "", stack: "10000" })),
    button: 6,
    hero: 4,
    heroCards: "",
    sb: "50",
    bb: "100",
    anteKind: "none",
    ante: "",
    forcedOverride: null,
    actions: [],
    flop: "",
    turn: "",
    river: "",
    showdown: {},
    tKind: "none",
    payouts: "",
    others: "",
    payoutUnit: "",
    ranges: {},
    keep: { source: { kind: "manual" } }
  };
}
export function draftFrom(h: HandRecord): Draft {
  const antes = h.forced.filter((f) => f.kind === "ante");
  const bba = h.forced.find((f) => f.kind === "bb-ante");
  return {
    id: h.id,
    unit: h.unit,
    bigBlind: h.bigBlind === null ? "" : String(h.bigBlind),
    complete: h.complete,
    seats: h.seats.map((s) => ({ seat: s.seat, name: s.name ?? "", stack: s.stack === null ? "" : String(s.stack) })),
    button: h.buttonSeat,
    hero: h.hero.seat,
    heroCards: (h.hero.cards ?? []).join(""),
    sb: String(h.forced.find((f) => f.kind === "sb")?.amount ?? ""),
    bb: String(h.forced.find((f) => f.kind === "bb")?.amount ?? ""),
    anteKind: bba ? "bb-ante" : antes.length ? "ante" : "none",
    ante: String(bba?.amount ?? antes[0]?.amount ?? ""),
    forcedOverride: h.forced.map((f) => ({ ...f })),
    actions: h.actions.map((a) => ({ ...a })),
    flop: (h.board.flop ?? []).join(" "),
    turn: h.board.turn ?? "",
    river: h.board.river ?? "",
    showdown: Object.fromEntries((h.showdown ?? []).map((s) => [String(s.seat), s.cards.join("")])),
    tKind: h.tournament?.kind ?? "none",
    payouts: (h.tournament?.payouts ?? []).join(", "),
    others: (h.tournament?.otherStacks ?? []).join(", "),
    payoutUnit: h.tournament?.payoutUnit ?? "",
    ranges: { ...(h.assumptions?.ranges ?? {}) },
    keep: { source: h.source, missing: h.missing, notes: h.notes, snapshots: h.snapshots }
  };
}

/** 양식의 블라인드·앤티로 강제 베팅을 만든다. 스택이 모자라면 낸 만큼(올인) */
function genForced(d: Draft): ForcedBet[] {
  const seats = [...d.seats].sort((a, b) => a.seat - b.seat);
  const n = seats.length;
  const bi = seats.findIndex((s) => s.seat === d.button);
  if (bi < 0) return [];
  const sbSeat = seats[n === 2 ? bi : (bi + 1) % n].seat;
  const bbSeat = seats[n === 2 ? (bi + 1) % n : (bi + 2) % n].seat;
  const left = new Map(seats.map((s) => [s.seat, num(s.stack) ?? Infinity]));
  const out: ForcedBet[] = [];
  const post = (seat: number, kind: ForcedBet["kind"], amt: number | null) => {
    if (!amt || !(amt > 0)) return;
    const a = Math.min(amt, left.get(seat)!);
    if (a <= 0) return;
    left.set(seat, left.get(seat)! - a);
    out.push({ seat, kind, amount: Math.round(a * 1000) / 1000 });
  };
  if (d.anteKind === "ante") for (const s of seats) post(s.seat, "ante", num(d.ante));
  if (d.anteKind === "bb-ante") post(bbSeat, "bb-ante", num(d.ante));
  post(sbSeat, "sb", num(d.sb));
  post(bbSeat, "bb", num(d.bb));
  return out;
}

function toRaw(d: Draft): unknown {
  const board: Record<string, unknown> = {};
  const f = cardsOf(d.flop);
  if (f && f.length) board.flop = f;
  else if (d.flop.trim()) board.flop = ["??"];
  if (d.turn.trim()) board.turn = d.turn.trim();
  if (d.river.trim()) board.river = d.river.trim();
  const showdown = Object.entries(d.showdown)
    .filter(([, v]) => v.trim())
    .map(([seat, v]) => ({ seat: Number(seat), cards: cardsOf(v) ?? ["??"] }));
  const ranges = Object.fromEntries(Object.entries(d.ranges).filter(([, v]) => v.trim()));
  return {
    schema: HAND_SCHEMA,
    id: d.id.trim(),
    complete: d.complete,
    source: d.keep.source,
    unit: d.unit,
    bigBlind: d.unit === "bb" ? 1 : num(d.bigBlind),
    buttonSeat: d.button,
    seats: d.seats.map((s) => ({ seat: s.seat, ...(s.name.trim() ? { name: s.name.trim() } : {}), stack: num(s.stack) })),
    hero: { seat: d.hero, cards: d.heroCards.trim() ? cardsOf(d.heroCards) ?? ["??", "??"] : null },
    forced: d.forcedOverride ?? genForced(d),
    actions: d.actions,
    board,
    ...(showdown.length ? { showdown } : {}),
    ...(d.keep.snapshots ? { snapshots: d.keep.snapshots } : {}),
    ...(d.tKind !== "none" ? { tournament: { kind: d.tKind, payouts: nums(d.payouts), otherStacks: nums(d.others), ...(d.payoutUnit.trim() ? { payoutUnit: d.payoutUnit.trim() } : {}) } } : {}),
    ...(Object.keys(ranges).length ? { assumptions: { ranges } } : {}),
    ...(d.keep.missing ? { missing: d.keep.missing } : {}),
    ...(d.keep.notes ? { notes: d.keep.notes } : {})
  };
}

export function Editor({ initial, onSave, onCancel }: { initial: HandRecord | null; onSave: (h: HandRecord, replaceId: string | null) => void; onCancel: () => void }) {
  const [d, setD] = useState<Draft>(() => (initial ? draftFrom(initial) : newDraft()));
  const [mode, setMode] = useState<"form" | "json">(initial ? "json" : "form");
  const [json, setJson] = useState(() => JSON.stringify(initial ?? toRaw(newDraft()), null, 2));
  const [amt, setAmt] = useState("");
  const [amtMode, setAmtMode] = useState<"to" | "add">("to");
  const [errs, setErrs] = useState<string[]>([]);
  const [fill, setFill] = useState({ sb: "0.5", anteKind: "ante" as "none" | "ante" | "bb-ante", ante: "0.125" });
  const set = (p: Partial<Draft>) => setD((x) => ({ ...x, ...p }));
  const v = useMemo(() => validateHand(toRaw(d)), [d]);
  const rp = useMemo(() => (v.hand ? replay(v.hand) : null), [v]);
  const n = d.seats.length;
  const names = positionNames(n);
  const posOf = (seat: number) => rp?.positions[seat] ?? `${seat}번`;
  const pend = rp?.pending ?? null;

  const resize = (k: number) => {
    const seats = Array.from({ length: k }, (_, i) => d.seats[i] ?? { seat: (d.seats.at(-1)?.seat ?? 0) + i - d.seats.length + 1, name: "", stack: d.seats[0]?.stack ?? "" });
    set({ seats, actions: [], forcedOverride: null, button: seats.some((s) => s.seat === d.button) ? d.button : seats.at(-1)!.seat, hero: seats.some((s) => s.seat === d.hero) ? d.hero : seats[0].seat });
  };
  const addAction = (type: ActionRecord["type"], allIn = false) => {
    if (!pend) return;
    const a: ActionRecord = { street: pend.state.street, seat: pend.seat, type };
    if (type === "call") a.add = pend.legal.callAdd;
    if (type === "bet" || type === "raise") {
      if (allIn) {
        a.to = pend.legal.maxTo;
        a.allIn = true;
      } else {
        const x = num(amt);
        if (x === null || !(x > 0)) return setErrs(["금액을 넣어 주세요"]);
        if (amtMode === "to") a.to = x;
        else a.add = x;
      }
    }
    setErrs([]);
    set({ actions: [...d.actions, a] });
    setAmt("");
  };
  const save = () => {
    const r = mode === "json" ? (() => { try { return validateHand(JSON.parse(json)); } catch (e) { return { hand: null, issues: [{ message: `JSON 오류: ${(e as Error).message}` }] }; } })() : v;
    if (!r.hand) return setErrs(r.issues.map((i) => i.message));
    onSave(r.hand, initial?.id ?? null);
  };
  const lulu = initial?.source.kind === "lulu-decision-log" && initial.seats.some((s) => s.stack === null);

  return (
    <div className="stack">
      <div className="row" style={{ justifyContent: "space-between" }}>
        <h2>{initial ? `편집 · ${initial.id}` : "새 핸드 입력"}</h2>
        <div className="row" role="tablist">
          <button role="tab" aria-selected={mode === "form"} onClick={() => { if (mode === "json") { try { const h = validateHand(JSON.parse(json)).hand; if (h) setD(draftFrom(h)); } catch { /* 양식은 그대로 */ } } setMode("form"); }}>양식</button>
          <button role="tab" aria-selected={mode === "json"} onClick={() => { setJson(JSON.stringify(toRaw(d), null, 2)); setMode("json"); }}>JSON</button>
        </div>
      </div>
      {lulu && (
        <div className="panel stack">
          <strong>루루 기록 보완</strong>
          <p className="small muted">기록에는 블라인드·앤티·앤티 포함 초기 스택이 없습니다. 실제 대회 구조를 확인해 넣으면 초기 스택 = 관측 스택(앤티 뺀 값) + 앤티 로 만듭니다. 추측해서 넣지 마세요.</p>
          <div className="small">관측 스택(BB): {initial!.seats.map((s) => `${s.name ?? s.seat} ${s.observedStackAfterAnte ?? "?"}`).join(" · ")}</div>
          <div className="fields">
            <label className="field">SB (BB 단위)<input inputMode="decimal" value={fill.sb} onChange={(e) => setFill({ ...fill, sb: e.target.value })} /></label>
            <label className="field">앤티 종류<select value={fill.anteKind} onChange={(e) => setFill({ ...fill, anteKind: e.target.value as typeof fill.anteKind })}><option value="none">없음</option><option value="ante">개인 앤티</option><option value="bb-ante">BB 앤티</option></select></label>
            <label className="field">앤티 (BB 단위)<input inputMode="decimal" value={fill.ante} onChange={(e) => setFill({ ...fill, ante: e.target.value })} /></label>
          </div>
          <div className="row">
            <button onClick={() => { const r = completeLuluHand(initial!, { sb: Number(fill.sb), anteKind: fill.anteKind, ante: Number(fill.ante) }); if (r.hand) onSave(r.hand, initial!.id); else setErrs([r.error!]); }}>이 값으로 보완해 저장</button>
          </div>
        </div>
      )}
      {mode === "json" ? (
        <>
          <textarea aria-label="핸드 JSON" style={{ minHeight: 360 }} value={json} onChange={(e) => setJson(e.target.value)} />
          <p className="small muted">형식은 DATA-CONTRACT.md 를 보세요. add = 이번 액션으로 추가로 넣은 금액, to = 이번 스트리트 누적 목표액.</p>
        </>
      ) : (
        <>
          <div className="panel stack">
            <h3 style={{ margin: 0 }}>기본</h3>
            <div className="fields">
              <label className="field">핸드 ID<input value={d.id} onChange={(e) => set({ id: e.target.value })} /></label>
              <label className="field">금액 단위<select value={d.unit} onChange={(e) => set({ unit: e.target.value as Draft["unit"] })}><option value="chips">칩</option><option value="bb">BB</option></select></label>
              {d.unit === "chips" && <label className="field">BB 크기(칩)<input inputMode="decimal" value={d.bigBlind} onChange={(e) => set({ bigBlind: e.target.value })} placeholder="모르면 비움" /></label>}
              <label className="field">인원<select value={n} onChange={(e) => resize(Number(e.target.value))}>{[2, 3, 4, 5, 6, 7, 8].map((k) => <option key={k} value={k}>{k}명</option>)}</select></label>
              <label className="field">버튼 좌석<select value={d.button} onChange={(e) => set({ button: Number(e.target.value), actions: [], forcedOverride: null })}>{d.seats.map((s) => <option key={s.seat} value={s.seat}>{s.seat}번</option>)}</select></label>
              <label className="field">내 좌석<select value={d.hero} onChange={(e) => set({ hero: Number(e.target.value) })}>{d.seats.map((s) => <option key={s.seat} value={s.seat}>{s.seat}번 {posOf(s.seat)}</option>)}</select></label>
              <label className="field">내 카드 (예: AsKd)<input value={d.heroCards} onChange={(e) => set({ heroCards: e.target.value })} placeholder="모르면 비움" /></label>
              <label className="field">완료 여부<select value={d.complete ? "1" : "0"} onChange={(e) => set({ complete: e.target.value === "1" })}><option value="1">완료 핸드</option><option value="0">미완료(내 차례에서 끝남 등)</option></select></label>
            </div>
            <div className="seatgrid small muted"><span>좌석</span><span>이름</span><span>초기 스택</span><span className="opt">자리</span></div>
            {d.seats.map((s, i) => (
              <div key={i} className="seatgrid">
                <input aria-label={`좌석 ${i + 1} 번호`} inputMode="numeric" value={s.seat} onChange={(e) => { const seats = d.seats.slice(); seats[i] = { ...s, seat: Number(e.target.value) || 0 }; set({ seats, actions: [] }); }} />
                <input aria-label={`좌석 ${s.seat} 이름`} value={s.name} onChange={(e) => { const seats = d.seats.slice(); seats[i] = { ...s, name: e.target.value }; set({ seats }); }} />
                <input aria-label={`좌석 ${s.seat} 초기 스택`} inputMode="decimal" value={s.stack} placeholder="모름" onChange={(e) => { const seats = d.seats.slice(); seats[i] = { ...s, stack: e.target.value }; set({ seats, forcedOverride: null }); }} />
                <span className="opt small">{posOf(s.seat)}{s.seat === d.button ? " · 버튼" : ""}{s.seat === d.hero ? " · 나" : ""}</span>
              </div>
            ))}
            <p className="small muted">자리 이름(프리플랍 순서): {names.join(" → ")}. 초기 스택은 블라인드·앤티를 내기 전 값입니다.</p>
          </div>
          <div className="panel stack">
            <h3 style={{ margin: 0 }}>블라인드·앤티 (실제로 낸 금액)</h3>
            <div className="fields">
              <label className="field">SB<input inputMode="decimal" value={d.sb} onChange={(e) => set({ sb: e.target.value, forcedOverride: null })} /></label>
              <label className="field">BB<input inputMode="decimal" value={d.bb} onChange={(e) => set({ bb: e.target.value, forcedOverride: null })} /></label>
              <label className="field">앤티 종류<select value={d.anteKind} onChange={(e) => set({ anteKind: e.target.value as Draft["anteKind"], forcedOverride: null })}><option value="none">없음</option><option value="ante">개인 앤티(모두)</option><option value="bb-ante">BB 앤티(BB 가 전부)</option></select></label>
              {d.anteKind !== "none" && <label className="field">앤티 금액<input inputMode="decimal" value={d.ante} onChange={(e) => set({ ante: e.target.value, forcedOverride: null })} /></label>}
            </div>
            {d.forcedOverride && <p className="small muted">가져온 강제 베팅 {d.forcedOverride.length}개를 그대로 씁니다. 위 값을 바꾸면 양식대로 다시 만듭니다.</p>}
          </div>
          <div className="panel stack">
            <h3 style={{ margin: 0 }}>액션</h3>
            <ol className="small" style={{ margin: 0, paddingLeft: 20 }}>
              {(rp?.steps ?? []).map((s) => <li key={s.index}>{STREET_KO[s.action.street]} · {posOf(s.action.seat)} {actText(s.action, "")}</li>)}
              {d.actions.slice(rp?.steps.length ?? 0).map((a, i) => <li key={`x${i}`} style={{ color: "var(--bad)" }}>{STREET_KO[a.street]} · {posOf(a.seat)} {a.type} {a.to ?? a.add ?? ""} (재구성 안 됨)</li>)}
            </ol>
            <div className="row"><button onClick={() => set({ actions: d.actions.slice(0, -1) })} disabled={!d.actions.length}>마지막 액션 지우기</button></div>
            {!v.hand && <Notes kind="bad" title="입력을 먼저 고쳐 주세요" items={v.issues.map((i) => i.message)} />}
            {rp && !rp.ok && <Notes kind="bad" title="재구성 오류" items={rp.issues.filter((i) => i.severity === "error").map((i) => i.message)} />}
            {pend ? (
              <div className="stack">
                <div className="note info">
                  다음 차례: <strong>{posOf(pend.seat)}</strong> ({STREET_KO[pend.state.street]}) · 추가 콜 {fmt(pend.legal.toCall)} · 최소 목표 {pend.legal.minTo === null ? "—" : fmt(pend.legal.minTo)} · 최대 목표 {fmt(pend.legal.maxTo)}
                  {pend.legal.raiseBlockedBy ? ` · ${pend.legal.raiseBlockedBy}` : ""}
                </div>
                <div className="row">
                  <button onClick={() => addAction("fold")}>폴드</button>
                  {pend.legal.canCheck && <button onClick={() => addAction("check")}>체크</button>}
                  {pend.legal.canCall && <button onClick={() => addAction("call")}>콜 +{fmt(pend.legal.callAdd)}</button>}
                </div>
                {(pend.legal.canBet || pend.legal.canRaise) && (
                  <div className="row">
                    <label className="field">금액 방식<select value={amtMode} onChange={(e) => setAmtMode(e.target.value as "to" | "add")}><option value="to">목표액(이번 스트리트 누적)</option><option value="add">추가액(이번에 더 넣는 금액)</option></select></label>
                    <label className="field">금액<input inputMode="decimal" value={amt} onChange={(e) => setAmt(e.target.value)} /></label>
                    <button onClick={() => addAction(pend.legal.canBet ? "bet" : "raise")}>{pend.legal.canBet ? "벳" : "레이즈"}</button>
                    <button onClick={() => addAction(pend.legal.canBet ? "bet" : "raise", true)}>올인 {fmt(pend.legal.maxTo)}</button>
                  </div>
                )}
              </div>
            ) : rp?.ok ? (
              <div className="note ok">핸드가 끝났습니다 ({rp.ended === "fold" ? "폴드" : rp.ended === "runout" ? "올인 런아웃" : "쇼다운"}).</div>
            ) : null}
          </div>
          <div className="panel stack">
            <h3 style={{ margin: 0 }}>보드와 쇼다운</h3>
            <div className="fields">
              <label className="field">플랍 (3장)<input value={d.flop} onChange={(e) => set({ flop: e.target.value })} placeholder="Ks 7d 2c" /></label>
              <label className="field">턴<input value={d.turn} onChange={(e) => set({ turn: e.target.value })} /></label>
              <label className="field">리버<input value={d.river} onChange={(e) => set({ river: e.target.value })} /></label>
            </div>
            <p className="small muted">쇼다운 카드는 사후 결과에만 씁니다. 공개되지 않았으면 비워 두세요.</p>
            <div className="fields">
              {d.seats.map((s) => <label key={s.seat} className="field">{posOf(s.seat)} 공개 카드<input value={d.showdown[s.seat] ?? ""} onChange={(e) => set({ showdown: { ...d.showdown, [s.seat]: e.target.value } })} /></label>)}
            </div>
          </div>
          <details className="panel">
            <summary>대회 지급 구조·전체 필드 (ICM, 선택)</summary>
            <div className="fields" style={{ marginTop: 8 }}>
              <label className="field">종류<select value={d.tKind} onChange={(e) => set({ tKind: e.target.value as Draft["tKind"] })}><option value="none">입력 안 함 (칩 EV 만)</option><option value="standard">일반 지급</option><option value="satellite">같은 티켓 새틀라이트</option></select></label>
              <label className="field">남은 지급액 (1위부터, 쉼표)<input value={d.payouts} onChange={(e) => set({ payouts: e.target.value })} placeholder="100, 100, 100" /></label>
              <label className="field">테이블 밖 스택 (쉼표, 없으면 비움)<input value={d.others} onChange={(e) => set({ others: e.target.value })} placeholder="5000, 4200, …" /></label>
              <label className="field">상금 단위 표시<input value={d.payoutUnit} onChange={(e) => set({ payoutUnit: e.target.value })} placeholder="티켓 가치" /></label>
            </div>
          </details>
          <details className="panel">
            <summary>상대 범위 가정 (선택 · '사용자 가정'으로 표시됨)</summary>
            <p className="small muted">자료 조건과 맞지 않는 핸드에서 닫힌 올인 콜 EV 를 계산할 때만 씁니다. 예: 22+,A2s+,KTo+. GTO 범위가 아닙니다.</p>
            <div className="fields">
              {d.seats.filter((s) => s.seat !== d.hero).map((s) => <label key={s.seat} className="field">{posOf(s.seat)}<input value={d.ranges[s.seat] ?? ""} onChange={(e) => set({ ranges: { ...d.ranges, [s.seat]: e.target.value } })} /></label>)}
            </div>
          </details>
        </>
      )}
      <Notes kind="bad" title="저장할 수 없습니다" items={errs} />
      <div className="row">
        <button className="primary" onClick={save}>저장</button>
        <button onClick={onCancel}>취소</button>
      </div>
    </div>
  );
}
