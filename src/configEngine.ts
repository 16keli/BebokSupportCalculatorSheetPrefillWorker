// src/configEngine.ts
//
// The evaluation engine. It turns a *compiled* datasource into named field
// values, and a compiled bundle + field values into cell writes.
//
// Why compiled: the Cloudflare Workers runtime (workerd) forbids
// `new Function`/`eval` at request time AND at module load. So config `expr`
// strings can't be evaluated in the Worker. scripts/compileConfigs.mjs emits
// real arrow-function literals (bundled at build time) that this engine calls.
// The JSON under configs/<key>/ remains the authoring source of truth.
//
// Within a datasource, expressions can:
//   - read `root` (the resolved rootPath) and `data` (the page nodes array)
//   - reference intermediates via `$.<id>` - computed lazily, memoized, with
//     cycle detection, to factor out shared sub-computations (e.g. party-wide
//     damageDealt) and reuse them across fields.
//
// Intermediate `scope` (log only) controls the `players` binding: "party"
// (whole party, default) or "member" (just the focused member) - the
// "whole party vs. a specific member" filter.

import type {
  AdvancedInput,
  CellFormat,
  CellOverride,
  DataSourceKind,
  DataSourceVersion,
  FieldResult,
  NumberFormat,
  SheetConfig,
} from "./types";

// Named number-format presets a cell binding can reference by string. Anything
// not listed here is treated as a raw Sheets number pattern (PERCENT when it
// contains '%', otherwise NUMBER) so authors can also write e.g. "0.0%".
const FORMAT_PRESETS: Record<string, NumberFormat> = {
  percent: { type: "PERCENT", pattern: "0%" },
  percent1: { type: "PERCENT", pattern: "0.0%" },
  percent2: { type: "PERCENT", pattern: "0.00%" },
  integer: { type: "NUMBER", pattern: "0" },
  number: { type: "NUMBER", pattern: "0.##" },
  number2: { type: "NUMBER", pattern: "0.00" },
};

