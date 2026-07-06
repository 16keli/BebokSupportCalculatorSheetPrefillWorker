// identityDmgGem field (B11) - snapshot datasource.
// Level (1-10) of the identity-damage gem: the equipped gem (root.gems) carrying
// an effect of type 65 (identity damage). '' when none. Bindings: root, ref.gems.
import { snapshotExpr } from "../../_context.ts";

export default snapshotExpr(({ root, ref }) => {
  const g = (root.gems || []).find((x: any) =>
    (x.effects || []).some((e: any) => e.type === 65),
  );
  if (!g) return "";
  const lv = ref.gems?.[g.id]?.level;
  return lv != null ? lv : "";
});
