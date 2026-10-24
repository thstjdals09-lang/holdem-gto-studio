// IndexedDB 저장: 솔브된 스팟, 프리플랍 에퀴티 행렬, 드릴, 트레이너 기록
import type { TreeConfig } from "../engine/tree";

export interface SavedSpot {
  id: string;
  name: string;
  createdAt: number;
  config: TreeConfig;
  oopText: string;
  ipText: string;
  oop: Float32Array;
  ip: Float32Array;
  strategy: Float32Array;
  iterations: number;
  exploitabilityPct: number;
  evOop: number;
  evIp: number;
  tags?: string[];
}

export interface Drill {
  id: string;
  name: string;
  spotId: string;
  heroSeat: 0 | 1 | 2; // 2 = 무작위
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
  heroSeat: 0 | 1;
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
const DB_VERSION = 1;

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

export const db = {
  async listSpots(): Promise<SavedSpot[]> {
    const all = await tx<SavedSpot[]>("spots", "readonly", (s) => s.getAll());
    return all.sort((a, b) => b.createdAt - a.createdAt);
  },
  getSpot(id: string): Promise<SavedSpot | undefined> {
    return tx("spots", "readonly", (s) => s.get(id));
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
