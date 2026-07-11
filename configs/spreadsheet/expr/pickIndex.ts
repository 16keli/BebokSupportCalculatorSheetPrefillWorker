// pickIndex - generic sheet-side transform: raw is an array (already fully
// computed by the datasource), arg (0-based) selects which element this cell
// takes. '' when the array has no element at that index, so cells past the
// array's length stay blank. Bindings (TransformCtx): raw, arg.
import { transform } from "../../_context.ts";

export default transform<void, unknown>(({ raw, arg }) => {
  const arr = Array.isArray(raw) ? raw : [];
  const v = arr[Number(arg) || 0];
  return v == null ? "" : v;
});
