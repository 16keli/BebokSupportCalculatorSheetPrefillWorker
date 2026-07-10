// critHitParts intermediate - snapshot datasource.
//
// Per-source "Damage on Crit Hit" contributions for the DPS player, each a
// fraction (0.12 = 12%). dpsCritHitTotal combines them MULTIPLICATIVELY into the
// DPS tab's C22 cell as a multiplier that defaults to 1:
//   C22 = (1 + critNode) * (1 + bracelet) * (1 + synergy).
// "Crit Hit Damage" is a CombatEffect (modify_damage_when_critical) bucket, NOT a
// StatType. Sources: the "Critical" ark-passive evolution node, the bracelet's
// crit-hit-damage lines (they ride on both the crit-rate and crit-damage rolls),
// and a curated class crit-hit-damage synergy keyed by the DPS's loa-logs spec.
//
// Bindings: ref (crit_hit_synergy), input (dpsSpec), $ (arkPassive, itemBySlot).
import { snapshotExpr, type CritHitParts } from "../../_context.ts";

// Ark-passive "Critical" evolution node (raw_data/ArkPassive.json id 1032100):
// "On Crit Hit, Damage +12%" - a flat 12% when allocated (single level).
const CRIT_NODE = 1032100;
const CRIT_NODE_PCT = 0.12;
// A bracelet crit-hit-damage line grants a flat +1.5% regardless of tier. It
// rides on both the crit-rate roll (Ability ids 11011-11014) and the crit-damage
// roll (11021-11024); a bracelet stat's `index` IS the Ability id.
const BRACELET_CRIT_HIT_PCT = 0.015;
const CRIT_RATE_RANGE: [number, number] = [11011, 11014];
const CRIT_DMG_RANGE: [number, number] = [11021, 11024];

const inRange = (n: number, [lo, hi]: [number, number]) => n >= lo && n <= hi;

export default snapshotExpr<void, CritHitParts>(({ ref, input, $ }) => {
  // Ark Passive "Critical" evolution node -> flat 12% when allocated.
  const critNode = ($.arkPassive.evo[CRIT_NODE] ?? 0) > 0 ? CRIT_NODE_PCT : 0;

  // Bracelet: +1.5% for each crit-rate / crit-damage line present (summed).
  const braceletStats = $.itemBySlot.bracelet?.data?.stats || [];
  const bracelet = braceletStats.reduce(
    (acc: number, s: { index: number }) =>
      inRange(s.index, CRIT_RATE_RANGE) || inRange(s.index, CRIT_DMG_RANGE)
        ? acc + BRACELET_CRIT_HIT_PCT
        : acc,
    0,
  );

  // Class crit-hit-damage synergy: curated table keyed by the DPS's loa-logs
  // spec (e.g. "Judgment" = Judgment Paladin), injected as input.dpsSpec.
  const synergy = ref.crit_hit_synergy?.[String(input.dpsSpec)] ?? 0;

  return { critNode, bracelet, synergy };
});
