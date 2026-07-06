// src/googleSheets.ts
//
// Thin wrapper around the Google Drive and Sheets REST APIs needed for:
//  1. Copying a template spreadsheet (Drive API: files.copy)
//  2. Appending rows of scraped data to the copy (Sheets API: values.append)

import { getAccessToken, type GoogleAuthEnv } from "./googleAuth";
import type { CellOverride } from "./types";

const DRIVE_API = "https://www.googleapis.com/drive/v3";
const SHEETS_API = "https://sheets.googleapis.com/v4/spreadsheets";

function extractSpreadsheetId(input: string): string {
  // Accepts either a raw spreadsheet ID or a full Google Sheets URL.
  const match = input.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
  return match ? match[1]! : input.trim();
}

export interface CopiedSheet {
  spreadsheetId: string;
  url: string;
}

export interface ResolvedSheet extends CopiedSheet {
  existed: boolean;
}

async function findSheetByName(
  name: string,
  token: string,
): Promise<CopiedSheet | null> {
  const q = `name='${name.replace(/'/g, "\\'")}' and mimeType='application/vnd.google-apps.spreadsheet' and trashed=false`;
  const res = await fetch(
    `${DRIVE_API}/files?q=${encodeURIComponent(q)}&fields=files(id)&pageSize=1`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  if (!res.ok) {
    const text = await res.text();
    throw new Error(
      `Failed to search Drive for existing sheet (${res.status}): ${text}`,
    );
  }
  const data = (await res.json()) as { files?: Array<{ id: string }> };
  const file = data.files?.[0];
  if (!file) return null;
  return {
    spreadsheetId: file.id,
    url: `https://docs.google.com/spreadsheets/d/${file.id}/template/preview`,
  };
}

async function shareWithAnyone(
  spreadsheetId: string,
  token: string,
): Promise<void> {
  const res = await fetch(`${DRIVE_API}/files/${spreadsheetId}/permissions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ role: "reader", type: "anyone" }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(
      `Failed to share sheet with anyone (${res.status}): ${text}`,
    );
  }
}

export async function getOrCopyTemplateSheet(
  env: GoogleAuthEnv,
  templateIdOrUrl: string,
  name: string,
): Promise<ResolvedSheet> {
  const token = await getAccessToken(env);

  const existing = await findSheetByName(name, token);
  if (existing) return { ...existing, existed: true };

  const templateId = extractSpreadsheetId(templateIdOrUrl);
  const res = await fetch(`${DRIVE_API}/files/${templateId}/copy`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ name }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(
      `Failed to copy template sheet (${res.status}): ${text}. ` +
        `Make sure the template sheet is shared with the service account email.`,
    );
  }

  const data = (await res.json()) as { id: string };
  await shareWithAnyone(data.id, token);
  return {
    spreadsheetId: data.id,
    url: `https://docs.google.com/spreadsheets/d/${data.id}/template/preview`,
    existed: false,
  };
}

export async function appendRows(
  env: GoogleAuthEnv,
  spreadsheetId: string,
  sheetRange: string,
  rows: string[][],
): Promise<unknown> {
  const token = await getAccessToken(env);

  const res = await fetch(
    `${SHEETS_API}/${spreadsheetId}/values/${encodeURIComponent(
      sheetRange,
    )}:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ values: rows }),
    },
  );

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Failed to append rows (${res.status}): ${text}`);
  }

  return res.json();
}

