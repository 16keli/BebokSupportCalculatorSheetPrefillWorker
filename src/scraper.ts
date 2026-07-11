// src/scraper.ts
//
// Fetches lostark.bible SvelteKit data using Puppeteer: navigates the page so
// the browser picks up a live session, then fetches __data.json from within
// the page context (inheriting cookies) to avoid the 403 a plain Worker fetch
// gets. The raw response is unflattened with devalue in the Worker context.
//
// This module is the I/O boundary; the actual field/intermediate evaluation
// lives in configEngine.ts. The log phase pre-evaluates the log datasource
// once per party (selecting the party's players and its support member); the
// snapshot phase evaluates the snapshot datasource for the chosen support.

import puppeteer from "@cloudflare/puppeteer";
import { unflatten } from "devalue";
import {
  evaluateSource,
  resolveRoot,
  type CompiledSource,
} from "./configEngine";
import { selectSourceForPayload } from "./version";
import {
  dataJsonUrl,
  getCachedPayload,
  putCachedPayload,
  type RawEnvelope,
} from "./scrapeCache";
import { stripRoot } from "./scrapeStrip";
import SUPPORT_SPECS_LIST from "../data/support_specs.json";
import SUPPORT_ENGRAVINGS_LIST from "../data/support_engravings.json";
import CHAOS_ENGRAVINGS_LIST from "../data/chaos_engravings.json";
import ENGRAVING_NAMES_MAP from "../data/engraving_names.json";
import type {
  FieldResult,
  PartyInfo,
  PartyLogResults,
  PartyMemberInfo,
  PlayerEntity,
  PlayerLogFingerprint,
} from "./types";

const NAV_TIMEOUT_MS = 30_000;

// Support specs used to pick the focused member within a party. Single source
// of truth is data/support_specs.json, also bundled into the log config as
// ref.support_specs (see configs/log/log.json's dpsPlayers), so the party-DPS
// filter and the member-selection here can never drift apart.
export const SUPPORT_SPECS = new Set<string>(SUPPORT_SPECS_LIST);

// Engraving-name heuristics for flagging inaccurate gear snapshots, read from
// the log's per-player engravingData (no snapshot fetch needed). A support whose
// build shows 2+ engravings outside the expected support set - or a DPS running
// a "chaos"/mobbing engraving - is likely logged with the wrong loadout.
const SUPPORT_ENGRAVINGS = new Set<string>(SUPPORT_ENGRAVINGS_LIST);
const CHAOS_ENGRAVINGS = new Set<string>(CHAOS_ENGRAVINGS_LIST);
// Character engraving-list id -> name (data/engraving_names.json, from
// raw_data/Ability.json). Snapshot engravings carry an id offset by +1000 from
// the ability id, so a snapshot engraving id X resolves as MAP[X].
const ENGRAVING_NAMES = ENGRAVING_NAMES_MAP as Record<string, string>;

// Normalizes an engraving-name list to the discriminating names: drops the
// "Unknown" slot padding and the shared "*Reduction" utility engravings (Atk.
// Power / Defense / Move Speed Reduction) which don't distinguish builds.
function cleanEngravings(list: unknown): string[] {
  return (Array.isArray(list) ? list : []).filter(
    (e: unknown): e is string =>
      typeof e === "string" && e !== "Unknown" && !e.includes("Reduction"),
  );
}

// Ark-passive node array -> { id: level }. Handles both the log shape ({id, lv})
// and the snapshot shape ({id, level}).
function arkNodeMap(arr: unknown): Record<number, number> {
  const m: Record<number, number> = {};
  for (const n of Array.isArray(arr) ? arr : []) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const node = n as any;
    if (node && node.id != null) m[node.id] = node.lv ?? node.level ?? 0;
  }
  return m;
}

// Counts nodes whose allocated level differs between two ark-passive trees
// (keyed id -> level). Missing on either side counts as 0.
function treeDiffs(
  a: Record<number, number>,
  b: Record<number, number>,
): number {
  const ids = new Set([...Object.keys(a), ...Object.keys(b)].map(Number));
  let d = 0;
  for (const id of ids) if ((a[id] ?? 0) !== (b[id] ?? 0)) d++;
  return d;
}

