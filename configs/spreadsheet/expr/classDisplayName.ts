// Sheet-side cell transform for F2 (class name). Snapshots carry the class's
// INTERNAL name (see classSkills.ts snapshot intermediate for the same
// mapping, keyed by numeric classId instead), e.g. paladin = "holyknight",
// valkyrie = "holyknight_female", artist = "yinyangshi". bard is already the
// display name. Resolved via data/classes.json (ref.classes). Bindings: raw, ref.
import { transform } from "../../_context.ts";

export default transform<void, string>(({ raw, ref }) => {
  const name = String(raw ?? "").toLowerCase();
  const match = (ref.classes ?? []).find((c) => c.internal_name === name);
  return (match?.name ?? name).toUpperCase();
});
