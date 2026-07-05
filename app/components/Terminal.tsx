// app/components/Terminal.tsx
import { useEffect, useRef } from "react";
import type { LogLine } from "../types";

interface TerminalProps {
  lines: LogLine[];
}

export function Terminal({ lines }: TerminalProps) {
  const bodyRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = bodyRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [lines]);

  if (lines.length === 0) return null;

  return (
    <div className="terminal">
      <div className="terminal-head">
        <span className="dot red" />
        <span className="dot yellow" />
        <span className="dot green" />
        <span className="terminal-title">run log</span>
      </div>
      <div className="terminal-body" ref={bodyRef}>
        {lines.map((line) => (
          <div className="log-line" key={line.id}>
            <span className={`tag ${line.tag}`}>
              {line.tag === "ok" ? "ok" : line.tag === "err" ? "fail" : "info"}
            </span>
            <span className="log-text">{line.text}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