// Returns a warning reason when a player's logged engravings suggest their gear
// snapshot is inaccurate, or undefined when it looks fine. `engravingData` is a
// Ark-passive evolution points a player put into Crit (node 1010100), from the
// log's per-member arkPassiveData - the same source the support's spec/swift
// points come from (see configs/log/expr/arkPassivePoints.ts). Feeds the UI's
// DPS Pet auto-seed; 0 when the log carries no ark-passive data for the member,
// which falls back to "other".
const CRIT_EVO_NODE = 1010100;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function critPointsOf(p: any): number {
  const evo = p?.arkPassiveData?.evolution;
  if (!Array.isArray(evo)) return 0;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return evo.find((n: any) => n?.id === CRIT_EVO_NODE)?.lv ?? 0;
}

// bare list of engraving names padded with "Unknown" for empty slots (ignored).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function snapshotWarningFor(p: any): string | undefined {
  const engr = cleanEngravings(p?.engravingData);
  if (SUPPORT_SPECS.has(p?.spec ?? "")) {
    const mismatches = engr.filter((e) => !SUPPORT_ENGRAVINGS.has(e)).length;
    if (mismatches >= 2)
      return "Snapshot may be inaccurate: engravings don't match a support build.";
  } else if (engr.some((e) => CHAOS_ENGRAVINGS.has(e))) {
    return "Chaos (mobbing) build detected — gear may not reflect a raid build.";
  }
  return undefined;
}

// env.MYBROWSER is typed as Fetcher (workers-types), but puppeteer.launch
// expects BrowserWorker - both are structurally compatible at runtime.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type BrowserBinding = any;

// Identifies this bot to lostark.bible so its operators can see/contact who's
// scraping (per their request), rather than looking like an anonymous browser.
const USER_AGENT = "Calculator Fill Bot - @mir_th";

// Runs `fn` with a fresh page. When `sharedBrowser` is provided the page is
// opened on it (and only the page is closed) so callers can reuse one browser
// across many fetches - each puppeteer.launch counts against Browser Rendering's
// new-browser-per-minute limit, so a per-item launch loop 429s after a couple.
// Without it, a browser is launched and closed for this single call.
async function withPage<T>(
  browserBinding: BrowserBinding,
  fn: (page: import("@cloudflare/puppeteer").Page) => Promise<T>,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  sharedBrowser?: any,
): Promise<T> {
  const browser = sharedBrowser ?? (await acquireBrowser(browserBinding));
  try {
    const page = await browser.newPage();
    await page.setUserAgent(USER_AGENT);
    try {
      return await fn(page);
    } finally {
      await page.close();
    }
  } finally {
    if (!sharedBrowser) await releaseBrowser(browser);
  }
}

// How long a browser session lingers after we disconnect, so the next request
// can reuse it instead of launching a new one. Browser Rendering caps NEW
// browsers per minute (429 "Unable to create new browser"), and a busy session
// (one initial log render + validation + phase-2, possibly across two logs)
// blows through that cap. Keeping sessions warm and reconnecting stays under it.
const BROWSER_KEEP_ALIVE_MS = 60_000;

// Acquires a browser to drive: reconnects to an existing idle Browser Rendering
// session when one is free (does NOT count against the new-browser limit), and
// only launches a fresh one - with keep_alive so it survives for reuse - when
// none are available. The caller MUST releaseBrowser() when done.
//
// Retries on the new-browser 429: a session another pass JUST released takes a
// moment to become reconnectable, and the per-minute launch budget recovers over
// time - so when two passes run back-to-back, waiting a couple seconds lets the
// second reconnect to the first's freed session instead of launching (and 429ing).
export async function acquireBrowser(
  browserBinding: BrowserBinding,
): Promise<unknown> {
  const MAX_ATTEMPTS = 4;
  let lastErr: unknown;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    if (attempt > 0) {
      await new Promise((r) => setTimeout(r, 1500 * attempt));
    }
    try {
      const sessions = await puppeteer.sessions(browserBinding);
      // A session with no connectionId has no active puppeteer connection - free
      // to reconnect to. Try each (another request may grab one first).
      const free = sessions.filter(
        (s: { connectionId?: string }) => !s.connectionId,
      );
      for (const s of free as { sessionId: string }[]) {
        try {
          return await puppeteer.connect(browserBinding, s.sessionId);
        } catch {
          // Taken or closed between listing and connecting - try the next.
        }
      }
      return await puppeteer.launch(browserBinding, {
        keep_alive: BROWSER_KEEP_ALIVE_MS,
      });
    } catch (err) {
      // Retry only the browser-creation rate limit; surface anything else at once.
      lastErr = err;
      if (!/429|rate limit/i.test((err as Error).message)) throw err;
    }
  }
  throw lastErr;
}

