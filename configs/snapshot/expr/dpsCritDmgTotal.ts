// dpsCritDmgTotal field - snapshot datasource.
// Absolute crit-damage multiplier for the DPS player, written to the "DPS players
// data (Serca)" tab's C23 cell (plain decimal, default 2.0). Crit damage has a
// 2.0 (200%) base in-game; the bonus sources add on top. Parts come from
// critDmgParts; see that expr for the per-source detection and coefficients.
import { snapshotExpr } from "../../_context.ts";

// In-game base crit-damage multiplier (200%).
const CRIT_DMG_BASE = 2.0;

export default snapshotExpr(({ $ }) => {
  const p = $.critDmgParts;
  return CRIT_DMG_BASE + p.bracelet + p.ring + p.keenBlunt + p.arkPassive;
});
