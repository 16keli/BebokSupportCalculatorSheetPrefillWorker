// Sheet-side cell transform for the chaos ark-grid core cells (AF4 Sun, AF13
// Moon, AF22 Star). Maps the raw core id (snapshot field, `raw`/`value`) to a
// display name via data/cores.json (ref.cores), e.g.
//   673103006 -> "Chaos Sun Core: Faith Enhancement (Ancient)"
// Built as "<category> Core: <title> (<rarity>)", HTML markup stripped and
// rarity from the grade (0 Epic / 1 Legendary / 2 Relic / 3 Ancient). Falls back
// to the raw value when the id isn't in cores.json ('' stays '' -> skipped).
// Bindings (TransformCtx): value, raw, ref, fields, arg, ctx.
import { transform } from "../../_context.ts";

export default transform(({ value, raw, ref }) => {
  if (raw === "" || raw == null) return value;
  const e = ref.cores?.cores?.[raw as any];
  if (!e) return value;
  const GRADES: Record<number, string> = {
    0: "Epic",
    1: "Legendary",
    2: "Relic",
    3: "Ancient",
  };
  const TYPES: Record<number, string> = { 0: "Sun", 1: "Moon", 2: "Star" };
  const category = e.attr == 0 ? "Order" : "Chaos";
  return `${category} ${TYPES[e.coreType] ?? e.coreType} Core: ${e.title} (${GRADES[e.grade] ?? e.grade})`;
});
