// dpsAddDmgTotal field - snapshot datasource.
// Additive sum of the DPS player's Additional Damage sources (a fraction, e.g.
// 0.2882 = 28.82%), written to the "DPS players data (Serca)" tab's C20 cell
// (percent formatted). Parts come from addDamageParts; see that expr for the
// per-source detection and coefficients.
import { snapshotExpr } from "../../_context.ts";

export default snapshotExpr(({ $ }) => {
  const p = $.addDamageParts;
  return p.weapon + p.evo + p.side + p.stable + p.bracelet + p.stronghold;
});
