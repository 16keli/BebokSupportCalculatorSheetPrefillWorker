// scripts/fetchLogPayload.mjs
// Usage: node scripts/fetchLogPayload.mjs <log-url>
// Fetches the SvelteKit __data.json for a lostark.bible log page and saves
// the raw + unflattened payload to logPayload.json in the project root.

import { writeFileSync } from "node:fs";
import { unflatten } from "devalue";

const url = process.argv[2];
if (!url) {
  console.error("Usage: node scripts/fetchLogPayload.mjs <log-url>");
  process.exit(1);
}

const dataUrl =
  url.replace(/\/$/, "") + "/__data.json?x-sveltekit-invalidated=011";
console.log("Fetching", dataUrl);

const res = await fetch(dataUrl);
if (!res.ok) {
  console.error(`Failed: ${res.status} ${res.statusText}`);
  process.exit(1);
}

const raw = await res.json();

const unflattened = {
  data: raw.nodes
    .map((node) => {
      if (node === null || typeof node !== "object") return null;
      if (node.type !== "data" || !Array.isArray(node.data)) return null;
      return unflatten(node.data);
    })
    .filter((x) => x !== null),
};

writeFileSync("logPayload.json", JSON.stringify(unflattened, null, 2));
console.log("Written to logPayload.json");
