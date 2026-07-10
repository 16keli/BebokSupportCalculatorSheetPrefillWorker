// critRateParts intermediate - snapshot datasource.
//
// Per-source crit-rate contributions for the DPS player, each a fraction (0.05 =
// 5%). dpsCritRateTotal ADDITIVELY sums them into the DPS tab's C24 cell (percent
// formatted, default 0) - crit rate is additive in-game (unlike the multiplicative
// C22 crit-hit-damage). Crit rate is statType CRITICAL_HIT_RATE (74). Sources:
// bracelet crit-rate lines, generic evolution nodes, class enlightenment nodes,
// a curated class synergy, the raw Crit combat stat, and ring crit-rate lines.
//
// Bindings: ref (crit_rate_bracelet/enlightenment/synergy), input (dpsSpec),
// $ (arkPassive, itemBySlot).
import { snapshotExpr, type CritRateParts } from "../../_context.ts";

// Generic evolution-board crit-rate nodes (raw_data/ArkPassive.json). Each grants
// a flat crit rate that scales linearly per allocated level (keyValue = base x
// level, verified): id -> per-level fraction.
const EVO_NODES: Record<number, number> = {
  1020300: 0.04, // Keen Sense   (4% / 8%)
  1030200: 0.12, // Zealous Smite (12% / 24%)
  1030300: 0.1, // Strike        (10% / 20%)
};
// Accessory/bracelet stat-line indices: Crit combat stat = 15 (Spec = 16, Swift =
// 18 are confirmed neighbors); ring crit-rate % line = 74 (CRITICAL_HIT_RATE).
const CRIT_STAT_INDEX = 15;
const CRIT_RATE_INDEX = 74;
// Crit combat points -> crit-rate fraction (user-supplied; not in raw data).
const CRIT_STAT_DIVISOR = 2794;
// Ring crit-rate line value is in hundredths of a percent (95 -> 0.95%).
const CRIT_RATE_LINE_SCALE = 10000;

export default snapshotExpr<void, CritRateParts>(({ ref, input, $ }) => {
  // Sum a stat-line `value` across every equipped item's stats at `index`.
  const sumItemStat = (index: number) =>
    Object.values($.itemBySlot).reduce(
      (
        acc: number,
        item: { data?: { stats?: { index: number; value?: number }[] } },
      ) =>
        acc +
        (item?.data?.stats || []).reduce(
          (a: number, s: { index: number; value?: number }) =>
            s.index === index ? a + (s.value ?? 0) : a,
          0,
        ),
      0,
    );

  // Bracelet crit-rate lines (Ability ids 11011-11014 -> 0.05/0.042/0.034/0.026).
  const braceletStats = $.itemBySlot.bracelet?.data?.stats || [];
  const bracelet = braceletStats.reduce(
    (acc: number, s: { index: number }) =>
      acc + (ref.crit_rate_bracelet?.[s.index] ?? 0),
    0,
  );

  // Evolution nodes: per-level fraction x allocated level.
  let evo = 0;
  for (const [id, perLevel] of Object.entries(EVO_NODES))
    evo += perLevel * ($.arkPassive.evo[Number(id)] ?? 0);

  // Enlightenment tree: curated node id -> per-level fraction, x allocated level.
  let enlightenment = 0;
  for (const [id, perLevel] of Object.entries(
    ref.crit_rate_enlightenment ?? {},
  ))
    enlightenment += perLevel * ($.arkPassive.enl[Number(id)] ?? 0);

  // Class crit-rate synergy: curated table keyed by the DPS's loa-logs spec.
  const synergy = ref.crit_rate_synergy?.[String(input.dpsSpec)] ?? 0;

  // Raw Crit combat stat (sum of index-15 lines) -> fraction via the divisor.
  const critStat = sumItemStat(CRIT_STAT_INDEX) / CRIT_STAT_DIVISOR;

  // Ring crit-rate lines (index-74 stat, value in hundredths of a percent).
  const ring = sumItemStat(CRIT_RATE_INDEX) / CRIT_RATE_LINE_SCALE;

  return { bracelet, evo, enlightenment, synergy, critStat, ring };
});
