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
import { fetchLogPhase, fetchSourcePhase, SUPPORT_SPECS } from "./scraper";
import { findSources, resolveCells, resolveInputs } from "./configEngine";
import { versionFromLoadoutHash } from "./version";
import { COMPILED_BUNDLES } from "./generated/compiledConfigs";
import { getOrCopyTemplateSheet, setCellValues } from "./googleSheets";
import type { Env } from "./env";
import type {
  FieldResult,
  LogPrefillInitialPayload,
  LogPrefillPartyPayload,
  LogPrefillJobMeta,
  PartyInfo,
  PartyLogResults,
  PartyMemberInfo,
  PlayerEntity,
  StreamEvent,
  SupportPreview,
} from "./types";

const JOB_ALARM_MS = 60 * 60 * 1000; // self-destruct 1 hour after last activity

// Expected shape of a lostark.bible loadoutHash ("v3/<64 hex>"); guards the
// path interpolation in the snapshot/loadout scrape URLs (see logPrefillParty).
const LOADOUT_HASH_PATTERN = /^v\d+\/[A-Za-z0-9]+$/;

interface RpcRequestBody {
  method: "logPrefillInitial" | "logPrefillParty";
  payload: LogPrefillInitialPayload | LogPrefillPartyPayload;
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
    return new Response(JSON.stringify({ error: "Unknown method" }), { status: 400 });
  }

  // ---------------------------------------------------------------------
  // Phase 1: copy template, fetch log data for party structure and
  // pre-evaluate the log datasource per party. Streams "party-pick";
  // autoSelect=true when <=1 party detected (frontend proceeds automatically).
  // Stores compact per-player stubs, the bundle, and per-party log field
  // results in DO storage - the raw log payload (often 1-2 MB) is never stored.
  // ---------------------------------------------------------------------
  private async logPrefillInitial(payload: LogPrefillInitialPayload): Promise<Response> {
    const { configKey, logUrl } = payload;

    const encoder = new TextEncoder();
    const ts = new TransformStream();
    const writer = ts.writable.getWriter();
    const send = (obj: StreamEvent) => writer.write(encoder.encode(JSON.stringify(obj) + "\n"));

    (async () => {
      try {
        const bundle = COMPILED_BUNDLES[configKey];
        if (!bundle) {
          send({ type: "error", message: `Unknown config '${configKey}'.` });
          return;
        }
        const logVariants = findSources(bundle, "log");
        if (logVariants.length === 0) {
          send({ type: "error", message: "Bundle has no 'log' datasource config." });
          return;
        }

        send({ type: "status", message: "Fetching log data..." });
        const { parties, playerEntities, logFieldResults, versionWarning } = await fetchLogPhase(
          this.env.MYBROWSER,
          logUrl,
          logVariants,
          this.env.bebok_scrape_cache
        );
        if (versionWarning) send({ type: "status", message: `Warning: ${versionWarning}` });

        const sheetName = sheetNameFromLogUrl(logUrl);
        const { spreadsheetId, url: sheetUrl, existed } = await getOrCopyTemplateSheet(
          this.env,
          bundle.sheet.templateSheet,
          sheetName
        );
        send({
          type: "status",
          message: existed ? `Using existing sheet: ${sheetUrl}` : `Created copy: ${sheetUrl}`,
          spreadsheetUrl: sheetUrl,
        });

        const meta: LogPrefillJobMeta = {
          spreadsheetId,
          sheetUrl,
          parties,
          playerEntities,
          configKey,
          logFieldResults,
        };
        await this.ctx.storage.put("prefill-meta", meta);

        // Per-party support preview (name + spec/swift evolution points from the
        // log) so the party-pick UI can resolve the pet "auto" choice and show
        // spec/swiftness before the snapshot is fetched.
        const supportInfo = buildSupportInfo(parties, playerEntities, logFieldResults);

        const autoSelect = parties.length <= 1;
        send({ type: "party-pick", parties, autoSelect, supportInfo });
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
  private async logPrefillParty(payload: LogPrefillPartyPayload): Promise<Response> {
    const { partyKey, inputs: rawInputs, gearMember, uptimeMember } = payload;

    const meta = await this.ctx.storage.get<LogPrefillJobMeta>("prefill-meta");
    if (!meta) {
      return new Response(
        JSON.stringify({ error: "Prefill job not found or expired. Re-run the initial scrape." }),
        { status: 404 }
      );
    }

    const encoder = new TextEncoder();
    const ts = new TransformStream();
    const writer = ts.writable.getWriter();
    const send = (obj: StreamEvent) => writer.write(encoder.encode(JSON.stringify(obj) + "\n"));

    (async () => {
      try {
        const bundle = COMPILED_BUNDLES[meta.configKey];
        if (!bundle) {
          send({ type: "error", message: `Unknown config '${meta.configKey}'.` });
          return;
        }

        const partyNames =
          meta.parties.length === 0 || partyKey === "all"
            ? null
            : new Set(
              meta.parties.find((p) => String(p.partyNumber) === partyKey)?.playerNames ?? []
            );

        const partyEntities = partyNames
          ? meta.playerEntities.filter((e) => partyNames.has(e.name))
          : meta.playerEntities;
        const supports = partyEntities.filter((e) => SUPPORT_SPECS.has(e.spec));

        if (supports.length === 0) {
          send({
            type: "error",
            message:
              "Could not find a support player (Blessed Aura, Liberator, Desperate Salvation, or Full Bloom) in the selected party.",
          });
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

        const snapshotVariants = findSources(bundle, "snapshot");
        let snapshotFields: Record<string, FieldResult> = {};
        if (snapshotVariants.length > 0) {
          const snapshotUrl = `https://lostark.bible/character/snapshot/${supportEntity.loadoutHash}`;
          send({ type: "status", message: `Fetching snapshot for ${supportEntity.name}...` });
          const res = await fetchSourcePhase(
            this.env.MYBROWSER,
            snapshotUrl,
            snapshotVariants,
            this.env.bebok_scrape_cache,
            inputs,
            bibleVersion
          );
          snapshotFields = res.fields;
          if (res.versionWarning) send({ type: "status", message: `Warning: ${res.versionWarning}` });
        }

        // Loadout is a separate page (skins etc.). Best-effort: only when a
        // config provides a urlTemplate and has fields; failure is non-fatal so
        // a bad/unknown loadout URL never breaks the rest of the prefill.
        const loadoutVariants = findSources(bundle, "loadout");
        const loadoutGate = loadoutVariants.find((s) => s.urlTemplate && s.fields.length > 0);
        let loadoutFields: Record<string, FieldResult> = {};
        if (loadoutGate) {
          const loadoutUrl = loadoutGate.urlTemplate!.replace("{hash}", supportEntity.loadoutHash);
          send({ type: "status", message: `Fetching loadout for ${supportEntity.name}...` });
          try {
            const res = await fetchSourcePhase(
              this.env.MYBROWSER,
              loadoutUrl,
              loadoutVariants,
              this.env.bebok_scrape_cache,
              undefined,
              bibleVersion
            );
            loadoutFields = res.fields;
            if (res.versionWarning) send({ type: "status", message: `Warning: ${res.versionWarning}` });
          } catch (e) {
            send({ type: "status", message: `Loadout fetch skipped: ${(e as Error).message}` });
          }
        }

        // DPS gear: fill any "dps"-character cells from a selected party
        // member's snapshot (default: the highest-combatPower non-support
        // member). A second snapshot fetch, namespaced as `dps:<field>` so it
        // sits alongside the support's fields without colliding. Non-fatal: a
        // missing/invalid gear member just leaves the DPS gear cells blank.
        const hasDpsCells = bundle.sheet.cells.some((c) => c.character === "dps");
        const gearMemberName =
          gearMember ?? highestCpDps(partyMembersFor(meta, partyKey));
        let dpsSnapshotFields: Record<string, FieldResult> = {};
        if (hasDpsCells && snapshotVariants.length > 0 && gearMemberName) {
          const gearEntity = meta.playerEntities.find((e) => e.name === gearMemberName);
          if (!gearEntity || !LOADOUT_HASH_PATTERN.test(gearEntity.loadoutHash)) {
            send({
              type: "status",
              message: `DPS gear skipped: no character data for ${gearMemberName}.`,
            });
          } else if (gearEntity.loadoutHash === supportEntity.loadoutHash) {
            // The chosen gear member is the support - reuse the fetch above.
            dpsSnapshotFields = snapshotFields;
          } else {
            const dpsUrl = `https://lostark.bible/character/snapshot/${gearEntity.loadoutHash}`;
            send({ type: "status", message: `Fetching DPS gear snapshot for ${gearEntity.name}...` });
            try {
              const res = await fetchSourcePhase(
                this.env.MYBROWSER,
                dpsUrl,
                snapshotVariants,
                this.env.bebok_scrape_cache,
                inputs,
                versionFromLoadoutHash(gearEntity.loadoutHash)
              );
              dpsSnapshotFields = res.fields;
              if (res.versionWarning) send({ type: "status", message: `Warning: ${res.versionWarning}` });
            } catch (e) {
              send({ type: "status", message: `DPS gear fetch skipped: ${(e as Error).message}` });
            }
          }
        }

        // Uptime cells: per-party results were pre-evaluated in phase 1. Pick
        // the selected member's per-member result, or the party-wide aggregate
        // ("aggregate", or when no member is selectable). Default: the same
        // highest-combatPower non-support member as the gear default.
        const partyResults = meta.logFieldResults[partyKey] ?? meta.logFieldResults["all"];
        const aggregateLog = partyResults?.aggregate ?? {};
        const uptimeName = uptimeMember ?? highestCpDps(partyMembersFor(meta, partyKey));
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
        const errored = skipped.filter((s) => s.reason.startsWith("error:") || s.reason === "field not produced");
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
}

function sheetNameFromLogUrl(logUrl: string): string {
  const logId = logUrl.trim().replace(/\/$/, "").split("/").pop() ?? logUrl;
  return `Bebok LOA Sup buff calc - ${logId}`;
}

// The display members (with combat power) of the selected party. For <=1 party
// everything is keyed "all", so return every member; otherwise the named party.
function partyMembersFor(meta: LogPrefillJobMeta, partyKey: string): PartyMemberInfo[] {
  if (meta.parties.length === 0) return [];
  if (partyKey === "all" || meta.parties.length <= 1) {
    return meta.parties.flatMap((p) => p.players);
  }
  return meta.parties.find((p) => String(p.partyNumber) === partyKey)?.players ?? [];
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
  logFieldResults: Record<string, PartyLogResults>
): Record<string, SupportPreview> {
  const groups: Array<[string, PlayerEntity[]]> =
    parties.length <= 1
      ? [["all", playerEntities]]
      : parties.map((p) => {
        const names = new Set(p.playerNames);
        return [String(p.partyNumber), playerEntities.filter((e) => names.has(e.name))];
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
