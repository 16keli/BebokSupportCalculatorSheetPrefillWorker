// src/scrapeStrip.ts
//
// Field allowlists for the scrape cache. Before a fetched payload is stored in
// D1 (see scrapeCache.ts / scraper.ts) we prune the resolved datasource root
// down to just the fields the configs actually read, which is most of the
// savings - a raw loa-logs encounter is ~1-2 MB, dominated by per-entity skill
// logs and the full buff/debuff dictionaries we never touch.
//
// The allowlists are derived from configs/<key>/{snapshot,log}.json (+ their
// expr files) and from how scraper.ts selects players/parties. If you change
// those configs to read a NEW field, add it here AND bump STRIP_VERSION: a
// cached entry records the version it was stripped under, and getCachedPayload
// treats any entry with a different version as a miss, so widening the
// allowlist transparently forces a re-fetch of the fuller data rather than
// serving a stale, over-pruned payload that is missing the new field.

import type { DataSourceKind } from "./types";

// Bump whenever any allowlist below changes (in either direction). Entries
// cached under an older version are ignored and re-fetched.
//   v2: log keeps encounterDamageStats.buffs (projected to uniqueGroup) for the
//       AP-buff uptime proportion (BC17).
//   v3: that buffs projection also keeps source.skill.id (as skillId), so BC17
//       can attribute AP-buff damage to the ap1 skill.
//   v4: log keeps encounterDamageStats.misc.version (the loa-logs format
//       version) so the datasource version check (src/version.ts) can compare it.
//   v5: log entities keep class/gearScore/combatPower (party-pick UI display:
//       class icon, item level, combat power - see PartyMemberInfo).
//   v6: log entities keep a projection of `skills` (only special:true, with
//       totalDamage/isHyperAwakening) so the uptime denominator can subtract
//       fixed/unbuffable damage (see configs/log/expr/partyDamageDealt.ts).
//   v7: log entities keep `engravingData` (the per-player engraving-name list,
//       used to flag inaccurate snapshots - see scraper.ts snapshotWarning), and
//       the loadout root (an array of loadouts from a /character/<region>/<name>
//       page) is pruned per-element to the snapshot gear keys + loadout-selection
//       metadata (see stripRoot's loadout branch below).
//   v8: snapshot root keeps `combatPower` (the phase-2 snapshot<->log cross-check
//       compares it against the log's combatPower - see compareSnapshotToLog).
//   v9: log keeps encounterDamageStats.misc.region (NA/CE), used to prefill the
//       gear-override character link (https://lostark.bible/character/<region>/<name>).
export const STRIP_VERSION = 9;

// Snapshot root (the character object): top-level keys read by snapshot.json
// and its expr files (itemBySlot/arkGrid/arkPassive/combatStats + the fields).
const SNAPSHOT_KEEP = new Set([
  "classId",
  "combatPower",
  "items",
  "gems",
  "skills",
  "engravings",
  "karma",
  "arkPassive",
  "arkGridCores",
]);

// Log encounter root: top-level keys read by log.json + scraper.ts.
const LOG_ROOT_KEEP = new Set([
  "currentBossName",
  "entityList",
  "encounterDamageStats",
]);

// Per-entity keys: the selection fields scraper.ts reads (entityType/name/
// classId/spec/loadoutHash), the party-pick display fields (class/gearScore/
// combatPower - see PartyMemberInfo), the engraving-name list (engravingData -
// used to flag inaccurate snapshots), plus what the log fields evaluate over
// (damageStats.*, arkPassiveData.evolution). Everything else on an entity -
// notably the heavy skills / skillCastLog / damageInfo - is dropped.
const LOG_ENTITY_KEEP = new Set([
  "entityType",
  "name",
  "classId",
  "class",
  "gearScore",
  "combatPower",
  "spec",
  "loadoutHash",
  "engravingData",
  "arkPassiveData",
  "damageStats",
  // Pruned further below to only special skills' {special,isHyperAwakening,
  // totalDamage} - the fixed-damage sources the uptime denominator subtracts.
  "skills",
]);

