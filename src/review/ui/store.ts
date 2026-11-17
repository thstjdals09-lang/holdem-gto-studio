// 이 브라우저에만 저장한다(localStorage). 막혀 있거나 비어 있어도 앱은 돌아간다. 읽은 값은 다시 검증한다.
import { validateHand } from "../hand-history";
import { REPORT_SCHEMA, type HandRecord, type HandReport } from "../types";

const HANDS = "holdem-review:hands";
const REPORTS = "holdem-review:reports";

function read(key: string): unknown {
  try {
    const t = localStorage.getItem(key);
    return t ? JSON.parse(t) : null;
  } catch {
    return null;
  }
}
/** 저장 실패(용량·차단)는 false 로 알린다 */
function write(key: string, v: unknown): boolean {
  try {
    localStorage.setItem(key, JSON.stringify(v));
    return true;
  } catch {
    return false;
  }
}
export function loadHands(): HandRecord[] {
  const raw = read(HANDS);
  if (!Array.isArray(raw)) return [];
  return raw.map((x) => validateHand(x).hand).filter((h): h is HandRecord => !!h);
}
export const saveHands = (hands: HandRecord[]) => write(HANDS, hands);
export function loadReports(): Record<string, HandReport> {
  const raw = read(REPORTS);
  if (!raw || typeof raw !== "object") return {};
  const out: Record<string, HandReport> = {};
  for (const [k, v] of Object.entries(raw as Record<string, HandReport>)) if (v && v.schema === REPORT_SCHEMA && typeof v.inputHash === "string") out[k] = v;
  return out;
}
export const saveReports = (r: Record<string, HandReport>) => write(REPORTS, r);
