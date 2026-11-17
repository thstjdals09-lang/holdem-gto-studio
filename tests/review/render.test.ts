import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { validateHand } from "../../src/review/hand-history";
import { analyzeHand } from "../../src/review/review-report";
import { loadLibraryFromText } from "../../src/review/strategy-provider";
import { DEFAULT_OPTIONS } from "../../src/review/types";
import { AnalysisView } from "../../src/review/ui/DecisionView";
import { HandList } from "../../src/review/ui/HandList";

describe("가져온 문자열의 안전한 렌더링", () => {
  it("핸드 id·이름·메모·범위 가정에 넣은 HTML 은 글자로만 나온다", async () => {
    const raw = JSON.parse(readFileSync("examples/review/ex-k4o-filled.json", "utf8"));
    raw.id = '<img src=x onerror="alert(1)">';
    raw.seats[6].name = "<script>alert(2)</script>";
    raw.notes = ['<b onmouseover="alert(3)">메모</b>'];
    raw.assumptions.ranges["7"] = "22+,A2+ <svg onload=alert(4)>";
    const hand = validateHand(raw).hand!;
    const report = await analyzeHand(hand, { ...DEFAULT_OPTIONS, samples: 500 }, { loadLibrary: (id) => loadLibraryFromText(id, readFileSync(`public/lib/preflop/${id}.json`, "utf8")) });
    const html =
      renderToString(createElement(HandList, { hands: [hand], reports: { [hand.id]: report }, selected: hand.id, stale: new Set<string>(),onSelect: () => {}, onAdd: () => {}, onNew: () => {} })) +
      renderToString(createElement(AnalysisView, { report, stale: false, running: null, onRun: () => {}, onCancel: () => {}, onDownload: () => {} }));
    expect(html).toContain("&lt;img src=x");
    expect(html).not.toMatch(/<img|<script|<svg|<b /);
    expect(html).toContain("범위 가정 문법 오류"); // 잘못된 범위는 계산하지 않고 이유만 글자로 보여 준다
  });
});
