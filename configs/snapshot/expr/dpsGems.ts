// dpsGems - snapshot datasource. The DPS's gemmed skills as {dmg, cdr} gem-level
// pairs, one row per gemmed skill (or skill GROUP), in gem-equip order. Feeds
// the DPS tab's H3:I11 block via the sheet's gemLevel.ts transform.
//
// Gems target skills two ways (see raw_data/GemSkillGroup.json):
//   - single skill  - effect type 5 (damage) / 27 (cooldown), keyed by skill id
//   - skill GROUP   - effect type 34 (damage) / 35 (cooldown), keyed by the
//     group id, which expands to a set of skill ids (ref.gem_skill_groups).
// A skill's damage-group and cooldown-group are DISTINCT ids over the SAME skill
// set (e.g. 170006/170007 -> [49260,49270], "Blaze Sweep"), so we key groups by
// their sorted skill set to merge the dmg+cdr rows into one. Levels come from
// ref.gems[gem.id].level. Unlike the support's otherSkills, nothing is excluded:
// a DPS on a support class still lists skills the support config would treat as
// ap1/ap2/brand. Bindings: root.gems, ref.gems, ref.gem_skill_groups.
import { snapshotExpr } from "../../_context.ts";

interface GemUnit {
  dmg: number | "";
  cdr: number | "";
}

export default snapshotExpr<void, GemUnit[]>(({ root, ref }) => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const groups = (ref.gem_skill_groups || {}) as Record<string, number[]>;
  const order: string[] = [];
  const units: Record<string, GemUnit> = {};
  const unit = (key: string): GemUnit => {
    if (!units[key]) {
      units[key] = { dmg: "", cdr: "" };
      order.push(key);
    }
    return units[key]!;
  };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  for (const g of (root.gems || []) as any[]) {
    const level = ref.gems?.[g.id]?.level;
    if (level == null) continue;
    for (const e of g.effects || []) {
      let key: string | null = null;
      let kind: "dmg" | "cdr" | null = null;
      if (e.type === 5) { key = "s:" + e.id; kind = "dmg"; }
      else if (e.type === 27) { key = "s:" + e.id; kind = "cdr"; }
      else if (e.type === 34 || e.type === 35) {
        const skills = groups[e.id];
        if (!skills) continue; // unknown group - not a skill gem we model
        key = "g:" + [...skills].sort((a, b) => a - b).join(",");
        kind = e.type === 34 ? "dmg" : "cdr";
      }
      if (!key || !kind) continue;
      const u = unit(key);
      if (u[kind] === "") u[kind] = level; // first gem of this kind wins
    }
  }

  return order.map((k) => units[k]!);
});
