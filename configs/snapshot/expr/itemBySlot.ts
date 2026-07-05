// itemBySlot intermediate - snapshot datasource.
// Map of equip slot -> item (weapon, head, neck, ear1, finger1, ability_stone,
// bracelet, ...) built from root.items. Bindings: root.
import { snapshotExpr, type Item } from "../../_context.ts";

export default snapshotExpr<void, Record<string, Item>>(({ root }) => {
  const m: Record<string, Item> = {};
  (root.items || []).forEach((i: Item) => {
    m[i.slot] = i;
  });
  return m;
});
