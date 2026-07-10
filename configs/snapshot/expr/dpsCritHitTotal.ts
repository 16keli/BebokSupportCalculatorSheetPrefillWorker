// dpsCritHitTotal field - snapshot datasource.
// "Damage on Crit Hit" multiplier for the DPS player, written to the "DPS players
// data (Serca)" tab's C22 cell (plain decimal, default 1). The crit-hit-damage
// sources combine MULTIPLICATIVELY on a base of 1:
//   C22 = (1 + critNode) * (1 + bracelet) * (1 + synergy).
// Parts come from critHitParts; see that expr for per-source detection.
import { snapshotExpr } from "../../_context.ts";

export default snapshotExpr(({ $ }) => {
  const p = $.critHitParts;
  return (1 + p.critNode) * (1 + p.bracelet) * (1 + p.synergy);
});
