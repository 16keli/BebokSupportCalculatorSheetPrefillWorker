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
    evolution: [
      { id: 1030200, level: 2 },
      // Master: flat 0.07 regardless of level.
      { id: 1032200, level: 1 },
    ],
    enlightenment: [{ id: 2170020, level: 3 }],
  };
  // Crit-rate engravings: Adrenaline maxed (0.14 + 4 x 0.015 = 0.20) + Precise
  // Dagger at 10 books (0.18 + 2 x 0.0075 = 0.195) + its rank-3 stone (0.0525).
  sRoot.engravings = [
    { id: 1299, grade: "engrave_grade05", progress: 20 },
    { id: 1303, grade: "engrave_grade04", progress: 10 },
  ];
  const sStone = (sRoot.items || []).find(
    (i: { slot: string }) => i.slot === "ability_stone",
  );
  if (sStone) sStone.data.engravings = [{ id: 303, nodes: 9 }];
  const sBrac = (sRoot.items || []).find(
    (i: { slot: string }) => i.slot === "bracelet",
  );
  if (sBrac)
    sBrac.data.stats.push(
      { type: 3, index: 11011, value: 1, fixed: false },
      { type: 2, index: 15, value: 2794, fixed: false },
      // Raw index-74 crit rate on the BRACELET (same params as a ring line).
      { type: 2, index: 74, value: 60, fixed: false },
    );
  // Raw index-74 crit rate on a RING too; both sum into the `ring` part
  // (35 + 60 = 95 -> 0.0095).
  const sRing = (sRoot.items || []).find((i: { slot: string }) =>
    i.slot.startsWith("finger"),
  );
  if (sRing)
    sRing.data.stats.push({ type: 2, index: 74, value: 35, fixed: false });
  const sRes = evaluateSource(snapSource, synth, undefined, {
    dpsSpec: "Judgment",
  });
  const parts = {
    bracelet: sRes.dpsCritRateBracelet.raw,
    evo: sRes.dpsCritRateEvo.raw,
    enl: sRes.dpsCritRateEnlightenment.raw,
    synergy: sRes.dpsCritRateSynergy.raw,
    engravings: sRes.dpsCritRateEngravings.raw,
    critStat: sRes.dpsCritRateCritStat.raw,
    ring: sRes.dpsCritRateRing.raw,
  };
  const tot = sRes.dpsCritRateTotal.raw as number;
  const expect = 0.05 + 0.31 + 0.15 + 0.1 + 0.4475 + 1.0 + 0.0095;
  const expected: Record<string, number> = {
    bracelet: 0.05,
    evo: 0.31,
    enl: 0.15,
    synergy: 0.1,
    engravings: 0.4475,
    critStat: 1.0,
    ring: 0.0095,
  };
  console.log(
    "  -- synthetic (Zealous Smite L2 + Master + Sophistication L3 + bracelet 11011 + Adrenaline max + Precise Dagger 10 books w/ rank-3 stone + crit stat 2794 + index-74 on bracelet 60 + ring 35 + Judgment) --",
  );
  for (const [k, v] of Object.entries(parts))
    console.log(
      `  dpsCritRate.${k.padEnd(9)} = ${v} ${Math.abs((v as number) - expected[k]) < 1e-9 ? "OK" : `MISMATCH (expected ${expected[k]})`}`,
    );
  console.log(
    `  dpsCritRateTotal      = ${tot} ${Math.abs(tot - expect) < 1e-9 ? "OK (sum 2.067)" : `MISMATCH (expected ${expect})`}`,
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

  // Crit STAT term: gear index-15 lines + tier-1 Crit evolution node (1010100,
  // +50/point) + roster Crit input + pet (+160 when on Crit). The pet defaults to
  // Crit iff the crit allocation is >= 20, else Other.
  const critStatCase = (critLevel: number, dpsPet?: string) => {
    const p = JSON.parse(read("planning/samples/snapshotPayload.json"));
    const pRoot = resolveRoot(p, snapSource) as any;
    pRoot.arkPassive = {
      evolution: [{ id: 1010100, level: critLevel }],
      enlightenment: [],
    };
    for (const it of pRoot.items || [])
      if (it.data?.stats)
        it.data.stats = it.data.stats.filter(
          (s: { index: number }) => s.index !== 15,
        );
    return evaluateSource(snapSource, p, undefined, {
      dpsRosterCrit: 76,
      ...(dpsPet ? { dpsPet } : {}),
    }).dpsCritRateCritStat.raw as number;
  };
  const petOn = critStatCase(20); // auto -> crit (20 >= 20): +160
  const petOff = critStatCase(19); // auto -> other (19 < 20): +0
  const forcedOther = critStatCase(20, "other");
  const expOn = (20 * 50 + 76 + 160) / 2794;
  const expOff = (19 * 50 + 76) / 2794;
  const expForced = (20 * 50 + 76) / 2794;
  console.log("  -- crit STAT (evo node 1010100 + roster 76 + pet) --");
  console.log(
    `  critStat @20pts (auto pet=crit) = ${petOn} ${Math.abs(petOn - expOn) < 1e-9 ? "OK (1000+76+160)/2794" : `MISMATCH (expected ${expOn})`}`,
  );
  console.log(
    `  critStat @19pts (auto pet=other)= ${petOff} ${Math.abs(petOff - expOff) < 1e-9 ? "OK (950+76)/2794" : `MISMATCH (expected ${expOff})`}`,
  );
  console.log(
    `  critStat @20pts (pet=other)     = ${forcedOther} ${Math.abs(forcedOther - expForced) < 1e-9 ? "OK (1000+76)/2794" : `MISMATCH (expected ${expForced})`}`,
  );
} catch (e) {
  console.log(`  (skipped: ${(e as Error).message})`);
}

