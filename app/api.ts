// app/api.ts
//
// Thin fetch wrapper for the two streaming NDJSON endpoints. Each line of
// the response body is a JSON-encoded StreamEvent; we parse and hand them
// to the caller one at a time as they arrive.

import type { StreamEvent } from "./types";

export class ApiError extends Error {}

export async function streamRequest(
  path: string,
  payload: unknown,
  onEvent: (event: StreamEvent) => void,
  headers?: Record<string, string>,
): Promise<void> {
  const res = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: "Request failed" }));
    throw new ApiError((err as { error?: string }).error || "Request failed");
  }
  if (!res.body) {
    throw new ApiError("Response had no body to stream.");
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      onEvent(JSON.parse(line) as StreamEvent);
    }
  }
}
