// braceletFlatWpLines intermediate - snapshot datasource.
// Every bracelet stat line that grants flat Weapon Power, resolved to its
// effective amount for the DPS tab's M15/M17/M18/M19 (packed, up to 4):
//   - index 151 (the generic "Weapon Power +{value}" line) -> raw value, same
//     as the braceletFlatWp field.
//   - a curated special-effect ability id (ref.flat_wp_bracelet, e.g.
//     11111-11113/11121-11123/605100101-605100103) -> the curated value, which
//     already assumes any condition is met and any stacks are maxed.
// Non-matching lines are dropped. Bindings: ref.flat_wp_bracelet, $.itemBySlot.
import { snapshotExpr } from "../../_context.ts";

const FLAT_WP_INDEX = 151;

export default snapshotExpr<void, number[]>(({ ref, $ }) => {
  const stats = $.itemBySlot.bracelet?.data?.stats || [];
  return stats
    .map((s: { index: number; value?: number }) => {
      if (s.index === FLAT_WP_INDEX) return s.value ?? 0;
      return ref.flat_wp_bracelet?.[s.index];
    })
    .filter((v: number | undefined): v is number => v != null);
});