// Releases a browser acquired via acquireBrowser by DISCONNECTING (not closing),
// so its session stays warm for BROWSER_KEEP_ALIVE_MS and the next request can
// reconnect instead of launching. Best-effort - a failure here never propagates.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function releaseBrowser(browser: any): Promise<void> {
  try {
    await browser.disconnect();
  } catch {
    // Already gone; nothing to release.
  }
}

// Reconstructs the SvelteKit page payload from the __data.json envelope.
// Only { type: "data", data: [...] } nodes are unflattened; null, skip, and
// error nodes are dropped, so data[0] is always the first real page node.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function unflattenPayload(raw: RawEnvelope): any {
  return {
    data: raw.nodes
      .map((node) => {
        if (node === null || typeof node !== "object") return null;
        const n = node as { type?: string; data?: unknown[] };
        if (n.type !== "data" || !Array.isArray(n.data)) return null;
        return unflatten(n.data);
      })
      .filter((x) => x !== null),
  };
}

// Fetches and unflattens a lostark.bible page's __data.json, going through the
// D1 cache (when a binding is provided): a hit skips the Puppeteer browser
// launch entirely and returns the previously stored payload; a miss launches
// the browser, fetches, prunes the datasource root to the fields the configs
// read (stripRoot - most of the cache's space saving), stores that, and returns
// it. The stored payload still resolves through the same rootPath, so the
// hit/miss results are identical to downstream evaluation.
async function fetchPayload(
  browserBinding: BrowserBinding,
  db: D1Database | undefined,
  source: CompiledSource,
  url: string,
  // Optional caller-owned browser to reuse (avoids a per-call launch). Only used
  // on a cache miss, so passing it costs nothing when the payload is cached.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  sharedBrowser?: any,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): Promise<any> {
  const dataUrl = dataJsonUrl(url);

  const cached = await getCachedPayload(db, dataUrl);
  if (cached) return cached;

  const raw = await withPage(
    browserBinding,
    async (page) => {
      const response = await page.goto(dataUrl, {
        waitUntil: "networkidle0",
        timeout: NAV_TIMEOUT_MS,
      });
      return (await response?.json()) as RawEnvelope | undefined;
    },
    sharedBrowser,
  );

  if (!raw || !Array.isArray(raw.nodes)) {
    throw new Error(`Unexpected __data.json shape from ${dataUrl}`);
  }
  const payload = unflattenPayload(raw);
  // Prune the resolved root in place to the config's allowlist before caching;
  // the surrounding payload structure is preserved so resolveRoot still works.
  stripRoot(source.source, resolveRoot(payload, source));
  await putCachedPayload(db, dataUrl, payload);
  return payload;
}

export interface LogPhaseResult {
  parties: PartyInfo[];
  playerEntities: PlayerEntity[];
  // partyKey ("all" | "0" | "1" | ...) -> per-party log results (aggregate +
  // per-member), pre-evaluated in phase 1.
  logFieldResults: Record<string, PartyLogResults>;
  // Per-player (by name) known-good log data, for phase-2 snapshot cross-check.
  logFingerprints: Record<string, PlayerLogFingerprint>;
  // The log's server region (e.g. "NA" / "CE"), from encounterDamageStats.misc.
  // Used to prefill the gear-override character link. Undefined if absent.
  region?: string;
  // Set when the log's data version matched no config variant and the latest was
  // used best-effort (see selectSourceForPayload). Surfaced to the user.
  versionWarning?: string;
}

