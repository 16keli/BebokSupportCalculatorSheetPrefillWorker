// app/types.ts
//
// Wire-facing types shared conceptually with src/types.ts on the backend.
// Kept as a separate copy because the Worker and the browser bundle compile
// under different tsconfigs - duplicating these small interfaces is simpler
// than wiring up a shared package for a project this size.

export interface PartyInfo {
  partyNumber: number;
  playerNames: string[];
  players: PartyMemberInfo[];
}

// Per-member display info (class icon/name, item level, combat power), in the
// same order as playerNames. Mirrors src/types.ts's PartyMemberInfo.
export interface PartyMemberInfo {
  name: string;
  classId: number;
  className: string;
  itemLevel: number;
  combatPower: number;
  isSupport: boolean;
}

// Per-party support preview from phase 1 (log arkPassiveData): used by the
// party-pick card to resolve the pet "auto" choice and show spec/swiftness.
export interface SupportPreview {
  name: string;
  specPoints: number;
  swiftPoints: number;
}

export type DataSourceKind = "snapshot" | "log" | "loadout";

export interface IntermediateDef {
  id: string;
  expr?: string;
  exprFile?: string;
  scope?: "party" | "member";
  comment?: string;
}

export interface FieldDef {
  id: string;
  expr?: string;
  exprFile?: string;
  comment?: string;
}

export interface DataSourceConfig {
  key: string;
  source: DataSourceKind;
  rootPath: string;
  rootPathFallbacks?: string[];
  intermediates?: IntermediateDef[];
  fields: FieldDef[];
  comment?: string;
}

export interface NumberFormat {
  type: string;
  pattern?: string;
}

export type CellFormat = string | NumberFormat;

export interface CellBinding {
  cell: string;
  field: string;
  // "support" (default) or "dps" - which character's snapshot the field is read
  // from. Mirrors src/types.ts's CellBinding.
  character?: "support" | "dps";
  // Optional per-cell sheet tab override (defaults to the sheet's sheetTab).
  sheetTab?: string;
  format?: CellFormat;
  comment?: string;
}

export interface AdvancedInputOption {
  value: string;
  label: string;
}
export interface AdvancedInput {
  id: string;
  label: string;
  type: "number" | "text" | "select" | "range";
  default?: string | number;
  options?: AdvancedInputOption[];
  min?: number;
  max?: number;
  step?: number;
  unit?: string;
  section?: string;
  help?: string;
}

export interface SheetConfig {
  key: string;
  version: string;
  templateSheet: string;
  sheetTitle?: string;
  inputs?: AdvancedInput[];
  cells: CellBinding[];
}

export interface ConfigBundle {
  key: string;
  sheet: SheetConfig;
  sources: DataSourceConfig[];
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

// ---- UI-local state (not sent over the wire) ----

export interface LogLine {
  id: string;
  text: string;
  tag: "info" | "ok" | "err";
}

export interface PrefillCardState {
  jobId: string;
  logUrl: string;
  parties: PartyInfo[];
  autoSelect: boolean;
  supportInfo?: Record<string, SupportPreview>;
  // The bundle's advanced-input definitions, captured so the card can render
  // them and send the collected values with the party request.
  inputsDefs?: AdvancedInput[];
}

// Pushed over the /api/rate-limit-stream WebSocket whenever quota changes.
// Mirrors src/rateLimiter.ts's QuotaSnapshot.
export interface QuotaSnapshot {
  type: "quota";
  remaining: number;
  limit: number;
  usedInWindow: number;
  msUntilNextSlot: number;
}
