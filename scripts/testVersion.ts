// scripts/testVersion.ts
//
// Offline checks for the datasource version system (src/version.ts): the
// comparator, and variant selection incl. the graceful "warn but continue"
// fallback when incoming data outruns every config variant.
//
// Run: node scripts/testVersion.ts

import {
  compareVersions,
  satisfiesVersion,
  selectSourceForPayload,
  versionFromLoadoutHash,
} from "../src/version.ts";
import type { CompiledSource } from "../src/configEngine.ts";

let failures = 0;
function check(label: string, got: unknown, want: unknown) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures++;
  console.log(`${ok ? "ok  " : "FAIL"}  ${label}  => ${JSON.stringify(got)}${ok ? "" : ` (want ${JSON.stringify(want)})`}`);
}

// -- comparator ---------------------------------------------------------
check("cmp 1.45.0 < 1.46.0", compareVersions("1.45.0", "1.46.0"), -1);
check("cmp 1.46.0 == 1.46", compareVersions("1.46.0", "1.46"), 0);
check("cmp v4 > v3", compareVersions("v4", "v3"), 1);
check("1.45.0 <= 1.46.0", satisfiesVersion("1.45.0", "<=1.46.0"), true);
check("1.46.0 <= 1.46.0", satisfiesVersion("1.46.0", "<=1.46.0"), true);
check("1.47.0 <= 1.46.0", satisfiesVersion("1.47.0", "<=1.46.0"), false);
check("v3 == v3", satisfiesVersion("v3", "v3"), true);
check("v4 == v3", satisfiesVersion("v4", "v3"), false);
check("range 1.46 in >=1.45 <=1.46", satisfiesVersion("1.46.0", ">=1.45.0 <=1.46.0"), true);
check("range 1.44 in >=1.45 <=1.46", satisfiesVersion("1.44.0", ">=1.45.0 <=1.46.0"), false);

// -- selection ----------------------------------------------------------
// Minimal CompiledSource stubs (only the fields selection touches).
const logRoot = (data: any) => data[0]?.encounterInfo?.encounter;
const mkLog = (supported: string, path = "encounterDamageStats.misc.version"): CompiledSource =>
  ({ source: "log", version: { path, supported }, rootFn: logRoot, rootFallbackFns: [], intermediates: [], fields: [] } as any);
const payloadWithVersion = (v: string) => ({
  data: [{ encounterInfo: { encounter: { encounterDamageStats: { misc: { version: v } } } } }],
});

// Current single variant, in-range data -> selected, no warning.
{
  const sel = selectSourceForPayload([mkLog("<=1.46.0")], payloadWithVersion("1.45.0"));
  check("in-range: actual", sel.actual, "1.45.0");
  check("in-range: no warning", sel.warning ?? null, null);
}

// Future data past the only variant -> fall back + warn (graceful).
{
  const sel = selectSourceForPayload([mkLog("<=1.46.0")], payloadWithVersion("1.47.0"));
  check("drift: actual", sel.actual, "1.47.0");
  check("drift: warns", Boolean(sel.warning), true);
  console.log(`      warning => ${sel.warning}`);
}

// Two variants (old <=1.46.0, new >=1.47.0): each version routes to its variant.
{
  const variants = [mkLog("<=1.46.0"), mkLog(">=1.47.0")];
  const old = selectSourceForPayload(variants, payloadWithVersion("1.46.0"));
  check("multi: 1.46 -> <=1.46.0", old.source.version?.supported, "<=1.46.0");
  check("multi: 1.46 no warning", old.warning ?? null, null);
  const neu = selectSourceForPayload(variants, payloadWithVersion("1.48.0"));
  check("multi: 1.48 -> >=1.47.0", neu.source.version?.supported, ">=1.47.0");
  check("multi: 1.48 no warning", neu.warning ?? null, null);
}

// Snapshot version comes from the loadoutHash prefix ("v3/<hash>" -> "v3").
check("hash v3/abc -> v3", versionFromLoadoutHash("v3/abc123"), "v3");
check("hash v4/abc -> v4", versionFromLoadoutHash("v4/abc123"), "v4");
check("hash no-prefix -> undefined", versionFromLoadoutHash("abc123") ?? null, null);

// Snapshot: version supplied out-of-band (from the loadoutHash) via override.
{
  const snap: CompiledSource =
    ({ source: "snapshot", version: { supported: "v3" }, rootFn: (d: any) => d[0]?.snapshot, rootFallbackFns: [], intermediates: [], fields: [] } as any);
  const payload = { data: [{ snapshot: {} }] };

  const match = selectSourceForPayload([snap], payload, versionFromLoadoutHash("v3/abc"));
  check("snapshot v3: actual", match.actual, "v3");
  check("snapshot v3: no warning", match.warning ?? null, null);

  const drift = selectSourceForPayload([snap], payload, versionFromLoadoutHash("v4/abc"));
  check("snapshot v4: actual", drift.actual, "v4");
  check("snapshot v4: warns", Boolean(drift.warning), true);
  console.log(`      warning => ${drift.warning}`);

  // No override + no payload signal -> latest variant, no warning.
  const none = selectSourceForPayload([snap], payload);
  check("snapshot no signal: no actual", none.actual ?? null, null);
  check("snapshot no signal: no warning", none.warning ?? null, null);
}

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
if (failures > 0) process.exit(1);
