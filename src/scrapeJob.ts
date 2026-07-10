// src/scrapeJob.ts
//
// Durable Object: one instance per prefill job. Owns all state for that job
// and the Google Sheets writes for it.
//
// Because Cloudflare routes all requests for a given object ID to the same
// single-threaded instance, requests against one job are naturally
// serialized - no double-header-write race, no interleaved row appends,
// even if the user double-clicks a button.
//
// Storage: uses the SQLite-backed key-value storage API (this.ctx.storage),
// which persists across evictions and is read-your-writes consistent.

import { DurableObject } from "cloudflare:workers";
import {
  fetchLogPhase,
  fetchSourcePhase,
  fetchCharacterGearPhase,
  fetchSnapshotRoot,
  acquireBrowser,
  releaseBrowser,
  compareSnapshotToLog,
  SUPPORT_SPECS,
} from "./scraper";
import { findSources, resolveCells, resolveInputs } from "./configEngine";
import { dataJsonUrl, hasCachedPayload } from "./scrapeCache";
import { versionFromLoadoutHash } from "./version";
import { COMPILED_BUNDLES } from "./generated/compiledConfigs";
import { getOrCopyTemplateSheet, setCellValues } from "./googleSheets";
import type { Env } from "./env";
import type {
  FieldResult,
  LogPrefillInitialPayload,
  LogPrefillPartyPayload,
  LogPrefillValidatePayload,
  LogPrefillJobMeta,
  PartyInfo,
  PartyLogResults,
  PartyMemberInfo,
  PlayerEntity,
  StreamEvent,
  SupportPreview,
} from "./types";
import type { RateLimitResult } from "./rateLimiter";

const JOB_ALARM_MS = 60 * 60 * 1000; // self-destruct 1 hour after last activity

// Expected shape of a lostark.bible loadoutHash ("v3/<64 hex>"); guards the
// path interpolation in the snapshot/loadout scrape URLs (see logPrefillParty).
const LOADOUT_HASH_PATTERN = /^v\d+\/[A-Za-z0-9]+$/;