// -- DPS Crit Damage (C23) ----------------------------------------------
// Absolute crit-damage multiplier = 2.0 base + additive bonus sources. Synthetic:
// bracelet crit-damage line 11021 (-> 0.10), a raw index-76 line value 95 (-> 0.0095),
// enlightenment node 2211100 @level 3 (crit_dmg_arkpassive [.., 0.12] -> 0.12), and
// Keen Blunt (id 1141) at ability-stone rank 3 (nodes 9 -> placeholder table 0.35).
console.log("\n=== DPS CRIT DAMAGE (C23) ===");
try {
  const synth = JSON.parse(read("planning/samples/snapshotPayload.json"));
  const sRoot = resolveRoot(synth, snapSource) as any;
  sRoot.arkPassive = {
    evolution: [],
    enlightenment: [{ id: 2211100, level: 3 }],
  };
  const sBrac = (sRoot.items || []).find(
    (i: { slot: string }) => i.slot === "bracelet",
  );
  if (sBrac)
    sBrac.data.stats.push(
      { type: 3, index: 11021, value: 1, fixed: false },
      { type: 2, index: 76, value: 95, fixed: false },
    );
  // Keen Blunt: BOOK list (root.engravings) uses id 1141; relic grade05 -> 20
  // books -> 0.44 + (20/5)*0.02 = 0.52. STONE list uses id 141; nodes 9 ->
  // thresholds [6,7,9] met = rank 3 -> 0.132. keenBlunt = 0.52 + 0.132 = 0.652.
  sRoot.engravings = [{ id: 1141, grade: "engrave_grade05", progress: 0 }];
  let stone = (sRoot.items || []).find(
    (i: { slot: string }) => i.slot === "ability_stone",
  );
  if (!stone) {
    stone = { slot: "ability_stone", data: { engravings: [] } };
    sRoot.items.push(stone);
  }
  stone.data.engravings = [{ id: 141, nodes: 9 }];
  const sRes = evaluateSource(snapSource, synth, undefined, {});
  const parts = {
    bracelet: sRes.dpsCritDmgBracelet.raw,
    ring: sRes.dpsCritDmgRing.raw,
    keenBlunt: sRes.dpsCritDmgKeenBlunt.raw,
    arkPassive: sRes.dpsCritDmgArkPassive.raw,
  };
  const tot = sRes.dpsCritDmgTotal.raw as number;
  const expected: Record<string, number> = {
    bracelet: 0.1,
    ring: 0.0095,
    keenBlunt: 0.652,
    arkPassive: 0.12,
  };
  const expTot = 2.0 + 0.1 + 0.0095 + 0.652 + 0.12;
  console.log(
    "  -- synthetic (bracelet 11021 + index-76 95 + enl 2211100 L3 + Keen Blunt relic+20books & stone rank 3) --",
  );
  for (const [k, v] of Object.entries(parts))
    console.log(
      `  dpsCritDmg.${k.padEnd(10)} = ${v} ${Math.abs((v as number) - expected[k]) < 1e-9 ? "OK" : `MISMATCH (expected ${expected[k]})`}`,
    );
  console.log(
    `  dpsCritDmgTotal       = ${tot} ${Math.abs(tot - expTot) < 1e-9 ? "OK (2.0 base + 0.8815)" : `MISMATCH (expected ${expTot})`}`,
  );

  // Default: no crit-damage sources -> 2.0 base.
  const clean2 = JSON.parse(read("planning/samples/snapshotPayload.json"));
  const c2Root = resolveRoot(clean2, snapSource) as any;
  c2Root.arkPassive = { evolution: [], enlightenment: [] };
  c2Root.engravings = [];
  for (const it of c2Root.items || []) {
    if (it.data?.stats)
      it.data.stats = it.data.stats.filter(
        (s: { index: number }) =>
          s.index !== 76 && !(s.index >= 11021 && s.index <= 11024),
      );
    if (it.slot === "ability_stone" && it.data) it.data.engravings = [];
  }
  const c2Res = evaluateSource(snapSource, clean2, undefined, {});
  const c2Tot = c2Res.dpsCritDmgTotal.raw as number;
  console.log(
    `  -- default (no crit-damage sources) --\n  dpsCritDmgTotal       = ${c2Tot} ${c2Tot === 2.0 ? "OK (default 2.0)" : "MISMATCH (expected 2.0)"}`,
  );
} catch (e) {
  console.log(`  (skipped: ${(e as Error).message})`);
}

