// Sheet-side cell transform for the order ark-grid core cells (Y15 Order Sun,
// Y25 Order Moon). Maps the raw core id (`raw`/`value`) to a curated display
// string via data/core_lines.json (ref.core_lines) - an explicit id -> string
// lookup (the percentages live behind unresolved <$CALC>/<$TABLE> tags). Falls
// back to the raw value when the id isn't listed ('' stays '' -> skipped).
// Bindings (TransformCtx): value, raw, ref, fields, arg, ctx.
import { transform } from "../../_context.ts";

export default transform(({ value, raw, ref }) => {
  if (raw === "" || raw == null) return value;
  const tbl = ref.core_lines || {};
  const s = tbl[raw as any] ?? tbl[String(raw)];
  return s == null ? value : s;
});
