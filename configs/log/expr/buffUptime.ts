// buffUptime - log datasource. Parameterized module replacing cheersUptime,
// majorChordWingsUptime, strengthOrbUptime and flashOrbUptime: the share of
// party damage buffed by a set of buff ids, `(matchedDamage / partyDamage)`
// to 4 dp, '' when the party dealt no damage. The buff-id predicate is data,
// supplied via params (exactly one form is used per field, reproducing each
// original file's filter):
//   params.prefix - Math.floor(id / 100) === prefix  (orbs: 5234 / 5235; per
//     raw_data/SkillBuff.json, Strength/Flash Orb ids are laid out
//     <prefix><tier*20><1-13 sub-index>, e.g. 523401-523493, so the stable
//     grouping digit is the hundreds place, not the tens place)
//   params.exact  - id === exact
//   params.ranges - any [lo, hi] with lo <= id <= hi  (major chord / wings / cheers)
// Bindings: $ (partyDamageDealt, dpsPlayers), sum.
import { logExpr } from "../../_context.ts";

export default logExpr<{ prefix?: number; exact?: number; ranges?: [number, number][] }>(
  ({ $, sum }, p) => {
    const d = $.partyDamageDealt;
    if (!d) return "";
    const match = (id: number) =>
      (p.prefix != null && Math.floor(id / 100) === p.prefix) ||
      (p.exact != null && id === p.exact) ||
      (p.ranges?.some(([lo, hi]) => id >= lo && id <= hi) ?? false);
    const t = sum($.dpsPlayers, (player) =>
      Object.entries(player.damageStats.buffedBy || {})
        .filter((kv) => match(+kv[0]))
        .reduce((a, kv) => a + (kv[1] as number), 0)
    );
    return (t / d).toFixed(4);
  }
);