// Phase 1: fetch the log, derive party structure + player stubs, and
// pre-evaluate the log datasource once per party. For each party we bind
// `players` to that party's PLAYER entities and `member` to its unique support
// (by spec), so log fields/intermediates resolve against the right selection.
//
// `logVariants` are all authored log configs for the bundle; the one whose
// `version` matches the fetched log's format version is selected (all variants
// share the root/version path, so any is fine for fetching).
export async function fetchLogPhase(
  browserBinding: BrowserBinding,
  url: string,
  logVariants: CompiledSource[],
  db?: D1Database,
): Promise<LogPhaseResult> {
  const payload = await fetchPayload(browserBinding, db, logVariants[0]!, url);
  const { source: logSource, warning: versionWarning } = selectSourceForPayload(
    logVariants,
    payload,
  );
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const enc = resolveRoot(payload, logSource) as any;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const allPlayers: any[] = (enc?.entityList ?? []).filter(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (e: any) => e.entityType === "PLAYER",
  );

  const parties: PartyInfo[] = [];
  const partyInfo = enc?.encounterDamageStats?.misc?.partyInfo as
    | Record<string, string[]>
    | undefined;
  if (partyInfo) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const byName = new Map<string, any>(allPlayers.map((p) => [p.name, p]));
    for (const [num, names] of Object.entries(partyInfo)) {
      const players: PartyMemberInfo[] = names.map((name) => {
        const p = byName.get(name);
        return {
          name,
          classId: p?.classId ?? 0,
          className: p?.class ?? "",
          itemLevel: p?.gearScore ?? 0,
          combatPower: p?.combatPower ?? 0,
          damage: p?.damageStats?.damageDealt ?? 0,
          isSupport: SUPPORT_SPECS.has(p?.spec ?? ""),
          critPoints: critPointsOf(p),
          snapshotWarning: snapshotWarningFor(p),
        };
      });
      // Order members by damage dealt (highest first) for display and default
      // reference-DPS selection.
      players.sort((a, b) => b.damage - a.damage);
      parties.push({ partyNumber: Number(num), playerNames: names, players });
    }
    parties.sort((a, b) => a.partyNumber - b.partyNumber);
  }

  // Include every player, even those lostark.bible has no loadoutHash for
  // (unlinked characters) - callers need to see them to tell "no support in
  // the party" apart from "support found but no gear data for them" and to
  // let a manual character-link override stand in for the missing gear.
  const playerEntities: PlayerEntity[] = allPlayers.map((e) => ({
    name: e.name,
    classId: e.classId,
    spec: e.spec ?? "",
    loadoutHash: e.loadoutHash ?? "",
  }));

  // Capture each player's known-good log data so phase 2 can cross-check the
  // fetched snapshot against it (compareSnapshotToLog). Keyed by name; built for
  // all players since the DPS gear member isn't chosen until phase 2.
  const logFingerprints: Record<string, PlayerLogFingerprint> = {};
  for (const e of allPlayers) {
    const apd = e.arkPassiveData ?? {};
    logFingerprints[e.name] = {
      arkEvolution: arkNodeMap(apd.evolution),
      arkEnlightenment: arkNodeMap(apd.enlightenment),
      engravings: cleanEngravings(e.engravingData),
      combatPower: e.combatPower ?? 0,
      classId: e.classId ?? 0,
    };
  }

  // Evaluate the log source for a party: once over the whole party (aggregate,
  // today's uptime = party-wide sums) and once per member with `players` bound
  // to just that member, which makes the party-scope uptime intermediates
  // ($.dpsPlayers / $.partyDamageDealt) collapse to that member - per-member
  // uptime with no separate fields. `member` (the support) is bound the same in
  // both so member-scope fields (specPoints/swiftPoints) are unaffected.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const evalForPlayers = (players: any[]): PartyLogResults => {
    const supports = players.filter((p) => SUPPORT_SPECS.has(p.spec));
    const member = supports.length === 1 ? supports[0] : null;
    const aggregate = evaluateSource(logSource, payload, { players, member });
    const byMember: Record<string, Record<string, FieldResult>> = {};
    for (const p of players) {
      byMember[p.name] = evaluateSource(logSource, payload, {
        players: [p],
        member,
      });
    }
    return { aggregate, byMember };
  };

  const logFieldResults: Record<string, PartyLogResults> = {};
  if (parties.length <= 1) {
    logFieldResults["all"] = evalForPlayers(allPlayers);
  } else {
    for (const party of parties) {
      const nameSet = new Set(party.playerNames);
      const players = allPlayers.filter((p) => nameSet.has(p.name));
      logFieldResults[String(party.partyNumber)] = evalForPlayers(players);
    }
  }

  const region = enc?.encounterDamageStats?.misc?.region;
  return {
    parties,
    playerEntities,
    logFieldResults,
    logFingerprints,
    region: typeof region === "string" ? region : undefined,
    versionWarning,
  };
}

export interface SourcePhaseResult {
  fields: Record<string, FieldResult>;
  // The resolved datasource root (for phase-2 snapshot cross-check against the
  // log - see compareSnapshotToLog). Undefined only if the source resolves none.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  root?: any;
  // Set when the data version matched no config variant (see fetchLogPhase).
  versionWarning?: string;
}

