// src/scrapeCache.ts
//
// D1-backed cache for the lostark.bible payloads that the scraper fetches via
// Puppeteer. A given loa-logs log or character snapshot is immutable for its
// URL (the loadoutHash changes when the character changes gear), so the URL is
// a safe content key and a cache hit lets us skip the expensive browser launch
// - and the global scrape rate limit - entirely.
//
// What we store is the UNFLATTENED payload with its datasource root pruned to
// just the fields the configs read (see scrapeStrip.ts) - a big space win, as a
// raw loa-logs encounter is ~1-2 MB dominated by data we never touch. The
// stored value is wrapped as { v: STRIP_VERSION, p: payload }; getCachedPayload
// treats a different version (i.e. the allowlist has since widened, so this
// entry may be missing a now-needed field) as a miss, forcing a re-fetch of the
// fuller data. Old raw-envelope entries (no `v`) are likewise treated as misses.
//
// Payloads are gzipped before storage. D1 caps a single row at 2 MB; pruning +
// gzip keeps even a big log well under. The table is created lazily on first
// use, so there is no separate migration step to run.

import { STRIP_VERSION } from "./scrapeStrip";

// The wire shape of a fetched __data.json before unflattening (used by the
// scraper); not what we cache.
export interface RawEnvelope {
  nodes: Array<unknown>;
}

// Stored (then gzipped) cache record: the pruned payload tagged with the
// allowlist version it was stripped under.
interface CachedRecord {
  v: number;
  p: unknown;
}

// Content is immutable per URL, so the TTL is purely storage hygiene (bound how
// long an unused entry lingers), not correctness.
const DEFAULT_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

// Maps a lostark.bible page URL to the SvelteKit data endpoint we actually
// fetch and key the cache on. Mirrors the URL the scraper navigates to.
export function dataJsonUrl(pageUrl: string): string {
  return pageUrl.replace(/\/$/, "") + "/__data.json?x-sveltekit-invalidated=011";
}

// Create-table-once guard, per isolate. Shared promise so concurrent callers
// don't each issue the DDL.
let schemaReady: Promise<void> | null = null;

function ensureSchema(db: D1Database): Promise<void> {
  if (!schemaReady) {
    schemaReady = db
      .prepare(
        "CREATE TABLE IF NOT EXISTS scrape_cache (" +
          "url TEXT PRIMARY KEY, payload BLOB NOT NULL, created_at INTEGER NOT NULL)"
      )
      .run()
      .then(() => undefined)
      .catch((err) => {
        // Reset so a later call can retry; surface the failure to the caller
        // that triggered it (cache ops swallow it and degrade to no-cache).
        schemaReady = null;
        throw err;
      });
  }
  return schemaReady;
}

// Returns an ArrayBuffer (D1's documented BLOB bind type) rather than a typed
// array, which D1 doesn't guarantee to accept as a bound parameter.
async function gzip(text: string): Promise<ArrayBuffer> {
  const stream = new Response(text).body!.pipeThrough(new CompressionStream("gzip"));
  return new Response(stream).arrayBuffer();
}

async function gunzip(bytes: Uint8Array): Promise<string> {
  const stream = new Response(bytes).body!.pipeThrough(new DecompressionStream("gzip"));
  return new Response(stream).text();
}

// D1 may return a BLOB as an ArrayBuffer, a typed-array view, or a plain
// number[] depending on runtime/driver version - normalize all of them.
function toBytes(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) {
    const view = value as ArrayBufferView;
    return new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
  }
  if (Array.isArray(value)) return new Uint8Array(value as number[]);
  throw new Error("Unexpected D1 BLOB representation for cached payload");
}

// Returns the cached (pruned, unflattened) payload for this data URL, or null on
// miss / expiry / stale strip-version / any cache error. Expired or
// stale-version rows are deleted opportunistically - a stale version means the
// allowlist has changed since this was stored, so the entry may be missing a
// now-needed field and must be re-fetched rather than served.
export async function getCachedPayload(
  db: D1Database | undefined,
  dataUrl: string
): Promise<unknown | null> {
  if (!db) return null;
  try {
    await ensureSchema(db);
    const row = await db
      .prepare("SELECT payload, created_at FROM scrape_cache WHERE url = ?")
      .bind(dataUrl)
      .first<{ payload: unknown; created_at: number }>();
    if (!row) return null;

    const expired = Date.now() - row.created_at >= DEFAULT_TTL_MS;
    if (!expired) {
      const parsed = JSON.parse(await gunzip(toBytes(row.payload))) as CachedRecord;
      if (parsed && parsed.v === STRIP_VERSION) return parsed.p;
    }
    // Expired, stale strip-version, or legacy (no v) -> drop and miss.
    await db.prepare("DELETE FROM scrape_cache WHERE url = ?").bind(dataUrl).run();
    return null;
  } catch (err) {
    console.warn("scrapeCache.getCachedPayload failed:", (err as Error).message);
    return null;
  }
}

// Returns true iff a usable (fresh, current-version) cached payload exists for
// this data URL. Used by the request entrypoint to skip the scrape rate limit
// on a hit - so it must apply the SAME version check as getCachedPayload, or a
// stale entry (which will be re-fetched) would wrongly bypass the limit.
export async function hasCachedPayload(
  db: D1Database | undefined,
  dataUrl: string
): Promise<boolean> {
  return (await getCachedPayload(db, dataUrl)) !== null;
}

// Stores the pruned payload for this data URL, tagged with the current strip
// version. Best-effort: a failure (e.g. the compressed payload still exceeding
// D1's 2 MB row cap) is logged and swallowed so it never breaks an
// otherwise-successful scrape.
export async function putCachedPayload(
  db: D1Database | undefined,
  dataUrl: string,
  payload: unknown
): Promise<void> {
  if (!db) return;
  try {
    await ensureSchema(db);
    const record: CachedRecord = { v: STRIP_VERSION, p: payload };
    const bytes = await gzip(JSON.stringify(record));
    await db
      .prepare(
        "INSERT OR REPLACE INTO scrape_cache (url, payload, created_at) VALUES (?, ?, ?)"
      )
      .bind(dataUrl, bytes, Date.now())
      .run();
  } catch (err) {
    console.warn("scrapeCache.putCachedPayload failed:", (err as Error).message);
  }
}
