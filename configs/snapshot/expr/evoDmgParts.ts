// evoDmgParts intermediate - snapshot datasource.
//
// Per-source Evolution-Type Damage (진화 피해, statType evolution_dam_rate = 45)
// for the DPS player, each a fraction (0.20 = 20%). dpsEvolutionDamage ADDITIVELY
// sums karma + tree + supersonic + mpFurnace into the DPS tab's C21 cell (percent,
// default 0). `bluntThorn` is a boolean flag written to C25 (a checkbox).
//
// Bindings: root (karma), ref (evolution_dam_tree), $ (arkPassive).
import { snapshotExpr, type EvoDmgParts } from "../../_context.ts";

// Karma "evolution" track (raw_data/ArkPassiveKarma.json id 10000): rank R grants
// evolution_dam_rate R% (keyValue R*100). Rank is derived from root.karma.evolution
// via the same breakpoints the sheet's F21 uses.
const KARMA_RANK_BREAKPOINTS = [0, 1, 5, 9, 13, 17, 21];
const KARMA_PER_RANK = 0.01;

// Keystone evolution nodes handled specially (NOT via the machine-readable tree
// table): Blunt Thorn contributes 0 here but ticks the C25 checkbox; Supersonic
// Breakthrough and MP Furnace have speed-/MP-scaling evolution damage capped at
// 12% per level (assume the cap), so each contributes 0.12 x allocated level.
const BLUNT_THORN = 1040100;
const SUPERSONIC = 1040200;
const MP_FURNACE = 1040500;
const CAPPED_PER_LEVEL = 0.12;
const EXCLUDED_FROM_TREE = new Set([BLUNT_THORN, SUPERSONIC, MP_FURNACE]);

export default snapshotExpr<void, EvoDmgParts>(({ root, ref, $ }) => {
  // Karma: level -> rank (0-6) -> R%.
  const karmaLevel = root.karma?.evolution ?? 0;
  const karmaRank =
    KARMA_RANK_BREAKPOINTS.filter((b) => karmaLevel >= b).length - 1;
  const karma = karmaRank * KARMA_PER_RANK;

  // Evolution tree: sum every allocated node's machine-readable evolution damage
  // (per-level array), excluding the specially-handled keystone nodes.
  let tree = 0;
  for (const [id, perLevel] of Object.entries(ref.evolution_dam_tree ?? {})) {
    if (EXCLUDED_FROM_TREE.has(Number(id))) continue;
    const level = $.arkPassive.evo[Number(id)] ?? 0;
    if (level >= 1) tree += perLevel[level - 1] ?? 0;
  }

  // Supersonic Breakthrough / MP Furnace: 12% per allocated level (assumed cap).
  const supersonic = CAPPED_PER_LEVEL * ($.arkPassive.evo[SUPERSONIC] ?? 0);
  const mpFurnace = CAPPED_PER_LEVEL * ($.arkPassive.evo[MP_FURNACE] ?? 0);

  // Blunt Thorn: contributes 0 to C21, but ticks the C25 checkbox when allocated.
  const bluntThorn = ($.arkPassive.evo[BLUNT_THORN] ?? 0) > 0;

  return { karma, tree, supersonic, mpFurnace, bluntThorn };
});
