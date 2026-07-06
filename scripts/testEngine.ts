// scripts/testEngine.ts
//
// Offline verification of the config engine against the captured samples in
// planning/samples. Uses the SAME compiled bundle the Worker uses
// (src/generated/compiledConfigs.ts), so it exercises codegen + engine exactly
// as production does - just without the network/Puppeteer.
//
// Run: node scripts/compileConfigs.mjs && node scripts/testEngine.ts

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { unflatten } from "devalue";
import {
  evaluateSource,
  resolveRoot,
  resolveCells,
  resolveInputs,
  findSource,
} from "../src/configEngine.ts";
import { COMPILED_BUNDLES } from "../src/generated/compiledConfigs.ts";
import type { FieldResult } from "../src/types.ts";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const read = (p: string) => readFileSync(join(root, p), "utf8");

const bundle = COMPILED_BUNDLES["bebok-3.8.1"];
const logSource = findSource(bundle, "log")!;
const snapSource = findSource(bundle, "snapshot")!;
const loadoutSource = findSource(bundle, "loadout")!;

const SUPPORT_SPECS = new Set([
  "Blessed Aura",
  "Liberator",
  "Desperate Salvation",
  "Full Bloom",
]);

// -- Log phase ----------------------------------------------------------
function unflattenPayload(raw: { nodes: unknown[] }) {
  return {
    data: raw.nodes
      .map((node) => {
        if (!node || typeof node !== "object") return null;
        const n = node as { type?: string; data?: unknown[] };
        return n.type === "data" && Array.isArray(n.data)
          ? unflatten(n.data)
          : null;
      })
      .filter((x) => x !== null),
  };
}

const logPayload = unflattenPayload(
  JSON.parse(read("planning/samples/log_data.json")),
);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const enc = resolveRoot(logPayload, logSource) as any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const allPlayers: any[] = enc.entityList.filter(
  (e: any) => e.entityType === "PLAYER",
);
const partyInfo = enc.encounterDamageStats.misc.partyInfo as Record<
  string,
  string[]
>;

console.log("=== LOG PHASE ===");
console.log("encounter root resolved:", !!enc, "| boss:", enc.currentBossName);
console.log(
  "parties:",
  Object.entries(partyInfo)
    .map(([k, v]) => `${k}:[${v.join(", ")}]`)
    .join("  "),
);

// Advanced-input defaults (roster + pet bonuses), applied exactly as the Worker
// does - now in phase 1, since spec/swiftness are computed from the log's
// member arkPassiveData.
const resolvedInputs = resolveInputs(bundle.sheet.inputs, {});
console.log("resolved inputs:", JSON.stringify(resolvedInputs));

const logResultsByParty: Record<string, Record<string, FieldResult>> = {};
for (const [num, names] of Object.entries(partyInfo)) {
  const nameSet = new Set(names);
  const players = allPlayers.filter((p) => nameSet.has(p.name));
  const supports = players.filter((p) => SUPPORT_SPECS.has(p.spec));
  const member = supports.length === 1 ? supports[0] : null;
  const res = evaluateSource(
    logSource,
    logPayload,
    { players, member },
    resolvedInputs,
  );
  logResultsByParty[num] = res;
  console.log(
    `\n-- party ${num} (support member: ${member ? member.name : "none"}) --`,
  );
  for (const f of logSource.fields) {
    const r = res[f.id];
    console.log(
      `  ${f.id.padEnd(20)} = ${r.error ? "ERROR " + r.error : r.value}`,
    );
  }
}

// -- Snapshot phase -----------------------------------------------------
// The hydrated sample is the SvelteKit `snapshot = {...}` var; its data[i]
// holds { type, data }. The Worker's unflattened payload exposes the inner
// data directly, so map each node to its `.data` to match data[1].snapshot.
function loadHydratedSnapshot(file: string) {
  let s = read(file);
  s = s.replace(/^\s*\w+\s*=\s*/, "").replace(/;\s*$/, "");
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  const obj = new Function("return (" + s + ");")();
  return { data: obj.data.map((n: { data: unknown }) => n.data) };
}

const snapPayload = loadHydratedSnapshot("planning/samples/mirsee_snapshot.js");
const snapResults = evaluateSource(
  snapSource,
  snapPayload,
  undefined,
  resolvedInputs,
);

console.log("\n=== SNAPSHOT PHASE (mirsee) ===");
console.log("snapshot root resolved:", !!resolveRoot(snapPayload, snapSource));

// Also test with live __data.json payload (1-node format via fetchSnapshotPayload.mjs)
// if snapshotPayload.json exists in the project root.
try {
  const livePayload = JSON.parse(read("snapshotPayload.json"));
  const liveRoot = resolveRoot(livePayload, snapSource);
  const liveResults = evaluateSource(
    snapSource,
    livePayload,
    undefined,
    resolvedInputs,
  );
  const liveGem = liveResults["identityDmgGem"];
  console.log(
    `\n=== LIVE SNAPSHOT CHECK (snapshotPayload.json) ===`,
    `\n  root resolved: ${!!liveRoot}`,
    `\n  identityDmgGem: ${liveGem?.error ? "ERROR " + liveGem.error : (liveGem?.value ?? "(missing)")}`,
    `\n  gem errors: ${
      Object.values(liveResults)
        .filter((r) => r.error)
        .map((r) => r.error)
        .join("; ") || "none"
    }`,
  );
} catch {
  /* snapshotPayload.json not present - skip */
}
let snapErrors = 0;
for (const f of snapSource.fields) {
  const r = snapResults[f.id];
  if (r.error) snapErrors++;
  console.log(
    `  ${f.id.padEnd(20)} = ${r.error ? "ERROR " + r.error : r.value}`,
  );
}

// -- Loadout phase (rarity-weighted avatar-skin bonus as a fraction: legendary
//    2% / epic 1% / rare 0.5% each across the 4 main slots. Feeds F18 only when
//    the support gear is a manual character-link override; otherwise F18 comes
//    from the manual advanced input.) --------------------------------------
console.log("\n=== LOADOUT PHASE (skinBonusFromLoadout) ===");
const loadoutResultsMirsee = evaluateSource(
  loadoutSource,
  loadHydratedSnapshot("planning/samples/mirsee_loadout.js"),
);
for (const file of ["mirsee", "esthie", "edward", "sos69"]) {
  const res = evaluateSource(
    loadoutSource,
    loadHydratedSnapshot(`planning/samples/${file}_loadout.js`),
  );
  const r = res.skinBonusFromLoadout;
  console.log(
    `  ${file.padEnd(8)} skinBonusFromLoadout = ${r.error ? "ERROR " + r.error : r.value}`,
  );
}

// -- Resolve to cells (party 0 = mirsee's party + snapshot + loadout) ---
const fieldValues: Record<string, FieldResult> = {
  ...logResultsByParty["0"],
  ...snapResults,
  ...loadoutResultsMirsee,
};
const { writes, skipped } = resolveCells(bundle, fieldValues);

console.log("\n=== RESOLVED CELL WRITES ===");
for (const w of writes) {
  const fmt = w.format
    ? `  [${w.format.type}${w.format.pattern ? " " + w.format.pattern : ""}]`
    : "";
  console.log(`  ${w.cell.padEnd(6)} <- ${w.value}${fmt}`);
}
console.log(
  `\n${writes.length} writes, ${skipped.length} skipped, ${snapErrors} snapshot field errors`,
);
if (skipped.length) {
  console.log("skipped:");
  for (const s of skipped)
    console.log(`  ${s.cell.padEnd(6)} ${s.field} (${s.reason})`);
}
