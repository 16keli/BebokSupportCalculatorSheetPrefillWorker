// Sheet-side cell transform: render accessory/bracelet stat line(s) to display
// text via the data/stat_lines.json lookup (ref.stat_lines). The snapshot stays
// canonical (raw {index,value} objects); this is the presentation layer.
//   - A single raw stat object -> rendered to text (or '' if no entry).
//   - A raw ARRAY of an item's stats -> the fixed base attributes are dropped and
//     `arg` (0-based) selects which remaining rolled line this cell takes.
// Matching tries keys most->least specific (ctx = section label, e.g. "ring"):
//   "<ctx>:<index>:<type>" -> "<ctx>:<index>" -> "<index>:<type>" -> "<index>"
// The matched entry's `text` has {value} replaced by value*scale (default 1);
// `decimals` fixes places, else trailing zeros trimmed (<=3 dp).
// Bindings (TransformCtx): value, raw, ref, arg, ctx.
import { transform } from "../../_context.ts";

export default transform(({ raw, ref, arg, ctx }) => {
  const tbl = ref.stat_lines || {};
  const render = (s: any) => {
    if (!s || s.index == null) return "";
    const e =
      tbl[ctx + ":" + s.index + ":" + s.type] ??
      tbl[ctx + ":" + s.index] ??
      tbl[s.index + ":" + s.type] ??
      tbl[s.index];
    if (!e || !e.text) return "";
    const scale = e.scale == null ? 1 : e.scale;
    const n = (s.value || 0) * scale;
    const v = e.decimals == null ? Math.round(n * 1000) / 1000 : n.toFixed(e.decimals);
    return e.text.split("{value}").join(String(v));
  };
  if (Array.isArray(raw)) {
    // Base attributes (NOT effect lines): accessories tag them base:true; bracelets
    // have no flag, so fall back to the base-attribute index set (main 3/4/5/6 +
    // combat stats 15-20). Dropping these leaves the rolled lines in original order.
    const BASE_STATS = new Set([3, 4, 5, 6, 15, 16, 17, 18, 19, 20]);
    const lines = raw.filter((s: any) => s && s.base !== true && !BASE_STATS.has(s.index));
    return render(lines[(arg as number) || 0]);
  }
  return render(raw);
});
