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
import { evaluateSource, resolveRoot, type CompiledSource } from "./configEngine";
import { selectSourceForPayload } from "./version";
import {
  dataJsonUrl,
  getCachedPayload,
  putCachedPayload,
  type RawEnvelope,
} from "./scrapeCache";
import { stripRoot } from "./scrapeStrip";
import SUPPORT_SPECS_LIST from "../data/support_specs.json";
import type {
  FieldResult,
  PartyInfo,
  PartyLogResults,
  PartyMemberInfo,
  PlayerEntity,
} from "./types";

const NAV_TIMEOUT_MS = 30_000;

// Support specs used to pick the focused member within a party. Single source
// of truth is data/support_specs.json, also bundled into the log config as
// ref.support_specs (see configs/log/log.json's dpsPlayers), so the party-DPS
// filter and the member-selection here can never drift apart.
export const SUPPORT_SPECS = new Set<string>(SUPPORT_SPECS_LIST);

// env.MYBROWSER is typed as Fetcher (workers-types), but puppeteer.launch
// expects BrowserWorker - both are structurally compatible at runtime.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type BrowserBinding = any;

// Identifies this bot to lostark.bible so its operators can see/contact who's
// scraping (per their request), rather than looking like an anonymous browser.
const USER_AGENT = "Calculator Fill Bot - @mir_th";

async function withPage<T>(
  browserBinding: BrowserBinding,
  fn: (page: import("@cloudflare/puppeteer").Page) => Promise<T>
): Promise<T> {
  const browser = await puppeteer.launch(browserBinding);
  try {
    const page = await browser.newPage();
    await page.setUserAgent(USER_AGENT);
    return await fn(page);
  } finally {
    await browser.close();
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
  url: string
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): Promise<any> {
  const dataUrl = dataJsonUrl(url);

  const cached = await getCachedPayload(db, dataUrl);
  if (cached) return cached;

  const raw = await withPage(browserBinding, async (page) => {
    const response = await page.goto(dataUrl, {
      waitUntil: "networkidle0",
      timeout: NAV_TIMEOUT_MS,
    });
    return (await response?.json()) as RawEnvelope | undefined;
  });

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
  db?: D1Database
): Promise<LogPhaseResult> {
  const payload = await fetchPayload(browserBinding, db, logVariants[0]!, url);
  const { source: logSource, warning: versionWarning } = selectSourceForPayload(logVariants, payload);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const enc = resolveRoot(payload, logSource) as any;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const allPlayers: any[] = (enc?.entityList ?? []).filter(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (e: any) => e.entityType === "PLAYER"
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
          isSupport: SUPPORT_SPECS.has(p?.spec ?? ""),
        };
      });
      parties.push({ partyNumber: Number(num), playerNames: names, players });
    }
    parties.sort((a, b) => a.partyNumber - b.partyNumber);
  }

  const playerEntities: PlayerEntity[] = [];
  for (const e of allPlayers) {
    if (e.loadoutHash) {
      playerEntities.push({
        name: e.name,
        classId: e.classId,
        spec: e.spec ?? "",
        loadoutHash: e.loadoutHash,
      });
    }
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
      byMember[p.name] = evaluateSource(logSource, payload, { players: [p], member });
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

  return { parties, playerEntities, logFieldResults, versionWarning };
}

export interface SourcePhaseResult {
  fields: Record<string, FieldResult>;
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
  dataVersion?: string
): Promise<SourcePhaseResult> {
  const payload = await fetchPayload(browserBinding, db, variants[0]!, url);
  const { source, warning: versionWarning } = selectSourceForPayload(variants, payload, dataVersion);
  return { fields: evaluateSource(source, payload, undefined, inputs), versionWarning };
}
