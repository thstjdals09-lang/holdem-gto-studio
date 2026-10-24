// 페이지 간 전달용 아주 작은 전역 스토어
import type { TreeConfig } from "../engine/tree";

export interface PendingSolve {
  oopText: string;
  ipText: string;
  pot: number;
  effStack: number;
  note: string;
}

const state: { pendingSolve: PendingSolve | null; loadedSpotId: string | null; auxSpotId: string | null; lastConfig: TreeConfig | null } = {
  pendingSolve: null,
  loadedSpotId: null,
  auxSpotId: null,
  lastConfig: null
};

export const store = {
  setPendingSolve(p: PendingSolve | null) {
    state.pendingSolve = p;
  },
  takePendingSolve(): PendingSolve | null {
    const p = state.pendingSolve;
    state.pendingSolve = null;
    return p;
  },
  get loadedSpotId() {
    return state.loadedSpotId;
  },
  set loadedSpotId(v: string | null) {
    state.loadedSpotId = v;
  },
  get auxSpotId() {
    return state.auxSpotId;
  },
  set auxSpotId(v: string | null) {
    state.auxSpotId = v;
  },
  get lastConfig() {
    return state.lastConfig;
  },
  set lastConfig(v: TreeConfig | null) {
    state.lastConfig = v;
  }
};

export function encodePath(path: Array<{ kind: "action"; index: number } | { kind: "card"; card: number }>): string {
  return path.map((s) => (s.kind === "action" ? String(s.index) : "c" + s.card)).join(".");
}
export function decodePath(s: string | null): Array<{ kind: "action"; index: number } | { kind: "card"; card: number }> {
  if (!s) return [];
  return s
    .split(".")
    .filter((x) => x.length > 0)
    .map((x) => (x.startsWith("c") ? { kind: "card" as const, card: Number(x.slice(1)) } : { kind: "action" as const, index: Number(x) }));
}
