// dpsCritRateTotal field - snapshot datasource.
// Crit-rate bonus aggregate for the DPS player, written to the "DPS players data
// (Serca)" tab's C24 cell (percent formatted, default 0). Crit rate is additive,
// so the parts simply sum. Parts come from critRateParts; see that expr for the
// per-source detection and coefficients.
import { snapshotExpr } from "../../_context.ts";

export default snapshotExpr(({ $ }) => {
  const p = $.critRateParts;
  return (
    p.bracelet +
    p.evo +
    p.enlightenment +
    p.synergy +
    p.engravings +
    p.critStat +
    p.ring
  );
});
