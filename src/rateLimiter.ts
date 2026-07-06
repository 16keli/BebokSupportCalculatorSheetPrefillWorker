// src/rateLimiter.ts
//
// One Durable Object instance per client IP (addressed via idFromName("ip:<ip>")
// in index.ts) enforcing a cap of 20 main-page scrapes per rolling 60-second
// window for that IP. Callers presenting a valid bypass token skip the check
// entirely (see src/bypassToken.ts), so they never reach this DO.
//
// Why a Durable Object rather than a counter in KV or in the Worker: every
// request for a given IP's object lands on the same single-threaded instance,
// so the check-then-record step is atomic by construction - two concurrent
// requests that would otherwise both "see" room for one more URL and both
// proceed (a classic check-then-act race) simply can't happen here, since
// the DO processes them one at a time.
//
// Scope: only main-page scrapes (phase 1 of a job) consume the limit.
// Follow-up/linked-page scrapes (phase 2) are deliberately NOT rate
// limited here - see the README for the reasoning.
//
// Live quota updates: this DO also accepts WebSocket connections (via the
// Hibernation API, so idle connections don't pin it to memory or accrue
// duration charges) and pushes the current quota state to every connected
// client whenever it changes - either because a batch was just consumed,
// or passively, because old timestamps aged out of the window. The latter
// is handled by a self-rescheduling alarm: while at least one socket is
// attached, an alarm fires roughly once a second, recomputes quota, and
// broadcasts it; once no sockets remain, it stops rescheduling itself.

import { DurableObject } from "cloudflare:workers";
import type { Env } from "./env";

const WINDOW_MS = 60_000;
const MAX_PER_WINDOW = 20;
// How often to push passive updates (window-draining) to connected clients
// while at least one is attached. 1s is frequent enough to feel "live" for
// a 60s window without generating excessive DO wake-ups.
const ALARM_INTERVAL_MS = 1_000;

export interface RateLimitResult {
  allowed: boolean;
  // How many of the requested URLs are actually allowed right now. Equal to
  // `requested` when allowed is true; when false, this is how many *could*
  // fit (0 if none can), so the caller can give a precise, useful message.
  allowedCount: number;
  currentCountInWindow: number;
  limit: number;
  // Milliseconds until the oldest timestamp in the window ages out, i.e.
  // roughly how long until at least one more slot opens up. 0 if N/A.
  retryAfterMs: number;
}

// Broadcast over WebSocket whenever quota state changes (consumption or
// passive aging-out). Distinct from RateLimitResult, which is the response
// to a specific tryConsume call (and includes allowedCount/allowed relative
// to a requested count that doesn't apply to a passive snapshot).
export interface QuotaSnapshot {
  type: "quota";
  remaining: number;
  limit: number;
  usedInWindow: number;
  // Milliseconds until the next slot frees up, if currently at or near cap.
  // 0 when there's no near-term change expected (nothing in the window, or
  // remaining is comfortably above zero and nothing is about to age out
  // within the next alarm tick).
  msUntilNextSlot: number;
}

interface ConsumeRequestBody {
  method: "tryConsume";
  payload: { count: number };
}

