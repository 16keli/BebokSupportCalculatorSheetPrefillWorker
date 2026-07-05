// arkGrid intermediate - snapshot datasource.
//
// Algorithm: walk each core's gems in order; a gem is "active" only while its
// cost (astrogem baseCost - that gem's costReduc) still fits the core's
// remaining capacity (the core's gemSlotPoint), short-circuiting on the first
// gem that doesn't fit. Sum active corePoints -> highest reached threshold, and
// sum active gems' side-node opts (opt id -> level).
//   root.arkGridCores - the equipped cores + their gems
//   ref.astrogems     - data/astrogems.json: { [id]: { id, baseCost, ... } }
//   ref.cores.cores   - data/cores.json:     { [id]: { id, gemSlotPoint, ... } }
//
// Returns { byBase: { [core.base]: {...} }, side: { [optId]: summedLevel } }.
import { snapshotExpr, type ArkGrid } from "../../_context.ts";

export default snapshotExpr<void, ArkGrid>(({ root, ref }) => {
  const baseCost = ref.astrogems || {};
  const cap = ref.cores?.cores || {};

  const TH = [20, 19, 18, 17, 14, 10, 0];
  const out: ArkGrid = { byBase: {}, side: {} };

  (root.arkGridCores || []).forEach((core: any) => {
    const capacity = cap[core.id]?.gemSlotPoint;
    if (capacity == null) {
      // Core id not in cores.json (unknown grade/variant): degrade cleanly.
      out.byBase[core.base] = {
        id: core.id,
        found: false,
        points: null,
        threshold: null,
        activeCount: 0,
      };
      return;
    }

    let remaining = capacity;
    let points = 0;
    let activeCount = 0;
    for (const g of core.gems || []) {
      const cost = (baseCost[g.id]?.baseCost || 0) - (g.costReduc || 0);
      if (cost > remaining) break; // short-circuit: this gem and all later ones inactive
      remaining -= cost;
      points += g.corePoints || 0;
      activeCount++;
      (g.opts || []).forEach((o: any) => {
        out.side[o.id] = (out.side[o.id] || 0) + o.level;
      });
    }

    let threshold = 0;
    for (const t of TH) {
      if (points >= t) {
        threshold = t;
        break;
      }
    }
    out.byBase[core.base] = {
      id: core.id,
      found: true,
      points,
      threshold,
      activeCount,
    };
  });

  return out;
});
