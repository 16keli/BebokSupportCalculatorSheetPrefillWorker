// scripts/fetchSnapshotPayload.mjs
// Usage: node scripts/fetchSnapshotPayload.mjs <snapshot-url-or-hash>
// Fetches the SvelteKit __data.json for a lostark.bible snapshot page and saves
// the unflattened payload to snapshotPayload.json. Also prints gem effect types.

import { writeFileSync } from "node:fs";
import { unflatten } from "devalue";

let arg = process.argv[2];
if (!arg) {
  console.error("Usage: node scripts/fetchSnapshotPayload.mjs <snapshot-url-or-hash>");
  console.error("  Hash example:  v3/c402fa984d30f95dc");
  console.error("  URL example:   https://lostark.bible/character/snapshot/v3/c402fa984d30f95dc");
  process.exit(1);
}

// Accept bare hash or full URL
if (!arg.startsWith("http")) {
  arg = `https://lostark.bible/character/snapshot/${arg}`;
}

const dataUrl = arg.replace(/\/$/, "") + "/__data.json?x-sveltekit-invalidated=011";
console.log("Fetching", dataUrl);

const res = await fetch(dataUrl);
if (!res.ok) {
  console.error(`Failed: ${res.status} ${res.statusText}`);
  process.exit(1);
}

const raw = await res.json();

const unflattened = {
  data: raw.nodes.map((node) => {
    if (node === null || typeof node !== "object") return null;
    if (node.type !== "data" || !Array.isArray(node.data)) return null;
    return unflatten(node.data);
  }).filter((x) => x !== null),
};

writeFileSync("snapshotPayload.json", JSON.stringify(unflattened, null, 2));
console.log("Written to snapshotPayload.json");

// Debug: inspect gem effects
// rootPath is data[1].snapshot (with fallbacks data[0].snapshot etc.)
const snapshot =
  unflattened.data[1]?.snapshot ??
  unflattened.data[0]?.snapshot ??
  unflattened.data[0];

const gems = snapshot?.gems ?? [];
console.log(`\nFound ${gems.length} equipped gems:`);
for (const g of gems) {
  const effects = (g.effects || []).map((e) => e.type);
  console.log(`  id=${g.id}  effects=[${effects.join(", ")}]`);
}

// Show all unique effect types across all gems
const allTypes = new Set();
for (const g of gems) {
  for (const e of g.effects || []) {
    allTypes.add(e.type);
  }
}
console.log(`\nAll effect types present: [${[...allTypes].sort((a, b) => a - b).join(", ")}]`);