export class RateLimiter extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
  }

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade") === "websocket") {
      return this.handleWebSocketUpgrade();
    }

    const { method, payload } = (await request.json()) as ConsumeRequestBody;

    if (method === "tryConsume") {
      const result = await this.tryConsume(payload.count);
      // Broadcast the updated quota to any live viewers immediately -
      // don't make them wait for the next alarm tick to see a consumption
      // they may have just caused (or that someone else just caused).
      await this.broadcastQuota();
      // If this consumption just brought the window to capacity, make sure
      // the alarm loop is (re-)armed so connected clients get notified the
      // moment a slot frees up again, even with no further requests.
      await this.ensureAlarmScheduledIfAtCapacity();
      return new Response(JSON.stringify(result), {
        headers: { "Content-Type": "application/json" },
      });
    }

    return new Response(JSON.stringify({ error: "Unknown method" }), { status: 400 });
  }

  private async handleWebSocketUpgrade(): Promise<Response> {
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair) as [WebSocket, WebSocket];

    // Hibernatable accept: the runtime can evict this DO from memory while
    // the connection stays open, waking it only when a message arrives or
    // an alarm fires.
    this.ctx.acceptWebSocket(server);

    // Send an immediate snapshot so the client doesn't wait for the first
    // alarm tick (up to ALARM_INTERVAL_MS away) to see anything.
    server.send(JSON.stringify(await this.computeQuotaSnapshot()));

    // Make sure the alarm loop is running now that there's a subscriber -
    // but only if quota is actually at capacity right now (i.e. there's
    // something worth watching for). If there's room to spare, the next
    // broadcast will come from an actual tryConsume() call instead.
    await this.ensureAlarmScheduledIfAtCapacity();

    return new Response(null, { status: 101, webSocket: client });
  }

  // No client->server messages are meaningful for this read-only quota
  // stream, but the handler must exist for the Hibernation API; reply with
  // a fresh snapshot on any inbound message as a harmless no-op/ping reply.
  async webSocketMessage(ws: WebSocket): Promise<void> {
    ws.send(JSON.stringify(await this.computeQuotaSnapshot()));
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
    ws.close(code, reason);
  }

  async webSocketError(): Promise<void> {
    // Nothing to clean up beyond what webSocketClose handles - the runtime
    // removes errored sockets from ctx.getWebSockets() on its own.
  }

  // Self-rescheduling: recompute and broadcast quota, then reschedule only
  // if there's still something worth watching for - at least one socket
  // attached AND the window is at capacity (so a slot aging out is an
  // event clients actually care about seeing). With room to spare, nothing
  // is about to change on its own; the next broadcast will be driven by an
  // actual tryConsume() call instead, and the loop stays stopped until
  // capacity is hit again.
  async alarm(): Promise<void> {
    if (this.ctx.getWebSockets().length === 0) return; // nothing to push to, stop the loop
    await this.broadcastQuota();
    await this.ensureAlarmScheduledIfAtCapacity();
  }

  private async ensureAlarmScheduledIfAtCapacity(): Promise<void> {
    const now = Date.now();
    const cutoff = now - WINDOW_MS;
    const timestamps = (await this.ctx.storage.get<number[]>("timestamps")) ?? [];
    const active = timestamps.filter((t) => t > cutoff);

    if (active.length < MAX_PER_WINDOW) return; // room to spare, nothing to watch for

    const existing = await this.ctx.storage.getAlarm();
    if (existing === null) {
      await this.ctx.storage.setAlarm(Date.now() + ALARM_INTERVAL_MS);
    }
  }

  private async broadcastQuota(): Promise<void> {
    const sockets = this.ctx.getWebSockets();
    if (sockets.length === 0) return;
    const snapshot = await this.computeQuotaSnapshot();
    const message = JSON.stringify(snapshot);
    for (const ws of sockets) {
      try {
        ws.send(message);
      } catch {
        // Socket may be in a closing/errored state between getWebSockets()
        // returning it and send() being called; safe to ignore, the
        // runtime will drop it from getWebSockets() once fully closed.
      }
    }
  }

  // Read-only: reports current quota without consuming anything. Also
  // prunes stale timestamps in storage as a side effect (cheap, and keeps
  // the stored array from growing unboundedly across many idle ticks).
  private async computeQuotaSnapshot(): Promise<QuotaSnapshot> {
    const now = Date.now();
    const cutoff = now - WINDOW_MS;

    const timestamps = (await this.ctx.storage.get<number[]>("timestamps")) ?? [];
    const active = timestamps.filter((t) => t > cutoff);
    if (active.length !== timestamps.length) {
      await this.ctx.storage.put("timestamps", active);
    }

    const usedInWindow = active.length;
    const remaining = Math.max(0, MAX_PER_WINDOW - usedInWindow);

    let msUntilNextSlot = 0;
    if (remaining === 0 && active.length > 0) {
      const oldest = Math.min(...active);
      msUntilNextSlot = Math.max(0, oldest + WINDOW_MS - now);
    }

    return { type: "quota", remaining, limit: MAX_PER_WINDOW, usedInWindow, msUntilNextSlot };
  }

  // Atomically checks whether `count` more URLs can be consumed within the
  // current rolling window and, if so, records them in the same step.
  // Returns allowed:false (consuming nothing) if the full count doesn't fit
  // - this app rejects the whole batch rather than partially admitting it,
  // but allowedCount is still reported so the caller can explain why.
  private async tryConsume(count: number): Promise<RateLimitResult> {
    const now = Date.now();
    const cutoff = now - WINDOW_MS;

    const timestamps = (await this.ctx.storage.get<number[]>("timestamps")) ?? [];
    const active = timestamps.filter((t) => t > cutoff);

    const currentCountInWindow = active.length;
    const roomLeft = Math.max(0, MAX_PER_WINDOW - currentCountInWindow);
    const allowed = count <= roomLeft;

    let retryAfterMs = 0;
    if (!allowed && active.length > 0) {
      // Oldest active timestamp ages out at oldest + WINDOW_MS; that's the
      // earliest moment any additional slot can open up.
      const oldest = Math.min(...active);
      retryAfterMs = Math.max(0, oldest + WINDOW_MS - now);
    }

    if (allowed) {
      for (let i = 0; i < count; i++) active.push(now);
      await this.ctx.storage.put("timestamps", active);
    }

    return {
      allowed,
      allowedCount: allowed ? count : roomLeft,
      currentCountInWindow,
      limit: MAX_PER_WINDOW,
      retryAfterMs,
    };
  }
}
