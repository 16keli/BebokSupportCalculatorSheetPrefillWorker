// src/env.ts
//
// Shape of the Worker's bindings + secrets. Used by index.ts, scrapeJob.ts,
// and threaded through to googleSheets.ts.

import type { GoogleAuthEnv } from "./googleAuth";

export interface Env extends GoogleAuthEnv {
  SCRAPE_JOB: DurableObjectNamespace;
  RATE_LIMITER: DurableObjectNamespace;
  ASSETS: Fetcher;
  // D1 cache of raw lostark.bible __data.json envelopes (see scrapeCache.ts),
  // so a repeat log/snapshot URL skips the network fetch entirely.
  // Name must match the `binding` in wrangler.jsonc's d1_databases entry.
  bebok_scrape_cache: D1Database;
  // Optional secret. When set, it (a) gates POST /api/bypass-token (the caller
  // must present it as `Authorization: Bearer <secret>`) and (b) is the HMAC key
  // for the tokens that endpoint mints. Unset -> token minting/bypass disabled.
  RATE_LIMIT_BYPASS_SECRET?: string;
}
