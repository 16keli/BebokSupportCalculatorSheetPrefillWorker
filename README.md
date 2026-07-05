# Bebok Support Calculator Sheet Prefill Worker

A Cloudflare Worker + React SPA that scrapes a Lost Ark support character's
data from lostark.bible (loa-logs encounters and character snapshots) and
prefills a copy of the **Bebok Support Calculator** Google Sheet (sheet tab
`Sup buff calc v3.81`).

You paste a loa-logs log URL, pick which party's support to fill for, and the
Worker copies the template sheet and writes the resolved cell values into it.
What goes where is entirely data-driven by the config bundle under
`configs/<version>/` - no cell mapping is hardcoded in the Worker.

This is a single deployable unit: Vite builds the React/TypeScript frontend
into static assets, and Wrangler serves them alongside the TypeScript Worker
(with a Durable Object per job) from one `wrangler deploy`.

## Architecture

```
app/                React frontend (TypeScript + Vite)
  main.tsx            React entry point
  App.tsx              Top-level form + prefill orchestration; globs the
                         configs/*/*.json bundles into the UI
  api.ts               NDJSON streaming fetch helper
  useRateLimitQuota.ts  WebSocket hook subscribing to live quota updates
  types.ts             Wire + UI-local type definitions
  styles.css           Plain CSS (dark "extraction console" theme)
  components/
    PrefillCard.tsx       Per-party support picker + prefill trigger
    Terminal.tsx          Live run log panel
    QuotaIndicator.tsx     Live rate-limit quota badge (bar + countdown)

src/                Worker backend (TypeScript)
  index.ts            Worker entrypoint: routes /api/* to the ScrapeJob DO,
                        enforces the global rate limit before any scrape,
                        forwards WebSocket upgrades to the RateLimiter DO
  scrapeJob.ts          Durable Object: per-job state + Google Sheets writes
  rateLimiter.ts          Durable Object: single global instance enforcing
                           20 scrapes per rolling 60s window, pushing live
                           quota snapshots over WebSocket
  scraper.ts             Puppeteer fetch of lostark.bible __data.json
                          (log phase + snapshot phase); devalue unflatten
  configEngine.ts         Evaluates compiled datasources into field values
                           and field values into cell writes
  scrapeCache.ts          D1-backed cache of fetched payloads (gzipped)
  scrapeStrip.ts          Field allowlists pruning cached payloads
  googleAuth.ts           Service-account JWT signing + token exchange
  googleSheets.ts         Drive API (copy sheet) + Sheets API (write cells)
  env.ts                  Env bindings interface
  types.ts                Shared wire-shape types (mirrors app/types.ts)
  generated/
    compiledConfigs.ts    Build-time output of scripts/compileConfigs.mjs

configs/<version>/   Config bundle: one sheet.json (cell -> field mappings,
                       with optional presentation transforms) plus a file per
                       datasource (snapshot.json / log.json / loadout.json)
                       and expr/ for longer expressions. Fields are joined
                       across datasources by id. This is the authoring source
                       of truth; it is compiled, not evaluated at runtime.
data/                JSON reference tables bundled into configs via refData
                       (skills, gems, cores, ark_passive, encounters, ...)
scripts/
  compileConfigs.mjs   Compiles config expr strings -> compiledConfigs.ts
  testEngine.ts        Local harness for the evaluation engine
  fetchLogPayload.mjs  Fetches a sample log payload for testing

index.html           Vite entry point
vite.config.ts        React + Cloudflare plugins
wrangler.jsonc         Worker config: browser + D1 bindings, DO bindings +
                        migrations, assets dir, run_worker_first for /api/*
tsconfig.json         References tsconfig.app.json + tsconfig.worker.json
tsconfig.app.json      Browser-targeted config for app/ (DOM lib, JSX)
tsconfig.worker.json   Workers-targeted config for src/ (no DOM lib)
```

**Why config is compiled, not evaluated.** The Workers runtime (`workerd`)
forbids `new Function`/`eval` at request time *and* at module load, so the
`expr` strings in the config JSON can't be evaluated inside the Worker.
`scripts/compileConfigs.mjs` emits real arrow-function literals into
`src/generated/compiledConfigs.ts` at build time; `configEngine.ts` calls
those. **If you edit any config, re-run the compile step** (it's part of
`npm run build` / `dev` / `typecheck`, or run `npm run compile-configs`).