// Phase 2: fetch a per-character datasource (snapshot or loadout) and evaluate
// it. These fields don't use party selection, but may use the advanced `inputs`
// (e.g. snapshot spec/swiftness combine evolution points with manual bonuses).
// `variants` are all authored configs for that kind; the version-matching one is
// selected. The bible snapshot/loadout carry no version in their payload - their
// version is the loadoutHash prefix - so the caller passes it as `dataVersion`.
export async function fetchSourcePhase(
  browserBinding: BrowserBinding,
  url: string,
  variants: CompiledSource[],
  db?: D1Database,
  inputs?: Record<string, unknown>,
  dataVersion?: string,
): Promise<SourcePhaseResult> {
  const payload = await fetchPayload(browserBinding, db, variants[0]!, url);
  const { source, warning: versionWarning } = selectSourceForPayload(
    variants,
    payload,
    dataVersion,
  );
  return {
    fields: evaluateSource(source, payload, undefined, inputs),
    root: resolveRoot(payload, source),
    versionWarning,
  };
}

// Phase 1.5 (validation): fetch a snapshot and return ONLY its resolved root,
// skipping field evaluation. Used by the up-front snapshot<->log cross-check
// (compareSnapshotToLog), which reads the raw root (arkPassive/engravings/
// combatPower) and needs no advanced `inputs`. Passing `db` warms the same D1
// cache phase 2 reads, so the later fetchSourcePhase call becomes a cache hit.
export async function fetchSnapshotRoot(
  browserBinding: BrowserBinding,
  url: string,
  variants: CompiledSource[],
  db?: D1Database,
  dataVersion?: string,
  // Caller-owned browser to reuse across a batch of snapshots (validation loop),
  // so each member isn't a separate puppeteer.launch that 429s on the Browser
  // Rendering new-browser limit.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  sharedBrowser?: any,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): Promise<any> {
  const payload = await fetchPayload(
    browserBinding,
    db,
    variants[0]!,
    url,
    sharedBrowser,
  );
  const { source } = selectSourceForPayload(variants, payload, dataVersion);
  return resolveRoot(payload, source);
}

// Picks the best loadout from a character page's `loadouts` array for the target
// role. Prefers loadouts whose battlePoint.isSupport matches `wantSupport`
// (falling back to all when none match), then the highest combat power
// (combatPower.score), with the most recently updated as a tiebreak.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function pickLoadout(loadouts: any[], wantSupport: boolean): any {
  if (!Array.isArray(loadouts) || loadouts.length === 0) return undefined;
  const roleMatch = loadouts.filter(
    (l) => !!l?.battlePoint?.isSupport === wantSupport,
  );
  const candidates = roleMatch.length > 0 ? roleMatch : loadouts;
  return candidates.reduce((best, l) => {
    const lCp = l?.combatPower?.score ?? 0;
    const bestCp = best?.combatPower?.score ?? 0;
    if (lCp !== bestCp) return lCp > bestCp ? l : best;
    return (l?.lastUpdated ?? 0) > (best?.lastUpdated ?? 0) ? l : best;
  });
}

