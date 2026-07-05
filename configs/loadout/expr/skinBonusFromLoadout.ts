// skinBonusFromLoadout field - loadout datasource.
// Auto-detected legendary-skin count (0-4) across the 4 main avatar slots.
// Superseded by the manual skinBonus advanced input (-> F18); kept (unbound) for
// when loadout fetching is enabled. Bindings: $ (activeLoadout, legendarySkins).
import { loadoutExpr } from "../../_context.ts";

export default loadoutExpr(({ $ }) => {
  const L = $.activeLoadout;
  if (!L) return "";
  const main = ["avatar_weapon", "avatar_head", "avatar_upper_body", "avatar_lower_body"];
  const set = $.legendarySkins;
  return (L.items || []).filter((i: any) => main.indexOf(i.slot) >= 0 && set.has(i.id)).length;
});
