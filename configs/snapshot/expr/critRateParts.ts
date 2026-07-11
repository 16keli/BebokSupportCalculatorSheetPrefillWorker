// critRateParts intermediate - snapshot datasource.
//
// Per-source crit-rate contributions for the DPS player, each a fraction (0.05 =
// 5%). dpsCritRateTotal ADDITIVELY sums them into the DPS tab's C24 cell (percent
// formatted, default 0) - crit rate is additive in-game (unlike the multiplicative
// C22 crit-hit-damage). Crit rate is statType CRITICAL_HIT_RATE (74). Sources:
// bracelet special-effect crit-rate lines (ability ids 11011-14), generic
// evolution nodes, class enlightenment nodes, a curated class synergy, the
// crit-rate engravings (Adrenaline / Precise Dagger), the raw Crit combat stat,
// and raw index-74 crit-rate lines (rings AND bracelets both carry these, with
// the same parameters).
//
// Bindings: root (engravings), ref (crit_rate_bracelet/enlightenment/synergy),
// input (dpsSpec, dpsRosterCrit, dpsPet), $ (arkPassive, itemBySlot,
// stoneEngravings).
import { snapshotExpr, type CritRateParts } from "../../_context.ts";

// Generic evolution-board crit-rate nodes (raw_data/ArkPassive.json). Each grants
// a flat crit rate that scales linearly per allocated level (keyValue = base x
// level, verified): id -> per-level fraction.
const EVO_NODES: Record<number, number> = {
  1020300: 0.04, // Keen Sense   (4% / 8%)
  1030200: 0.12, // Zealous Smite (12% / 24%)
  1030300: 0.1, // Strike        (10% / 20%)
  // Master: single level, +1.4% Crit Rate per stack at its 5-stack max -> 7%
  // (assumed unconditional, same as its 8.5% additional damage in addDamageParts).
  1032200: 0.07,
};
// Crit-rate engravings. Like Keen Blunt (critDmgParts.ts), each has TWO ids: the
// character engraving BOOK list (root.engravings) uses the +1000-offset id, the
// ability-STONE list (stoneEngravings) the un-offset base id. Both grant a base
// at legendary (grade 4) with no books plus a per-5-books increment; only Precise
// Dagger additionally rolls on the stone (per-rank bonus, ranks 1-4).
const ADRENALINE_BOOK_ID = 1299;
const ADRENALINE_BASE = 0.14;
const ADRENALINE_PER_5_BOOKS = 0.015;
const PRECISE_DAGGER_BOOK_ID = 1303;
const PRECISE_DAGGER_STONE_ID = 303;
const PRECISE_DAGGER_BASE = 0.18;
const PRECISE_DAGGER_PER_5_BOOKS = 0.0075;
const PRECISE_DAGGER_ROCK = [0.03, 0.0375, 0.0525, 0.06];
// Item stat-line indices: Crit combat stat = 15 (Spec = 16, Swift = 18 are
// confirmed neighbors); raw crit-rate % line = 74 (CRITICAL_HIT_RATE), carried by
// both rings and bracelets with the same parameters.
const CRIT_STAT_INDEX = 15;
const CRIT_RATE_INDEX = 74;
// Crit combat points -> crit-rate fraction (user-supplied; not in raw data).
const CRIT_STAT_DIVISOR = 2794;
// Raw crit-rate line value is in hundredths of a percent (95 -> 0.95%).
const CRIT_RATE_LINE_SCALE = 10000;
// The tier-1 evolution node "Crit +50" (raw_data/ArkPassive.json 1010100): each
// allocated point is +50 Crit, exactly like spec (1010200) / swift (1010400) in
// combatStats.ts. The flat roster + pet Crit aren't in the snapshot, so they come
// from advanced inputs (dpsRosterCrit, dpsPet) - mirroring the support's
// rosterSpec/rosterSwift/pet. The pet adds +160 to the stat it's assigned to;
// when dpsPet is unset it defaults to Crit iff the crit allocation is >= 20.
const CRIT_EVO_NODE = 1010100;
const CRIT_PER_POINT = 50;
const PET_STAT_BONUS = 160;
const PET_AUTO_CRIT_POINTS = 20;

export default snapshotExpr<void, CritRateParts>(({ root, ref, input, $ }) => {
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

  // Crit-rate engravings: base + per-5-books increment, plus (Precise Dagger only)
  // the ability stone's per-rank bonus. Books are derived exactly as in
  // engravingBooks.ts / critDmgParts.ts (grade05 -> 20, grade04 -> floor(progress/5)*5).
  const engravingBonus = (bookId: number, base: number, per5Books: number) => {
    const eng = (root.engravings || []).find(
      (x: { id: number }) => x.id === bookId,
    );
    if (!eng) return 0;
    const books =
      eng.grade === "engrave_grade05"
        ? 20
        : eng.grade === "engrave_grade04"
          ? Math.floor((eng.progress || 0) / 5) * 5
          : 0;
    return base + (books / 5) * per5Books;
  };
  let engravings =
    engravingBonus(
      ADRENALINE_BOOK_ID,
      ADRENALINE_BASE,
      ADRENALINE_PER_5_BOOKS,
    ) +
    engravingBonus(
      PRECISE_DAGGER_BOOK_ID,
      PRECISE_DAGGER_BASE,
      PRECISE_DAGGER_PER_5_BOOKS,
    );
  const daggerRank =
    $.stoneEngravings.find((e) => e.id === PRECISE_DAGGER_STONE_ID)?.level ?? 0;
  if (daggerRank >= 1) engravings += PRECISE_DAGGER_ROCK[daggerRank - 1] ?? 0;

  // Crit combat stat -> fraction via the divisor. Points come from the gear's
  // index-15 lines, the tier-1 "Crit +50" evolution node, the flat roster Crit
  // input, and the pet (+160 when assigned to Crit).
  const critPoints = $.arkPassive.evo[CRIT_EVO_NODE] ?? 0;
  let pet = input.dpsPet;
  if (!pet || pet === "auto")
    pet = critPoints >= PET_AUTO_CRIT_POINTS ? "crit" : "other";
  const critStat =
    (sumItemStat(CRIT_STAT_INDEX) +
      critPoints * CRIT_PER_POINT +
      (Number(input.dpsRosterCrit) || 0) +
      (pet === "crit" ? PET_STAT_BONUS : 0)) /
    CRIT_STAT_DIVISOR;

  // Raw crit-rate lines (index-74 stat, value in hundredths of a percent).
  // sumItemStat spans every equipped item, so this covers both ring and bracelet
  // index-74 rolls (same parameters).
  const ring = sumItemStat(CRIT_RATE_INDEX) / CRIT_RATE_LINE_SCALE;

  return { bracelet, evo, enlightenment, synergy, engravings, critStat, ring };
});
