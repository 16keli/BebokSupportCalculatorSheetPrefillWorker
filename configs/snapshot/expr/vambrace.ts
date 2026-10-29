// vambrace field - snapshot datasource.
// The equipped vambrace (snapshot slot "bracer") as { level, grade }, or null
// when the character has none. level = the item's honing level; grade is looked
// up by item id in data/vambrace.json (ref.vambrace, from raw_data/Item.json
// category 10206), falling back to the id's grade digit (1343xxxxx epic,
// 1344 legend, 1345 relic, 1346 ancient) for ids newer than the table. The sheet
// renders it as the level dropdown text (expr/vambraceLabel.ts) and ticks the
// vambrace checkbox. Bindings: $ (itemBySlot), ref.vambrace.
import { snapshotExpr } from "../../_context.ts";

const GRADE_DIGITS: Record<number, string> = {
  3: "epic",
  4: "legend",
  5: "relic",
  6: "ancient",
};

export default snapshotExpr<void, { level: number; grade: string } | null>(
  ({ $, ref }) => {
    const item = $.itemBySlot.bracer;
    if (!item) return null;
    const grade =
      ref.vambrace?.[item.id] ??
      GRADE_DIGITS[Math.floor(Number(item.id) / 100000) % 10] ??
      "epic";
    return { level: Number(item.data?.honing) || 0, grade };
  },
);
