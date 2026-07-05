// app/useRateLimitQuota.ts
//
// Subscribes to the global rate limiter's live quota stream over
// WebSocket. Reconnects automatically (with simple backoff) if the
// connection drops, since "real time" shouldn't mean "permanently stale
// after one network blip." Returns null until the first snapshot arrives.

import { useEffect, useRef, useState } from "react";
import type { QuotaSnapshot } from "./types";

const INITIAL_RECONNECT_DELAY_MS = 1_000;
const MAX_RECONNECT_DELAY_MS = 15_000;

function wsUrlForPath(path: string): string {
  const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${window.location.host}${path}`;
}

export function useRateLimitQuota(): QuotaSnapshot | null {
  const [quota, setQuota] = useState<QuotaSnapshot | null>(null);

  // Mutable refs for reconnect bookkeeping that shouldn't trigger re-renders.
  const reconnectDelayRef = useRef(INITIAL_RECONNECT_DELAY_MS);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const closedByEffectCleanupRef = useRef(false);

  useEffect(() => {
    closedByEffectCleanupRef.current = false;
    let socket: WebSocket | null = null;

    function connect() {
      socket = new WebSocket(wsUrlForPath("/api/rate-limit-stream"));

      socket.addEventListener("open", () => {
        // Reset backoff once a connection actually succeeds.
        reconnectDelayRef.current = INITIAL_RECONNECT_DELAY_MS;
      });

      socket.addEventListener("message", (event) => {
        try {
          const data = JSON.parse(event.data as string) as QuotaSnapshot;
          if (data.type === "quota") setQuota(data);
        } catch {
          // Ignore malformed frames rather than tearing down the connection.
        }
      });

      socket.addEventListener("close", scheduleReconnect);
      socket.addEventListener("error", () => socket?.close());
    }

    function scheduleReconnect() {
      if (closedByEffectCleanupRef.current) return;
      reconnectTimerRef.current = setTimeout(() => {
        reconnectDelayRef.current = Math.min(
          reconnectDelayRef.current * 2,
          MAX_RECONNECT_DELAY_MS
        );
        connect();
      }, reconnectDelayRef.current);
    }

    connect();

    return () => {
      closedByEffectCleanupRef.current = true;
      if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
      socket?.close();
    };
  }, []);

  return quota;
}
