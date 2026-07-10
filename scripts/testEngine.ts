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

// -- DPS Additional Damage (C20) ----------------------------------------
// Each source is a fraction summed by dpsAddDmgTotal into the DPS tab's C20.
// (a) Real payload: the live snapshotPayload.json weapon carries the computed
//     stat id 10144000 (=2882 -> weapon 0.2882). (b) Synthetic: a grade-3
//     ("ancient") Stable Attack core (673101006) at threshold 20 + the Master
//     evolution node (1032200) exercise the grid-schedule and evo detection.
console.log("\n=== DPS ADDITIONAL DAMAGE (C20) ===");
const ADD_DMG_PARTS = [
  "dpsAddDmgWeapon",
  "dpsAddDmgEvo",
  "dpsAddDmgSide",
  "dpsAddDmgStable",
  "dpsAddDmgBracelet",
  "dpsAddDmgStronghold",
  "dpsAddDmgTotal",
];
try {
  const dpsInputs = resolveInputs(bundle.sheet.inputs, {
    dpsStronghold: "1.0",
  });
  const livePayload = JSON.parse(read("planning/samples/snapshotPayload.json"));
  const liveRes = evaluateSource(snapSource, livePayload, undefined, dpsInputs);
  console.log("  -- real snapshot (snapshotPayload.json, stronghold 1.0%) --");
  for (const id of ADD_DMG_PARTS) {
    const r = liveRes[id];
    console.log(
      `  ${id.padEnd(20)} = ${r.error ? "ERROR " + r.error : r.value}`,
    );
  }

  // Synthetic: ancient Stable Attack core at threshold 20 + Master node.
  const synthetic = JSON.parse(read("planning/samples/snapshotPayload.json"));
  const sRoot = resolveRoot(synthetic, snapSource) as any;
  sRoot.arkGridCores = [
    {
      id: 673101006,
      base: 10004,
      gems: [{ id: 67401025, idx: 0, costReduc: 5, corePoints: 20, opts: [] }],
    },
  ];
  sRoot.arkPassive = {
    evolution: [{ id: 1032200, level: 1 }],
    enlightenment: [],
  };
  // Give the bracelet BOTH additional-damage forms: an "Additional Damage +3.5%"
  // special effect (ability index 11041 -> 0.035) and a raw skill_damage_rate roll
  // (index 50, value 300 -> 0.03). They sum to 0.065.
  const synthBrac = (sRoot.items || []).find(
    (i: { slot: string }) => i.slot === "bracelet",
  );
  if (synthBrac)
    synthBrac.data.stats.push(
      { type: 3, index: 11041, value: 5, fixed: false },
      { type: 2, index: 50, value: 300, fixed: false },
    );
  const synthInputs = resolveInputs(bundle.sheet.inputs, {
    dpsStronghold: "0",
  });
  const synthRes = evaluateSource(
    snapSource,
    synthetic,
    undefined,
    synthInputs,
  );
  const stable = synthRes.dpsAddDmgStable.raw;
  const evo = synthRes.dpsAddDmgEvo.raw;
  const brac = synthRes.dpsAddDmgBracelet.raw;
  console.log(
    "  -- synthetic (ancient Stable Attack @20p + Master node + bracelet 11041 + index-50) --",
  );
  console.log(
    `  dpsAddDmgStable      = ${stable} ${stable === 0.028 + 0.0023 * 3 ? "OK" : "MISMATCH (expected 0.0349)"}`,
  );
  console.log(
    `  dpsAddDmgEvo         = ${evo} ${evo === 0.085 ? "OK" : "MISMATCH (expected 0.085)"}`,
  );
  console.log(
    `  dpsAddDmgBracelet    = ${brac} ${brac === 0.065 ? "OK (11041 0.035 + index50 0.03)" : "MISMATCH (expected 0.065)"}`,
  );
} catch (e) {
  console.log(`  (skipped: ${(e as Error).message})`);
}

// -- DPS Damage on Crit Hit (C22) ---------------------------------------
// Multiplier defaulting to 1; sources combine multiplicatively:
//   (1 + critNode) * (1 + bracelet) * (1 + synergy).
// (a) Synthetic "loaded": the 'Critical' evolution node 1032100 (-> 0.12), a
//     bracelet crit-rate line (index 11011 -> 0.015), and dpsSpec "Judgment"
//     (curated synergy 0.08). (b) Default: no crit sources + unknown spec -> 1.
console.log("\n=== DPS DAMAGE ON CRIT HIT (C22) ===");
try {
  const loaded = JSON.parse(read("planning/samples/snapshotPayload.json"));
  const lRoot = resolveRoot(loaded, snapSource) as any;
  lRoot.arkPassive = {
    evolution: [{ id: 1032100, level: 1 }],
    enlightenment: [],
  };
  const lBrac = (lRoot.items || []).find(
    (i: { slot: string }) => i.slot === "bracelet",
  );
  if (lBrac)
    lBrac.data.stats.push({ type: 3, index: 11011, value: 1, fixed: false });
  const lRes = evaluateSource(snapSource, loaded, undefined, {
    dpsSpec: "Judgment",
  });
  const cNode = lRes.dpsCritNode.raw;
  const cBrac = lRes.dpsCritBracelet.raw;
  const cSyn = lRes.dpsCritSynergy.raw;
  const cTot = lRes.dpsCritHitTotal.raw as number;
  const expectTot = 1.12 * 1.015 * 1.08;
  console.log(
    "  -- loaded (Critical node 1032100 + bracelet 11011 + Judgment synergy) --",
  );
  console.log(
    `  dpsCritNode          = ${cNode} ${cNode === 0.12 ? "OK" : "MISMATCH (expected 0.12)"}`,
  );
  console.log(
    `  dpsCritBracelet      = ${cBrac} ${cBrac === 0.015 ? "OK" : "MISMATCH (expected 0.015)"}`,
  );
  console.log(
    `  dpsCritSynergy       = ${cSyn} ${cSyn === 0.08 ? "OK (Judgment)" : "MISMATCH (expected 0.08)"}`,
  );
  console.log(
    `  dpsCritHitTotal      = ${cTot} ${Math.abs(cTot - expectTot) < 1e-9 ? "OK (1.12*1.015*1.08)" : `MISMATCH (expected ${expectTot})`}`,
  );

  // Default: strip crit sources, unknown spec -> multiplier stays 1.
  const clean = JSON.parse(read("planning/samples/snapshotPayload.json"));
  const cleanRoot = resolveRoot(clean, snapSource) as any;
  cleanRoot.arkPassive = { evolution: [], enlightenment: [] };
  const dRes = evaluateSource(snapSource, clean, undefined, {
    dpsSpec: "Unknown Spec",
  });
  const dTot = dRes.dpsCritHitTotal.raw as number;
  console.log(
    `  -- default (no crit sources, unknown spec) --\n  dpsCritHitTotal      = ${dTot} ${dTot === 1 ? "OK (default 1)" : "MISMATCH (expected 1)"}`,
  );
} catch (e) {
  console.log(`  (skipped: ${(e as Error).message})`);
}