**Why two tsconfigs?** The frontend runs in a browser (needs the `DOM` lib,
JSX) and the Worker runs in `workerd` (no DOM, needs
`@cloudflare/workers-types` instead). One shared config would leak browser
globals into Worker code or vice versa.

**Why duplicate types between `app/types.ts` and `src/types.ts`?** The two
bundles compile independently (different tsconfigs, different targets). For a
project this size, copying the small, stable wire-facing interface is simpler
than a shared workspace package. If this grows, that's the first refactor.

## How it works (two-phase)

**Phase 1 - log scrape + party selection**
1. In the React UI: pick a config version, a template Sheet, and paste a
   loa-logs log URL.
2. The Worker fetches the log's `__data.json` from lostark.bible (via
   Puppeteer, so it inherits a real browser session and avoids the plain-fetch
   403), unflattens it with devalue, and evaluates the **log** datasource once
   per party - selecting each party's players and its support member.
3. Each party renders as a `PrefillCard` showing the detected support, so you
   choose which support to prefill for. Per-job state lives in a `ScrapeJob`
   Durable Object (one instance per job) so it survives until you choose.

**Phase 2 - snapshot scrape + sheet write**
4. Pick a support on a `PrefillCard`. The Worker fetches that character's
   snapshot, evaluates the **snapshot** datasource, joins it with the
   already-computed log fields, applies the sheet's cell mappings (and any
   per-cell presentation transforms), copies the template Sheet, and writes
   the resolved values into the `Sup buff calc v3.81` tab.

Because each job's state lives in one Durable Object instance, concurrent
requests against the same job are serialized - no double-write race.

## Scrape cache (D1)

A given loa-logs log or character snapshot is immutable for its URL, so the
URL is a safe content key. Fetched payloads are unflattened, **pruned to just
the fields the configs read** (`scrapeStrip.ts`), gzipped, and stored in D1
(`bebok_scrape_cache`). A cache hit skips the expensive Puppeteer launch *and*
doesn't consume the global scrape rate limit.

`scrapeStrip.ts` carries a `STRIP_VERSION`: each cached entry records the
version it was pruned under, and a different version is treated as a cache miss
(forcing a re-fetch of the fuller data). **If you change a config to read a new
field, add it to the relevant allowlist in `scrapeStrip.ts` and bump
`STRIP_VERSION`.**

## One-time setup

### 1. Create a Google Cloud service account

1. Go to console.cloud.google.com, create or select a project.
2. APIs & Services -> Library -> enable Google Sheets API and Google Drive API.
3. APIs & Services -> Credentials -> Create Credentials -> Service account.
4. Open it -> Keys tab -> Add Key -> Create new key -> JSON. Note:
   - `client_email` (looks like `name@project.iam.gserviceaccount.com`)
   - `private_key` (starts with `-----BEGIN PRIVATE KEY-----`)

### 2. Share your template sheet with the service account

Template Sheet -> Share -> paste the `client_email` -> Editor access.

### 3. Create the D1 database

```bash
npx wrangler d1 create bebok_scrape_cache
```

Paste the returned `database_id` into `wrangler.jsonc` under `d1_databases`.
The `scrape_cache` table is created lazily on first use - no migration to run.

### 4. Durable Objects - no manual setup needed

`wrangler.jsonc` already declares the bindings and migrations that provision
both Durable Object classes on first deploy (SQLite-backed, free-plan
compatible):

```jsonc
"durable_objects": {
  "bindings": [
    { "name": "SCRAPE_JOB", "class_name": "ScrapeJob" },
    { "name": "RATE_LIMITER", "class_name": "RateLimiter" }
  ]
},
"migrations": [
  { "tag": "v1", "new_sqlite_classes": ["ScrapeJob"] },
  { "tag": "v2", "new_sqlite_classes": ["RateLimiter"] }
]
```

`RateLimiter` is its own migration tag because Cloudflare migrations are
append-only - once `v1` is applied you can't retroactively add a class to it;
a new class needs its own subsequent tag.

### 5. Install dependencies and configure secrets

```bash
npm install

npx wrangler secret put GOOGLE_SERVICE_ACCOUNT_EMAIL
npx wrangler secret put GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY
```

### 6. Typecheck

```bash
npm run typecheck
```

Runs `compile-configs` then `tsc -b --noEmit` against both
`tsconfig.app.json` and `tsconfig.worker.json`.

