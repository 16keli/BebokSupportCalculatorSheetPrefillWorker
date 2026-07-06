// src/googleAuth.ts
//
// Implements Google OAuth 2.0 refresh-token flow using only the fetch API -
// no external libraries needed.
//
// Secrets required (set via `wrangler secret put`):
//   GOOGLE_CLIENT_ID       - OAuth 2.0 client ID (from Google Cloud Console)
//   GOOGLE_CLIENT_SECRET   - OAuth 2.0 client secret
//   GOOGLE_REFRESH_TOKEN   - Offline refresh token obtained once via consent flow
//
// How to get a refresh token:
//   1. In Google Cloud Console, create an OAuth 2.0 client (Desktop app type).
//   2. Open https://developers.google.com/oauthplayground
//      -> gear icon -> check "Use your own OAuth credentials" -> enter client ID + secret.
//   3. Authorize these scopes:
//        https://www.googleapis.com/auth/spreadsheets
//        https://www.googleapis.com/auth/drive
//   4. Click "Exchange authorization code for tokens" -> copy the refresh_token.
//   5. Store all three values as wrangler secrets.

export interface GoogleAuthEnv {
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  GOOGLE_REFRESH_TOKEN?: string;
}

const TOKEN_URL = "https://oauth2.googleapis.com/token";

interface TokenResponse {
  access_token: string;
  expires_in: number;
  token_type: string;
}

// Simple in-memory token cache (per Worker isolate). Tokens are valid for
// 1 hour; we refresh 60 s early to avoid races near expiry.
let cachedToken: string | null = null;
let cachedTokenExpiry = 0;

export async function getAccessToken(env: GoogleAuthEnv): Promise<string> {
  const now = Date.now();
  if (cachedToken && now < cachedTokenExpiry) {
    return cachedToken;
  }

  const { GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN } = env;
  if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET || !GOOGLE_REFRESH_TOKEN) {
    throw new Error(
      "Missing required secrets: GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN.",
    );
  }

  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: GOOGLE_REFRESH_TOKEN,
      client_id: GOOGLE_CLIENT_ID,
      client_secret: GOOGLE_CLIENT_SECRET,
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Google token refresh failed (${res.status}): ${text}`);
  }

  const data = (await res.json()) as TokenResponse;
  cachedToken = data.access_token;
  cachedTokenExpiry = now + (data.expires_in - 60) * 1000;
  return cachedToken;
}
