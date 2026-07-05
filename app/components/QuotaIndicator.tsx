// app/components/QuotaIndicator.tsx
import { useEffect, useState } from "react";
import { useRateLimitQuota } from "../useRateLimitQuota";

// Re-derives a smoothly counting-down "Xs" label between server pushes,
// rather than only updating once a second when a new snapshot arrives -
// the server already pushes roughly every second while exhausted, but this
// avoids a visible stutter/freeze between ticks if a push is slightly late.
function useCountdown(msUntilNextSlot: number, receivedAt: number): number {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (msUntilNextSlot <= 0) return;
    const id = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(id);
  }, [msUntilNextSlot, receivedAt]);

  const elapsed = now - receivedAt;
  return Math.max(0, Math.ceil((msUntilNextSlot - elapsed) / 1000));
}

export function QuotaIndicator() {
  const quota = useRateLimitQuota();
  const [receivedAt, setReceivedAt] = useState(() => Date.now());

  useEffect(() => {
    setReceivedAt(Date.now());
  }, [quota?.usedInWindow, quota?.remaining]);

  const countdownSeconds = useCountdown(quota?.msUntilNextSlot ?? 0, receivedAt);

  if (!quota) {
    return (
      <div className="quota-indicator quota-loading">
        <span className="quota-dot" />
        <span className="quota-label">Checking quota...</span>
      </div>
    );
  }

  const { remaining, limit, usedInWindow } = quota;
  const fraction = limit > 0 ? usedInWindow / limit : 0;

  let level: "ok" | "warn" | "exhausted";
  if (remaining === 0) level = "exhausted";
  else if (fraction >= 0.7) level = "warn";
  else level = "ok";

  return (
    <div className={`quota-indicator quota-${level}`} role="status" aria-live="polite">
      <div className="quota-bar-track">
        <div className="quota-bar-fill" style={{ width: `${Math.min(100, fraction * 100)}%` }} />
      </div>
      <span className="quota-label">
        {remaining} / {limit} available
        {level === "exhausted" && countdownSeconds > 0 ? (
          <span className="quota-countdown"> - next slot in {countdownSeconds}s</span>
        ) : null}
      </span>
    </div>
  );
}
