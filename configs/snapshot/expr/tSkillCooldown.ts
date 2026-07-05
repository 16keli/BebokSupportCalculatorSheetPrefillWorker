// tSkillCooldown field (BD11) - snapshot datasource.
// Default (base) cooldown (ms) of the class's T skill - a fixed skill id per
// class (Bard 21300 / Paladin 36260 / Valkyrie 48510 / Artist 31950). No tripod
// reduction is applied. '' for an unknown class. Bindings: root, ref.skills.
import { snapshotExpr } from "../../_context.ts";

export default snapshotExpr(({ root, ref }) => {
  const TID: Record<string, number> = { paladin: 36260, valkyrie: 48510, bard: 21300, artist: 31950 };
  const id = TID[String(root.classId).toLowerCase()];
  if (id == null) return "";
  const s = (ref.skills || []).find((k) => k.id === id);
  return s && s.cooldown != null ? s.cooldown : "";
});
