// gearTier intermediate - snapshot datasource.
// Map of equip slot -> raid gear tier name, resolved from the equipped item's id
// (root.items via $.itemBySlot) looked up in data/armor.json (ref.armor) by
// balanceLevel (1590 -> Aegir, 1675 -> Serca). '' when the item isn't in
// armor.json (not relic/ancient at one of those two balance levels) or the slot
// is empty. Bindings: $ (itemBySlot), ref.armor.
import { snapshotExpr } from "../../_context.ts";

const TIER_NAMES: Record<number, string> = { 1590: "Aegir", 1675: "Serca" };
const SLOTS = ["head", "shoulder", "upper_body", "lower_body", "hand", "weapon"];

export default snapshotExpr<void, Record<string, string>>(({ $, ref }) => {
  const out: Record<string, string> = {};
  for (const slot of SLOTS) {
    const id = $.itemBySlot[slot]?.id;
    const bl = id != null ? ref.armor?.[id]?.balanceLevel : undefined;
    out[slot] = bl != null ? TIER_NAMES[bl] ?? "" : "";
  }
  return out;
});
