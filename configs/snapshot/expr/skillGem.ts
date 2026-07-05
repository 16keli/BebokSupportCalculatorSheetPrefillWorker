// skillGem - snapshot datasource. Parameterized module replacing the six
// {ap1,ap2,brand}Skill{Dmg,Cdr}Gem files: the gem LEVEL slotted on one of the
// class's skills, '' when none.
//   params.slot - which class skill (ap1 | ap2 | brand)
//   params.kind - which gem effect: 'dmg' (type 5) or 'cdr' (type 27)
// Bindings: $ (classSkills, skillGems).
import { snapshotExpr } from "../../_context.ts";

export default snapshotExpr<{ slot: "ap1" | "ap2" | "brand"; kind: "dmg" | "cdr" }>(
  ({ $ }, { slot, kind }) => {
    const s = $.classSkills[slot];
    if (!s) return "";
    const g = $.skillGems[s.id];
    return g?.[kind] ?? "";
  }
);