// Loadout element (one entry of a /character/<region>/<name> page's `loadouts`
// array): each is a structural superset of a snapshot root, so it's evaluated by
// the snapshot datasource (see scraper.ts fetchCharacterGearPhase). Keep the
// snapshot gear keys plus the metadata pickLoadout selects on.
const LOADOUT_ELEMENT_KEEP = new Set([
  ...SNAPSHOT_KEEP,
  "classification",
  "battlePoint",
  "lastUpdated",
  "itemLevel",
]);

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

// Deletes every own key of `obj` not in `allow` (in place). No-op for non-objects.
function keepKeys(obj: unknown, allow: Set<string>): void {
  if (!isPlainObject(obj)) return;
  for (const k of Object.keys(obj)) {
    if (!allow.has(k)) delete obj[k];
  }
}

// Prunes the resolved datasource root IN PLACE to the allowlist for its kind,
// preserving the surrounding payload structure so resolveRoot still finds it on
// read. Unknown kinds are left untouched.
export function stripRoot(kind: DataSourceKind, root: unknown): void {
  // Loadout root is the `loadouts` array (a character page); prune each element.
  if (kind === "loadout") {
    if (Array.isArray(root)) {
      for (const l of root) keepKeys(l, LOADOUT_ELEMENT_KEEP);
    }
    return;
  }

  if (!isPlainObject(root)) return;

  if (kind === "snapshot") {
    keepKeys(root, SNAPSHOT_KEEP);
    return;
  }

  if (kind === "log") {
    keepKeys(root, LOG_ROOT_KEEP);
    if (Array.isArray(root.entityList)) {
      for (const e of root.entityList) {
        keepKeys(e, LOG_ENTITY_KEEP);
        // `skills` is the heaviest per-entity field (full per-skill logs). We
        // keep only fixed-damage sources (special:true) projected to the three
        // fields partyDamageDealt.ts reads; hyper-awakening damage already lives
        // on damageStats, so it needs no per-skill data.
        if (isPlainObject(e) && isPlainObject((e as { skills?: unknown }).skills)) {
          const src = (e as { skills: Record<string, unknown> }).skills;
          const kept: Record<string, unknown> = {};
          for (const [id, s] of Object.entries(src)) {
            if (isPlainObject(s) && s.special === true) {
              kept[id] = {
                special: true,
                isHyperAwakening: s.isHyperAwakening === true,
                totalDamage: s.totalDamage,
              };
            }
          }
          (e as { skills: unknown }).skills = kept;
        }
      }
    }
    // encounterDamageStats is huge (full buff/debuff defs + descriptions). We
    // keep only misc.partyInfo (read by scraper.ts to group players into
    // parties), misc.version (the loa-logs format version, read by the
    // datasource version check - see src/version.ts), misc.region (NA/CE, used
    // to prefill the gear-override character link), and a per-buff projection
    // of `buffs` (read by the AP-buff uptime field BC17): uniqueGroup
    // categorizes a buffedBy entry by attack-power group, and skillId
    // (= source.skill.id) attributes it to the casting skill so BC17 can isolate
    // the ap1 share. Everything else - each buff's name/desc/icon and the rest
    // of source - is dropped.
    const eds = root.encounterDamageStats as
      | { misc?: { partyInfo?: unknown; version?: unknown; region?: unknown }; buffs?: Record<string, unknown> }
      | undefined;
    const partyInfo = eds?.misc?.partyInfo;
    const version = eds?.misc?.version;
    const region = eds?.misc?.region;
    const buffs: Record<string, { uniqueGroup: unknown; skillId: unknown }> = {};
    if (isPlainObject(eds?.buffs)) {
      for (const [id, b] of Object.entries(eds.buffs)) {
        if (isPlainObject(b) && "uniqueGroup" in b) {
          const source = b.source;
          const skill = isPlainObject(source) ? source.skill : undefined;
          const skillId = isPlainObject(skill) ? skill.id : undefined;
          buffs[id] = { uniqueGroup: b.uniqueGroup, skillId };
        }
      }
    }
    root.encounterDamageStats = { misc: { partyInfo, version, region }, buffs };
    return;
  }
}
