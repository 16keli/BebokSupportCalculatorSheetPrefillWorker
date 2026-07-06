// combatStats intermediate - snapshot datasource (authoritative final values).
// Computes the sheet's Specialization (F14) and Swiftness (F15) totals from the
// support's own snapshot: root.arkPassive.evolution holds the ark-passive tree
// (node id -> level); each allocated point = +50 to the actual stat. The flat
// roster + pet bonuses aren't in the snapshot, so they come from advanced inputs:
//   input.rosterSpec  - flat roster Specialization (default 75)
//   input.rosterSwift - flat roster Swiftness (default 77)
//   input.pet         - "spec" | "swiftness" | "other"; the pet adds +160 to
//                       the chosen stat. The UI seeds this from the same rule
//                       "auto" used to apply (spec if the evolution spec
//                       allocation is maxed at 30, else swiftness) but always
//                       sends a resolved value; the "auto"/empty fallback
//                       below is kept only as a defensive default.
// Returns { spec, swift, pet } (pet = the resolved choice).
import { snapshotExpr, type CombatStats } from "../../_context.ts";

export default snapshotExpr<void, CombatStats>(({ root, input }) => {
  const evo = (root.arkPassive && root.arkPassive.evolution) || [];
  const specPts =
    (evo.find((n: any) => n.id === 1010200) || { level: 0 }).level || 0;
  const swiftPts =
    (evo.find((n: any) => n.id === 1010400) || { level: 0 }).level || 0;

  const rosterSpec = Number(input.rosterSpec) || 0;
  const rosterSwift = Number(input.rosterSwift) || 0;

  let pet = input.pet;
  if (!pet || pet === "auto") pet = specPts === 30 ? "spec" : "swiftness";

  return {
    spec: specPts * 50 + rosterSpec + (pet === "spec" ? 160 : 0),
    swift: swiftPts * 50 + rosterSwift + (pet === "swiftness" ? 160 : 0),
    pet,
  };
});
