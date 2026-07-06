// src/index.ts
//
// Worker entrypoint. With `assets.run_worker_first: ["/api/*"]` in
// wrangler.jsonc, this Worker is only invoked for /api/* routes - every
// other request (the React SPA's static files, plus client-side routes via
// `not_found_handling: "single-page-application"`) is served directly from
// the built `dist/` assets, no Worker code involved.

import { ScrapeJob } from "./scrapeJob";
import { RateLimiter, type RateLimitResult } from "./rateLimiter";
import { dataJsonUrl, hasCachedPayload } from "./scrapeCache";
import { COMPILED_BUNDLES } from "./generated/compiledConfigs";
import { generateBypassToken, verifyBypassToken, constantTimeEqual } from "./bypassToken";
import type { Env } from "./env";
import type {
  LogPrefillInitialPayload,
  LogPrefillPartyPayload,
  LogPrefillValidatePayload,
  StreamEvent,
} from "./types";

export { ScrapeJob, RateLimiter };

// Server-side allowlist for the log URL the Worker will drive a headless
// browser to. MUST mirror the client check in app/App.tsx - the client one is
// UX only and trivially bypassed by calling the API directly, so this is the
// real guard against SSRF (arbitrary browser navigation to internal hosts,
// metadata endpoints, or third-party targets).
const LOG_URL_PATTERN = /^https:\/\/lostark\.bible\/logs\/[A-Za-z0-9]+$/;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "POST" && url.pathname === "/api/log-prefill-initial") {
      return handleLogPrefillInitial(request, env);
    }

    if (request.method === "POST" && url.pathname === "/api/log-prefill-party") {
      return handleLogPrefillParty(request, env);
    }

    if (request.method === "POST" && url.pathname === "/api/log-prefill-validate") {
      return handleValidateParty(request, env);
    }

    if (request.method === "POST" && url.pathname === "/api/bypass-token") {
      return handleGenerateBypassToken(request, env);
    }

    if (url.pathname === "/api/rate-limit-stream") {
      return handleRateLimitStream(request, env);
    }

    return new Response("Not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;

async function handleRateLimitStream(request: Request, env: Env): Promise<Response> {
  if (request.headers.get("Upgrade") !== "websocket") {
    return jsonError("Expected a WebSocket upgrade request.", 426);
  }
  // Per-IP quota stream: the client sees its own remaining quota, not a shared
  // global one, matching the per-IP limit enforced on the prefill endpoints.
  const stub = getRateLimiterStub(env, scrapeBucket(request));
  return stub.fetch(request);
}

// Mints a bypass token. Gated on RATE_LIMIT_BYPASS_SECRET, presented as a
// bearer token - the raw secret never leaves the operator, only short-lived
// signed tokens do. Body may carry `{ ttlSeconds }` (clamped in bypassToken.ts).
async function handleGenerateBypassToken(request: Request, env: Env): Promise<Response> {
  const secret = env.RATE_LIMIT_BYPASS_SECRET;
  if (!secret) return jsonError("Bypass tokens are not enabled.", 501);

  // Throttle per IP (a bucket separate from the scrape quota) so the admin
  // secret can't be brute-forced: every attempt, success or not, consumes a
  // slot, capping guesses at the limiter's per-window rate per IP.
  const mint = await checkRateLimit(env, `mint:${ipBucket(clientIp(request))}`, 1);
  if (!mint.allowed) return jsonError(formatRateLimitMessage(mint, 1), 429);

  const provided = bearerToken(request);
  if (!provided || !(await constantTimeEqual(provided, secret))) {
    return jsonError("Unauthorized.", 401);
  }

  const body = (await request.json().catch(() => ({}))) as { ttlSeconds?: unknown };
  const ttlSeconds = typeof body.ttlSeconds === "number" ? body.ttlSeconds : undefined;

  const { token, expiresAt } = await generateBypassToken(secret, ttlSeconds);
  return new Response(JSON.stringify({ token, expiresAt }), {
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

async function handleLogPrefillInitial(request: Request, env: Env): Promise<Response> {
  let body: LogPrefillInitialPayload;
  try {
    body = (await request.json()) as LogPrefillInitialPayload;
  } catch {
    return jsonError("Invalid JSON body", 400);
  }

  if (!body.logUrl) return jsonError("Missing 'logUrl'.", 400);
  if (!LOG_URL_PATTERN.test(body.logUrl.trim())) {
    return jsonError("Invalid 'logUrl'. Expected https://lostark.bible/logs/<id>.", 400);
  }
  if (!body.configKey) return jsonError("Missing 'configKey'.", 400);
  if (!COMPILED_BUNDLES[body.configKey]) {
    return jsonError(`Unknown configKey '${body.configKey}'.`, 400);
  }

  // A cached log envelope means phase 1 won't actually scrape lostark.bible,
  // so it shouldn't consume the scrape quota. Only rate-limit on a miss - and
  // skip it entirely for callers presenting a valid bypass token.
  const cached = await hasCachedPayload(env.bebok_scrape_cache, dataJsonUrl(body.logUrl));
  if (!cached && !(await hasValidBypass(request, env))) {
    const rateLimitResult = await checkRateLimit(env, scrapeBucket(request), 1);
    if (!rateLimitResult.allowed) {
      return jsonError(formatRateLimitMessage(rateLimitResult, 1), 429);
    }
  }

  const jobId = crypto.randomUUID();
  const stub = getJobStub(env, jobId);
  const doResponse = await stub.fetch("https://do/", {
    method: "POST",
    body: JSON.stringify({ method: "logPrefillInitial", payload: body }),
  });
  return prependJobIdEvent(doResponse, jobId);
}

async function handleLogPrefillParty(request: Request, env: Env): Promise<Response> {
  let body: LogPrefillPartyPayload;
  try {
    body = (await request.json()) as LogPrefillPartyPayload;
  } catch {
    return jsonError("Invalid JSON body", 400);
  }

  if (!body.jobId) return jsonError("Missing 'jobId'.", 400);
  if (body.partyKey === undefined || body.partyKey === null) {
    return jsonError("Missing 'partyKey'.", 400);
  }

  const stub = getJobStub(env, body.jobId);
  const doResponse = await stub.fetch("https://do/", {
    method: "POST",
    body: JSON.stringify({ method: "logPrefillParty", payload: body }),
  });
  return pumpDoStream(doResponse);
}

// Phase 1.5: cross-check the selected party's snapshots against the log so
// discrepancies surface during configuration. The heavy path (up to 8 headless
// renders on a cold party), but the DO meters only the members it must actually
// render - cache hits and re-validated parties cost nothing - so the per-IP
// bucket + bypass flag are passed through for it to charge against.
async function handleValidateParty(request: Request, env: Env): Promise<Response> {
  let body: LogPrefillValidatePayload;
  try {
    body = (await request.json()) as LogPrefillValidatePayload;
  } catch {
    return jsonError("Invalid JSON body", 400);
  }

  if (!body.jobId) return jsonError("Missing 'jobId'.", 400);
  if (body.partyKey === undefined || body.partyKey === null) {
    return jsonError("Missing 'partyKey'.", 400);
  }

  const bypass = await hasValidBypass(request, env);
  const stub = getJobStub(env, body.jobId);
  const doResponse = await stub.fetch("https://do/", {
    method: "POST",
    body: JSON.stringify({
      method: "validateParty",
      payload: { ...body, bucket: scrapeBucket(request), bypass },
    }),
  });
  return pumpDoStream(doResponse);
}

function getJobStub(env: Env, jobId: string) {
  const id = env.SCRAPE_JOB.idFromName(jobId);
  return env.SCRAPE_JOB.get(id);
}

// One RateLimiter DO instance per bucket name, each with an independent
// rolling-window quota. Scrape requests use a per-IP `ip:` bucket; the token
// mint endpoint uses a separate `mint:` bucket so the two don't share a quota.
function getRateLimiterStub(env: Env, bucketName: string) {
  const id = env.RATE_LIMITER.idFromName(bucketName);
  return env.RATE_LIMITER.get(id);
}

// The client IP as seen by Cloudflare's edge - CF-Connecting-IP is set by the
// edge and can't be spoofed by the client, so it's a sound per-IP key.
function clientIp(request: Request): string {
  return request.headers.get("CF-Connecting-IP") ?? "unknown";
}

// Collapse an IPv6 address to its /64 prefix so an attacker can't dodge the
// per-IP limit by rotating through a single allocation (a standard /64 is 2^64
// addresses). IPv4 and the "unknown" dev fallback pass through unchanged.
function ipBucket(ip: string): string {
  if (!ip.includes(":")) return ip;
  const [head, tail = ""] = ip.split("::");
  const headGroups = head ? head.split(":") : [];
  const tailGroups = tail ? tail.split(":") : [];
  const missing = Math.max(0, 8 - headGroups.length - tailGroups.length);
  const groups = [...headGroups, ...Array(missing).fill("0"), ...tailGroups];
  return groups.slice(0, 4).map((g) => g || "0").join(":") + "::/64";
}

// Rate-limit bucket name for a scrape request, keyed on the (IPv6-/64-collapsed)
// client IP. Both the prefill endpoint and the WebSocket quota stream use this
// so the displayed quota matches what's actually consumed.
function scrapeBucket(request: Request): string {
  return `ip:${ipBucket(clientIp(request))}`;
}

function bearerToken(request: Request): string | null {
  const header = request.headers.get("Authorization");
  const match = header ? /^Bearer\s+(.+)$/i.exec(header.trim()) : null;
  return match ? match[1]! : null;
}

// True iff the request carries a valid, unexpired X-Bypass-Token (and bypass is
// configured). Any malformed/expired/forged token simply falls through to the
// normal per-IP limit rather than erroring.
async function hasValidBypass(request: Request, env: Env): Promise<boolean> {
  const secret = env.RATE_LIMIT_BYPASS_SECRET;
  if (!secret) return false;
  const token = request.headers.get("X-Bypass-Token");
  if (!token) return false;
  return verifyBypassToken(secret, token);
}

async function checkRateLimit(env: Env, bucketName: string, urlCount: number): Promise<RateLimitResult> {
  const stub = getRateLimiterStub(env, bucketName);
  const res = await stub.fetch("https://do/", {
    method: "POST",
    body: JSON.stringify({ method: "tryConsume", payload: { count: urlCount } }),
  });
  return (await res.json()) as RateLimitResult;
}

function formatRateLimitMessage(result: RateLimitResult, requested: number): string {
  const retrySeconds = Math.ceil(result.retryAfterMs / 1000);
  return (
    `Rate limit exceeded: ${requested} request(s) made, but only ` +
    `${result.allowedCount} of the ${result.limit}-per-minute limit ` +
    `remain right now (${result.currentCountInWindow}/${result.limit} used in ` +
    `the last 60s). Try again in about ${retrySeconds}s.`
  );
}

function prependJobIdEvent(doResponse: Response, jobId: string): Response {
  const jobEvent: StreamEvent = { type: "job", jobId };
  return pumpDoStream(doResponse, jobEvent);
}

// Streams a Durable Object's NDJSON response back to the client by actively
// reading it in a Worker-side loop, optionally prepending one event.
//
// This is NOT just cosmetic framing: the DO produces its stream from a detached
// background task (see scrapeJob.ts) that keeps running only while its response
// body is being consumed. Returning `doResponse.body` by plain passthrough does
// not reliably drive that consumption in production - the DO gets suspended
// right after returning the (still-empty) stream head, so its snapshot renders
// never run. Draining it here, exactly as the initial-scrape path already did,
// keeps the DO's background work alive to completion.
function pumpDoStream(doResponse: Response, prefixEvent?: StreamEvent): Response {
  if (!doResponse.ok || !doResponse.body) {
    return new Response(doResponse.body, {
      status: doResponse.status,
      headers: doResponse.headers,
    });
  }

  const encoder = new TextEncoder();
  const ts = new TransformStream();
  const writer = ts.writable.getWriter();

  (async () => {
    try {
      if (prefixEvent) {
        await writer.write(encoder.encode(JSON.stringify(prefixEvent) + "\n"));
      }
      const reader = doResponse.body!.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        await writer.write(value);
      }
    } catch (err) {
      const errEvent: StreamEvent = { type: "error", message: (err as Error).message };
      await writer.write(encoder.encode(JSON.stringify(errEvent) + "\n"));
    } finally {
      await writer.close();
    }
  })();

  return new Response(ts.readable, {
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-cache",
    },
  });
}

function jsonError(message: string, status: number): Response {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
