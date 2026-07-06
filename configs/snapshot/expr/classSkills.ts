// classSkills intermediate - snapshot datasource.
// The player class's ap1 / ap2 / brand skill (from skills.json by classId+type),
// each { id, type, level, cooldown (base ms), effectiveCooldown (ms after taken
// cooldown tripods) } or null. root.classId is the lowercase class NAME, while
// skills.json keys on the numeric classId, so NAME2ID maps the 4 support classes
// (a numeric classId passes through). Every support has one ap1 and one ap2.
// A class may DESIGNATE several brand skills (skills.json type "brand"); `brands`
// lists every one DETECTED in the build (level > 0 in root.skills, most-leveled
// first) and `brand` designates the primary - the first of `brands`, i.e. highest
// level with ties broken by skills.json order (deterministic but arbitrary). When
// no brand skill is slotted, `brands` is empty and `brand` falls back to the
// class's highest-defined brand so the brand slot still resolves (matching prior
// behaviour). effectiveCooldown applies each matching cdrTripod delta.
// Bindings: root, ref.skills.
import {
  snapshotExpr,
  type ClassSkill,
  type ClassSkills,
  type Skill,
} from "../../_context.ts";

export default snapshotExpr<void, ClassSkills>(({ root, ref }) => {
  // Snapshots carry the class's INTERNAL name, not the display name (verified
  // against samples): paladin = "holyknight", valkyrie = "holyknight_female",
  // artist = "yinyangshi"; bard is plain "bard". Display-name aliases are kept
  // as defensive fallbacks.
  const NAME2ID: Record<string, number> = {
    paladin: 105,
    holyknight: 105,
    valkyrie: 113,
    holyknight_female: 113,
    bard: 204,
    artist: 602,
    yinyangshi: 602,
  };
  const cls = NAME2ID[String(root.classId).toLowerCase()] ?? root.classId;
  const list = (ref.skills || []).filter((s) => s.classId === cls && s.type);
  const playerSkill = (id: number) =>
    (root.skills || []).find((k: any) => k.id === id);
  const lvl = (id: number) => (playerSkill(id) || {}).level || 0;
  const effCd = (s: Skill) => {
    const tr = (playerSkill(s.id) || {}).tripods || [];
    let cd = s.cooldown || 0;
    for (const t of s.cdrTripods || []) {
      if (tr[t.tier - 1] === t.option) cd += t.cd;
    }
    return cd;
  };
  const resolve = (s: Skill): ClassSkill => ({
    id: s.id,
    type: s.type,
    level: lvl(s.id),
    cooldown: s.cooldown,
    effectiveCooldown: effCd(s),
  });
  const pick = (t: string): ClassSkill | null => {
    const c = list.filter((s) => s.type === t);
    if (!c.length) return null;
    return resolve(c.reduce((a, b) => (lvl(b.id) > lvl(a.id) ? b : a)));
  };
  // All designated brand skills the player actually runs (level > 0), highest
  // level first (ties -> skills.json order). The first is the primary brand; if
  // none are slotted, fall back to the class's highest-defined brand.
  const brands = list
    .filter((s) => s.type === "brand" && lvl(s.id) > 0)
    .sort((a, b) => lvl(b.id) - lvl(a.id))
    .map(resolve);
  return {
    ap1: pick("ap1"),
    ap2: pick("ap2"),
    brand: brands[0] ?? pick("brand"),
    brands,
  };
});