// A lostark.bible character link ("https://lostark.bible/character/<region>/
// <name>") the user can paste to override gear from that character's loadout
// instead of the in-game snapshot. Region is 2-4 letters; name is any run of
// non-slash chars (allows unicode names). Validated before it's interpolated
// into a scrape URL so a crafted value can't smuggle a different host/path.
const CHARACTER_URL_PATTERN =
  /^https:\/\/lostark\.bible\/character\/[A-Za-z]{2,4}\/[^/\s?#]+$/;

interface RpcRequestBody {
  method: "logPrefillInitial" | "logPrefillParty" | "validateParty";
  payload:
    | LogPrefillInitialPayload
    | LogPrefillPartyPayload
    | LogPrefillValidatePayload;
}

export class ScrapeJob extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
  }

  private async touch(): Promise<void> {
    await this.ctx.storage.setAlarm(Date.now() + JOB_ALARM_MS);
  }

  async alarm(): Promise<void> {
    await this.ctx.storage.deleteAll();
  }

  async fetch(request: Request): Promise<Response> {
    const { method, payload } = (await request.json()) as RpcRequestBody;
    await this.touch();

    if (method === "logPrefillInitial") {
      return this.logPrefillInitial(payload as LogPrefillInitialPayload);
    }
    if (method === "logPrefillParty") {
      return this.logPrefillParty(payload as LogPrefillPartyPayload);
    }
    if (method === "validateParty") {
      return this.validateParty(payload as LogPrefillValidatePayload);
    }
    return new Response(JSON.stringify({ error: "Unknown method" }), {
      status: 400,
    });
  }

  // ---------------------------------------------------------------------
  // Phase 1: copy template, fetch log data for party structure and
  // pre-evaluate the log datasource per party. Streams "party-pick";
  // autoSelect=true when <=1 party detected (frontend proceeds automatically).
  // Stores compact per-player stubs, the bundle, and per-party log field
  // results in DO storage - the raw log payload (often 1-2 MB) is never stored.
  // ---------------------------------------------------------------------
  private async logPrefillInitial(
    payload: LogPrefillInitialPayload,
  ): Promise<Response> {
    const { configKey, logUrl } = payload;

    const encoder = new TextEncoder();
    const ts = new TransformStream();
    const writer = ts.writable.getWriter();
    const send = (obj: StreamEvent) =>
      writer.write(encoder.encode(JSON.stringify(obj) + "\n"));

    (async () => {
      try {
        const bundle = COMPILED_BUNDLES[configKey];
        if (!bundle) {
          send({ type: "error", message: `Unknown config '${configKey}'.` });
          return;
        }
        const logVariants = findSources(bundle, "log");
        if (logVariants.length === 0) {
          send({
            type: "error",
            message: "Bundle has no 'log' datasource config.",
          });
          return;
        }

        send({ type: "status", message: "Fetching log data..." });
        const {
          parties,
          playerEntities,
          logFieldResults,
          logFingerprints,
          region,
          versionWarning,
        } = await fetchLogPhase(
          this.env.MYBROWSER,
          logUrl,
          logVariants,
          this.env.bebok_scrape_cache,
        );
        if (versionWarning)
          send({ type: "status", message: `Warning: ${versionWarning}` });

        const sheetName = sheetNameFromLogUrl(logUrl);
        const {
          spreadsheetId,
          url: sheetUrl,
          existed,
        } = await getOrCopyTemplateSheet(
          this.env,
          bundle.sheet.templateSheet,
          sheetName,
        );
        send({
          type: "status",
          message: existed
            ? `Using existing sheet: ${sheetUrl}`
            : `Created copy: ${sheetUrl}`,
          spreadsheetUrl: sheetUrl,
        });

        const meta: LogPrefillJobMeta = {
          spreadsheetId,
          sheetUrl,
          parties,
          playerEntities,
          configKey,
          logFieldResults,
          logFingerprints,
        };
        await this.ctx.storage.put("prefill-meta", meta);

        // Per-party support preview (name + spec/swift evolution points from the
        // log) so the party-pick UI can resolve the pet "auto" choice and show
        // spec/swiftness before the snapshot is fetched.
        const supportInfo = buildSupportInfo(
          parties,
          playerEntities,
          logFieldResults,
        );

        const autoSelect = parties.length <= 1;
        send({ type: "party-pick", parties, autoSelect, supportInfo, region });
      } catch (err) {
        send({ type: "error", message: (err as Error).message });
      } finally {
        writer.close();
      }
    })();

    return new Response(ts.readable, {
      headers: { "Content-Type": "application/x-ndjson; charset=utf-8" },
    });
  }

  // ---------------------------------------------------------------------
  // Phase 2: party chosen (or auto-selected). Finds the support player in the
  // selected party by spec, fetches the snapshot, evaluates the snapshot
  // datasource, merges with the pre-evaluated log fields for the party, then
  // resolves cells through the bundle's sheet config and writes them.
  // ---------------------------------------------------------------------
  private async logPrefillParty(
    payload: LogPrefillPartyPayload,
  ): Promise<Response> {
    const { partyKey, inputs: rawInputs, gearMember, uptimeMember } = payload;
    // Optional gear-override character links (validated before any fetch).
    const supportGearLink =
      payload.supportGearLink &&
      CHARACTER_URL_PATTERN.test(payload.supportGearLink)
        ? payload.supportGearLink
        : undefined;
    const dpsGearLink =
      payload.dpsGearLink && CHARACTER_URL_PATTERN.test(payload.dpsGearLink)
        ? payload.dpsGearLink
        : undefined;

    const meta = await this.ctx.storage.get<LogPrefillJobMeta>("prefill-meta");
    if (!meta) {
      return new Response(
        JSON.stringify({
          error: "Prefill job not found or expired. Re-run the initial scrape.",
        }),
        { status: 404 },
      );
    }

    const encoder = new TextEncoder();
    const ts = new TransformStream();
    const writer = ts.writable.getWriter();
    const send = (obj: StreamEvent) =>
      writer.write(encoder.encode(JSON.stringify(obj) + "\n"));

    (async () => {
      try {
        const bundle = COMPILED_BUNDLES[meta.configKey];
        if (!bundle) {
          send({
            type: "error",
            message: `Unknown config '${meta.configKey}'.`,
          });
          return;
        }

        const partyNames =
          meta.parties.length === 0 || partyKey === "all"
            ? null
            : new Set(
                meta.parties.find((p) => String(p.partyNumber) === partyKey)
                  ?.playerNames ?? [],
              );

        const partyEntities = partyNames
          ? meta.playerEntities.filter((e) => partyNames.has(e.name))
          : meta.playerEntities;
        const supports = partyEntities.filter((e) => SUPPORT_SPECS.has(e.spec));

        if (supports.length === 0) {
          // playerEntities already excludes anyone without a loadoutHash, so a
          // support that's visibly a support in the party display (isSupport,
          // from meta.parties - see PartyMemberInfo) but missing here means
          // lostark.bible has no gear data for them, not that none exists.
          const displayedSupports = meta.parties
            .flatMap((p) => p.players)
            .filter(
              (m) => m.isSupport && (!partyNames || partyNames.has(m.name)),
            );
          const message =
            displayedSupports.length > 0
              ? `Found a support player (${displayedSupports.map((m) => m.name).join(", ")}) in the selected party, but lostark.bible has no gear data for them in this log. Try a different log, or link their character directly.`
              : "Could not find a support player (Blessed Aura, Liberator, Desperate Salvation, or Full Bloom) in the selected party.";
          send({ type: "error", message });
          return;
        }
        if (supports.length > 1) {
          send({
            type: "error",
            message: `Found ${supports.length} support players in the selected party (${supports.map((e) => e.name).join(", ")}). Expected exactly one.`,
          });
          return;
        }
        const supportEntity = supports[0]!;

        // loadoutHash comes from the scraped log payload and is interpolated
        // into the snapshot/loadout scrape URLs below. Enforce its expected
        // "v<n>/<hex>" shape so a crafted hash can't smuggle path traversal or
        // a different host into those navigations.
        if (!LOADOUT_HASH_PATTERN.test(supportEntity.loadoutHash)) {
          send({
            type: "error",
            message: `Unexpected loadout hash for ${supportEntity.name}; cannot fetch character data.`,
          });
          return;
        }

        // Coerce/default the user's advanced inputs (roster + pet bonuses),
        // collected in the party-pick step, so the snapshot's spec/swiftness
        // fields can combine them with evolution points.
        const inputs = resolveInputs(bundle.sheet.inputs, rawInputs);

        // The bible snapshot/loadout payloads carry no version field; their
        // version is the loadoutHash prefix (e.g. "v3/<hash>" -> "v3").
        const bibleVersion = versionFromLoadoutHash(supportEntity.loadoutHash);

        // Snapshot<->log cross-validation now happens up front (validateParty,
        // phase 1.5), surfacing discrepancies during configuration rather than
        // after this write - so the in-game fetches below just fill cells (and
        // hit the cache validateParty warmed).
        const snapshotVariants = findSources(bundle, "snapshot");
        const loadoutVariants = findSources(bundle, "loadout");
        let snapshotFields: Record<string, FieldResult> = {};
        if (snapshotVariants.length > 0) {
          let usedSupportOverride = false;
          if (supportGearLink) {
            // Manual override: pull the support build from the pasted character
            // link's best-matching loadout instead of the (possibly inaccurate)
            // in-game snapshot. Non-fatal: on failure fall back to the snapshot.
            send({
              type: "status",
              message: `Fetching support gear from ${supportGearLink}...`,
            });
            try {
              const res = await fetchCharacterGearPhase(
                this.env.MYBROWSER,
                supportGearLink,
                snapshotVariants,
                loadoutVariants,
                inputs,
                true,
              );
              snapshotFields = res.fields;
              usedSupportOverride = true;
              if (res.versionWarning)
                send({
                  type: "status",
                  message: `Warning: ${res.versionWarning}`,
                });
            } catch (e) {
              send({
                type: "status",
                message: `Support gear link failed (${(e as Error).message}); using in-game snapshot.`,
              });
            }
          }
          if (!usedSupportOverride) {
            const snapshotUrl = `https://lostark.bible/character/snapshot/${supportEntity.loadoutHash}`;
            send({
              type: "status",
              message: `Fetching snapshot for ${supportEntity.name}...`,
            });
            const res = await fetchSourcePhase(
              this.env.MYBROWSER,
              snapshotUrl,
              snapshotVariants,
              this.env.bebok_scrape_cache,
              inputs,
              bibleVersion,
            );
            snapshotFields = res.fields;
            if (res.versionWarning)
              send({
                type: "status",
                message: `Warning: ${res.versionWarning}`,
              });
          }
        }

        // Loadout is a separate page (skins etc.). Best-effort: only when a
        // config provides a urlTemplate and has fields; failure is non-fatal so
        // a bad/unknown loadout URL never breaks the rest of the prefill.
        const loadoutGate = loadoutVariants.find(
          (s) => s.urlTemplate && s.fields.length > 0,
        );
        let loadoutFields: Record<string, FieldResult> = {};
        if (loadoutGate) {
          const loadoutUrl = loadoutGate.urlTemplate!.replace(
            "{hash}",
            supportEntity.loadoutHash,
          );
          send({
            type: "status",
            message: `Fetching loadout for ${supportEntity.name}...`,
          });
          try {
            const res = await fetchSourcePhase(
              this.env.MYBROWSER,
              loadoutUrl,
              loadoutVariants,
              this.env.bebok_scrape_cache,
              undefined,
              bibleVersion,
            );
            loadoutFields = res.fields;
            if (res.versionWarning)
              send({
                type: "status",
                message: `Warning: ${res.versionWarning}`,
              });
          } catch (e) {
            send({
              type: "status",
              message: `Loadout fetch skipped: ${(e as Error).message}`,
            });
          }
        }

        // DPS gear: fill any "dps"-character cells from a selected party
        // member's snapshot (default: the highest-combatPower non-support
        // member). A second snapshot fetch, namespaced as `dps:<field>` so it
        // sits alongside the support's fields without colliding. Non-fatal: a
        // missing/invalid gear member just leaves the DPS gear cells blank.
        const hasDpsCells = bundle.sheet.cells.some(
          (c) => c.character === "dps",
        );
        const gearMemberName =
          gearMember ?? highestCpDps(partyMembersFor(meta, partyKey));
        // The DPS's loa-logs spec (e.g. "Judgment") lives on the log entity, not
        // the snapshot; inject it so the DPS snapshot pass can resolve class
        // crit-hit-damage synergy (dps:dpsCritHitTotal / C22). Injected AFTER
        // resolveInputs, which strips undeclared keys. Support fetches keep plain
        // `inputs` (they ignore dpsSpec).
        const dpsSpec =
          meta.playerEntities.find((e) => e.name === gearMemberName)?.spec ??
          "";
        const dpsInputs = { ...inputs, dpsSpec };
        let dpsSnapshotFields: Record<string, FieldResult> = {};
        let usedDpsOverride = false;
        if (hasDpsCells && snapshotVariants.length > 0 && dpsGearLink) {
          // Manual override: source the DPS gear cells from the pasted character
          // link instead of the member's in-game snapshot. Non-fatal: on failure
          // fall through to the member snapshot below.
          send({
            type: "status",
            message: `Fetching DPS gear from ${dpsGearLink}...`,
          });
          try {
            const res = await fetchCharacterGearPhase(
              this.env.MYBROWSER,
              dpsGearLink,
              snapshotVariants,
              loadoutVariants,
              dpsInputs,
              false,
            );
            dpsSnapshotFields = res.fields;
            usedDpsOverride = true;
            if (res.versionWarning)
              send({
                type: "status",
                message: `Warning: ${res.versionWarning}`,
              });
          } catch (e) {
            send({
              type: "status",
              message: `DPS gear link failed (${(e as Error).message}); using in-game snapshot.`,
            });
          }
        }
        if (
          !usedDpsOverride &&
          hasDpsCells &&
          snapshotVariants.length > 0 &&
          gearMemberName
        ) {
          const gearEntity = meta.playerEntities.find(
            (e) => e.name === gearMemberName,
          );
          if (
            !gearEntity ||
            !LOADOUT_HASH_PATTERN.test(gearEntity.loadoutHash)
          ) {
            send({
              type: "status",
              message: `DPS gear skipped: no character data for ${gearMemberName}.`,
            });
          } else if (gearEntity.loadoutHash === supportEntity.loadoutHash) {
            // The chosen gear member is the support - reuse the fetch above.
            dpsSnapshotFields = snapshotFields;
          } else {
            const dpsUrl = `https://lostark.bible/character/snapshot/${gearEntity.loadoutHash}`;
            send({
              type: "status",
              message: `Fetching DPS gear snapshot for ${gearEntity.name}...`,
            });
            try {
              const res = await fetchSourcePhase(
                this.env.MYBROWSER,
                dpsUrl,
                snapshotVariants,
                this.env.bebok_scrape_cache,
                dpsInputs,
                versionFromLoadoutHash(gearEntity.loadoutHash),
              );
              dpsSnapshotFields = res.fields;
              if (res.versionWarning)
                send({
                  type: "status",
                  message: `Warning: ${res.versionWarning}`,
                });
            } catch (e) {
              send({
                type: "status",
                message: `DPS gear fetch skipped: ${(e as Error).message}`,
              });
            }
          }
        }

        // Uptime cells: per-party results were pre-evaluated in phase 1. Pick
        // the selected member's per-member result, or the party-wide aggregate
        // ("aggregate", or when no member is selectable). Default: the same
        // highest-combatPower non-support member as the gear default.
        const partyResults =
          meta.logFieldResults[partyKey] ?? meta.logFieldResults["all"];
        const aggregateLog = partyResults?.aggregate ?? {};
        const uptimeName =
          uptimeMember ?? highestCpDps(partyMembersFor(meta, partyKey));
        const logFields =
          uptimeName && uptimeName !== "aggregate"
            ? (partyResults?.byMember[uptimeName] ?? aggregateLog)
            : aggregateLog;

        const fieldValues: Record<string, FieldResult> = {
          ...logFields,
          ...snapshotFields,
          ...loadoutFields,
        };
        for (const [id, fr] of Object.entries(dpsSnapshotFields)) {
          fieldValues[`dps:${id}`] = fr;
        }

        const { writes, skipped } = resolveCells(bundle, fieldValues);
        if (writes.length > 0) {
          await setCellValues(this.env, meta.spreadsheetId, writes);
        }
        // Only surface skipped cells that failed due to an error (not just empty values, which
        // are normal for optional fields the character doesn't have).
        const errored = skipped.filter(
          (s) =>
            s.reason.startsWith("error:") || s.reason === "field not produced",
        );
        const errorMsg = errored.length
          ? ` Errors: ${errored.map((s) => `${s.field}: ${s.reason}`).join("; ")}.`
          : "";
        send({
          type: "prefill-done",
          message: `Sheet filled with ${writes.length} cell(s), ${skipped.length} skipped.${errorMsg}`,
          spreadsheetUrl: meta.sheetUrl,
        });
      } catch (err) {
        send({ type: "error", message: (err as Error).message });
      } finally {
        writer.close();
      }
    })();

    return new Response(ts.readable, {
      headers: { "Content-Type": "application/x-ndjson; charset=utf-8" },
    });
  }

  // ---------------------------------------------------------------------
  // Phase 1.5: cross-check every member of the selected party's in-game
  // snapshot against the log (compareSnapshotToLog) and stream one
  // "snapshot-checked" event per member, so discrepancies surface WHILE the
  // user is configuring - before the sheet is written. Each fetch also warms
  // the D1 cache the phase-2 write reads, so that write hits the cache instead
  // of re-rendering. Best-effort: a member whose snapshot can't be fetched is
  // reported with an `error` and never blocks configuration.
  // ---------------------------------------------------------------------
  private async validateParty(
    payload: LogPrefillValidatePayload & { bucket?: string; bypass?: boolean },
  ): Promise<Response> {
    const { partyKey, bucket, bypass } = payload;
    const meta = await this.ctx.storage.get<LogPrefillJobMeta>("prefill-meta");
    if (!meta) {
      return new Response(
        JSON.stringify({
          error: "Prefill job not found or expired. Re-run the initial scrape.",
        }),
        { status: 404 },
      );
    }

    const encoder = new TextEncoder();
    const ts = new TransformStream();
    const writer = ts.writable.getWriter();
    const send = (obj: StreamEvent) =>
      writer.write(encoder.encode(JSON.stringify(obj) + "\n"));

    (async () => {
      try {
        const bundle = COMPILED_BUNDLES[meta.configKey];
        const snapshotVariants = bundle ? findSources(bundle, "snapshot") : [];
        // Nothing to validate if the bundle reads no snapshot data.
        if (snapshotVariants.length === 0) {
          send({ type: "snapshot-check-done" });
          return;
        }

        // Dedupe: replay a previously computed result set for this party so
        // re-selecting it (or re-opening the card) doesn't re-render its pages
        // or consume any quota.
        const cacheKey = `validation:${partyKey}`;
        const cached =
          await this.ctx.storage.get<
            Record<string, { warnings?: string[]; error?: string }>
          >(cacheKey);
        if (cached) {
          for (const [name, r] of Object.entries(cached)) {
            send({
              type: "snapshot-checked",
              name,
              warnings: r.warnings,
              error: r.error,
            });
          }
          send({ type: "snapshot-check-done" });
          return;
        }

        const partyNames =
          meta.parties.length === 0 || partyKey === "all"
            ? null
            : new Set(
                meta.parties.find((p) => String(p.partyNumber) === partyKey)
                  ?.playerNames ?? [],
              );
        const partyEntities = partyNames
          ? meta.playerEntities.filter((e) => partyNames.has(e.name))
          : meta.playerEntities;

        const fetchable = partyEntities.filter((e) =>
          LOADOUT_HASH_PATTERN.test(e.loadoutHash),
        );

        // Rate-limit gating: charge only for members whose snapshot isn't already
        // in the D1 cache (each miss is a real headless-browser render). Cache
        // hits and the dedupe short-circuit above cost nothing, so a re-checked
        // or already-warmed party consumes no quota. Skipped for valid bypass.
        const cachedByName = new Map<string, boolean>();
        await Promise.all(
          fetchable.map(async (e) => {
            cachedByName.set(
              e.name,
              await hasCachedPayload(
                this.env.bebok_scrape_cache,
                dataJsonUrl(
                  `https://lostark.bible/character/snapshot/${e.loadoutHash}`,
                ),
              ),
            );
          }),
        );
        const missCount = [...cachedByName.values()].filter(
          (hit) => !hit,
        ).length;
        if (missCount > 0 && bucket && !bypass) {
          const rl = await this.consumeRateLimit(bucket, missCount);
          if (!rl.allowed) {
            const retry = Math.ceil(rl.retryAfterMs / 1000);
            send({
              type: "error",
              message:
                `Rate limit exceeded validating ${missCount} snapshot(s): only ${rl.allowedCount} of ` +
                `${rl.limit}/min remain (${rl.currentCountInWindow}/${rl.limit} used in the last 60s). ` +
                `Try again in about ${retry}s.`,
            });
            return;
          }
        }

        // Fetch sequentially: each is a full headless-browser render (unless
        // cached), and the Browser Rendering binding limits concurrent sessions.
        console.log(
          `[validateParty] partyKey=${partyKey} entities=${partyEntities.length} ` +
            `fetchable=${fetchable.length} missCount=${missCount} variants=${snapshotVariants.length}`,
        );
        const results: Record<string, { warnings?: string[]; error?: string }> =
          {};
        // Reuse ONE browser for every member's snapshot. Each puppeteer.launch
        // counts against Browser Rendering's new-browser-per-minute limit, so a
        // launch-per-member loop 429s after a couple; one shared session renders
        // all of them (opened lazily, only when there's a cache miss to render).
        // If even the one browser can't be acquired (limit hit by a concurrent
        // pass), validation degrades to best-effort: cache HITS still validate
        // (they need no browser), and uncached members are left for phase 2 to
        // fetch - NOT a hard failure of the whole party.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        let sharedBrowser: any;
        if (missCount > 0) {
          try {
            sharedBrowser = await acquireBrowser(this.env.MYBROWSER);
          } catch (e) {
            console.error(
              `[validateParty] browser unavailable: ${(e as Error).message}`,
            );
          }
        }
        try {
          for (const entity of partyEntities) {
            if (!LOADOUT_HASH_PATTERN.test(entity.loadoutHash)) {
              const error = "no character data";
              results[entity.name] = { error };
              send({ type: "snapshot-checked", name: entity.name, error });
              continue;
            }
            // Uncached and no browser to render it: skip (phase 2 will fetch it).
            // Send an error badge but do NOT persist it, so re-selecting retries.
            if (!cachedByName.get(entity.name) && !sharedBrowser) {
              const error = "validation unavailable (browser busy) - try again";
              results[entity.name] = { error };
              send({ type: "snapshot-checked", name: entity.name, error });
              continue;
            }
            const url = `https://lostark.bible/character/snapshot/${entity.loadoutHash}`;
            console.log(
              `[validateParty] fetching snapshot for ${entity.name} (${url})`,
            );
            try {
              const root = await fetchSnapshotRoot(
                this.env.MYBROWSER,
                url,
                snapshotVariants,
                this.env.bebok_scrape_cache,
                versionFromLoadoutHash(entity.loadoutHash),
                sharedBrowser,
              );
              const warnings = compareSnapshotToLog(
                root,
                meta.logFingerprints[entity.name],
              );
              results[entity.name] = { warnings };
              console.log(
                `[validateParty] ok ${entity.name} warnings=${JSON.stringify(warnings)}`,
              );
              send({ type: "snapshot-checked", name: entity.name, warnings });
            } catch (e) {
              const error = (e as Error).message;
              console.error(
                `[validateParty] FAILED ${entity.name}: ${error}\n${(e as Error).stack ?? ""}`,
              );
              results[entity.name] = { error };
              send({ type: "snapshot-checked", name: entity.name, error });
            }
          }
        } finally {
          if (sharedBrowser) await releaseBrowser(sharedBrowser);
        }
        // Persist for dedupe only when everything resolved cleanly. If any member
        // errored (e.g. a transient browser-busy skip), leave the cache unset so
        // re-selecting the party re-runs and retries the missing ones - already
        // successful members are D1-cached, so the retry is cheap for them.
        const anyErrors = Object.values(results).some((r) => r.error);
        if (!anyErrors) await this.ctx.storage.put(cacheKey, results);
        console.log(
          `[validateParty] done partyKey=${partyKey} persisted=${!anyErrors} ` +
            `results=${JSON.stringify(results)}`,
        );
        send({ type: "snapshot-check-done" });
      } catch (err) {
        console.error(
          `[validateParty] fatal: ${(err as Error).message}\n${(err as Error).stack ?? ""}`,
        );
        send({ type: "error", message: (err as Error).message });
      } finally {
        writer.close();
      }
    })();

    return new Response(ts.readable, {
      headers: { "Content-Type": "application/x-ndjson; charset=utf-8" },
    });
  }

  // Consume `count` slots from the caller's per-IP rate-limit bucket (the same
  // RateLimiter DO the Worker uses for phase 1). Kept here so validateParty can
  // meter only the members it will actually render, using cache/dedupe state
  // that isn't visible at the Worker layer.
  private async consumeRateLimit(
    bucket: string,
    count: number,
  ): Promise<RateLimitResult> {
    const id = this.env.RATE_LIMITER.idFromName(bucket);
    const stub = this.env.RATE_LIMITER.get(id);
    const res = await stub.fetch("https://do/", {
      method: "POST",
      body: JSON.stringify({ method: "tryConsume", payload: { count } }),
    });
    return (await res.json()) as RateLimitResult;
  }
}

