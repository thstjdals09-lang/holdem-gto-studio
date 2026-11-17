// 앱의 "예제 불러오기" 목록. 파일은 examples/review/ (테스트와 같은 파일)
import a2Filled from "../../examples/review/ex-a2-satellite-filled.json";
import a2Partial from "../../examples/review/ex-a2-satellite-partial.json";
import aa from "../../examples/review/ex-aa-bb160-fold.json";
import k4oFilled from "../../examples/review/ex-k4o-filled.json";
import k4oPartial from "../../examples/review/ex-k4o-partial.json";
import lib25 from "../../examples/review/ex-library-25bb.json";
import lulu from "../../examples/review/lulu-sample-synthetic.json";

export const EXAMPLES: Array<{ title: string; data: unknown }> = [
  { title: "자료와 정확히 같은 8명 25BB 핸드", data: lib25 },
  { title: "사례 3 · AA, BB 160 뒤 320 레이즈에 폴드 (보완)", data: aa },
  { title: "사례 1 · K4o 129BB 콜 (부분 기록)", data: k4oPartial },
  { title: "사례 1 · K4o 129BB 콜 (사용자 보완)", data: k4oFilled },
  { title: "사례 2 · A2 새틀라이트 리버 콜 (부분 기록)", data: a2Partial },
  { title: "사례 2 · A2 새틀라이트 리버 콜 (사용자 보완)", data: a2Filled }
];
export const LULU_SAMPLE_TEXT = JSON.stringify(lulu);
