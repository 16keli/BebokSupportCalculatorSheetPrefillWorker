// arkGrid intermediate - snapshot datasource.
//
// Algorithm: walk each core's gems in order; a gem is "active" only while its
// cost (astrogem baseCost - that gem's costReduc) still fits the core's
// remaining capacity (the core's gemSlotPoint), short-circuiting on the first
// gem that doesn't fit. Sum active corePoints -> highest reached threshold, and
// sum active gems' side-node opts (opt id -> level).
//   root.arkGridCores - the equipped cores + their gems
//   ref.astrogems     - data/astrogems.json: { [id]: { id, baseCost, ... } }
//   ref.cores.cores   - data/cores.json:     { [id]: { id, gemSlotPoint, attr,
//                                                       coreType, ... } }
//
// Keying: results are keyed by the core's *identity* (order/chaos x sun/moon/
// star), derived from cores.json - NOT `core.base`, which only encodes the grid
// SLOT the core sits in. Slots are conventionally filled in a fixed order, but
// that's not enforced, so the slot doesn't reliably tell you what core it holds.
// We reconstruct the same 10001..10006 key space the sheet fields expect from
// the core's real attr (0 order / 1 chaos) and coreType (0 sun / 1 moon /
// 2 star): key = 10001 + attr*3 + coreType.
//
// Returns { byBase: { [identityKey]: {...} }, side: { [optId]: summedLevel } }.
import { snapshotExpr, type ArkGrid } from "../../_context.ts";

export default snapshotExpr<void, ArkGrid>(({ root, ref }) => {
  const baseCost = ref.astrogems || {};
  const cap = ref.cores?.cores || {};

  const TH = [20, 19, 18, 17, 14, 10, 0];
  const out: ArkGrid = { byBase: {}, side: {} };

  (root.arkGridCores || []).forEach((core: any) => {
    const meta = cap[core.id];
    if (
      meta?.gemSlotPoint == null ||
      meta.attr == null ||
      meta.coreType == null
    ) {
      // Core id not in cores.json (unknown grade/variant): we can't derive its
      // identity, so fall back to the slot `base` and degrade cleanly.
      out.byBase[core.base] = {
        id: core.id,
        found: false,
        points: null,
        threshold: null,
        activeCount: 0,
      };
      return;
    }
    const capacity = meta.gemSlotPoint;
    // Identity key from the core's real attr/coreType, independent of its slot.
    const key = 10001 + meta.attr * 3 + meta.coreType;

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
    out.byBase[key] = {
      id: core.id,
      found: true,
      points,
      threshold,
      activeCount,
    };
  });

  return out;
});