function sheetNameFromLogUrl(logUrl: string): string {
  const logId = logUrl.trim().replace(/\/$/, "").split("/").pop() ?? logUrl;
  return `Bebok LOA Sup buff calc - ${logId}`;
}

// The display members (with combat power) of the selected party. For <=1 party
// everything is keyed "all", so return every member; otherwise the named party.
function partyMembersFor(
  meta: LogPrefillJobMeta,
  partyKey: string,
): PartyMemberInfo[] {
  if (meta.parties.length === 0) return [];
  if (partyKey === "all" || meta.parties.length <= 1) {
    return meta.parties.flatMap((p) => p.players);
  }
  return (
    meta.parties.find((p) => String(p.partyNumber) === partyKey)?.players ?? []
  );
}

// Name of the non-support member with the highest combat power - the default
// reference DPS for gear and uptime. Undefined when no DPS is present (e.g. the
// log carried no party structure, so no per-member combat power is known).
function highestCpDps(members: PartyMemberInfo[]): string | undefined {
  const dps = members.filter((m) => !m.isSupport);
  if (dps.length === 0) return undefined;
  return dps.reduce((a, b) => (b.combatPower > a.combatPower ? b : a)).name;
}

// Build the per-party support preview from phase-1 results: the support's name
// (from the player entities) plus its spec/swift evolution points (from the
// log's pre-evaluated specPoints/swiftPoints fields). Mirrors fetchLogPhase's
// party keying ("all" when <=1 party, else the party number).
function buildSupportInfo(
  parties: PartyInfo[],
  playerEntities: PlayerEntity[],
  logFieldResults: Record<string, PartyLogResults>,
): Record<string, SupportPreview> {
  const groups: Array<[string, PlayerEntity[]]> =
    parties.length <= 1
      ? [["all", playerEntities]]
      : parties.map((p) => {
          const names = new Set(p.playerNames);
          return [
            String(p.partyNumber),
            playerEntities.filter((e) => names.has(e.name)),
          ];
        });

  const out: Record<string, SupportPreview> = {};
  for (const [key, players] of groups) {
    const supports = players.filter((e) => SUPPORT_SPECS.has(e.spec));
    const support = supports.length === 1 ? supports[0]! : null;
    const fr = logFieldResults[key]?.aggregate ?? {};
    const num = (id: string) => Number(fr[id]?.value ?? 0) || 0;
    out[key] = {
      name: support?.name ?? "",
      specPoints: num("specPoints"),
      swiftPoints: num("swiftPoints"),
    };
  }
  return out;
}
