// arkPassivePoints (member scope) - log datasource. Parameterized module
// replacing specPoints (id 1010200) and swiftPoints (id 1010400): the support's
// ark-passive evolution points for one node, read from the log's per-member
// arkPassiveData. Phase-1 preview only (not a cell).
//   params.nodeId - evolution node id to read
// Bindings: member.
import { logExpr } from "../../_context.ts";

export default logExpr<{ nodeId: number }>(({ member }, { nodeId }) => {
  const e = (member && member.arkPassiveData && member.arkPassiveData.evolution) || [];
  return (e.find((n: any) => n.id === nodeId) || { lv: 0 }).lv || 0;
});
