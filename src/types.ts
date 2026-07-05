// src/types.ts
//
// Shared shape definitions for the prefill pipeline. The frontend has its
// own copy of the wire-facing subset of these (app/types.ts) since the
// Worker and the browser bundle are compiled separately.
//
// -- Config model -------------------------------------------------------
// A prefill is driven by a ConfigBundle: one SheetConfig plus one
// DataSourceConfig per datasource (snapshot, log, loadout). All four share a
// common `key` so they can be authored as separate files and re-associated.
//
//   sheet.json     cells:   cell A1 -> field id            (where to write)
//   snapshot.json  fields:  field id -> expr over snapshot  (what to compute)
//   log.json       fields:  field id -> expr over log       (what to compute)
//
// The association is the field id: a datasource produces a named field, the
// sheet binds that field id to a cell. Datasources may also declare named
// `intermediates` - reusable sub-computations referenced from field/other
// intermediate expressions via `$.<id>` (e.g. party-wide damageDealt).

// A Google Sheets number format (the userEnteredFormat.numberFormat shape).
// `type` is one of Sheets' NumberFormatType values (NUMBER, PERCENT, CURRENCY,
// DATE, TIME, etc.); `pattern` is an optional format string (e.g. "0.00%").
export interface NumberFormat {
  type: string;
  pattern?: string;
}

// What a sheet cell binding may declare for `format`: either a preset name
// (e.g. "percent", "percent1", "integer") or a raw number pattern string
// (e.g. "0.00%"), or a full NumberFormat object for complete control.
export type CellFormat = string | NumberFormat;

export interface CellOverride {
  cell: string;
  value: string;
  // Optional number format to apply to the cell alongside the value.
  format?: NumberFormat;
}

export type DataSourceKind = "snapshot" | "log" | "loadout";

// A reusable named value computed once per evaluation and referenced from
// other expressions as `$.<id>`. `scope` (log only) selects which players the
// `players` binding holds when this intermediate runs: the whole party
// ("party", default) or just the focused member ("member").
// Provide exactly one of `expr` (inline) or `exprFile` (path, relative to the
// bundle dir, to a standalone .js file holding a single expression - used for
// large expressions like the ark grid that are unreadable inline).
export interface IntermediateDef {
  id: string;
  expr?: string;
  exprFile?: string;
  // Constant object passed to a parameterized exprFile module as its second
  // argument (`params`), so one typed module can back several defs (e.g. the
  // skill-gem module keyed by { slot, kind }). Ignored for inline `expr`.
  params?: Record<string, unknown>;
  scope?: "party" | "member";
  comment?: string;
}

// A named output value. `expr` is JS evaluated with these bindings:
//   data    - the full unflattened page payload
//   root    - the datasource's resolved rootPath (e.g. the snapshot object)
//   $       - lazy accessor to this datasource's intermediates
//   players - PLAYER entities in scope (log only; whole party for fields)
//   member  - the focused member entity, or null (log only)
//   sum,avg - helpers: sum(arr, fn?), avg(arr, fn?)
// Provide exactly one of `expr` (inline) or `exprFile` (see IntermediateDef).
export interface FieldDef {
  id: string;
  expr?: string;
  exprFile?: string;
  // Constant object passed to a parameterized exprFile module as its second
  // argument (`params`). Ignored for inline `expr`. See IntermediateDef.params.
  params?: Record<string, unknown>;
  comment?: string;
}

// Declares which data-format version(s) a datasource config supports, so the
// runtime can detect when a scraped page's format has drifted past what the
// config was written for and handle it gracefully (warn, still run best-effort).
// Several configs of the same `key` + `source` but different `version` may
// coexist as separate files; the runtime picks the variant whose `supported`
// constraint matches the incoming data's version (see src/version.ts).
export interface DataSourceVersion {
  // Dotted path (relative to the resolved datasource root) to the incoming
  // version value in the PAYLOAD, e.g. "encounterDamageStats.misc.version" for a
  // loa-logs encounter. Omit for datasources whose version isn't in the payload:
  // the bible snapshot/loadout carry no version field, but the loadoutHash used
  // to fetch them is prefixed with it ("v3/<hash>"), which the runtime supplies
  // out-of-band (see versionFromLoadoutHash / selectSourceForPayload). When no
  // version can be determined at all, `supported` is documentation only and the
  // latest variant is used without a comparison.
  path?: string;
  // Version constraint this variant supports: a whitespace-separated list of
  // comparators, ANDed, each `(<=|<|>=|>|=)?<version>` (a bare version means
  // "="). A leading "v" and missing components are normalized, so both semver
  // ("1.46.0") and short forms ("v3") work. Examples: "<=1.46.0", "v3",
  // ">=1.47.0", ">=1.45.0 <=1.46.0".
  supported: string;
}

