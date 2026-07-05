// Sheet-side cell transform for F2 (class name). Snapshots carry the class's
// INTERNAL name for 3 of the 4 support classes (see classSkills.ts snapshot
// intermediate for the same mapping, keyed by numeric classId instead):
// paladin = "holyknight", valkyrie = "holyknight_female", artist =
// "yinyangshi". bard is already the display name. Bindings: raw.
import { transform } from "../../_context.ts";

const INTERNAL2DISPLAY: Record<string, string> = {
  holyknight: "paladin",
  holyknight_female: "valkyrie",
  yinyangshi: "artist",
};

export default transform<void, string>(({ raw }) => {
  const name = String(raw ?? "").toLowerCase();
  return (INTERNAL2DISPLAY[name] ?? name).toUpperCase();
});
