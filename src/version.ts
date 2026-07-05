// src/version.ts
//
// Datasource version handling. Each datasource config may declare a
// `version: { path?, supported }` (see DataSourceVersion): where to read the
// incoming data's version from the payload, and which version(s) the config
// supports. At fetch time the runtime reads the incoming version and selects the
// config variant whose `supported` constraint matches - or, when the data has
// drifted past every variant, falls back to the latest and warns (best-effort),
// so a new loa-logs / bible release degrades gracefully instead of silently
// producing wrong cells.
//
// Version strings are normalized so both semver ("1.46.0") and short forms
// ("v3") compare sensibly: a leading "v" is dropped and each dot-separated
// component is parsed as an integer (non-numeric / missing -> 0).

import { resolveRoot, type CompiledSource } from "./configEngine.ts";

// "v3" -> [3]; "1.46.0" -> [1,46,0]; "1.46" vs "1.46.0" compare equal (missing
// trailing components are treated as 0).
export function parseVersion(v: string): number[] {
  return String(v)
    .trim()
    .replace(/^v/i, "")
    .split(".")
    .map((part) => {
      const n = parseInt(part, 10);
      return Number.isNaN(n) ? 0 : n;
    });
}

// -1 if a < b, 0 if equal, 1 if a > b (component-wise, shorter padded with 0).
export function compareVersions(a: string, b: string): number {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return 0;
}

// Does `actual` satisfy a constraint string? The constraint is a
// whitespace-separated list of comparators, ALL of which must hold, each
// `(<=|<|>=|>|=)?<version>` (a bare version means "="). Examples:
//   satisfiesVersion("1.45.0", "<=1.46.0")            -> true
//   satisfiesVersion("1.47.0", "<=1.46.0")            -> false
//   satisfiesVersion("v3", "v3")                       -> true
//   satisfiesVersion("1.46.0", ">=1.45.0 <=1.46.0")   -> true
export function satisfiesVersion(actual: string, constraint: string): boolean {
  const tokens = constraint.trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return true;
  for (const token of tokens) {
    const m = /^(<=|>=|<|>|=)?\s*(.+)$/.exec(token);
    if (!m) return false;
    const op = m[1] ?? "=";
    const cmp = compareVersions(actual, m[2]!);
    const ok =
      op === "<=" ? cmp <= 0 :
      op === "<" ? cmp < 0 :
      op === ">=" ? cmp >= 0 :
      op === ">" ? cmp > 0 :
      cmp === 0;
    if (!ok) return false;
  }
  return true;
}

// Read a dotted path (e.g. "encounterDamageStats.misc.version") off an object,
// returning the value as a string, or undefined if the path is absent / the leaf
// isn't a string/number.
export function readVersionPath(root: unknown, path: string): string | undefined {
  let cur: unknown = root;
  for (const key of path.split(".")) {
    if (cur == null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[key];
  }
  return typeof cur === "string" || typeof cur === "number" ? String(cur) : undefined;
}

// The bible data version is encoded as the loadoutHash prefix, e.g.
// "v3/5752fa..." -> "v3". This is the version signal for the snapshot (and
// loadout) datasources - their payload bodies carry no version field, but the
// hash used to fetch them does. Returns undefined for a hash with no prefix.
export function versionFromLoadoutHash(loadoutHash: string): string | undefined {
  const i = loadoutHash.indexOf("/");
  return i > 0 ? loadoutHash.slice(0, i) : undefined;
}

// The largest version mentioned in a constraint, used to order variants
// "latest first" (so the newest config is preferred, and is the fallback when
// the data outruns every variant). Version-agnostic configs sort lowest.
function constraintMaxVersion(v?: DataSourceVersionLike): string {
  const supported = v?.supported;
  if (!supported) return "0";
  let max: string | null = null;
  for (const token of supported.trim().split(/\s+/).filter(Boolean)) {
    const ver = token.replace(/^(<=|>=|<|>|=)/, "");
    if (max === null || compareVersions(ver, max) > 0) max = ver;
  }
  return max ?? "0";
}

type DataSourceVersionLike = { path?: string; supported: string };

export interface SourceSelection {
  // The chosen variant to evaluate.
  source: CompiledSource;
  // The incoming data version read from the payload, if any variant declared a
  // `path` and it resolved.
  actual?: string;
  // Set when the data version matched no variant and we fell back to the latest;
  // surfaced to the user so they know the output is best-effort.
  warning?: string;
}

// Pick the config variant to evaluate for a freshly fetched payload.
//
// The incoming data version comes from, in order of precedence:
//   1. `actualOverride`, when the caller already knows it out-of-band - the
//      snapshot/loadout version lives in the loadoutHash prefix, not the payload
//      (see versionFromLoadoutHash), so scrapeJob passes it in.
//   2. otherwise, the first variant's `version.path` read off the resolved root
//      (the log's encounterDamageStats.misc.version).
//
// - No variant declares a version -> the first variant (version-agnostic).
// - Incoming version known -> compare against each variant's `supported` (latest
//   first) and take the first match; if none match, use the latest + warn.
// - Incoming version unknown -> use the latest variant, no warning.
export function selectSourceForPayload(
  variants: CompiledSource[],
  payload: unknown,
  actualOverride?: string
): SourceSelection {
  if (variants.length === 0) throw new Error("selectSourceForPayload: no variants");

  // Latest-first ordering by the max version each variant supports.
  const ordered = [...variants].sort((a, b) =>
    compareVersions(constraintMaxVersion(b.version ?? undefined), constraintMaxVersion(a.version ?? undefined))
  );

  const versioned = variants.filter((v) => v.version?.supported);
  if (versioned.length === 0) return { source: ordered[0]! };

  let actual = actualOverride;
  if (actual === undefined) {
    // Read the incoming version via the first variant that declares a path (all
    // variants of a kind share the same root/path).
    const pathVariant = variants.find((v) => v.version?.path);
    actual = pathVariant
      ? readVersionPath(resolveRoot(payload, pathVariant), pathVariant.version!.path!)
      : undefined;
  }

  if (actual === undefined) {
    // No version signal available -> newest variant, best-effort, no warning.
    return { source: ordered[0]! };
  }

  const match = ordered.find((v) => v.version?.supported && satisfiesVersion(actual!, v.version.supported));
  if (match) return { source: match, actual };

  const fallback = ordered[0]!;
  const supportedList = variants.map((v) => v.version?.supported).filter(Boolean).join(", ");
  return {
    source: fallback,
    actual,
    warning:
      `${fallback.source} data version ${actual} is not supported ` +
      `(supported: ${supportedList}). Using the latest config best-effort - ` +
      `some values may be inaccurate until the config is updated.`,
  };
}
