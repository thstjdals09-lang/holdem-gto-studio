// 2. 핸드 상세와 스트리트별 재생. 사후 결과(쇼다운·분배)는 따로 접어 두고 판단 분석과 섞지 않는다.
import { useEffect, useMemo, useState } from "react";
import { visibleBoard } from "../knowledge";
import { computeOutcome, potLayersMilli, replay, toMilli } from "../replay-state";
import { STREET_KO, type HandRecord, type NormalizedAction } from "../types";
import { Cards, Notes, fmt, unitKo } from "./common";

export function actText(a: NormalizedAction, u: string) {
  if (a.type === "fold") return "폴드";
  if (a.type === "check") return "체크";
  if (a.type === "call") return `콜 +${fmt(a.add)}${a.allIn ? " 올인" : ""}`;
  return `${a.type === "bet" ? "벳" : "레이즈"} → ${fmt(a.to)}${u}${a.allIn ? " 올인" : ""}${!a.fullRaise ? " (완전 레이즈 아님)" : ""}`;
}

export function ReplayView({ hand }: { hand: HandRecord }) {
  const rp = useMemo(() => replay(hand), [hand]);
  const outcome = useMemo(() => computeOutcome(hand, rp), [hand, rp]);
  const [k, setK] = useState(0);
  useEffect(() => setK(0), [hand]);
  const u = unitKo(hand.unit);
  const atEnd = k >= rp.steps.length;
  const view = atEnd ? rp.final : rp.steps[k].before;
  const next = atEnd ? null : rp.steps[k];
  const errors = rp.issues.filter((i) => i.severity === "error").map((i) => i.message);
  const warns = rp.issues.filter((i) => i.severity === "warn").map((i) => i.message);
  const board = view ? visibleBoard(hand, view.street) : [];
  const layers = view ? potLayersMilli(view.seats.map((s) => ({ seat: s.seat, totalIn: toMilli(s.totalIn), deadIn: toMilli(s.deadIn), folded: s.folded }))) : [];
  const pos = (seat: number) => `${rp.positions[seat] ?? "?"}(${seat})`;
  return (
    <div className="stack">
      <div className="row" style={{ justifyContent: "space-between" }}>
        <h2>재생 · <span className="mono">{hand.id}</span></h2>
        <span className="small muted">
          {hand.seats.length}명 · 단위 {u}
          {hand.bigBlind ? ` · BB ${fmt(hand.bigBlind)}` : " · BB 크기 모름"}
        </span>
      </div>
      <Notes kind="bad" title="재구성 오류 (이 지점 뒤로는 재생하지 않습니다)" items={errors} />
      <Notes kind="warn" title="확인 필요" items={warns} />
      {hand.missing?.length ? <Notes kind="warn" title="기록에서 확인하지 못한 값 (임의로 채우지 않음)" items={hand.missing} /> : null}
      {hand.source.detail && <p className="small muted">{hand.source.detail}</p>}

      <div className="row">
        <button onClick={() => setK(0)} disabled={k === 0}>처음</button>
        <button onClick={() => setK(Math.max(0, k - 1))} disabled={k === 0}>이전</button>
        <button onClick={() => setK(Math.min(rp.steps.length, k + 1))} disabled={atEnd}>다음</button>
        <button onClick={() => setK(rp.steps.length)} disabled={atEnd}>끝</button>
        <span className="small muted">
          {k} / {rp.steps.length} · {view ? STREET_KO[view.street] : "—"}
        </span>
      </div>
      <div className="steps" role="list" aria-label="액션 순서">
        {rp.steps.map((s, i) => (
          <button key={i} role="listitem" aria-current={i === k} className={s.action.seat === hand.hero.seat ? "hero" : ""} onClick={() => setK(i)} title={`${STREET_KO[s.action.street]} ${pos(s.action.seat)} ${actText(s.action, u)}`}>
            {i + 1}. {s.action.position} {actText(s.action, "")}
          </button>
        ))}
      </div>

      <div className="panel stack">
        <div className="row" style={{ justifyContent: "space-between" }}>
          <div>
            <div className="small muted">공개 보드 ({view ? STREET_KO[view.street] : "—"} 시점)</div>
            <Cards cards={board} slots={view?.street === "preflop" ? 0 : board.length} />
            {view?.street === "preflop" && <span className="small muted">프리플랍 (보드 없음)</span>}
          </div>
          <div>
            <div className="small muted">내 카드 ({pos(hand.hero.seat)})</div>
            <Cards cards={hand.hero.cards} slots={2} />
          </div>
        </div>
        {next ? (
          <div className={`note ${next.action.seat === hand.hero.seat ? "ok" : "info"}`}>
            다음 액션: <strong>{pos(next.action.seat)} {actText(next.action, u)}</strong> · 추가 콜 {fmt(next.legal.toCall)}
            {next.legal.minTo !== null ? ` · 최소 목표 ${fmt(next.legal.minTo)}` : ""} · 최대 목표 {fmt(next.legal.maxTo)}
            {next.legal.raiseBlockedBy ? ` · ${next.legal.raiseBlockedBy}` : ""}
          </div>
        ) : (
          <div className="note info">
            {rp.ended === "incomplete" ? (rp.pending ? `기록이 여기서 끝났습니다. 다음 차례: ${pos(rp.pending.seat)} (추가 콜 ${fmt(rp.pending.legal.toCall)})` : "기록이 여기서 끝났습니다") : rp.ended === "fold" ? "모두 폴드해 핸드가 끝났습니다" : rp.ended === "runout" ? "올인으로 남은 보드만 열고 끝났습니다" : "리버 베팅이 끝나 쇼다운입니다"}
          </div>
        )}
        {view && (
          <>
            <dl className="kv">
              <div><dt>팟 (이번 스트리트 포함)</dt><dd>{fmt(view.pot)}</dd></div>
              <div><dt>지난 스트리트까지</dt><dd>{fmt(view.potSettled)}</dd></div>
              <div><dt>현재 베팅</dt><dd>{fmt(view.currentBet)}</dd></div>
              {hand.bigBlind ? <div><dt>팟 (BB)</dt><dd>{fmt(view.pot / hand.bigBlind)}</dd></div> : null}
            </dl>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr><th>자리</th><th>이름</th><th className="num">초기</th><th className="num">남은 스택</th><th className="num">이번 스트리트</th><th className="num">핸드 누적</th><th>상태</th></tr>
                </thead>
                <tbody>
                  {view.seats.map((s) => (
                    <tr key={s.seat} className={s.folded ? "dim" : s.seat === hand.hero.seat ? "actual" : ""}>
                      <td>{pos(s.seat)}{s.seat === hand.buttonSeat ? " · 버튼" : ""}</td>
                      <td>{s.name ?? ""}{s.seat === hand.hero.seat ? " (나)" : ""}</td>
                      <td className="num">{fmt(s.start)}</td>
                      <td className="num">{fmt(s.stack)}</td>
                      <td className="num">{fmt(s.streetIn)}</td>
                      <td className="num">{fmt(s.totalIn)}{s.deadIn ? ` (BB앤티 ${fmt(s.deadIn)})` : ""}</td>
                      <td>{s.folded ? "폴드" : s.allIn ? "올인" : view.toAct === s.seat ? "차례" : ""}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="small">
              팟 층:{" "}
              {layers.map((l, i) => (
                <span key={i} className="badge b-plain" style={{ marginRight: 4 }}>
                  {i === 0 ? "메인" : `사이드 ${i}`} {fmt(l.amount / 1000)} · {l.eligible.map((s) => rp.positions[s]).join("/")}
                </span>
              ))}
            </div>
          </>
        )}
      </div>

      {rp.refunds.length > 0 && <Notes kind="info" title="돌려준 초과 베팅" items={rp.refunds.map((r) => `${pos(r.seat)} ${fmt(r.amount)}${u} (${STREET_KO[r.street]})`)} />}
      {rp.snapshotChecks.length > 0 && (
        <div className="panel">
          <h3>기록 스냅샷 대조</h3>
          <div className="table-wrap">
            <table>
              <thead><tr><th>액션 전</th><th>항목</th><th className="num">기록</th><th className="num">재구성</th><th>결과</th></tr></thead>
              <tbody>
                {rp.snapshotChecks.map((c, i) => (
                  <tr key={i}>
                    <td>#{c.beforeAction + 1}</td><td>{c.field}</td><td className="num">{fmt(c.recorded)}</td><td className="num">{fmt(c.reconstructed)}</td>
                    <td>{c.ok ? "일치" : <strong style={{ color: "var(--bad)" }}>불일치</strong>}{c.note ? ` · ${c.note}` : ""}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
      <details className="panel">
        <summary>사후 결과 — 쇼다운·분배 (판단 분석에는 쓰지 않습니다)</summary>
        {outcome.known ? (
          <div className="stack" style={{ marginTop: 8 }}>
            <div className="row"><span className="small muted">최종 보드</span><Cards cards={outcome.board} /></div>
            {outcome.shown.map((s) => (
              <div key={s.seat} className="row small"><span>{pos(s.seat)} 공개</span><Cards cards={s.cards} /></div>
            ))}
            <div className="small">분배: {outcome.awards.map((a) => `${pos(a.seat)} +${fmt(a.amount)}`).join(", ")}</div>
            <div className="small">내 결과: {fmt(outcome.heroNet)}{u} · 칩 보존 {outcome.conservation?.ok ? "확인" : "실패"} ({fmt(outcome.conservation?.start)} → {fmt(outcome.conservation?.end)})</div>
            <p className="small muted">결과가 나빴다고 판단이 틀린 것은 아닙니다. 판단은 '분석' 화면에서 그 시점 정보로만 봅니다.</p>
          </div>
        ) : (
          <p className="small muted">{outcome.reason}</p>
        )}
      </details>
    </div>
  );
}
