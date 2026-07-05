// gemLevel - sheet-side transform for the DPS tab's gem block (H3:I11).
// The bound field (dpsGemmedSkills) is the DPS's full list of gemmed skills in
// gem-equip order. transformArg = the 0-based row index; transformContext picks
// the column: "dmg" = skill-damage gem level, "cdr" = skill-cooldown gem level.
// '' (skipped) when that row has no skill or no gem of that kind - so rows past
// the DPS's gem count, or a skill missing one gem type, stay blank.
import { transform, type OtherSkill } from "../../_context.ts";

export default transform<void, number | "">(({ raw, arg, ctx }) => {
  const skills = (raw as OtherSkill[]) || [];
  const s = skills[Number(arg)];
  if (!s) return "";
  const v = ctx === "cdr" ? s.cdr : s.dmg;
  return v == null || v === "" ? "" : v;
});
