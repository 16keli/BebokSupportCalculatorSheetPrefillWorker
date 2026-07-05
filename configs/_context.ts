// configs/expr/_context.ts
//
// Shared authoring surface for the typed expression modules in this directory.
// Each expr file is a real TypeScript module that exports (as default) a
// function built with one of the helpers below. The build
// (scripts/compileConfigs.mjs) imports these modules into
// src/generated/compiledConfigs.ts and the engine (src/configEngine.ts) calls
// them as `(ctx, params)` - a typed context object plus the def's optional
// `params` constant (see FieldDef.params / CellBinding.transformParams).
//
// The helpers are IDENTITY FUNCTIONS at runtime (they just return `fn`); their
// only job is to attach the right context/param types so authoring an
// expression is type-checked and autocompletes. Typing here is deliberately
// PRAGMATIC: the intermediates accessor ($), the sum/avg helpers, the resolved
// `input` map and the bundled `ref` tables are typed; `root`/`data` stay `any`
// (they mirror loosely-shaped scraped payloads and can be tightened later).

/* eslint-disable @typescript-eslint/no-explicit-any */

// -- Helper types ---------------------------------------------------------
export type Sum = (arr: any[], fn?: (x: any) => number) => number;
export type Avg = (arr: any[], fn?: (x: any) => number) => number;

// A user-supplied advanced input value, already coerced by resolveInputs.
export type Inputs = Record<string, string | number>;

// -- Reference tables (data/<name>.json), bundled via a source's refData ----
export interface Skill {
  id: number;
  classId: number;
  type: string;
  cooldown: number;
  cdrTripods?: { tier: number; option: number; cd: number }[];
}
export interface Core {
  id: number;
  attr: number;
  coreType: number;
  groupId: number;
  grade: number;
  gemSlotPoint: number;
  pcClass: number;
  title: string;
  options: { optionId: number; requiredPoints: number }[];
}
export interface RefTables {
  skills?: Skill[];
  gems?: Record<number, { id: number; level: number }>;
  astrogems?: Record<number, { id: number; name: string; baseCost: number }>;
  cores?: { cores: Record<number, Core> };
  armor?: Record<number, { id: number; balanceLevel: number }>;
  ark_passive?: { enlightenment?: Record<string, { tier: number; type: string }> };
  encounters?: Record<string, Record<string, string[]>>;
  core_lines?: Record<string, string>;
  stat_lines?: Record<string, any>;
  legendary_skin_ids?: number[];
  // Support spec names (data/support_specs.json) - used to exclude supports from
  // the party DPS aggregate (dpsPlayers). Mirrors SUPPORT_SPECS in src/scraper.ts.
  support_specs?: string[];
  // Skill-group id -> member skill ids (data/gem_skill_groups.json, from
  // raw_data/GemSkillGroup.json). Resolves type-34/35 group-targeting gems to
  // their skills for the DPS gem block (see configs/snapshot/expr/dpsGems.ts).
  gem_skill_groups?: Record<string, number[]>;
}

// -- Intermediate result shapes ($.<id>) ------------------------------------
export interface ClassSkill {
  id: number;
  type: string;
  level: number;
  cooldown: number;
  effectiveCooldown: number;
}
export interface ClassSkills {
  ap1: ClassSkill | null;
  ap2: ClassSkill | null;
  // The primary brand skill (feeds the sheet's single brand slot). Chosen from
  // `brands` - highest level, ties broken by skills.json order - so when several
  // brand skills are present the pick is deterministic but otherwise arbitrary.
  brand: ClassSkill | null;
  // Every brand skill DETECTED in the build (present in root.skills), primary
  // first. A class may designate several brand skills (skills.json type "brand");
  // this lists the ones the player actually runs. `brand` is brands[0]. Empty
  // when no brand skill is slotted. (otherSkills still excludes only the primary,
  // so a non-primary brand appears there as a normal skill.)
  brands: ClassSkill[];
}
export type SkillGems = Record<number, { dmg?: number; cdr?: number }>;
export interface OtherSkill {
  id: number;
  cooldown: number | "";
  dmg: number | "";
  cdr: number | "";
}
export interface Item {
  slot: string;
  data?: any;
  [k: string]: any;
}
export interface StoneEngraving {
  id: number;
  nodes: number;
  level: number;
}
export interface ArkGrid {
  byBase: Record<
    number,
    { id: number; found: boolean; points: number | null; threshold: number | null; activeCount: number }
  >;
  side: Record<number, number>;
}
export interface ArkPassiveResolved {
  evo: Record<number, number>;
  enlMain: Record<number, number>;
  enlSide: Record<number, number>;
}
export interface CombatStats {
  spec: number;
  swift: number;
  pet: string | number;
}

// The snapshot datasource's intermediates. Explicitly enumerated (no index
// signature) so a typo like `$.classSkil` is a compile error.
export interface SnapshotIntermediates {
  itemBySlot: Record<string, Item>;
  gearTier: Record<string, string>;
  arkGrid: ArkGrid;
  arkPassive: ArkPassiveResolved;
  combatStats: CombatStats;
  stoneEngravings: StoneEngraving[];
  skillGems: SkillGems;
  classSkills: ClassSkills;
  otherSkills: OtherSkill[];
}

export interface DpsPlayer {
  name?: string;
  damageStats: { buffedBy?: Record<string, number>;[k: string]: any };
  [k: string]: any;
}
// The log datasource's intermediates. The named ones are read from expr
// modules; the index signature covers the several inline aggregates in log.json.
export interface LogIntermediates {
  partyDamageDealt: number;
  dpsPlayers: DpsPlayer[];
  [k: string]: any;
}

export interface LoadoutIntermediates {
  legendarySkins: Set<number>;
  activeLoadout: any;
  [k: string]: any;
}

// -- Context objects passed to each expression as its first argument ---------
interface BaseCtx {
  data: any;
  root: any;
  players: any[];
  member: any;
  sum: Sum;
  avg: Avg;
  ref: RefTables;
  input: Inputs;
}
export interface SnapshotCtx extends BaseCtx {
  $: SnapshotIntermediates;
}
export interface LogCtx extends BaseCtx {
  $: LogIntermediates;
}
export interface LoadoutCtx extends BaseCtx {
  $: LoadoutIntermediates;
}

// Cell transforms (sheet-side). See CellBinding.transform / resolveCells.
export interface TransformCtx {
  value: string;
  raw: unknown;
  ref: RefTables;
  fields: Record<string, unknown>;
  arg: unknown;
  ctx: string | undefined;
}

// -- Authoring helpers (identity at runtime) --------------------------------
export const snapshotExpr =
  <P = void, R = unknown>(fn: (c: SnapshotCtx, p: P) => R) => fn;
export const logExpr =
  <P = void, R = unknown>(fn: (c: LogCtx, p: P) => R) => fn;
export const loadoutExpr =
  <P = void, R = unknown>(fn: (c: LoadoutCtx, p: P) => R) => fn;
export const transform =
  <P = void, R = unknown>(fn: (c: TransformCtx, p: P) => R) => fn;