export interface DataSourceConfig {
  key: string;
  source: DataSourceKind;
  // Version support declaration (see DataSourceVersion). Optional; absent means
  // the config is version-agnostic (always used, never version-checked).
  version?: DataSourceVersion;
  // Expression locating the datasource root within the unflattened payload.
  rootPath: string;
  // Alternate rootPaths tried in order if rootPath resolves to null/undefined
  // (the SvelteKit __data.json node order can shift between routes).
  rootPathFallbacks?: string[];
  intermediates?: IntermediateDef[];
  fields: FieldDef[];
  comment?: string;
}

export interface CellBinding {
  cell: string;
  field: string; // references a FieldDef.id from any datasource in the bundle
  // Which character's evaluation this cell reads the field from. "support"
  // (default) uses the party's support snapshot/log - the existing behavior.
  // "dps" reads the field from the user-selected DPS player's snapshot instead,
  // evaluated separately in phase 2 and namespaced as `dps:<field>` (see
  // resolveCells / logPrefillParty). Only meaningful for snapshot-sourced fields.
  character?: "support" | "dps";
  // Optional sheet tab override for this cell. Defaults to the sheet's
  // `sheetTab`. Lets a bundle write some cells to a different tab (e.g. the DPS
  // gear cells live on a separate "DPS players data" tab). Ignored when `cell`
  // is already tab-qualified (contains "!").
  sheetTab?: string;
  // Optional custom number format applied to the cell (e.g. "percent" so an
  // uptime ratio like 0.96 displays as 96%). See CellFormat.
  format?: CellFormat;
  // Optional spreadsheet-side transform turning the field's raw value into the
  // value actually written. This lives in the sheet (not the datasource) so the
  // datasource can stay canonical and a different spreadsheet can render the
  // same raw value differently. Evaluated with bindings (value, raw, ref,
  // fields): `value` = the field's stringified value, `raw` = its un-stringified
  // value, `ref` = the sheet's bundled refData, `fields` = a map of every
  // field's raw value (for cross-field transforms). Provide at most one of
  // `transform` (inline) or `transformFile` (path relative to the bundle dir).
  transform?: string;
  transformFile?: string;
  // Constant object passed to a parameterized transformFile module as its second
  // argument (`params`), mirroring FieldDef.params for sheet-side transforms.
  transformParams?: Record<string, unknown>;
  // Optional constant passed to the transform as its `arg` binding, so several
  // cells can share one transformFile yet behave differently - e.g. a bracelet
  // packs many effect lines and each cell's `transformArg` (0,1,2,...) selects
  // which rendered line it takes.
  transformArg?: unknown;
  // Optional section label passed to the transform as its `ctx` binding. Lets
  // one transform render the same underlying stat differently per spreadsheet
  // section - e.g. an ally-attack line worded one way in the ring section and
  // another in the bracelet section (see data/stat_lines.json context keys).
  transformContext?: string;
  comment?: string;
}

// A user-supplied value collected in the frontend's "advanced" section and
// exposed to expressions as the `input` binding (input["<id>"]). Used for stats
// that aren't in the scraped snapshot/log (e.g. flat roster + pet bonuses).
export interface AdvancedInputOption {
  value: string;
  label: string;
}
export interface AdvancedInput {
  id: string;
  label: string;
  type: "number" | "text" | "select" | "range";
  // Applied when the user leaves the field blank.
  default?: string | number;
  // Required for type "select".
  options?: AdvancedInputOption[];
  // For type "range" (slider).
  min?: number;
  max?: number;
  step?: number;
  // Display suffix for number/range values, e.g. "%".
  unit?: string;
  // Optional grouping heading in the UI (inputs sharing a section render
  // together under that heading).
  section?: string;
  help?: string;
}

