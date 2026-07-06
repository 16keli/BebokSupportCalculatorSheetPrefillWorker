// skinBonusFromLoadout field - loadout datasource.
// Main-stat % from avatar skins across the 4 main avatar slots, weighted by
// rarity (legendary 2%, epic 1%, rare 0.5% each), returned as a fraction for the
// percent-formatted F18 cell. Only the 4 stat-bearing avatar slots count; the
// exact-slot match naturally ignores the purely cosmetic "*_outfit" slots.
// Feeds F18 (skinBonus) when the support gear comes from a manual character-link
// override (see fetchCharacterGearPhase in src/scraper.ts).
// Bindings: $ (activeLoadout, skinLegend, skinEpic, skinRare).
import { loadoutExpr } from "../../_context.ts";

export default loadoutExpr(({ $ }) => {
  const L = $.activeLoadout;
  if (!L) return "";
  const main = [
    "avatar_weapon",
    "avatar_head",
    "avatar_upper_body",
    "avatar_lower_body",
  ];
  const pct = (L.items || []).reduce((acc: number, i: any) => {
    if (main.indexOf(i.slot) < 0) return acc;
    if ($.skinLegend.has(i.id)) return acc + 2;
    if ($.skinEpic.has(i.id)) return acc + 1;
    if ($.skinRare.has(i.id)) return acc + 0.5;
    return acc;
  }, 0);
  return pct / 100;
});
