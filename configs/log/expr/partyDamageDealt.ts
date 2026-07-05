// partyDamageDealt - log datasource. The uptime DENOMINATOR: party-wide
// *buffable* damage, i.e. each DPS player's damageDealt minus their FIXED
// (unbuffable) damage. Fixed damage can't receive any buff, so leaving it in
// the denominator understates every uptime ratio (the numerators -
// buffedBySupport / buffedBy[...] - already exclude it). Fixed damage =
//   - hyper-awakening: damageStats.hyperAwakeningDamage, and
//   - skills flagged special:true (e.g. orbs like "Orb of Sacred Nature").
// The two are disjoint in the log (hyper-awakening skills are never special), so
// they sum without double-counting; the `!isHyperAwakening` guard is defensive.
// Bindings: $ (dpsPlayers), sum.
import { logExpr } from "../../_context.ts";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const fixedDamage = (p: any): number =>
  (p.damageStats?.hyperAwakeningDamage || 0) +
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  Object.values(p.skills || {}).reduce(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (a: number, s: any) => a + (s.special && !s.isHyperAwakening ? s.totalDamage || 0 : 0),
    0
  );

export default logExpr(({ $, sum }) =>
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  sum($.dpsPlayers, (p: any) => (p.damageStats?.damageDealt || 0) - fixedDamage(p))
);
