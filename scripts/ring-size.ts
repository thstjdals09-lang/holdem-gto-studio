import { buildRingTree, RING_FORMATS } from "../src/engine/ring";
for (const f of RING_FORMATS) {
  const t = buildRingTree(f);
  const types: Record<string, number> = {};
  for (const x of t.terminals) types[x.type] = (types[x.type] ?? 0) + 1;
  let slots = 0;
  for (const d of t.decisions) slots += d.actions.length;
  const mw = t.terminals.filter((x) => x.type !== "fold" && x.folded.filter((f) => !f).length >= 3).length;
  console.log(f.id, "decisions", t.decisions.length, "actionSlots", slots, "terminals", JSON.stringify(types), "multiway", mw);
  console.log("  root actions:", (t.root as any).actions.map((a: any) => a.label).join(", "));
}
