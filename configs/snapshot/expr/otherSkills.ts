// otherSkills intermediate - snapshot datasource.
// The player's other GEMMED skills (BB6:BD10), driven by the equipped gems
// (root.gems via $.skillGems) rather than the skill loadout: every skill that
// carries a damage or cooldown gem, in gem-equip order, minus the 3 already
// placed as ap1/ap2/brand (by id - only the PRIMARY brand is excluded). Each
// resolved to { id, cooldown (effectiveCooldown ms, same cdrTripod logic as
// classSkills - base cooldown when the skill isn't in the loadout so tripods are
// unknown), dmg, cdr gem levels from skillGems }. Paladin-only: the identity's
// cooldown gem (no dedicated sheet slot) parks its level in the first empty
// damage-gem slot (see below). Bindings: $, ref.skills, ref.gems, root.
import { snapshotExpr, type OtherSkill, type Skill } from "../../_context.ts";

export default snapshotExpr<void, OtherSkill[]>(({ root, $, ref }) => {
  const cs = $.classSkills;
  const used = new Set(
    [cs.ap1 && cs.ap1.id, cs.ap2 && cs.ap2.id, cs.brand && cs.brand.id].filter((x) => x != null)
  );
  const byId: Record<number, Skill> = {};
  (ref.skills || []).forEach((s) => {
    byId[s.id] = s;
  });
  const psById: Record<number, any> = {};
  (root.skills || []).forEach((s: any) => {
    psById[s.id] = s;
  });
  const effCd = (meta: Skill | undefined, ps: any) => {
    const tr = (ps && ps.tripods) || [];
    let cd = (meta && meta.cooldown) || 0;
    for (const t of (meta && meta.cdrTripods) || []) {
      if (tr[t.tier - 1] === t.option) cd += t.cd;
    }
    return cd;
  };
  // Skill ids that carry a gem, in the order gems appear in root.gems.
  const gemmedIds: number[] = [];
  const seen = new Set<number>();
  for (const g of root.gems || []) {
    for (const e of g.effects || []) {
      if ((e.type === 5 || e.type === 27) && !seen.has(e.id)) {
        seen.add(e.id);
        gemmedIds.push(e.id);
      }
    }
  }
  const list = gemmedIds
    .filter((id) => !used.has(id))
    .map((id): OtherSkill => {
      const meta = byId[id];
      const g = $.skillGems[id] || {};
      return {
        id,
        cooldown: meta ? effCd(meta, psById[id]) : "",
        dmg: g.dmg != null ? g.dmg : "",
        cdr: g.cdr != null ? g.cdr : "",
      };
    });

  // Paladin identity cooldown gem: paladins alone can slot a COOLDOWN gem on
  // their identity - an effect of type 35 targeting skill group 15001 (the Piety
  // skills, see GemSkillGroup.json). The sheet has no identity-cooldown slot, so
  // per spec it's sufficient to drop the gem's level into any available (empty)
  // damage-gem slot instead, so it still counts toward the gem-level total.
  const idCdGem = (root.gems || []).find((g: any) =>
    (g.effects || []).some((e: any) => e.type === 35 && e.id === 15001)
  );
  if (idCdGem) {
    const lv = ref.gems?.[idCdGem.id]?.level;
    if (lv != null) {
      const slot = list.find((o) => o.dmg === "");
      if (slot) slot.dmg = lv;
      else list.push({ id: 15001, cooldown: "", dmg: lv, cdr: "" });
    }
  }
  return list;
});
