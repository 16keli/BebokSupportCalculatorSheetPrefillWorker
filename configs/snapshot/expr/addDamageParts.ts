// addDamageParts intermediate - snapshot datasource.
//
// Per-source Additional Damage contributions for the DPS player, each a fraction
// (0.06 = 6%). dpsAddDmgTotal sums them into the DPS tab's C20 cell (percent
// formatted). Every source is read from the DPS snapshot except stronghold,
// which is a manual advanced input. Sources (see the sheet's "Additional Damage"
// section): weapon quality (folded into a computed weapon stat), the Master ark-
// passive evolution node, ark-grid side lines, the "Stable Attack" ark-grid core,
// bracelet additional damage (special-effect ability ids + raw skill_damage_rate
// rolls), and the stronghold farm bonus.
//
// Bindings: ref (cores, add_dmg_bracelet), input (dpsStronghold), $
// (itemBySlot, arkPassive, arkGrid).
import { snapshotExpr, type AddDamageParts } from "../../_context.ts";

// The weapon's post-quality computed value lives on a single stat with this id;
// /10000 yields the additional-damage fraction (2882 -> 0.2882 = 28.82%).
const WEAPON_STAT_ID = 10144000;
// Master evolution node (raw_data/ArkPassive.json id 1032200): assumed
// unconditional at its 5-stack max -> 1.7% x 5 = 8.5% additional damage.
const MASTER_EVO_NODE = 1032200;
const MASTER_EVO_PCT = 0.085;
// Each activated ark-grid side-node line grants this much additional damage.
// NOTE: counted as the SUM of side-line levels (Object.values($.arkGrid.side));
// flip to a distinct-line count here if that interpretation is preferred.
const SIDE_LINE_PCT = 0.0008086;
// The additional-damage ark-grid core is titled "Stable Attack" (cores.json);
// detect by title so new grades keep resolving.
const STABLE_ATTACK_TITLE = "Stable Attack";
// A bracelet stat at this index (StatType SKILL_DAMAGE_RATE) is a raw additional-
// damage roll; value is in hundredths of a percent (300 -> 3% -> /10000).
const SKILL_DAMAGE_RATE_INDEX = 50;

// "Stable Attack" core additional damage by reached point threshold + core grade
// (cores.json grade: 2 = relic, 3 = ancient). 14p is grade-independent; the 17p
// base splits relic/ancient; 18-20p add +0.23% per step over 17p.
function stableAttackPct(threshold: number, grade: number): number {
  if (threshold >= 17) {
    const base = grade >= 3 ? 0.028 : 0.014;
    return threshold >= 18 ? base + 0.0023 * (threshold - 17) : base;
  }
  if (threshold >= 14) return 0.007;
  return 0;
}

export default snapshotExpr<void, AddDamageParts>(({ ref, input, $ }) => {
  // Weapon: the single computed weapon stat already folds in quality.
  const weaponStat = ($.itemBySlot.weapon?.data?.stats || []).find(
    (s: { id: number }) => s.id === WEAPON_STAT_ID,
  );
  const weapon = (weaponStat?.value ?? 0) / 10000;

  // Ark Passive Master evolution node -> flat 8.5% when allocated.
  const evo = ($.arkPassive.evo[MASTER_EVO_NODE] ?? 0) > 0 ? MASTER_EVO_PCT : 0;

  // Ark grid side lines: sum of side-line levels x per-line coefficient.
  const side =
    Object.values($.arkGrid.side).reduce((a, b) => a + b, 0) * SIDE_LINE_PCT;

  // Ark grid "Stable Attack" core: threshold + grade schedule.
  let stable = 0;
  for (const b of Object.values($.arkGrid.byBase)) {
    const core = ref.cores?.cores?.[b.id];
    if (b.found && b.threshold != null && core?.title === STABLE_ATTACK_TITLE) {
      stable = stableAttackPct(b.threshold, core.grade);
      break;
    }
  }

  // Bracelet additional damage: sum every bracelet stat that grants it, either
  // as an "Additional Damage" special-effect ability id (data/add_dmg_bracelet.json,
  // e.g. 11041 -> 3.5%) or as a raw skill_damage_rate roll (index 50, value in
  // hundredths of a percent -> /10000, e.g. 300 -> 3%).
  const braceletStats = $.itemBySlot.bracelet?.data?.stats || [];
  const bracelet = braceletStats.reduce(
    (acc: number, s: { index: number; value?: number }) => {
      const tableFrac = ref.add_dmg_bracelet?.[s.index];
      if (tableFrac != null) return acc + tableFrac;
      if (s.index === SKILL_DAMAGE_RATE_INDEX)
        return acc + (s.value ?? 0) / 10000;
      return acc;
    },
    0,
  );

  // Stronghold farm bonus: manual select input (0 / 0.4 / 0.7 / 1.0 %).
  const stronghold = Number(input.dpsStronghold) / 100 || 0;

  return { weapon, evo, side, stable, bracelet, stronghold };
});
