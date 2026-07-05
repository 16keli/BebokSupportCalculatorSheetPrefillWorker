// skillGems intermediate - snapshot datasource.
// Map of skill id -> { dmg, cdr } gem LEVELS. Walks the player's equipped gems
// (root.gems): effect type 5 = skill-damage gem, type 27 = skill-cooldown gem,
// both keyed by the target skill id; level from ref.gems. Bindings: root, ref.
import { snapshotExpr, type SkillGems } from "../../_context.ts";

export default snapshotExpr<void, SkillGems>(({ root, ref }) => {
  const out: SkillGems = {};
  for (const g of root.gems || []) {
    const lv = ref.gems?.[g.id]?.level;
    for (const e of g.effects || []) {
      if (e.type === 5) {
        (out[e.id] || (out[e.id] = {})).dmg = lv;
      } else if (e.type === 27) {
        (out[e.id] || (out[e.id] = {})).cdr = lv;
      }
    }
  }
  return out;
});