// -- DPS Crit Rate (C24) ------------------------------------------------
// Additive crit-rate bonus aggregate (default 0). Synthetic: Zealous Smite evo
// node 1030200 @level 2 (-> 0.24), Sophistication enlightenment 2170020 @level 3
// (-> 0.15), a bracelet crit-rate line index 11011 (-> 0.05), a Crit combat stat
// line index 15 value 2794 (-> 1.0), a ring crit-rate line index 74 value 95
// (-> 0.0095), and dpsSpec "Judgment" (-> synergy 0.10).
console.log("\n=== DPS CRIT RATE (C24) ===");
try {
  const synth = JSON.parse(read("planning/samples/snapshotPayload.json"));
  const sRoot = resolveRoot(synth, snapSource) as any;
  sRoot.arkPassive = {
    evolution: [{ id: 1030200, level: 2 }],
    enlightenment: [{ id: 2170020, level: 3 }],
  };
  const sBrac = (sRoot.items || []).find(
    (i: { slot: string }) => i.slot === "bracelet",
  );
  if (sBrac)
    sBrac.data.stats.push(
      { type: 3, index: 11011, value: 1, fixed: false },
      { type: 2, index: 15, value: 2794, fixed: false },
      { type: 2, index: 74, value: 95, fixed: false },
    );
  const sRes = evaluateSource(snapSource, synth, undefined, {
    dpsSpec: "Judgment",
  });
  const parts = {
    bracelet: sRes.dpsCritRateBracelet.raw,
    evo: sRes.dpsCritRateEvo.raw,
    enl: sRes.dpsCritRateEnlightenment.raw,
    synergy: sRes.dpsCritRateSynergy.raw,
    critStat: sRes.dpsCritRateCritStat.raw,
    ring: sRes.dpsCritRateRing.raw,
  };
  const tot = sRes.dpsCritRateTotal.raw as number;
  const expect = 0.05 + 0.24 + 0.15 + 0.1 + 1.0 + 0.0095;
  const expected: Record<string, number> = {
    bracelet: 0.05,
    evo: 0.24,
    enl: 0.15,
    synergy: 0.1,
    critStat: 1.0,
    ring: 0.0095,
  };
  console.log(
    "  -- synthetic (Zealous Smite L2 + Sophistication L3 + bracelet 11011 + crit stat 2794 + ring 95 + Judgment) --",
  );
  for (const [k, v] of Object.entries(parts))
    console.log(
      `  dpsCritRate.${k.padEnd(9)} = ${v} ${Math.abs((v as number) - expected[k]) < 1e-9 ? "OK" : `MISMATCH (expected ${expected[k]})`}`,
    );
  console.log(
    `  dpsCritRateTotal      = ${tot} ${Math.abs(tot - expect) < 1e-9 ? "OK (sum 1.5495)" : `MISMATCH (expected ${expect})`}`,
  );

  // Default: no crit-rate sources, unknown spec -> 0.
  const clean = JSON.parse(read("planning/samples/snapshotPayload.json"));
  const cRoot = resolveRoot(clean, snapSource) as any;
  cRoot.arkPassive = { evolution: [], enlightenment: [] };
  for (const it of cRoot.items || [])
    if (it.data?.stats)
      it.data.stats = it.data.stats.filter(
        (s: { index: number }) =>
          s.index !== 15 &&
          s.index !== 74 &&
          !(s.index >= 11011 && s.index <= 11014),
      );
  const cRes = evaluateSource(snapSource, clean, undefined, {
    dpsSpec: "Unknown Spec",
  });
  const cTot = cRes.dpsCritRateTotal.raw as number;
  console.log(
    `  -- default (no crit-rate sources, unknown spec) --\n  dpsCritRateTotal      = ${cTot} ${cTot === 0 ? "OK (default 0)" : "MISMATCH (expected 0)"}`,
  );
} catch (e) {
  console.log(`  (skipped: ${(e as Error).message})`);
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
