// src/bypassToken.ts
//
// Stateless, HMAC-signed tokens that let a holder skip the per-IP scrape rate
// limit until the token's embedded expiry. Minted by the admin endpoint
// (POST /api/bypass-token, gated on RATE_LIMIT_BYPASS_SECRET) and verified on
// each prefill request via the X-Bypass-Token header.
//
// No storage: a token is `<expiryMs>.<base64url(HMAC-SHA256(expiryMs))>`, so
// verification is just a signature recompute + expiry check. Rotating the
// secret instantly invalidates every outstanding token.

const DEFAULT_TTL_SECONDS = 60 * 60; // 1 hour
const MAX_TTL_SECONDS = 30 * 24 * 60 * 60; // 30 days - cap so a token can't be effectively permanent

function base64urlEncode(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64urlDecode(s: string): Uint8Array {
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/"));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

export interface GeneratedToken {
  token: string;
  expiresAt: number; // epoch ms
}

// Mints a token valid for `ttlSeconds` (clamped to [1, MAX_TTL_SECONDS]).
export async function generateBypassToken(
  secret: string,
  ttlSeconds: number = DEFAULT_TTL_SECONDS,
): Promise<GeneratedToken> {
  const ttl = Math.min(Math.max(1, Math.floor(ttlSeconds)), MAX_TTL_SECONDS);
  const expiresAt = Date.now() + ttl * 1000;
  const msg = String(expiresAt);
  const key = await hmacKey(secret);
  const sig = new Uint8Array(
    await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(msg)),
  );
  return { token: `${msg}.${base64urlEncode(sig)}`, expiresAt };
}

// True iff `token` carries a valid signature under `secret` AND has not expired.
// The signature is checked before the expiry so a forged token is rejected the
// same way regardless of the (attacker-chosen) expiry it claims.
export async function verifyBypassToken(
  secret: string,
  token: string,
): Promise<boolean> {
  const dot = token.indexOf(".");
  if (dot <= 0) return false;
  const msg = token.slice(0, dot);
  const expiresAt = Number(msg);
  if (!Number.isFinite(expiresAt)) return false;

  let sig: Uint8Array;
  try {
    sig = base64urlDecode(token.slice(dot + 1));
  } catch {
    return false;
  }

  const key = await hmacKey(secret);
  // crypto.subtle.verify compares the MAC in constant time.
  const ok = await crypto.subtle.verify(
    "HMAC",
    key,
    sig,
    new TextEncoder().encode(msg),
  );
  return ok && Date.now() < expiresAt;
}

// Constant-time (and length-hiding) string equality for the admin secret check:
// HMACs both sides under an ephemeral random key and compares the fixed-length
// digests, so neither the compare time nor the digest length leaks anything
// about the real secret.
export async function constantTimeEqual(
  a: string,
  b: string,
): Promise<boolean> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    crypto.getRandomValues(new Uint8Array(32)),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const ha = new Uint8Array(
    await crypto.subtle.sign("HMAC", key, enc.encode(a)),
  );
  const hb = new Uint8Array(
    await crypto.subtle.sign("HMAC", key, enc.encode(b)),
  );
  let diff = 0;
  for (let i = 0; i < ha.length; i++) diff |= ha[i]! ^ hb[i]!;
  return diff === 0;
}
