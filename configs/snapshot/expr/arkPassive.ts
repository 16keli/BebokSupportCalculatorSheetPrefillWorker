// arkPassive intermediate - snapshot datasource.
// Resolves the character's ark passive nodes (snapshot arkPassive.evolution and
// .enlightenment, each [{ id, level }]) against data/ark_passive.json (exposed
// as ref.ark_passive), which names every node and tags enlightenment nodes with
// a tier (1-4) and type ("main" | "side"). A support invests in at most one main
// and one side node per enlightenment tier, so keying by (tier, type) is
// unambiguous within a single character's nodes.
//
// Returns { evo: { [id]: level }, enl: { [id]: level },
//           enlMain: { [tier]: level }, enlSide: { [tier]: level } }.
// `enl` keeps EVERY enlightenment node by id (like `evo`), so DPS enlightenment
// nodes absent from ark_passive.json (which only lists the 4 support classes)
// are still detectable - enlMain/enlSide would drop them. See critRateParts.ts.
import { snapshotExpr, type ArkPassiveResolved } from "../../_context.ts";

export default snapshotExpr<void, ArkPassiveResolved>(({ root, ref }) => {
  const ap = root.arkPassive || {};
  const enlRef = (ref.ark_passive && ref.ark_passive.enlightenment) || {};

  const evo: Record<number, number> = {};
  (ap.evolution || []).forEach((n: any) => {
    evo[n.id] = n.level;
  });

  const enl: Record<number, number> = {};
  const enlMain: Record<number, number> = {};
  const enlSide: Record<number, number> = {};
  (ap.enlightenment || []).forEach((n: any) => {
    enl[n.id] = n.level;
    const meta = enlRef[n.id]; // numeric id auto-coerces to the string ref key
    if (!meta) return;
    if (meta.type === "side") enlSide[meta.tier] = n.level;
    else enlMain[meta.tier] = n.level;
  });

  return { evo, enl, enlMain, enlSide };
});
