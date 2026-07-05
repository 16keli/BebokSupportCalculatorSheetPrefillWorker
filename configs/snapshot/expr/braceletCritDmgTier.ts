// braceletCritDmgTier field - snapshot datasource.
// Bracelet crit-damage tier 1(high)-3(low) from stat index 11091-11093; ''
// when absent. Bindings: $ (itemBySlot).
import { snapshotExpr } from "../../_context.ts";

export default snapshotExpr(({ $ }) => {
  const s = ($.itemBySlot.bracelet?.data?.stats || []).find(
    (x: any) => x.index >= 11091 && x.index <= 11093
  );
  return s ? s.index - 11091 + 1 : "";
});
