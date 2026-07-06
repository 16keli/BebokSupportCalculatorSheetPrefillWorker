// Sheet-side cell transform for L31 (boss name). Maps the logged boss
// (root.currentBossName, here `raw`/`value`) to a content-type label when it
// belongs to the current raid tier, otherwise leaves the raw boss name.
// "Kazeros Raid" covers every boss in the raids spanning [Echidna .. Final Act:
// Kazeros] inclusive, as ordered in data/encounters.json (ref.encounters).
// Bindings (TransformCtx): value, raw, ref, fields, arg, ctx.
import { transform } from "../../_context.ts";

export default transform(({ value, raw, ref }) => {
  const enc = ref.encounters || {};
  const raids = Object.keys(enc);
  const start = raids.indexOf("Echidna");
  const end = raids.indexOf("Final Act: Kazeros");
  if (start === -1 || end === -1) return value;
  const bosses = new Set<string>();
  raids.slice(start, end + 1).forEach((raid) => {
    const gates = enc[raid] || {};
    Object.keys(gates).forEach((g) =>
      (gates[g] || []).forEach((b) => bosses.add(b)),
    );
  });
  return bosses.has(raw as string) ? "Kazeros Raid" : "";
});