### 7. Develop locally

```bash
npm run dev
```

Runs `compile-configs` then Vite with the Cloudflare plugin - your Worker code
executes inside `workerd` (the real Workers runtime), not a Node shim. Durable
Objects and D1 work locally too.

### 8. Deploy

```bash
npm run deploy
```

Runs `npm run build` (compile-configs -> `tsc -b` -> `vite build`, producing
`dist/`) then `wrangler deploy`, uploading the Worker and static assets as one
unit. `run_worker_first: ["/api/*"]` means only `/api/*` requests hit the
Worker - everything else is served from `dist/` by Cloudflare's assets layer,
with `not_found_handling: "single-page-application"`.

## Editing configs

A prefill config is a directory under `configs/<version>/`:

- **`sheet.json`** - the cell mappings: each entry binds a sheet `cell` to a
  `field` id, with an optional `transform` for presentation (e.g. ms -> seconds,
  uppercasing) that keeps the datasource value canonical.
- **`snapshot.json` / `log.json` / `loadout.json`** - datasources. Each lists
  `fields` (joined to the sheet by id) and reusable `intermediates`. Log
  intermediates take a `scope` (`party` default, or `member` to rebind
  `players` to just the focused support).
- **`refData`** - names a `data/<name>.json` table to bundle as `ref.<name>`.

Expression context: `data, root, $, players, member, sum, avg, ref, input`
(`$` = intermediates, `input` = advanced inputs). After any edit, run
`npm run compile-configs` (and bump `STRIP_VERSION` if you read a new raw
field - see above).

## Global rate limiting

A single global `RateLimiter` Durable Object (always addressed via
`idFromName("global")`) caps **scrapes at 20 per rolling 60-second window**,
shared across every job and user.

- **Checked before any work happens:** the limiter is consulted before a
  browser launches, so a rejected request costs nothing beyond the check.
- **Cache hits are free:** a request served from the D1 cache doesn't scrape,
  so it isn't counted against the limit.
- **Rejection, not throttling:** an over-limit request gets a `429` with how
  many slots are free and roughly how long until the next opens - no queueing.
- **Why a Durable Object and not KV:** every request for the same object ID is
  processed one at a time, so "check if there's room, then record it" is atomic
  by construction - no check-then-act race.

### Live quota indicator

A badge next to the run button shows "N / 20 available", updating in real time
via a WebSocket to the same `RateLimiter` DO - without submitting anything.

- **Push, not polling:** `GET /api/rate-limit-stream` upgrades to a WebSocket
  forwarded to the DO, which accepts it via the [WebSocket Hibernation
  API](https://developers.cloudflare.com/durable-objects/best-practices/websockets/),
  so an idle connection doesn't pin the object in memory.
- **Updates on two triggers:** immediately when any client consumes quota, and
  via a self-rescheduling ~1s alarm - but only while the window is at capacity
  (20/20) and at least one client is connected, so the loop stays off when
  there's room to spare.
- **Color states:** accent under the cap, amber past 70%, red plus a live "next
  slot in Ns" countdown once exhausted.
- **Informational only:** the client view can be milliseconds stale; the
  server-side check remains the source of truth, and the run button is
  deliberately not disabled by the indicator alone.
- **Reconnects automatically** with backoff (1s, 2s, 4s... capped at 15s).

**A scale tradeoff worth knowing:** Cloudflare advises against a single
"global" Durable Object for all traffic (one object tops out around
500-1,000 req/s). But here the *point* of `RateLimiter` is to be a single
shared counter and broadcast point, so concentration is inherent - and the
limiter caps how much load ever reaches it (20 scrapes/minute plus a few
WebSocket viewers). If scope grew well beyond a personal/small-team tool, that
ceiling is the thing to watch.

## Usage notes & limits

- **Max 20 scrapes per rolling 60 seconds globally** - see above. Cache hits
  don't count.
- **lostark.bible payloads are fetched in real headless Chrome** (Puppeteer)
  so a live browser session is inherited; a plain Worker fetch gets a 403.
- **Job state expires after 1 hour of inactivity** - each job's Durable Object
  sets a self-cleanup alarm that pushes out on every request.
- **Writes target the `Sup buff calc v3.81` tab** of the copied template.
- Free Cloudflare accounts have monthly Browser Run minute limits.
