// dpsEvolutionDamage field - snapshot datasource.
// Additive Evolution-Type Damage bonus for the DPS player, written to the "DPS
// players data (Serca)" tab's C21 cell (percent, default 0). Sums karma + tree +
// Supersonic Breakthrough + MP Furnace from evoDmgParts (Blunt Thorn is 0 here;
// it ticks the C25 checkbox instead). See that expr for per-source detection.
import { snapshotExpr } from "../../_context.ts";

export default snapshotExpr(({ $ }) => {
  const p = $.evoDmgParts;
  return p.karma + p.tree + p.supersonic + p.mpFurnace;
});
