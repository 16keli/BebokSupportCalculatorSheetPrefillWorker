// critDmgParts intermediate - snapshot datasource.
//
// Per-source crit-DAMAGE bonus contributions for the DPS player, each a fraction
// (0.10 = 10%). dpsCritDmgTotal adds them to the 2.0 base into the DPS tab's C23
// cell (plain decimal): C23 = 2.0 + bracelet + ring + keenBlunt + arkPassive.
// Crit damage is statType CRITICAL_DAM_RATE (76) - the crit multiplier SIZE,
// distinct from crit rate (74, C24) and the "damage on crit hit" bucket (C22).
//
// Bindings: root (engravings), ref (crit_dmg_bracelet/arkpassive), $ (arkPassive,
// itemBySlot, stoneEngravings).
import { snapshotExpr, type CritDmgParts } from "../../_context.ts";

// Raw crit-damage stat line index (CRITICAL_DAM_RATE); value in hundredths of a
// percent (95 -> 0.95%), same convention as the crit-rate line (index 74).
const CRIT_DMG_INDEX = 76;
const CRIT_DMG_LINE_SCALE = 10000;
// Keen Blunt Weapon. It has TWO ids: the character engraving BOOK list
// (root.engravings) uses the +1000-offset id 1141, while the ability-STONE
// engraving list (stoneEngravings) uses the un-offset base id 141 - the same
// split as awakening (1255 vs 255). Crit damage comes from two parts:
//   - the engraving: 44% base at legendary (grade 4) with no books, +2% per 5
//     books (books derived exactly as engravingBooks.ts: grade05 -> 20,
//     grade04 -> floor(progress/5)*5, else 0).
//   - the ability stone: a per-rank bonus at the stone's Keen Blunt rank (0-4,
//     from stoneEngravings, the generalized rock-level source awakeningRock wraps).
const KEEN_BLUNT_BOOK_ID = 1141;
const KEEN_BLUNT_STONE_ID = 141;
const KEEN_BLUNT_BASE = 0.44;
const KEEN_BLUNT_PER_5_BOOKS = 0.02;
const KEEN_BLUNT_ROCK = [0.075, 0.094, 0.132, 0.15];

export default snapshotExpr<void, CritDmgParts>(({ root, ref, $ }) => {
  // Bracelet crit-damage lines (Ability ids 11021-11024 -> 0.10/0.084/0.068/0.052).
  const braceletStats = $.itemBySlot.bracelet?.data?.stats || [];
  const bracelet = braceletStats.reduce(
    (acc: number, s: { index: number }) =>
      acc + (ref.crit_dmg_bracelet?.[s.index] ?? 0),
    0,
  );

  // Raw index-76 crit-damage lines across every item (rings and bracelets carry
  // these with the same parameters).
  const ring =
    Object.values($.itemBySlot).reduce(
      (
        acc: number,
        item: { data?: { stats?: { index: number; value?: number }[] } },
      ) =>
        acc +
        (item?.data?.stats || []).reduce(
          (a: number, s: { index: number; value?: number }) =>
            s.index === CRIT_DMG_INDEX ? a + (s.value ?? 0) : a,
          0,
        ),
      0,
    ) / CRIT_DMG_LINE_SCALE;

  // Keen Blunt Weapon crit damage = engraving part + ability-stone part.
  let keenBlunt = 0;
  // Engraving part: base + 2% per 5 books, only when the engraving is equipped.
  const eng = (root.engravings || []).find(
    (x: { id: number }) => x.id === KEEN_BLUNT_BOOK_ID,
  );
  if (eng) {
    const books =
      eng.grade === "engrave_grade05"
        ? 20
        : eng.grade === "engrave_grade04"
          ? Math.floor((eng.progress || 0) / 5) * 5
          : 0;
    keenBlunt += KEEN_BLUNT_BASE + (books / 5) * KEEN_BLUNT_PER_5_BOOKS;
  }
  // Ability-stone part: per-rank bonus at the stone's Keen Blunt rank (1-4).
  const keenRank =
    $.stoneEngravings.find((e) => e.id === KEEN_BLUNT_STONE_ID)?.level ?? 0;
  if (keenRank >= 1) keenBlunt += KEEN_BLUNT_ROCK[keenRank - 1] ?? 0;

  // Ark passive: curated node id -> per-level crit-damage array. A node is either
  // an evolution or an enlightenment node (disjoint id ranges); the array is
  // indexed by the allocated level.
  let arkPassive = 0;
  for (const [id, perLevel] of Object.entries(ref.crit_dmg_arkpassive ?? {})) {
    const level =
      ($.arkPassive.evo[Number(id)] || $.arkPassive.enl[Number(id)]) ?? 0;
    if (level >= 1) arkPassive += perLevel[level - 1] ?? 0;
  }

  return { bracelet, ring, keenBlunt, arkPassive };
});
