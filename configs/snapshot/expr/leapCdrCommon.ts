// leapCdrCommon field (BB27) - snapshot datasource.
// Level of the class's "Release Potential" leap node (Hyper Awakening
// Technique CDR, 2%/level) - a fixed node id per class (Bard 2215400 /
// Paladin 2365400 / Valkyrie 2485400 / Artist 2315400; see data/ark_passive.json
// "leap"). Snapshots carry the class's INTERNAL name for 3 of the 4 classes
// (paladin = "holyknight", valkyrie = "holyknight_female", artist =
// "yinyangshi" - see classSkills.ts), so both aliases are keyed here. 0 for
// an unknown class. Bindings: root.
import { snapshotExpr } from "../../_context.ts";

const NODE_ID: Record<string, number> = {
  bard: 2215400,
  paladin: 2365400,
  holyknight: 2365400,
  valkyrie: 2485400,
  holyknight_female: 2485400,
  artist: 2315400,
  yinyangshi: 2315400,
};

export default snapshotExpr(({ root }) => {
  const id = NODE_ID[String(root.classId).toLowerCase()];
  if (id == null) return 0;
  const leap = (root.arkPassive && root.arkPassive.leap) || [];
  return (leap.find((n: any) => n.id === id) || { level: 0 }).level;
});