// Resolve a cell binding's `format` (preset name | raw pattern | NumberFormat)
// into a concrete Google Sheets NumberFormat, or undefined if none was set.
export function resolveFormat(format?: CellFormat): NumberFormat | undefined {
  if (!format) return undefined;
  if (typeof format !== "string") return format;
  const preset = FORMAT_PRESETS[format.toLowerCase()];
  if (preset) return preset;
  return { type: format.includes("%") ? "PERCENT" : "NUMBER", pattern: format };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ExprFn = (...args: any[]) => unknown;

export interface CompiledFieldFn {
  id: string;
  fn: ExprFn;
  // Constant passed to a parameterized expr module as its second argument, so
  // one typed module can back several defs (see FieldDef.params). Null/absent
  // for inline exprs.
  params?: unknown;
  scope?: "party" | "member" | null;
}

export interface CompiledSource {
  source: DataSourceKind;
  // Version support declaration (see DataSourceVersion); null when the config is
  // version-agnostic. Used by selectSourceForPayload to pick the right variant.
  version?: DataSourceVersion | null;
  // URL to fetch this datasource from, with {hash} replaced by the support's
  // loadoutHash. Undefined/empty disables fetching this source.
  urlTemplate?: string;
  // Bundled reference datasets (from data/<name>.json), exposed to expressions
  // as ref["<name>"].
  ref?: Record<string, unknown>;
  rootFn: ExprFn;
  rootFallbackFns?: ExprFn[];
  intermediates: CompiledFieldFn[];
  fields: CompiledFieldFn[];
}

export interface CompiledBundle {
  key: string;
  sheet: SheetConfig;
  sources: CompiledSource[];
  // Reference datasets bundled for the sheet's cell transforms (sheet.refData),
  // exposed to a transform as its `ref` argument.
  sheetRef?: Record<string, unknown>;
  // Compiled cell transforms, keyed by the (unqualified) cell A1 ref. Each is
  // called (value, raw, ref, fields) during resolveCells to derive the written
  // value from the field's raw value. See CellBinding.transform.
  cellTransforms?: Record<string, ExprFn>;
}

// Players the field/intermediate expressions operate over. `players` is set
// per-party in the log phase; `member` is the single focused entity (the
// support), or null when it can't be uniquely identified.
export interface Selection {
  players: unknown[];
  member: unknown | null;
}

export function stringifyVal(v: unknown): string {
  if (v === undefined || v === null) return "";
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const sum = (arr: any[], fn?: (x: any) => number): number =>
  (arr || []).reduce((s, x) => s + (fn ? Number(fn(x)) || 0 : Number(x) || 0), 0);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const avg = (arr: any[], fn?: (x: any) => number): number =>
  arr && arr.length ? sum(arr, fn) / arr.length : 0;

// Expression `data` binding = the array of unflattened SvelteKit page nodes
// (data[0], data[1], ...). Accepts either that array directly or the
// { data: [...] } wrapper the scraper's unflatten produces.
function nodesOf(payload: unknown): unknown {
  if (Array.isArray(payload)) return payload;
  if (payload && typeof payload === "object" && Array.isArray((payload as { data?: unknown }).data)) {
    return (payload as { data: unknown }).data;
  }
  return payload;
}

// Resolve the datasource root, trying rootFn then each fallback in order,
// returning the first that yields a non-nullish value. Exported so the log
// phase can locate the encounter with the same rules the engine uses.
export function resolveRoot(payload: unknown, src: CompiledSource): unknown {
  const data = nodesOf(payload);
  for (const fn of [src.rootFn, ...(src.rootFallbackFns ?? [])]) {
    try {
      const v = fn(data);
      if (v !== undefined && v !== null) return v;
    } catch {
      /* try next */
    }
  }
  return undefined;
}

// Coerce/default the user-supplied advanced inputs against their definitions:
// blanks fall back to the configured default, and "number" inputs become real
// numbers. Produces the map bound as `input` during evaluation.
export function resolveInputs(
  defs: AdvancedInput[] | undefined,
  provided: Record<string, unknown> | undefined
): Record<string, string | number> {
  const out: Record<string, string | number> = {};
  for (const def of defs ?? []) {
    const raw = provided?.[def.id];
    const isBlank = raw === undefined || raw === null || raw === "";
    const value = isBlank ? def.default : raw;
    const numeric = def.type === "number" || def.type === "range";
    out[def.id] = numeric ? Number(value ?? 0) : (value as string);
  }
  return out;
}

// Evaluate every field of a compiled datasource against `payload`. `selection`
// is only meaningful for the log source; snapshot/loadout pass none. `inputs`
// (already resolved via resolveInputs) is bound as `input` for every expr.
export function evaluateSource(
  src: CompiledSource,
  payload: unknown,
  selection?: Selection,
  inputs?: Record<string, unknown>
): Record<string, FieldResult> {
  const data = nodesOf(payload);
  const root = resolveRoot(payload, src);
  const partyPlayers = selection?.players ?? [];
  const member = selection?.member ?? null;
  const ref = src.ref ?? {};
  const input = inputs ?? {};

  const defs = new Map(src.intermediates.map((i) => [i.id, i]));
  const cache = new Map<string, { value: unknown } | { error: string }>();
  const inProgress = new Set<string>();

  // The typed context object every expression receives as its first argument
  // (its second is the def's `params`). `players` varies per call - the whole
  // party for fields, and per-scope for intermediates - so it's filled in at the
  // call site; everything else is shared.
  const makeCtx = (players: unknown[]) => ({
    data,
    root,
    $,
    players,
    member,
    sum,
    avg,
    ref,
    input,
  });

  // Lazy, memoized, cycle-checked accessor for intermediates. Reading
  // `$.foo` computes `foo` on first access (binding `players` per its scope)
  // and caches the result (or the error) for subsequent reads.
  const $ = new Proxy(
    {},
    {
      get(_t, prop): unknown {
        if (typeof prop !== "string") return undefined;
        const cached = cache.get(prop);
        if (cached) {
          if ("error" in cached) throw new Error(cached.error);
          return cached.value;
        }
        const def = defs.get(prop);
        if (!def) throw new Error(`unknown intermediate '${prop}'`);
        if (inProgress.has(prop)) throw new Error(`cyclic intermediate '${prop}'`);
        inProgress.add(prop);
        try {
          const scoped = def.scope === "member" ? (member ? [member] : []) : partyPlayers;
          const value = def.fn(makeCtx(scoped), def.params);
          cache.set(prop, { value });
          return value;
        } catch (e) {
          cache.set(prop, { error: (e as Error).message });
          throw e;
        } finally {
          inProgress.delete(prop);
        }
      },
    }
  );

  const out: Record<string, FieldResult> = {};
  for (const f of src.fields) {
    try {
      const val = f.fn(makeCtx(partyPlayers), f.params);
      out[f.id] = { value: stringifyVal(val), raw: val };
    } catch (e) {
      out[f.id] = { error: (e as Error).message };
    }
  }
  return out;
}

export interface ResolveResult {
  writes: CellOverride[];
  skipped: Array<{ cell: string; field: string; reason: string }>;
}

// Qualifies a bare cell reference (e.g. "F2") with a sheet tab prefix so the
// write targets the correct tab. Already-qualified refs (containing "!") are
// passed through unchanged. Single quotes are required when the name contains
// spaces, dots, or other special characters; internal single quotes are doubled.
function qualifyCell(cell: string, sheetTab: string | undefined): string {
  if (!sheetTab || cell.includes("!")) return cell;
  const needsQuotes = /[^A-Za-z0-9_]/.test(sheetTab);
  const tabName = needsQuotes ? `'${sheetTab.replace(/'/g, "''")}'` : sheetTab;
  return `${tabName}!${cell}`;
}

// Map the compiled bundle's sheet cells onto computed field values. Cells whose
// field produced an error, no value, or an empty string are skipped (not
// written) and reported so callers can surface what was left blank.
export function resolveCells(
  bundle: CompiledBundle,
  fieldValues: Record<string, FieldResult>
): ResolveResult {
  const writes: CellOverride[] = [];
  const skipped: ResolveResult["skipped"] = [];
  const { sheetTab } = bundle.sheet;
  const sheetRef = bundle.sheetRef ?? {};
  const transforms = bundle.cellTransforms ?? {};

  // Map of every field's raw value, exposed to cell transforms as `fields` so a
  // transform can read sibling fields (built lazily - only if any transform
  // exists for this sheet).
  let rawFields: Record<string, unknown> | null = null;
  const rawFieldsOf = () => {
    if (!rawFields) {
      rawFields = {};
      for (const [id, fr] of Object.entries(fieldValues)) rawFields[id] = fr.raw;
    }
    return rawFields;
  };

  for (const binding of bundle.sheet.cells) {
    // "dps" cells read the field from the DPS player's separately-evaluated
    // snapshot, merged into fieldValues under a `dps:` namespace by phase 2.
    const lookupId = binding.character === "dps" ? `dps:${binding.field}` : binding.field;
    const r = fieldValues[lookupId];
    if (!r) {
      skipped.push({ cell: binding.cell, field: binding.field, reason: "field not produced" });
      continue;
    }
    if (r.error) {
      skipped.push({ cell: binding.cell, field: binding.field, reason: `error: ${r.error}` });
      continue;
    }

    // The value to write: the field's value, optionally run through the sheet's
    // cell transform (which derives the written value from the raw value).
    let value = r.value;
    const transform = transforms[binding.cell];
    if (transform) {
      try {
        const tctx = {
          value: r.value,
          raw: r.raw,
          ref: sheetRef,
          fields: rawFieldsOf(),
          arg: binding.transformArg,
          ctx: binding.transformContext,
        };
        value = stringifyVal(transform(tctx, binding.transformParams));
      } catch (e) {
        skipped.push({
          cell: binding.cell,
          field: binding.field,
          reason: `transform error: ${(e as Error).message}`,
        });
        continue;
      }
    }

    if (value === undefined || value === "") {
      skipped.push({ cell: binding.cell, field: binding.field, reason: "empty" });
      continue;
    }
    writes.push({
      cell: qualifyCell(binding.cell, binding.sheetTab ?? sheetTab),
      value,
      format: resolveFormat(binding.format),
    });
  }
  return { writes, skipped };
}

// All compiled variants for a datasource kind (one per authored version file).
// May be empty. The runtime picks among them by data version - see
// selectSourceForPayload in src/version.ts.
export function findSources(
  bundle: CompiledBundle,
  kind: DataSourceKind
): CompiledSource[] {
  return bundle.sources.filter((s) => s.source === kind);
}

// The first compiled variant for a kind (undefined if none). Sufficient where a
// specific version isn't needed (e.g. reading shared metadata); use
// findSources + selectSourceForPayload when the data version matters.
export function findSource(
  bundle: CompiledBundle,
  kind: DataSourceKind
): CompiledSource | undefined {
  return bundle.sources.find((s) => s.source === kind);
}
