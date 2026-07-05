// Sheet-side cell transform for the Gear Tier cells (E6-E11). Formats
// "<Label> (<tier>)" from the plain tier string produced by the snapshot's
// gearTier intermediate. Blank when the tier can't be resolved (item not in
// data/armor.json - not relic/ancient at balanceLevel 1590/1675, or no item
// in that slot). Bindings (TransformCtx): raw, arg.
import { transform } from "../../_context.ts";

export default transform<string>(({ raw, arg }) => {
  if (!raw) return "";
  return `${arg} (${raw})`;
});