export interface SheetConfig {
  key: string;
  version: string;
  templateSheet: string;
  sheetTitle?: string;
  // Target sheet tab for cell writes. If omitted, writes go to the first sheet.
  // Sheet names with spaces/special chars are automatically single-quoted.
  sheetTab?: string;
  // Manual inputs surfaced in the UI's "advanced" section, bound as `input`.
  inputs?: AdvancedInput[];
  // Reference datasets (from data/<name>.json) the sheet's cell transforms can
  // read as ref["<name>"] - e.g. a stat-index -> display-text lookup. Bundled at
  // build time, mirroring a datasource's own refData.
  refData?: string[];
  cells: CellBinding[];
}

export interface ConfigBundle {
  key: string;
  sheet: SheetConfig;
  sources: DataSourceConfig[];
}

// Result of evaluating one field/intermediate. Exactly one of value/error set.
// `raw` carries the un-stringified value (objects, numbers, ...) so sheet-side
// cell transforms can operate on structured data rather than `value`'s string.
export interface FieldResult {
  value?: string;
  raw?: unknown;
  error?: string;
}

export interface PartyInfo {
  partyNumber: number;
  playerNames: string[];
  // Display info for each member (class icon/name, item level, combat power),
  // in the same order as playerNames. From the log's PLAYER entities
  // (classId/class/gearScore/combatPower) - see fetchLogPhase.
  players: PartyMemberInfo[];
}

export interface PartyMemberInfo {
  name: string;
  classId: number;
  className: string;
  itemLevel: number;
  combatPower: number;
  // Whether the member's spec is one of SUPPORT_SPECS (see scraper.ts) -
  // selects the dps/support combat-power icon in the party-pick UI.
  isSupport: boolean;
}

export interface PlayerEntity {
  name: string;
  classId: number;
  spec: string;
  loadoutHash: string;
}

// The Worker bundles its own compiled configs (src/generated/compiledConfigs.ts)
// and looks them up by key - the wire payload carries only the key, never the
// expressions, since compiled functions aren't serializable and the runtime
// can't compile expr strings anyway.
export interface LogPrefillInitialPayload {
  configKey: string;
  logUrl: string;
}

export interface LogPrefillPartyPayload {
  jobId: string;
  partyKey: string; // "all" | "0" | "1" | ...
  // Advanced-input values (string-valued from the party-pick form); coerced/
  // defaulted via resolveInputs before the snapshot is evaluated.
  inputs?: Record<string, string | number>;
  // Name of the party member whose snapshot fills the "dps"-character gear
  // cells. Defaults (worker-side) to the highest-combatPower non-support member.
  gearMember?: string;
  // Name of the party member whose per-member uptime fills the uptime cells, or
  // "aggregate" for the whole-party sum (today's behavior). Defaults to the
  // same highest-combatPower non-support member.
  uptimeMember?: string;
}

// Per-party support preview computed in phase 1 from the log's arkPassiveData,
// so the party-pick UI can resolve the pet "auto" choice and show spec/swift
// before the snapshot is fetched. Keyed by partyKey ("all" | "0" | "1" | ...).
export interface SupportPreview {
  name: string;
  specPoints: number;
  swiftPoints: number;
}

// Pre-evaluated log fields for one party (partyKey). `aggregate` is the whole
// party (today's uptime = party-wide sums); `byMember` holds each member's
// result, evaluated with `players` bound to just that member so the same
// uptime fields collapse to per-member values. Phase 2 picks between them from
// the user's uptime selection.
export interface PartyLogResults {
  aggregate: Record<string, FieldResult>;
  byMember: Record<string, Record<string, FieldResult>>;
}

export interface LogPrefillJobMeta {
  spreadsheetId: string;
  sheetUrl: string;
  parties: PartyInfo[];
  playerEntities: PlayerEntity[];
  // Re-looked-up against COMPILED_BUNDLES in phase 2 (functions can't be
  // stored in DO storage).
  configKey: string;
  // partyKey -> per-party log results (aggregate + per-member), pre-evaluated
  // for every party in phase 1.
  logFieldResults: Record<string, PartyLogResults>;
}

export type StreamEvent =
  | { type: "job"; jobId: string }
  | { type: "status"; message: string; spreadsheetUrl?: string }
  | {
      type: "party-pick";
      parties: PartyInfo[];
      autoSelect: boolean;
      supportInfo?: Record<string, SupportPreview>;
    }
  | { type: "prefill-done"; message: string; spreadsheetUrl: string }
  | { type: "error"; message: string };
