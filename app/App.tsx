// app/App.tsx
import { useState, type FormEvent } from "react";
import { Terminal } from "./components/Terminal";
import { PrefillCard } from "./components/PrefillCard";
import { QuotaIndicator } from "./components/QuotaIndicator";
import { streamRequest, ApiError } from "./api";
import type {
  ConfigBundle,
  DataSourceConfig,
  LogLine,
  PrefillCardState,
  SheetConfig,
} from "./types";

// Each prefill config lives as a directory under configs/<key>/ with one
// sheet.json plus a file per datasource (snapshot/log/loadout). Group the
// per-directory files back into ConfigBundles by their parent directory.
const configModules = import.meta.glob("../configs/*/*.json", { eager: true }) as Record<
  string,
  { default: SheetConfig | DataSourceConfig }
>;

function assembleBundles(): ConfigBundle[] {
  const byDir = new Map<string, { sheet?: SheetConfig; sources: DataSourceConfig[] }>();
  for (const [path, mod] of Object.entries(configModules)) {
    const dir = path.slice(0, path.lastIndexOf("/"));
    const entry = byDir.get(dir) ?? { sources: [] };
    const data = mod.default as SheetConfig & DataSourceConfig;
    if (Array.isArray(data.cells)) {
      entry.sheet = data as SheetConfig;
    } else if (data.source) {
      entry.sources.push(data as DataSourceConfig);
    }
    byDir.set(dir, entry);
  }
  return [...byDir.values()]
    .filter((b): b is { sheet: SheetConfig; sources: DataSourceConfig[] } => Boolean(b.sheet))
    .map((b) => ({ key: b.sheet.key, sheet: b.sheet, sources: b.sources }));
}

const availableBundles = assembleBundles();

let logIdCounter = 0;
function nextLogId() {
  logIdCounter += 1;
  return `log-${logIdCounter}`;
}

const firstBundle = availableBundles[0];

export default function App() {
  const [selectedKey, setSelectedKey] = useState(firstBundle?.key ?? "");
  const [bundle, setBundle] = useState<ConfigBundle | undefined>(firstBundle);
  const [url, setUrl] = useState("");
  // Optional rate-limit bypass token (minted by an operator via
  // POST /api/bypass-token). Sent as the X-Bypass-Token header when present.
  const [bypassToken, setBypassToken] = useState("");

  function handleConfigChange(key: string) {
    const entry = availableBundles.find((b) => b.key === key);
    if (!entry) return;
    setSelectedKey(key);
    setBundle(entry);
  }

  const [running, setRunning] = useState(false);
  const [logLines, setLogLines] = useState<LogLine[]>([]);
  const [prefillCards, setPrefillCards] = useState<PrefillCardState[]>([]);
  const [resultUrl, setResultUrl] = useState<string | null>(null);

  function log(text: string, tag: LogLine["tag"] = "info") {
    setLogLines((prev) => [...prev, { id: nextLogId(), text, tag }]);
  }

  const URL_PATTERN = /^https:\/\/lostark\.bible\/logs\/[A-Za-z0-9]+$/;

  function validate(): string | null {
    if (!bundle) return "No config bundle is loaded.";
    if (!bundle.sheet.templateSheet.trim()) return "Bundle is missing a template sheet.";
    if (!url.trim()) return "Add a log URL.";
    if (!URL_PATTERN.test(url.trim())) {
      return "URL must match https://lostark.bible/logs/<id> (e.g. https://lostark.bible/logs/4Lg6pvC).";
    }
    if (bundle.sheet.cells.length === 0) return "This config has no cell bindings.";
    return null;
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();

    const validationError = validate();
    if (validationError || !bundle) {
      alert(validationError ?? "No config bundle is loaded.");
      return;
    }

    setRunning(true);
    setLogLines([]);
    setPrefillCards([]);
    setResultUrl(null);
    log("Submitting job...");

    let jobId: string | null = null;

    try {
      await streamRequest(
        "/api/log-prefill-initial",
        {
          configKey: bundle.key,
          logUrl: url.trim(),
        },
        (evt) => {
          if (evt.type === "status") {
            log(evt.message, "info");
          } else if (evt.type === "job") {
            jobId = evt.jobId;
          } else if (evt.type === "party-pick") {
            const msg =
              evt.parties.length > 1
                ? `${evt.parties.length} parties detected - choose which one the support was in.`
                : evt.parties.length === 1
                  ? `Party detected - proceeding automatically.`
                  : `No party data in log - proceeding automatically.`;
            log(msg, "info");
            setPrefillCards((prev) => [
              ...prev,
              {
                jobId: jobId!,
                logUrl: url.trim(),
                parties: evt.parties,
                autoSelect: evt.autoSelect,
                supportInfo: evt.supportInfo,
                inputsDefs: bundle.sheet.inputs ?? [],
              },
            ]);
          } else if (evt.type === "prefill-done") {
            log(evt.message, "ok");
            setResultUrl(evt.spreadsheetUrl);
          } else if (evt.type === "error") {
            log(evt.message, "err");
          }
        },
        bypassToken.trim() ? { "X-Bypass-Token": bypassToken.trim() } : undefined
      );
    } catch (err) {
      log(err instanceof ApiError ? err.message : "Connection error", "err");
    }

    setRunning(false);
  }

  return (
    <div className="wrap">
      <header>
        <h1>Calculator Prefiller</h1>
        <div className="sub">
          Paste a lostark.bible log URL to prefill your spreadsheet automatically.
        </div>
      </header>

      {availableBundles.length > 1 && (
        <div className="stage">
          <div className="stage-head">
            <span className="stage-num">00</span>
            <span className="stage-title">Config</span>
          </div>
          <label htmlFor="configSelect">Load a saved config</label>
          <select
            id="configSelect"
            value={selectedKey}
            onChange={(e) => handleConfigChange(e.target.value)}
          >
            {availableBundles.map((b) => (
              <option key={b.key} value={b.key}>
                {b.sheet.version ? `${b.key} (v${b.sheet.version})` : b.key}
              </option>
            ))}
          </select>
        </div>
      )}

      <form onSubmit={handleSubmit}>
        <div className="stage">
          <div className="stage-head">
            <span className="stage-num">01</span>
            <span className="stage-title">Log URL</span>
          </div>
          <label htmlFor="url">lostark.bible log URL</label>
          <input
            id="url"
            type="url"
            placeholder="https://lostark.bible/logs/4Lg6pvC"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            pattern="https://lostark\.bible/logs/[A-Za-z0-9]+"
            required
          />
          <details className="advanced-collapse bypass-collapse">
            <summary>Bypass token (optional)</summary>
            <input
              id="bypassToken"
              aria-label="Bypass token"
              type="text"
              placeholder="Paste a token to skip the rate limit"
              value={bypassToken}
              onChange={(e) => setBypassToken(e.target.value)}
              autoComplete="off"
              spellCheck={false}
            />
          </details>
        </div>

        <div className="run-row">
          <button type="submit" className="run-btn" disabled={running}>
            {running ? "Running..." : "Continue"}
          </button>
          <QuotaIndicator />
        </div>
      </form>

      <Terminal lines={logLines} />

      {prefillCards.map((card, i) => (
        <PrefillCard key={i} card={card} onDone={setResultUrl} />
      ))}

      {resultUrl && (
        <div className="result-banner">
          Updated -{" "}
          <a href={resultUrl} target="_blank" rel="noopener noreferrer">
            open your spreadsheet -&gt;
          </a>
        </div>
      )}
    </div>
  );
}
