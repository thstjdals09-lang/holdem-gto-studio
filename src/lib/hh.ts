// 핸드 히스토리 파서 (PokerStars / GGPoker 텍스트 형식, 홀덤 노리밋)
import { parseCard } from "../engine/cards";

export type HHActType = "fold" | "check" | "call" | "bet" | "raise";
export interface HHAction {
  player: string;
  type: HHActType;
  amount: number; // 이번 액션으로 추가로 넣은 금액 (bb)
  to: number; // 이 액션 후 해당 스트리트 총 투자 (bb)
  allin: boolean;
}
export interface HHSeat {
  seat: number;
  name: string;
  stack: number; // bb
  position: string;
  order: number; // 프리플랍 행동 순서 (0 = 첫 행동자, 마지막 = BB)
}
export interface ParsedHand {
  id: string;
  site: string;
  date: string;
  sb: number; // 통화 단위
  bb: number;
  maxSeats: number;
  button: number;
  seats: HHSeat[];
  hero: string | null;
  heroCards: [number, number] | null;
  streets: { preflop: HHAction[]; flop: HHAction[]; turn: HHAction[]; river: HHAction[] };
  board: number[];
  heroNet: number; // bb
  raw: string;
}

const MONEY = "(?:[$€£₩])?";
const num = (s: string) => parseFloat(s.replace(/,/g, ""));

/** 버튼 기준 자리 이름 (6맥스 명칭; 6명 미만이면 앞자리부터 생략) */
export function positionNames(count: number): string[] {
  // 프리플랍 행동 순서
  const table: Record<number, string[]> = {
    2: ["BTN", "BB"],
    3: ["BTN", "SB", "BB"],
    4: ["CO", "BTN", "SB", "BB"],
    5: ["HJ", "CO", "BTN", "SB", "BB"],
    6: ["UTG", "HJ", "CO", "BTN", "SB", "BB"],
    7: ["UTG", "LJ", "HJ", "CO", "BTN", "SB", "BB"],
    8: ["UTG", "UTG1", "LJ", "HJ", "CO", "BTN", "SB", "BB"],
    9: ["UTG", "UTG1", "UTG2", "LJ", "HJ", "CO", "BTN", "SB", "BB"],
    10: ["UTG", "UTG1", "UTG2", "LJ", "HJ", "HJ2", "CO", "BTN", "SB", "BB"]
  };
  return table[count] ?? table[9];
}