// Phase 2 (manual override): fetch a lostark.bible character page
// (/character/<region>/<name>), whose payload carries an array of loadouts at
// data[2].loadouts. Each loadout is a structural superset of a snapshot root, so
// we pick the best one for the role, wrap it as a snapshot-shaped payload, and
// evaluate it with the SNAPSHOT datasource - reusing every gear expr unchanged.
// The cache is intentionally bypassed (db omitted): a character URL is mutable
// (unlike an immutable loadoutHash snapshot URL), so caching would risk serving
// stale gear - exactly what this override exists to avoid.
export async function fetchCharacterGearPhase(
  browserBinding: BrowserBinding,
  characterUrl: string,
  snapshotVariants: CompiledSource[],
  loadoutVariants: CompiledSource[],
  inputs?: Record<string, unknown>,
  wantSupport = true,
): Promise<SourcePhaseResult> {
  if (loadoutVariants.length === 0)
    throw new Error("No loadout datasource configured.");
  const payload = await fetchPayload(
    browserBinding,
    undefined,
    loadoutVariants[0]!,
    characterUrl,
  );
  const loadouts = resolveRoot(payload, loadoutVariants[0]!);
  const chosen = pickLoadout(loadouts as unknown[] as any[], wantSupport);
  if (!chosen) throw new Error("No loadouts found for that character.");
  // The in-game snapshot omits avatar skins, so the skin bonus normally comes
  // from a manual advanced input. But a character-link override carries the full
  // loadout (items incl. skins), so we can derive the authoritative skin bonus
  // from it for EITHER role. Wrap the chosen loadout for the loadout source's
  // rootPath ("data[2].loadouts") and evaluate skinBonusFromLoadout (a
  // rarity-weighted fraction, matching the skinBonus field's units).
  const loadoutWrapped = { data: [null, null, { loadouts: [chosen] }] };
  const { source: loadoutSource } = selectSourceForPayload(
    loadoutVariants,
    loadoutWrapped,
    "v3",
  );
  const skin = evaluateSource(
    loadoutSource,
    loadoutWrapped,
    undefined,
    inputs,
  ).skinBonusFromLoadout;
  const skinOk = !!skin && skin.error == null && skin.value !== "";

  // DPS: M27 (dpsMainStatBonus) sums the dpsSkinBonus + dpsMainStronghold INPUTS,
  // so feed the loadout-derived skin back in as that input (a percentage, hence
  // x100) rather than patching the field afterwards - the stronghold half of the
  // sum keeps working untouched. The UI disables the slider in this mode.
  const effInputs =
    !wantSupport && skinOk
      ? { ...inputs, dpsSkinBonus: Number(skin.raw) * 100 }
      : inputs;

  // Wrap so the snapshot source's rootPath ("data[1].snapshot") resolves to the
  // chosen loadout. data[0] is a placeholder (snapshot pages put it at data[1]).
  const wrapped = { data: [null, { snapshot: chosen }] };
  const { source, warning: versionWarning } = selectSourceForPayload(
    snapshotVariants,
    wrapped,
    "v3",
  );
  const fields = evaluateSource(source, wrapped, undefined, effInputs);

  // Support: F18 (skinBonus) is its own cell, so override the field directly.
  if (wantSupport && skinOk) fields.skinBonus = skin;

  return {
    fields,
    root: chosen,
    versionWarning,
  };
}

// Cross-validates a fetched snapshot root against a player's known-good log
// fingerprint, returning a list of discrepancy reasons (empty = consistent).
// Game snapshots are unreliable and can be wrong even when the log is correct
// (e.g. a corrupted ark-passive tree yielding wrong spec/swift) - a class of
// error the log-only heuristic (snapshotWarningFor) can't see until the snapshot
// is pulled. Only meaningful when the in-game snapshot was used (a user-supplied
// character-link override is authoritative and shouldn't be cross-checked).
export function compareSnapshotToLog(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  root: any,
  fp: PlayerLogFingerprint | undefined,
): string[] {
  if (!root || !fp) return [];
  const out: string[] = [];

  // 1. Ark-passive: diff the whole evolution + enlightenment trees against the
  //    log's (authoritative) allocation. This covers spec/swift (nodes 1010200/
  //    1010400, sheet F14/F15) and the rest of the AM column in one pass - a
  //    corrupted snapshot tree shows up as any node differing.
  const snapEvo = arkNodeMap(root.arkPassive?.evolution);
  const snapEnl = arkNodeMap(root.arkPassive?.enlightenment);
  if (
    treeDiffs(snapEvo, fp.arkEvolution) +
      treeDiffs(snapEnl, fp.arkEnlightenment) >
    0
  ) {
    out.push("ark-passive differs");
  }

  // 2. Engravings: map snapshot engraving ids -> names (id offset +1000) and
  //    compare the discriminating set to the log's. A material (>=2) symmetric
  //    difference means the snapshot is a different build than the logged one.
  const snapEngr = cleanEngravings(
    // Snapshot engraving ids are already the character-list form (ability id +
    // 1000), the same keying as ENGRAVING_NAMES - look up directly.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (root.engravings ?? []).map(
      (e: any) => ENGRAVING_NAMES[String(e?.id ?? 0)],
    ),
  );
  const logSet = new Set(fp.engravings);
  const snapSet = new Set(snapEngr);
  let symDiff = 0;
  for (const e of snapSet) if (!logSet.has(e)) symDiff++;
  for (const e of logSet) if (!snapSet.has(e)) symDiff++;
  if (symDiff >= 2) out.push("engravings differ");

  // 3. Combat power: a coarse "is this even the right character" check (item
  //    level proxy; both sides carry it numerically).
  const snapCp = root.combatPower?.score ?? 0;
  if (
    fp.combatPower > 0 &&
    Math.abs(snapCp - fp.combatPower) / fp.combatPower > 0.02
  ) {
    out.push("combat power differs");
  }

  return out;
}