// -- DPS Evolution Damage (C21) + Blunt Thorn checkbox (C25) -------------
// Additive Evolution-Type Damage bonus (default 0). Synthetic: karma evolution 21
// -> rank 6 -> 0.06; tree nodes 1032300 L1 (0.20) + 1030400 L2 (0.24) = 0.44;
// Supersonic 1040200 L2 -> 0.24; MP Furnace 1040500 L1 -> 0.12; Blunt Thorn 1040100
// L1 -> tree 0 but C25 = TRUE.
console.log("\n=== DPS EVOLUTION DAMAGE (C21) + BLUNT THORN (C25) ===");
try {
  const synth = JSON.parse(read("planning/samples/snapshotPayload.json"));
  const sRoot = resolveRoot(synth, snapSource) as any;
  sRoot.karma = { evolution: 21, enlightenment: 0, leap: 0 };
  sRoot.arkPassive = {
    evolution: [
      { id: 1032300, level: 1 },
      { id: 1030400, level: 2 },
      { id: 1040200, level: 2 },
      { id: 1040500, level: 1 },
      { id: 1040100, level: 1 },
    ],
    enlightenment: [],
  };
  const sRes = evaluateSource(snapSource, synth, undefined, {});
  const parts = {
    karma: sRes.dpsEvoDmgKarma.raw,
    tree: sRes.dpsEvoDmgTree.raw,
    supersonic: sRes.dpsEvoDmgSupersonic.raw,
    mpFurnace: sRes.dpsEvoDmgMpFurnace.raw,
  };
  const expected: Record<string, number> = {
    karma: 0.06,
    tree: 0.44,
    supersonic: 0.24,
    mpFurnace: 0.12,
  };
  const tot = sRes.dpsEvolutionDamage.raw as number;
  const blunt = sRes.dpsBluntThornActive.raw;
  const expTot = 0.06 + 0.44 + 0.24 + 0.12;
  console.log(
    "  -- synthetic (karma 21 + tree 1032300/1030400 + Supersonic L2 + MP Furnace L1 + Blunt Thorn) --",
  );
  for (const [k, v] of Object.entries(parts))
    console.log(
      `  dpsEvoDmg.${k.padEnd(11)} = ${v} ${Math.abs((v as number) - expected[k]) < 1e-9 ? "OK" : `MISMATCH (expected ${expected[k]})`}`,
    );
  console.log(
    `  dpsEvolutionDamage   = ${tot} ${Math.abs(tot - expTot) < 1e-9 ? "OK (0.86)" : `MISMATCH (expected ${expTot})`}`,
  );
  console.log(
    `  dpsBluntThornActive  = ${blunt} ${blunt === true ? "OK (TRUE -> C25)" : "MISMATCH (expected true)"}`,
  );

  // Default: no karma, no evolution nodes -> 0 and Blunt Thorn FALSE.
  const clean3 = JSON.parse(read("planning/samples/snapshotPayload.json"));
  const c3Root = resolveRoot(clean3, snapSource) as any;
  c3Root.karma = { evolution: 0, enlightenment: 0, leap: 0 };
  c3Root.arkPassive = { evolution: [], enlightenment: [] };
  const c3Res = evaluateSource(snapSource, clean3, undefined, {});
  const c3Tot = c3Res.dpsEvolutionDamage.raw as number;
  const c3Blunt = c3Res.dpsBluntThornActive.raw;
  console.log(
    `  -- default (no karma/nodes) --\n  dpsEvolutionDamage   = ${c3Tot} ${c3Tot === 0 ? "OK (default 0)" : "MISMATCH (expected 0)"}  | bluntThorn = ${c3Blunt} ${c3Blunt === false ? "OK (FALSE)" : "MISMATCH"}`,
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
