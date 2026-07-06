// engravingBooks - snapshot datasource. Parameterized module replacing
// awakeningBooks (id 1255) and magickStreamBooks (id 1251): grade/level of an
// equipped engraving book. engrave_grade05 -> 20; engrave_grade04 ->
// floor(progress/5)*5 (5/10/15); a relic level below 5 or any lower grade ->
// 'legendary'; '' when not slotted.
//   params.engravingId - root.engravings id to resolve
// Bindings: root.
import { snapshotExpr } from "../../_context.ts";

export default snapshotExpr<{ engravingId: number }>(
  ({ root }, { engravingId }) => {
    const e = (root.engravings || []).find((x: any) => x.id === engravingId);
    if (!e) return "";
    if (e.grade === "engrave_grade05") return 20;
    const lvl =
      e.grade === "engrave_grade04" ? Math.floor((e.progress || 0) / 5) * 5 : 0;
    return lvl >= 5 ? lvl : "legendary";
  },
);
