// awakeningRock field (BC24) - snapshot datasource.
// Activation level (0-4) of the awakening engraving (id 255) on the ability
// stone (see stoneEngravings). '' when no stone. Bindings: $ (itemBySlot,
// stoneEngravings).
import { snapshotExpr } from "../../_context.ts";

export default snapshotExpr(({ $ }) => {
  const s = $.itemBySlot.ability_stone;
  if (!s) return "";
  const a = ($.stoneEngravings || []).find((e) => e.id === 255);
  return a ? a.level : 0;
});