export function splitHands(text: string): string[] {
  const lines = text.replace(/\r/g, "").split("\n");
  const out: string[] = [];
  let cur: string[] = [];
  for (const l of lines) {
    if (/^(PokerStars|Poker|GGPoker) (?:Hand|Game) #/i.test(l.trim()) || /^PokerStars Zoom Hand #/.test(l.trim())) {
      if (cur.some((x) => x.trim())) out.push(cur.join("\n"));
      cur = [];
    }
    cur.push(l);
  }
  if (cur.some((x) => x.trim())) out.push(cur.join("\n"));
  return out.filter((h) => /Hand #/.test(h));
}

export function parseHand(raw: string): ParsedHand | null {
  const lines = raw.split("\n").map((l) => l.trim()).filter(Boolean);
  const head = lines[0] ?? "";
  const hm = head.match(new RegExp(`Hand #([A-Za-z0-9-]+):.*?\\(${MONEY}([\\d.,]+)\\/${MONEY}([\\d.,]+)`));
  if (!hm) return null;
  if (!/Hold'?em No Limit/i.test(head)) return null;
  const site = /^Poker Hand/i.test(head) || /GG/i.test(head) ? "GGPoker" : "PokerStars";
  const sbAmt = num(hm[2]);
  const bbAmt = num(hm[3]);
  const date = (head.match(/(\d{4}\/\d{2}\/\d{2} \d{1,2}:\d{2}:\d{2})/) ?? [])[1] ?? "";
  const tm = lines.find((l) => l.startsWith("Table "))?.match(/(\d+)-max.*?Seat #(\d+) is the button/);
  const maxSeats = tm ? Number(tm[1]) : 6;
  const button = tm ? Number(tm[2]) : 1;
  const seats: HHSeat[] = [];
  for (const l of lines) {
    const m = l.match(new RegExp(`^Seat (\\d+): (.+?) \\(${MONEY}([\\d.,]+) in chips`));
    if (m && !l.includes("folded") && !l.includes("collected")) seats.push({ seat: Number(m[1]), name: m[2], stack: num(m[3]) / bbAmt, position: "", order: 0 });
    if (l.startsWith("*** HOLE CARDS")) break;
  }
  if (seats.length < 2) return null;
  // 자리 이름: 버튼 다음부터 SB, BB, ... 순으로 정렬해 프리플랍 순서로 매핑
  const sorted = seats.slice().sort((a, b) => a.seat - b.seat);
  const bi = Math.max(0, sorted.findIndex((s) => s.seat >= button));
  const fromBtn = [...sorted.slice(bi), ...sorted.slice(0, bi)]; // BTN, SB, BB, ...
  const names = positionNames(seats.length); // 프리플랍 순서 (… BTN, SB, BB)
  if (seats.length === 2) {
    fromBtn[0].position = "BTN";
    fromBtn[0].order = 0;
    fromBtn[1].position = "BB";
    fromBtn[1].order = 1;
  } else {
    // fromBtn: [BTN, SB, BB, 나머지(UTG..CO)]
    const order = [...fromBtn.slice(3), fromBtn[0], fromBtn[1], fromBtn[2]]; // 프리플랍 행동 순서
    order.forEach((s, i) => {
      s.position = names[i];
      s.order = i;
    });
  }
  let hero: string | null = null;
  let heroCards: [number, number] | null = null;
  const streets: ParsedHand["streets"] = { preflop: [], flop: [], turn: [], river: [] };
  let street: keyof ParsedHand["streets"] = "preflop";
  const board: number[] = [];
  const invested = new Map<string, number>(); // 전체 투자 (bb)
  const streetInv = new Map<string, number>();
  let collected = new Map<string, number>();
  const add = (p: string, x: number) => {
    invested.set(p, (invested.get(p) ?? 0) + x);
    streetInv.set(p, (streetInv.get(p) ?? 0) + x);
  };
  let started = false;
  for (const l of lines) {
    const sm = l.match(/^\*\*\* (HOLE CARDS|FLOP|TURN|RIVER|SHOW ?DOWN|SUMMARY) \*\*\*(.*)$/);
    if (sm) {
      const kind = sm[1];
      if (kind === "HOLE CARDS") {
        started = true;
        street = "preflop";
      } else if (kind === "FLOP" || kind === "TURN" || kind === "RIVER") {
        const cards = sm[2].match(/\[([^\]]+)\]/g)?.map((x) => x.slice(1, -1)) ?? [];
        const last = cards[cards.length - 1] ?? "";
        for (const c of last.split(" ").filter(Boolean)) {
          try {
            const pc = parseCard(c);
            if (!board.includes(pc)) board.push(pc);
          } catch {
            /* 무시 */
          }
        }
        street = kind === "FLOP" ? "flop" : kind === "TURN" ? "turn" : "river";
        streetInv.clear();
      } else if (kind === "SUMMARY") break;
      continue;
    }
    const post = l.match(new RegExp(`^(.+?): posts (small blind|big blind|the ante|small & big blinds|straddle) ${MONEY}([\\d.,]+)`));
    if (post) {
      const amt = num(post[3]) / bbAmt;
      if (post[2] === "the ante") invested.set(post[1], (invested.get(post[1]) ?? 0) + amt);
      else add(post[1], amt);
      continue;
    }
    const dealt = l.match(/^Dealt to (.+?) \[(\S\S) (\S\S)\]/);
    if (dealt) {
      hero = dealt[1];
      try {
        heroCards = [parseCard(dealt[2]), parseCard(dealt[3])];
      } catch {
        heroCards = null;
      }
      continue;
    }
    if (!started) continue;
    const act = l.match(new RegExp(`^(.+?): (folds|checks|calls|bets|raises)(?: ${MONEY}([\\d.,]+))?(?: to ${MONEY}([\\d.,]+))?(.*)$`));
    if (act) {
      const p = act[1];
      const verb = act[2];
      const allin = /all-in/.test(act[5] ?? "");
      const before = streetInv.get(p) ?? 0;
      let amount = 0;
      let to = before;
      let type: HHActType = "fold";
      if (verb === "folds") type = "fold";
      else if (verb === "checks") type = "check";
      else if (verb === "calls") {
        type = "call";
        amount = num(act[3] ?? "0") / bbAmt;
        to = before + amount;
      } else if (verb === "bets") {
        type = "bet";
        amount = num(act[3] ?? "0") / bbAmt;
        to = before + amount;
      } else if (verb === "raises") {
        type = "raise";
        to = num(act[4] ?? act[3] ?? "0") / bbAmt;
        amount = to - before;
      }
      if (amount > 0) add(p, amount);
      streets[street].push({ player: p, type, amount: round2(amount), to: round2(to), allin });
      continue;
    }
    const unc = l.match(new RegExp(`^Uncalled bet \\(${MONEY}([\\d.,]+)\\) returned to (.+)$`));
    if (unc) {
      const p = unc[2];
      const amt = num(unc[1]) / bbAmt;
      invested.set(p, (invested.get(p) ?? 0) - amt);
      continue;
    }
    const col = l.match(new RegExp(`^(.+?) collected ${MONEY}([\\d.,]+) from`));
    if (col) {
      collected.set(col[1], (collected.get(col[1]) ?? 0) + num(col[2]) / bbAmt);
      continue;
    }
  }
  // GG 형식은 SUMMARY 이후에도 collected 줄이 없을 수 있음: "Seat n: X ... and won ($y)"
  if (collected.size === 0) {
    for (const l of lines) {
      const m = l.match(new RegExp(`^Seat \\d+: (.+?) (?:\\(.*?\\) )*(?:showed \\[.*?\\] and )?(?:won|collected) \\(${MONEY}([\\d.,]+)\\)`));
      if (m) collected.set(m[1], (collected.get(m[1]) ?? 0) + num(m[2]) / bbAmt);
    }
  }
  const heroNet = hero ? round2((collected.get(hero) ?? 0) - (invested.get(hero) ?? 0)) : 0;
  void sbAmt;
  return { id: hm[1], site, date, sb: sbAmt, bb: bbAmt, maxSeats, button, seats, hero, heroCards, streets, board, heroNet, raw };
}

function round2(x: number): number {
  return Math.round(x * 100) / 100;
}

export function parseAll(text: string): { hands: ParsedHand[]; skipped: number } {
  const parts = splitHands(text);
  const hands: ParsedHand[] = [];
  let skipped = 0;
  for (const p of parts) {
    const h = parseHand(p);
    if (h) hands.push(h);
    else skipped++;
  }
  return { hands, skipped };
}
