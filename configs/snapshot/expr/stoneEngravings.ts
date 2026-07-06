// stoneEngravings intermediate - snapshot datasource.
// Per-engraving activation level on the ability stone: an engraving activates
// one level at each of [6,7,9,10] nodes, so level = count of thresholds met
// (0-4). [] when no stone. Bindings: $ (itemBySlot).
import { snapshotExpr, type StoneEngraving } from "../../_context.ts";

export default snapshotExpr<void, StoneEngraving[]>(({ $ }) => {
  const s = $.itemBySlot.ability_stone;
  if (!s) return [];
  const TH = [6, 7, 9, 10];
  const lvl = (n: number) => TH.filter((t) => (n || 0) >= t).length;
  return (s.data.engravings || []).map((e: any) => ({
    id: e.id,
    nodes: e.nodes,
    level: lvl(e.nodes),
  }));
});
