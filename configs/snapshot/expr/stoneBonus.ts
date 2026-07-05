// stoneBonus field (F19) - snapshot datasource.
// Sum of activated engraving levels on the ability stone (penalty engravings
// 800-803 excluded). '' when no stone. Bindings: $ (itemBySlot, stoneEngravings).
import { snapshotExpr } from "../../_context.ts";

export default snapshotExpr(({ $ }) => {
  const s = $.itemBySlot.ability_stone;
  if (!s) return "";
  return ($.stoneEngravings || [])
    .filter((e) => !(e.id >= 800 && e.id <= 803))
    .reduce((a, e) => a + e.level, 0);
});