export async function setCellValues(
  env: GoogleAuthEnv,
  spreadsheetId: string,
  overrides: CellOverride[],
): Promise<void> {
  if (overrides.length === 0) return;
  const token = await getAccessToken(env);

  const res = await fetch(`${SHEETS_API}/${spreadsheetId}/values:batchUpdate`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      valueInputOption: "USER_ENTERED",
      data: overrides.map(({ cell, value }) => ({
        range: cell,
        values: [[value]],
      })),
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Failed to write cell overrides (${res.status}): ${text}`);
  }

  // Values go in via the values API; number formats need the cell-level
  // spreadsheets:batchUpdate API (repeatCell on userEnteredFormat.numberFormat),
  // which addresses cells by grid coordinates rather than A1 ranges.
  await applyCellFormats(token, spreadsheetId, overrides);
}

// Column letters (A, B, ..., AA) -> 0-based column index.
function columnToIndex(letters: string): number {
  let n = 0;
  for (const ch of letters.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

// Split an (optionally tab-qualified) A1 cell reference into its tab name and
// 0-based row/column indices. Returns null if it isn't a single A1 cell.
function parseA1(
  ref: string,
): { tab?: string; row: number; col: number } | null {
  let tab: string | undefined;
  let a1 = ref;
  const bang = ref.lastIndexOf("!");
  if (bang >= 0) {
    tab = ref
      .slice(0, bang)
      .replace(/^'(.*)'$/, "$1")
      .replace(/''/g, "'");
    a1 = ref.slice(bang + 1);
  }
  const m = a1.match(/^([A-Za-z]+)(\d+)$/);
  if (!m) return null;
  return { tab, col: columnToIndex(m[1]!), row: parseInt(m[2]!, 10) - 1 };
}

// Apply number formats for the overrides that declare one, via a single
// spreadsheets:batchUpdate of repeatCell requests. No-op when none are present.
async function applyCellFormats(
  token: string,
  spreadsheetId: string,
  overrides: CellOverride[],
): Promise<void> {
  const formatted = overrides.filter((o) => o.format);
  if (formatted.length === 0) return;

  // Resolve tab name -> grid sheetId (and the first sheet's id for unqualified
  // cells), which the cell-level API requires in place of the A1 tab name.
  const metaRes = await fetch(
    `${SHEETS_API}/${spreadsheetId}?fields=sheets.properties(sheetId,title)`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  if (!metaRes.ok) {
    const text = await metaRes.text();
    throw new Error(
      `Failed to read sheet metadata for formatting (${metaRes.status}): ${text}`,
    );
  }
  const meta = (await metaRes.json()) as {
    sheets?: Array<{ properties: { sheetId: number; title: string } }>;
  };
  const sheets = meta.sheets ?? [];
  const idByTitle = new Map(
    sheets.map((s) => [s.properties.title, s.properties.sheetId]),
  );
  const firstSheetId = sheets[0]?.properties.sheetId;

  const requests = [];
  for (const { cell, format } of formatted) {
    const parsed = parseA1(cell);
    if (!parsed) continue; // ranges / malformed refs: skip formatting, value still written
    const sheetId = parsed.tab ? idByTitle.get(parsed.tab) : firstSheetId;
    if (sheetId === undefined) continue;
    requests.push({
      repeatCell: {
        range: {
          sheetId,
          startRowIndex: parsed.row,
          endRowIndex: parsed.row + 1,
          startColumnIndex: parsed.col,
          endColumnIndex: parsed.col + 1,
        },
        cell: { userEnteredFormat: { numberFormat: format } },
        fields: "userEnteredFormat.numberFormat",
      },
    });
  }
  if (requests.length === 0) return;

  const res = await fetch(`${SHEETS_API}/${spreadsheetId}:batchUpdate`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ requests }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Failed to apply cell formats (${res.status}): ${text}`);
  }
}

export async function getSheetTitles(
  env: GoogleAuthEnv,
  spreadsheetId: string,
): Promise<string[]> {
  const token = await getAccessToken(env);
  const res = await fetch(
    `${SHEETS_API}/${spreadsheetId}?fields=sheets.properties.title`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Failed to read sheet metadata (${res.status}): ${text}`);
  }
  const data = (await res.json()) as {
    sheets?: Array<{ properties: { title: string } }>;
  };
  return (data.sheets || []).map((s) => s.properties.title);
}
