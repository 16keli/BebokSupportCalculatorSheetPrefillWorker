// apBuffUptimeProportion field (BC17) - log datasource.
// Of the party's attack-power-buff damage (Attack Buff Categorization -
// encounterDamageStats.buffs[id].uniqueGroup in atkPwrGrp [101105 Pala, 314004
// Artist, 101204 Bard, 480030 Valk]), the proportion attributable to the
// support's ap1 skill. Numerator = AP-buffedBy damage whose buff skillId is an
// ap1 skill (ref.skills filtered to type==='ap1'); denominator = all AP-buffedBy
// damage (ap1 + ap2). Bindings: root, ref.skills, $ (dpsPlayers), sum.
import { logExpr } from "../../_context.ts";

export default logExpr(({ root, ref, $, sum }) => {
  const buffs =
    (root.encounterDamageStats && root.encounterDamageStats.buffs) || {};
  const AP = new Set([101105, 314004, 101204, 480030]);
  const AP1 = new Set(
    (ref.skills || []).filter((s) => s.type === "ap1").map((s) => s.id),
  );
  const acc = (p: any) =>
    Object.entries(p.damageStats.buffedBy || {}).reduce(
      (o, kv) => {
        const b = buffs[kv[0]];
        if (b && AP.has(b.uniqueGroup)) {
          o.total += kv[1] as number;
          if (AP1.has(b.skillId)) o.ap1 += kv[1] as number;
        }
        return o;
      },
      { total: 0, ap1: 0 },
    );
  const total = sum($.dpsPlayers, (p) => acc(p).total);
  if (!total) return "";
  const ap1 = sum($.dpsPlayers, (p) => acc(p).ap1);
  return (ap1 / total).toFixed(4);
});
