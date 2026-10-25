import { describe, it, expect } from "vitest";
import { parseCards } from "../src/engine/cards";
import { classifyMade, classifyDraw } from "../src/engine/categories";
const h = (s: string) => parseCards(s) as [number, number];
describe("핸드 분류", () => {
  const b = parseCards("Ks7d2c");
  it("완성 핸드", () => {
    expect(classifyMade(h("AhAd"), b)).toBe("오버페어");
    expect(classifyMade(h("KhQd"), b)).toBe("탑페어");
    expect(classifyMade(h("8h7h"), b)).toBe("미들페어");
    expect(classifyMade(h("3h2h"), b)).toBe("약한 페어");
    expect(classifyMade(h("7h7s"), b)).toBe("셋");
    expect(classifyMade(h("Kh7h"), b)).toBe("투페어");
    expect(classifyMade(h("QhQd"), b)).toBe("언더 오버페어");
    expect(classifyMade(h("AhQd"), b)).toBe("에이스 하이");
    expect(classifyMade(h("QhJd"), b)).toBe("노메이드");
  });
  it("드로우", () => {
    expect(classifyDraw(h("AdQd"), parseCards("Kd7d2c"))).toBe("플러시 드로우");
    expect(classifyDraw(h("9h8h"), parseCards("Td7c2s"))).toBe("양방 스트레이트 드로우");
    expect(classifyDraw(h("9h5h"), parseCards("Th7c2s"))).toBe("백도어 플러시");
    expect(classifyDraw(h("9c6s"), parseCards("Td7c2s"))).toBe("거셧");
    expect(classifyDraw(h("AhQd"), b)).toBe("드로우 없음");
  });
  it("페어 보드", () => {
    const pb = parseCards("8d8c3s");
    expect(classifyMade(h("AhKd"), pb)).toBe("에이스 하이");
    expect(classifyMade(h("8h5h"), pb)).toBe("트립스");
    expect(classifyMade(h("3h4h"), pb)).toBe("약한 페어");
    expect(classifyMade(h("9h9d"), pb)).toBe("오버페어");
  });
});
