// IndexedDB 저장: 솔브된 스팟, 프리플랍 에퀴티 행렬, 드릴, 트레이너 기록
import type { TreeConfig } from "../engine/tree";
import type { MultiTreeConfig } from "../engine/multi";

export interface SavedSpot {
  id: string;
  name: string;
  createdAt: number;
  players: number;
  config?: TreeConfig; // players === 2
  mconfig?: MultiTreeConfig; // players > 2
  rangeTexts: string[];
  ranges: Float32Array[];
  strategy: Float32Array;
  iterations: number;
  exploitabilityPct: number;
  ev: number[];
  board: number[];
  pot: number;
  effStack: number;
  tags?: string[];
}

export interface Drill {
  id: string;
  name: string;
  spotId: string;
  heroSeat: number; // -1 = 무작위
  startPath: Array<{ kind: "action"; index: number } | { kind: "card"; card: number }>;
  createdAt: number;
  handsPlayed: number;
  correct: number;
  inaccuracy: number;
  blunder: number;
  evLossSum: number;
}

export interface TrainerRecord {
  id: string;
  at: number;
  spotId: string;
  spotName: string;
  heroSeat: number;
  seatLabel: string;
  street: number;
  heroCombo: number;
  chosen: string;
  best: string;
  evLoss: number; // 칩
  evLossPot: number; // 팟 대비 %
  verdict: "correct" | "inaccuracy" | "blunder";
  gtoFreq: number;
}

const DB_NAME = "holdem-gto-studio";
const DB_VERSION = 2;

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains("spots")) db.createObjectStore("spots", { keyPath: "id" });
      if (!db.objectStoreNames.contains("kv")) db.createObjectStore("kv");
      if (!db.objectStoreNames.contains("drills")) db.createObjectStore("drills", { keyPath: "id" });
      if (!db.objectStoreNames.contains("trainer")) db.createObjectStore("trainer", { keyPath: "id" });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function tx<T>(store: string, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T> | IDBRequest<any>): Promise<T> {
  return open().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const t = db.transaction(store, mode);
        const r = fn(t.objectStore(store));
        r.onsuccess = () => resolve(r.result as T);
        r.onerror = () => reject(r.error);
      })
  );
}

/** 구버전(HU 전용) 스팟 레코드를 현재 형식으로 변환 */
function migrate(raw: any): SavedSpot | null {
  if (!raw) return null;
  if (raw.players && raw.ranges) return raw as SavedSpot;
  if (raw.config && raw.oop && raw.ip) {
    return {
      id: raw.id,
      name: raw.name,
      createdAt: raw.createdAt,
      players: 2,
      config: raw.config,
      rangeTexts: [raw.oopText, raw.ipText],
      ranges: [raw.oop, raw.ip],
      strategy: raw.strategy,
      iterations: raw.iterations,
      exploitabilityPct: raw.exploitabilityPct,
      ev: [raw.evOop, raw.evIp],
      board: raw.config.board,
      pot: raw.config.pot,
      effStack: raw.config.effStack
    };
  }
  return null;
}

export const db = {
  async listSpots(): Promise<SavedSpot[]> {
    const all = await tx<any[]>("spots", "readonly", (s) => s.getAll());
    return all
      .map(migrate)
      .filter((s): s is SavedSpot => !!s)
      .sort((a, b) => b.createdAt - a.createdAt);
  },
  async getSpot(id: string): Promise<SavedSpot | undefined> {
    const raw = await tx<any>("spots", "readonly", (s) => s.get(id));
    return migrate(raw) ?? undefined;
  },
  putSpot(spot: SavedSpot): Promise<unknown> {
    return tx("spots", "readwrite", (s) => s.put(spot));
  },
  deleteSpot(id: string): Promise<unknown> {
    return tx("spots", "readwrite", (s) => s.delete(id));
  },
  getKV<T>(key: string): Promise<T | undefined> {
    return tx("kv", "readonly", (s) => s.get(key));
  },
  putKV(key: string, value: unknown): Promise<unknown> {
    return tx("kv", "readwrite", (s) => s.put(value, key));
  },
  async listDrills(): Promise<Drill[]> {
    const all = await tx<Drill[]>("drills", "readonly", (s) => s.getAll());
    return all.sort((a, b) => b.createdAt - a.createdAt);
  },
  putDrill(d: Drill): Promise<unknown> {
    return tx("drills", "readwrite", (s) => s.put(d));
  },
  deleteDrill(id: string): Promise<unknown> {
    return tx("drills", "readwrite", (s) => s.delete(id));
  },
  async listTrainer(): Promise<TrainerRecord[]> {
    const all = await tx<TrainerRecord[]>("trainer", "readonly", (s) => s.getAll());
    return all.sort((a, b) => b.at - a.at);
  },
  putTrainer(r: TrainerRecord): Promise<unknown> {
    return tx("trainer", "readwrite", (s) => s.put(r));
  },
  clearTrainer(): Promise<unknown> {
    return tx("trainer", "readwrite", (s) => s.clear());
  }
};

export function newId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

export function spotInput(s: SavedSpot) {
  return { players: s.players, config: s.config, mconfig: s.mconfig, ranges: s.ranges };
}
