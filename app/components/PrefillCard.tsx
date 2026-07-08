// app/components/PrefillCard.tsx
import { useState, useEffect, useMemo, useRef } from "react";
import { streamRequest, ApiError } from "../api";
import type {
  AdvancedInput,
  PartyMemberInfo,
  PrefillCardState,
  SupportPreview,
} from "../types";

interface PrefillCardProps {
  card: PrefillCardState;
  onDone: (spreadsheetUrl: string) => void;
}

// Item level to 2 decimal places, trimming trailing zeros (e.g. 1732 -> "1732",
// 1732.5 -> "1732.5", 1732.56 -> "1732.56").
function formatIlvl(n: number): string {
  return Number.isInteger(n)
    ? String(n)
    : n.toFixed(2).replace(/0+$/, "").replace(/\.$/, "");
}

// One party member's class icon (public/classes/<classId>.png) + name + item
// level + combat power (public/icons/{dps,support}_combat_power.png, picked
// via isSupport - see SUPPORT_SPECS in src/scraper.ts), used in both the
// multi-party picker and the single-party summary. `validation` (when present,
// i.e. for the selected party) adds a per-member snapshot<->log check badge.
function PartyMembers({
  players,
  validation,
  reserveBadge,
  onRetry,
}: {
  players: PartyMemberInfo[];
  validation?: Record<string, MemberValidation>;
  // When true, always render a badge slot (a placeholder if this member has no
  // validation state yet) so rows don't reflow as badges stream in or as the
  // user switches between parties in the multi-party picker.
  reserveBadge?: boolean;
  // Re-run validation for this party (wired only for the selected party); makes
  // a final-error badge clickable.
  onRetry?: () => void;
}) {
  return (
    <div className="party-members">
      {players.map((p) => (
        <div className="party-member" key={p.name}>
          <img
            src={`/classes/${p.classId}.png`}
            alt={p.className}
            className="class-icon"
          />
          <span className="member-name">{p.name}</span>
          <span className="member-stat">{formatIlvl(p.itemLevel)} ilvl</span>
          <span className="member-stat">
            <img
              src={`/icons/${p.isSupport ? "support" : "dps"}_combat_power.png`}
              alt={p.isSupport ? "Support combat power" : "DPS combat power"}
              className="stat-icon"
            />
            {p.combatPower.toFixed(2)}
          </span>
          {(validation?.[p.name] || reserveBadge) && (
            <MemberBadge v={validation?.[p.name]} onRetry={onRetry} />
          )}
        </div>
      ))}
    </div>
  );
}

// Small per-member snapshot-validation indicator. Neutral while checking, green
// when the snapshot matches the log, amber (with the reasons in its tooltip)
// when it disagrees, grey when it couldn't be validated. A final "error" (after
// auto-retries are exhausted) is clickable to retry manually.
function MemberBadge({
  v,
  onRetry,
}: {
  v?: MemberValidation;
  onRetry?: () => void;
}) {
  const meta: Record<
    MemberValidation["state"],
    { cls: string; icon: string; title: string }
  > = {
    checking: {
      cls: "checking",
      icon: "…",
      title: "Checking snapshot against the log…",
    },
    retrying: {
      cls: "retrying",
      icon: "…",
      title: "Validation was busy — retrying…",
    },
    ok: { cls: "ok", icon: "✓", title: "Snapshot matches the log" },
    warn: { cls: "warn", icon: "⚠", title: "Snapshot may be inaccurate" },
    error: {
      cls: "error",
      icon: "?",
      title: "Couldn't validate this snapshot",
    },
  };
  // No state yet (e.g. an unselected party in the picker): render an invisible
  // placeholder that reserves the same space so the row layout stays stable.
  if (!v)
    return <span className="member-badge placeholder" aria-hidden="true" />;
  const m = meta[v.state];
  // Final error with a retry handler: make it an actionable control. Uses a
  // span (not <button>) with stopPropagation so it nests validly inside the
  // party-select button in the multi-party picker without triggering re-select.
  if (v.state === "error" && onRetry) {
    return (
      <span
        className="member-badge error clickable"
        role="button"
        tabIndex={0}
        title="Couldn't validate — click to retry"
        onClick={(e) => {
          e.stopPropagation();
          onRetry();
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.stopPropagation();
            e.preventDefault();
            onRetry();
          }
        }}
      >
        ↻
      </span>
    );
  }
  return (
    <span className={`member-badge ${m.cls}`} title={m.title}>
      {m.icon}
    </span>
  );
}

// Flip any members still "checking" to "error" - used when the validation
// stream ends early (network drop or a stream-level error like a rate limit).
function markPendingErrored(
  v: Record<string, MemberValidation> | undefined,
): Record<string, MemberValidation> {
  const out = { ...(v ?? {}) };
  for (const k of Object.keys(out)) {
    if (out[k]?.state === "checking") out[k] = { state: "error" };
  }
  return out;
}

function seedInputs(defs: AdvancedInput[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const d of defs) out[d.id] = d.default != null ? String(d.default) : "";
  return out;
}

// Sentinel value for the uptime dropdown's whole-party option.
const AGGREGATE = "aggregate";

// Validation is best-effort and can fail transiently when the shared Browser
// Rendering session budget is momentarily exhausted (a concurrent party's pass).
// We auto-retry ONCE, after a delay long enough for the per-minute browser cap to
// recover, then fall back to a manual (clickable) retry so a persistently
// saturated account doesn't spin forever. Total passes = MAX_VALIDATION_ATTEMPTS.
const MAX_VALIDATION_ATTEMPTS = 2;
const VALIDATION_RETRY_DELAY_MS = 25_000;

// Format of a lostark.bible character link the user can paste to override gear
// (mirrors CHARACTER_URL_PATTERN in src/scrapeJob.ts). Region 2-4 letters, name
// any run of non-slash chars (unicode names allowed).
const CHARACTER_URL_PATTERN =
  /^https:\/\/lostark\.bible\/character\/[A-Za-z]{2,4}\/[^/\s?#]+$/;

// Builds the lostark.bible link for a character to prefill the manual override.
// Names logged anonymously contain "#" - those (and a missing region/name) can't
// be resolved, so we return "" (which clears the field).
function characterLink(region: string | undefined, name: string): string {
  if (!region || !name || name.includes("#")) return "";
  return `https://lostark.bible/character/${region}/${name}`;
}

// The default reference DPS: the highest-damage non-support member (falls back
// to the highest-damage member overall if a party is somehow all support).
function highestDamageDpsName(players: PartyMemberInfo[]): string {
  const dps = players.filter((p) => !p.isSupport);
  const pool = dps.length ? dps : players;
  if (pool.length === 0) return "";
  return pool.reduce((a, b) => (b.damage > a.damage ? b : a)).name;
}

const PET_LABEL: Record<string, string> = {
  spec: "Specialization",
  swiftness: "Swiftness",
  other: "Other",
};

// Live preview mirroring the snapshot combatStats logic. The authoritative
// values are still computed server-side from the snapshot in phase 2; this only
// shows the user what to expect.
function previewStats(
  support: SupportPreview | undefined,
  inputs: Record<string, string>,
) {
  const specPts = support?.specPoints ?? 0;
  const swiftPts = support?.swiftPoints ?? 0;
  const rosterSpec = Number(inputs.rosterSpec) || 0;
  const rosterSwift = Number(inputs.rosterSwift) || 0;
  let pet = inputs.pet;
  if (!pet) pet = specPts === 30 ? "spec" : "swiftness";
  return {
    pet,
    spec: specPts * 50 + rosterSpec + (pet === "spec" ? 160 : 0),
    swift: swiftPts * 50 + rosterSwift + (pet === "swiftness" ? 160 : 0),
  };
}

// Table layout for the "Specialization / Swiftness" input section: rows Pet /
// Roster Bonus, columns Specialization / Swiftness / Other. Replaces the
// generic renderField mapping for these three fields specifically (pet is now
// a 3-way exclusive picker instead of a dropdown; roster bonus never applies
// to Other, so that cell is intentionally left empty).
function SpecSwiftTable({
  pet,
  rosterSpec,
  rosterSwift,
  inputs,
  onChange,
  onPetChange,
  locked,
  idPrefix,
}: {
  pet: AdvancedInput;
  rosterSpec: AdvancedInput;
  rosterSwift: AdvancedInput;
  inputs: Record<string, string>;
  onChange: (id: string, value: string) => void;
  onPetChange: (value: string) => void;
  locked: boolean;
  idPrefix: string;
}) {
  const petValue = inputs.pet ?? "";
  return (
    <div className="spec-swift-wrap">
      <div className="spec-swift-table">
        <div className="spec-swift-cell spec-swift-header" />
        <div
          className="spec-swift-cell spec-swift-header"
          title="Specialization"
        >
          <img
            src="/icons/spec.png"
            alt="Specialization"
            className="spec-swift-icon"
          />
        </div>
        <div className="spec-swift-cell spec-swift-header" title="Swiftness">
          <img
            src="/icons/swift.png"
            alt="Swiftness"
            className="spec-swift-icon"
          />
        </div>
        <div className="spec-swift-cell spec-swift-header">Other</div>

        <div
          className="spec-swift-cell spec-swift-row-label"
          title={pet.label ?? "Pet"}
        >
          Pet
        </div>
        {(["spec", "swiftness", "other"] as const).map((value) => (
          <button
            key={value}
            type="button"
            aria-pressed={petValue === value}
            disabled={locked}
            className={`spec-swift-cell spec-swift-option${petValue === value ? " selected" : ""}`}
            onClick={() => onPetChange(value)}
          >
            {PET_LABEL[value]}
          </button>
        ))}

        <div className="spec-swift-cell spec-swift-row-label">Roster</div>
        <div className="spec-swift-cell">
          <input
            id={`${idPrefix}-rosterSpec`}
            type="number"
            // value={inputs.rosterSpec ?? ""}
            placeholder={
              rosterSpec.default != null ? String(rosterSpec.default) : ""
            }
            disabled={locked}
            onChange={(e) => onChange("rosterSpec", e.target.value)}
          />
        </div>
        <div className="spec-swift-cell">
          <input
            id={`${idPrefix}-rosterSwift`}
            type="number"
            // value={inputs.rosterSwift ?? ""}
            placeholder={
              rosterSwift.default != null ? String(rosterSwift.default) : ""
            }
            disabled={locked}
            onChange={(e) => onChange("rosterSwift", e.target.value)}
          />
        </div>
        <div className="spec-swift-cell spec-swift-cell-empty" />
      </div>
      {pet.help && <small className="advanced-help">{pet.help}</small>}
    </div>
  );
}

// One side's gear source, laid out as two columns toggled by a radio: the left
// column selects the in-game snapshot via a character dropdown (disabled/visual
// for the support, which has a single member); the right column takes a manual
// lostark.bible character link. Only the selected column is enabled.
function GearSourcePicker({
  title,
  idBase,
  mode,
  onMode,
  warning,
  locked,
  selectValue,
  onSelect,
  options,
  selectDisabled,
  link,
  onLink,
  linkInvalid,
}: {
  title: string;
  idBase: string;
  mode: "snapshot" | "manual";
  onMode: (v: "snapshot" | "manual") => void;
  warning?: string;
  locked: boolean;
  selectValue: string;
  onSelect?: (v: string) => void;
  options: string[];
  selectDisabled?: boolean;
  link: string;
  onLink: (v: string) => void;
  linkInvalid: boolean;
}) {
  const snapshotChosen = mode === "snapshot";
  return (
    <div className="gear-source">
      <div className="gear-source-title">{title}</div>
      {warning && <div className="gear-warning">⚠ {warning}</div>}
      <div className="gear-source-cols">
        <label className={`gear-source-col${snapshotChosen ? " active" : ""}`}>
          <div className="gear-source-opt">
            <input
              type="radio"
              name={idBase}
              checked={snapshotChosen}
              disabled={locked}
              onChange={() => onMode("snapshot")}
            />
            <span>In-game snapshot</span>
          </div>
          <select
            aria-label={`${title} character`}
            value={selectValue}
            disabled={locked || selectDisabled || !snapshotChosen}
            onChange={(e) => onSelect?.(e.target.value)}
          >
            {options.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
        </label>
        <label className={`gear-source-col${!snapshotChosen ? " active" : ""}`}>
          <div className="gear-source-opt">
            <input
              type="radio"
              name={idBase}
              checked={!snapshotChosen}
              disabled={locked}
              onChange={() => onMode("manual")}
            />
            <span>Manual override</span>
          </div>
          <input
            type="url"
            placeholder="https://lostark.bible/character/NA/Name"
            value={link}
            disabled={locked || snapshotChosen}
            className={linkInvalid ? "invalid" : undefined}
            onChange={(e) => onLink(e.target.value)}
          />
          {linkInvalid && (
            <small className="advanced-help gear-error">
              Expected
              https://lostark.bible/character/&lt;region&gt;/&lt;name&gt;
            </small>
          )}
        </label>
      </div>
    </div>
  );
}

interface PartyFormState {
  inputs: Record<string, string>;
  petTouched: boolean;
  // Selected reference-DPS member names; undefined = use the party's default
  // (highest-CP DPS). uptimeMember may also be the AGGREGATE sentinel.
  gearMember?: string;
  uptimeMember?: string;
  // Which gear source each side uses: "snapshot" (the in-game snapshot, picked
  // via the character dropdown) or "manual" (a pasted lostark.bible link).
  // undefined = "snapshot".
  supportGearMode?: "snapshot" | "manual";
  dpsGearMode?: "snapshot" | "manual";
  // Optional lostark.bible character links overriding the support / DPS gear
  // source (used only when the corresponding mode is "manual"). Empty = not set.
  supportGearLink?: string;
  dpsGearLink?: string;
  // Phase 1.5 snapshot<->log cross-check, streamed per member once this party is
  // selected. `validationAttempts` counts passes (0 = never run): it both guards
  // the one-shot auto-fetch on selection and caps auto-retries after a browser
  // rate-limit degradation (see runValidation / MAX_VALIDATION_ATTEMPTS).
  validationAttempts?: number;
  validation?: Record<string, MemberValidation>;
  done: boolean;
  status: { text: string; tag: "info" | "ok" | "err" } | null;
}

// Per-member result of the up-front snapshot cross-check (see validateParty).
// "checking" until its event arrives; "warn" carries the discrepancy reasons.
interface MemberValidation {
  state: "checking" | "retrying" | "ok" | "warn" | "error";
  warnings?: string[];
}

export function PrefillCard({ card, onDone }: PrefillCardProps) {
  const inputsDefs = card.inputsDefs ?? [];
  const hasInputs = inputsDefs.length > 0;
  const showPicker = !card.autoSelect && card.parties.length > 1;

  // For <=1 party the worker keys everything under "all" (see fetchLogPhase /
  // buildSupportInfo); multi-party is keyed by party number.
  const [selectedKey, setSelectedKey] = useState<string | null>(
    showPicker ? null : "all",
  );
  // Each party (support) gets its own inputs/pet-touched/done/status bucket -
  // switching parties must neither leak one party's edits into another nor
  // leave a completed party's "Done" state stuck on a different, unsubmitted
  // party. `submitting` stays a single shared lock (only one
  // /api/log-prefill-party request in flight across the whole card at a time).
  const [partyState, setPartyState] = useState<Record<string, PartyFormState>>(
    {},
  );
  const [submitting, setSubmitting] = useState(false);

  // Pending auto-retry timers, keyed by party, so they can be cleared on unmount
  // (and superseded by a manual retry). Not state - changing them never re-renders.
  const retryTimers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});
  useEffect(() => {
    const timers = retryTimers.current;
    return () => {
      for (const t of Object.values(timers)) clearTimeout(t);
    };
  }, []);

  function defaultPartyState(): PartyFormState {
    return {
      inputs: seedInputs(inputsDefs),
      petTouched: false,
      done: false,
      status: null,
    };
  }

  function getParty(key: string | null): PartyFormState {
    return (key ? partyState[key] : undefined) ?? defaultPartyState();
  }

  function updateParty(
    key: string,
    patch:
      | Partial<PartyFormState>
      | ((s: PartyFormState) => Partial<PartyFormState>),
  ) {
    setPartyState((prev) => {
      const base = prev[key] ?? defaultPartyState();
      const patchObj = typeof patch === "function" ? patch(base) : patch;
      return { ...prev, [key]: { ...base, ...patchObj } };
    });
  }

  // Members of a given party key (for <=1 party everything is keyed "all").
  function playersForKey(key: string): PartyMemberInfo[] {
    if (card.parties.length === 0) return [];
    if (key === "all" || card.parties.length <= 1)
      return card.parties[0]?.players ?? [];
    return (
      card.parties.find((p) => String(p.partyNumber) === key)?.players ?? []
    );
  }

  async function submit(partyKey: string) {
    setSubmitting(true);
    // Clear any prior completion state so a re-run starts fresh (no stale "done"
    // flashing until the new result arrives).
    updateParty(partyKey, {
      status: { text: "Fetching snapshot and writing sheet...", tag: "info" },
      done: false,
    });
    const st = partyState[partyKey] ?? defaultPartyState();
    const { inputs } = st;
    const dflt = highestDamageDpsName(playersForKey(partyKey));
    const gearMember = (st.gearMember ?? dflt) || undefined;
    const uptimeMember = (st.uptimeMember ?? dflt) || undefined;
    // Links only apply in "manual" mode; otherwise the in-game snapshot is used.
    const supportGearLink =
      st.supportGearMode === "manual"
        ? st.supportGearLink?.trim() || undefined
        : undefined;
    const dpsGearLink =
      st.dpsGearMode === "manual"
        ? st.dpsGearLink?.trim() || undefined
        : undefined;
    try {
      await streamRequest(
        "/api/log-prefill-party",
        {
          jobId: card.jobId,
          partyKey,
          inputs,
          gearMember,
          uptimeMember,
          supportGearLink,
          dpsGearLink,
        },
        (evt) => {
          if (evt.type === "status") {
            updateParty(partyKey, {
              status: { text: evt.message, tag: "info" },
            });
          } else if (evt.type === "prefill-done") {
            updateParty(partyKey, {
              status: { text: evt.message, tag: "ok" },
              done: true,
            });
            onDone(evt.spreadsheetUrl);
          } else if (evt.type === "error") {
            updateParty(partyKey, {
              status: { text: evt.message, tag: "err" },
            });
          }
        },
      );
    } catch (err) {
      updateParty(partyKey, {
        status: {
          text: err instanceof ApiError ? err.message : "Connection error",
          tag: "err",
        },
      });
      setSubmitting(false);
      return;
    }
    setSubmitting(false);
  }

  // With no advanced inputs to collect, preserve the original behavior: a single
  // party auto-submits on mount with no extra interaction.
  useEffect(() => {
    if (!card.autoSelect || hasInputs) return;
    submit("all");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Phase 1.5: cross-check the selected party's snapshots against the log so
  // discrepancies surface during configuration. Streams one result per member.
  // `attempt` is the 1-based pass number; a pass that leaves any member errored
  // (e.g. the browser budget was momentarily exhausted) auto-retries once after a
  // delay, then leaves a clickable "error" badge for manual retry.
  async function runValidation(partyKey: string, attempt = 1) {
    // A fresh attempt supersedes any pending auto-retry timer for this party.
    if (retryTimers.current[partyKey]) {
      clearTimeout(retryTimers.current[partyKey]);
      delete retryTimers.current[partyKey];
    }
    const players = playersForKey(partyKey);
    // Seed: on the first pass everything is "checking"; on a retry only reset the
    // members that failed (to "retrying") so already-resolved rows don't flicker.
    updateParty(partyKey, (s) => {
      const prev = s.validation ?? {};
      const seed: Record<string, MemberValidation> = { ...prev };
      for (const m of players) {
        if (attempt === 1) seed[m.name] = { state: "checking" };
        else if (prev[m.name]?.state === "error" || !prev[m.name])
          seed[m.name] = { state: "retrying" };
      }
      return { validationAttempts: attempt, validation: seed };
    });

    // Track the final per-member outcome locally so we can decide on a retry
    // without racing React's async state.
    const latest: Record<string, MemberValidation> = {};
    let streamError = false;
    try {
      await streamRequest(
        "/api/log-prefill-validate",
        { jobId: card.jobId, partyKey },
        (evt) => {
          if (evt.type === "snapshot-checked") {
            const result: MemberValidation = evt.error
              ? { state: "error" }
              : evt.warnings && evt.warnings.length
                ? { state: "warn", warnings: evt.warnings }
                : { state: "ok" };
            latest[evt.name] = result;
            updateParty(partyKey, (s) => ({
              validation: { ...s.validation, [evt.name]: result },
            }));
          } else if (evt.type === "error") {
            // A stream-level error (e.g. rate limit): mark the still-pending
            // members as unvalidated rather than leaving them spinning.
            streamError = true;
            updateParty(partyKey, (s) => ({
              validation: markPendingErrored(s.validation),
            }));
          }
        },
      );
    } catch {
      streamError = true;
      updateParty(partyKey, (s) => ({
        validation: markPendingErrored(s.validation),
      }));
    }

    // Any member unresolved (errored, or never reported due to a stream error)?
    const hasErrors =
      streamError ||
      players.some(
        (m) =>
          latest[m.name] === undefined || latest[m.name]!.state === "error",
      );
    if (hasErrors && attempt < MAX_VALIDATION_ATTEMPTS) {
      // Show the failed members as "retrying" during the wait so they don't read
      // as final, then re-run after the browser cap has had time to recover.
      updateParty(partyKey, (s) => {
        const next = { ...(s.validation ?? {}) };
        for (const k of Object.keys(next)) {
          if (next[k]?.state === "error") next[k] = { state: "retrying" };
        }
        return { validation: next };
      });
      retryTimers.current[partyKey] = setTimeout(() => {
        delete retryTimers.current[partyKey];
        runValidation(partyKey, attempt + 1);
      }, VALIDATION_RETRY_DELAY_MS);
    }
  }

  // Manual retry (from a clicked error badge): a one-off pass that schedules no
  // further auto-retry (attempt is already at the cap), so the user stays in
  // control if the account is persistently saturated.
  function retryValidation(partyKey: string) {
    runValidation(partyKey, MAX_VALIDATION_ATTEMPTS);
  }

  // Trigger validation once whenever a (non-null) party becomes selected.
  useEffect(() => {
    if (!selectedKey) return;
    if (partyState[selectedKey]?.validationAttempts) return;
    runValidation(selectedKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedKey]);

  const support = selectedKey ? card.supportInfo?.[selectedKey] : undefined;
  const current = getParty(selectedKey);
  const preview = useMemo(
    () => (selectedKey ? previewStats(support, current.inputs) : null),
    [selectedKey, support, current.inputs],
  );

  // Auto-seed this party's Pet cell from its support's spec points (spec if
  // maxed at 30, else swiftness) - the same rule the old "auto" dropdown
  // option used - until the user manually picks a cell for this party.
  useEffect(() => {
    if (!selectedKey || current.petTouched || !support) return;
    const auto = support.specPoints === 30 ? "spec" : "swiftness";
    if (current.inputs.pet === auto) return;
    updateParty(selectedKey, (s) => ({ inputs: { ...s.inputs, pet: auto } }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedKey, support, current.petTouched, current.inputs.pet]);

  // Group inputs by their (optional) section heading, preserving order.
  const sections = useMemo(() => {
    const order: string[] = [];
    const bySection = new Map<string, AdvancedInput[]>();
    for (const inp of inputsDefs) {
      const key = inp.section ?? "";
      if (!bySection.has(key)) {
        bySection.set(key, []);
        order.push(key);
      }
      bySection.get(key)!.push(inp);
    }
    return order.map((s) => [s, bySection.get(s)!] as const);
  }, [inputsDefs]);

  // Locked only while a request is in flight - NOT after completion: a finished
  // run stays fully editable so the user can act on a discrepancy warning (flip
  // a flagged side to the manual character-link override and re-run). Phase 2 is
  // idempotent (reuses the existing sheet, overwrites cells - see scrapeJob.ts).
  const locked = submitting;
  const showInputs = hasInputs && selectedKey !== null;

  const setField = (id: string, v: string) => {
    if (!selectedKey) return;
    updateParty(selectedKey, (s) => ({ inputs: { ...s.inputs, [id]: v } }));
  };

  // Reference-DPS selectors: the party's members, defaulting to the highest-CP
  // DPS. Gear picks whose snapshot fills the DPS gear cells; uptime picks whose
  // per-member uptime fills the uptime cells (or AGGREGATE for the whole party).
  const partyPlayers = selectedKey ? playersForKey(selectedKey) : [];
  const defaultDps = highestDamageDpsName(partyPlayers);
  const gearValue = current.gearMember ?? defaultDps;
  const uptimeValue = current.uptimeMember ?? defaultDps;
  const showSelectors = selectedKey !== null && partyPlayers.length > 0;
  const setGearMember = (v: string) =>
    selectedKey && updateParty(selectedKey, { gearMember: v });
  const setUptimeMember = (v: string) =>
    selectedKey && updateParty(selectedKey, { uptimeMember: v });

  // Gear source: "snapshot" (dropdown) vs "manual" (pasted link), per side.
  const supportGearMode = current.supportGearMode ?? "snapshot";
  const dpsGearMode = current.dpsGearMode ?? "snapshot";
  const setSupportGearMode = (v: "snapshot" | "manual") =>
    selectedKey && updateParty(selectedKey, { supportGearMode: v });
  const setDpsGearMode = (v: "snapshot" | "manual") =>
    selectedKey && updateParty(selectedKey, { dpsGearMode: v });

  // Gear-override character links + their validity (block submit while invalid).
  // Only a link for a side whose mode is "manual" gates submission.
  const supportGearLink = current.supportGearLink ?? "";
  const dpsGearLink = current.dpsGearLink ?? "";
  const setSupportGearLink = (v: string) =>
    selectedKey && updateParty(selectedKey, { supportGearLink: v });
  const setDpsGearLink = (v: string) =>
    selectedKey && updateParty(selectedKey, { dpsGearLink: v });
  const linkInvalid = (v: string) =>
    v.trim() !== "" && !CHARACTER_URL_PATTERN.test(v.trim());
  const supportGearLinkInvalid =
    supportGearMode === "manual" && linkInvalid(supportGearLink);
  const dpsGearLinkInvalid =
    dpsGearMode === "manual" && linkInvalid(dpsGearLink);
  const linksInvalid = supportGearLinkInvalid || dpsGearLinkInvalid;

  // The party's (single) support, shown in the disabled support gear dropdown.
  const supportName = partyPlayers.find((p) => p.isSupport)?.name ?? "";

  // Prefill each manual-override link from the currently selected gear character
  // whenever that selection changes (including the initial default). Anonymous
  // names (containing "#") can't be resolved, so the field is cleared instead.
  // Keyed on the character name, so a later manual edit to the link isn't
  // clobbered until the dropdown selection actually changes again.
  const region = card.region;
  useEffect(() => {
    if (!selectedKey) return;
    updateParty(selectedKey, { dpsGearLink: characterLink(region, gearValue) });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedKey, gearValue, region]);
  useEffect(() => {
    if (!selectedKey) return;
    updateParty(selectedKey, {
      supportGearLink: characterLink(region, supportName),
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedKey, supportName, region]);

  // Contextual snapshot-accuracy warnings for the support (drives the support
  // build) and the selected gear member (drives the DPS gear cells). Prefer the
  // authoritative phase-1.5 cross-check once it lands; until then fall back to
  // the log-only heuristic (PartyMemberInfo.snapshotWarning).
  const validation = current.validation;
  const memberWarning = (name?: string): string | undefined => {
    if (!name) return undefined;
    const v = validation?.[name];
    if (v?.state === "warn") {
      return "Snapshot may be inaccurate — paste this character's lostark.bible link to override.";
    }
    return partyPlayers.find((p) => p.name === name)?.snapshotWarning;
  };
  const supportWarning = memberWarning(supportName);
  const gearWarning = memberWarning(gearValue);

  function renderField(inp: AdvancedInput) {
    const fieldId = `inp-${card.jobId}-${inp.id}`;
    const onChange = (v: string) => setField(inp.id, v);
    // Skin bonus is derived from the loadout when the support gear comes from a
    // manual character-link override - the worker fills F18 from the loadout's
    // avatar skins, so the manual slider is inert. Disable it and say so.
    const loadoutComputed =
      inp.id === "skinBonus" && supportGearMode === "manual";
    const disabled = locked || loadoutComputed;
    return (
      <div className="advanced-field" key={inp.id}>
        <label htmlFor={fieldId}>{inp.label}</label>
        {inp.type === "select" ? (
          <select
            id={fieldId}
            value={current.inputs[inp.id] ?? ""}
            disabled={disabled}
            onChange={(e) => onChange(e.target.value)}
          >
            {inp.options?.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        ) : inp.type === "range" ? (
          <div className="range-row">
            <input
              id={fieldId}
              type="range"
              min={inp.min}
              max={inp.max}
              step={inp.step}
              value={current.inputs[inp.id] ?? ""}
              disabled={disabled}
              onChange={(e) => onChange(e.target.value)}
            />
            <span className="range-value">
              {loadoutComputed
                ? "auto"
                : `${current.inputs[inp.id]}${inp.unit ?? ""}`}
            </span>
          </div>
        ) : (
          <input
            id={fieldId}
            type={inp.type === "number" ? "number" : "text"}
            value={current.inputs[inp.id] ?? ""}
            placeholder={inp.default != null ? String(inp.default) : ""}
            disabled={disabled}
            onChange={(e) => onChange(e.target.value)}
          />
        )}
        {loadoutComputed ? (
          <small className="advanced-help">
            Computed directly from the loadout's skins.
          </small>
        ) : (
          inp.help && <small className="advanced-help">{inp.help}</small>
        )}
      </div>
    );
  }

  function renderSection([section, defs]: readonly [string, AdvancedInput[]]) {
    return (
      <div className="advanced-section" key={section || "default"}>
        {section && <div className="advanced-section-head">{section}</div>}
        {section === "Specialization / Swiftness" ? (
          <SpecSwiftTable
            pet={defs.find((d) => d.id === "pet")!}
            rosterSpec={defs.find((d) => d.id === "rosterSpec")!}
            rosterSwift={defs.find((d) => d.id === "rosterSwift")!}
            inputs={current.inputs}
            onChange={setField}
            onPetChange={(v) => {
              if (!selectedKey) return;
              updateParty(selectedKey, (s) => ({
                inputs: { ...s.inputs, pet: v },
                petTouched: true,
              }));
            }}
            locked={locked}
            idPrefix={`inp-${card.jobId}`}
          />
        ) : (
          defs.map(renderField)
        )}
      </div>
    );
  }

  // Split the sections into a support column and a DPS column (DPS sections are
  // those whose heading starts with "DPS"), rendered side by side.
  const dpsSections = sections.filter(([s]) => s.startsWith("DPS"));
  const supportSections = sections.filter(([s]) => !s.startsWith("DPS"));

  return (
    <div className="pick-card">
      <div className="pick-card-title">{card.logUrl}</div>

      {showPicker ? (
        <>
          <div className="pick-card-summary">
            Choose which party the support was in (used for uptime
            calculations):
          </div>
          <div className="option-btn-grid">
            {card.parties.map((party) => {
              const key = String(party.partyNumber);
              return (
                <button
                  key={key}
                  type="button"
                  className={`option-btn${selectedKey === key ? " selected" : ""}`}
                  disabled={locked}
                  onClick={() => {
                    setSelectedKey(key);
                    if (!hasInputs) submit(key);
                  }}
                >
                  <div>Party {party.partyNumber + 1}</div>
                  <PartyMembers
                    players={party.players}
                    validation={
                      selectedKey === key ? current.validation : undefined
                    }
                    reserveBadge={card.parties.length > 1}
                    onRetry={
                      selectedKey === key
                        ? () => retryValidation(key)
                        : undefined
                    }
                  />
                </button>
              );
            })}
          </div>
        </>
      ) : (
        card.parties.length > 0 && (
          <div className="pick-card-summary">
            <div>Party {card.parties[0]!.partyNumber + 1}</div>
            <PartyMembers
              players={card.parties[0]!.players}
              validation={current.validation}
              onRetry={
                selectedKey ? () => retryValidation(selectedKey) : undefined
              }
            />
          </div>
        )
      )}

      {showSelectors && (
        <div className="dps-selectors">
          {/* Gear source, per side: pick between the in-game snapshot (the
              dropdown, left) and a manual lostark.bible character link (right),
              toggled by a radio. Game snapshots are unreliable, so when a member
              is flagged the manual override pulls gear from that character's
              loadout instead. */}
          <GearSourcePicker
            title="Support gear"
            idBase={`support-gear-${card.jobId}`}
            mode={supportGearMode}
            onMode={setSupportGearMode}
            warning={supportWarning}
            locked={locked}
            // Support has a single member: the dropdown is purely visual.
            selectDisabled
            selectValue={supportName}
            options={supportName ? [supportName] : []}
            link={supportGearLink}
            onLink={setSupportGearLink}
            linkInvalid={supportGearLinkInvalid}
          />
          <GearSourcePicker
            title="DPS gear"
            idBase={`dps-gear-${card.jobId}`}
            mode={dpsGearMode}
            onMode={setDpsGearMode}
            warning={gearWarning}
            locked={locked}
            selectValue={gearValue}
            onSelect={setGearMember}
            options={partyPlayers.map((p) => p.name)}
            link={dpsGearLink}
            onLink={setDpsGearLink}
            linkInvalid={dpsGearLinkInvalid}
          />

          <div className="advanced-field">
            <label htmlFor={`uptime-${card.jobId}`}>DPS Player's Uptime</label>
            <select
              id={`uptime-${card.jobId}`}
              value={uptimeValue}
              disabled={locked}
              onChange={(e) => setUptimeMember(e.target.value)}
            >
              {/* Supports are excluded: uptime measures the support's buff
                  coverage over DPS damage, which is undefined for the support
                  itself (dpsPlayers filters supports out -> blank cells). Gear
                  still lists everyone. */}
              {partyPlayers
                .filter((p) => !p.isSupport)
                .map((p) => (
                  <option key={p.name} value={p.name}>
                    {p.name}
                  </option>
                ))}
              <option value={AGGREGATE}>Aggregate (whole party)</option>
            </select>
          </div>
        </div>
      )}

      {showInputs && (
        <div className="advanced-inline">
          {support?.name && preview && (
            <div className="support-preview">
              Support <strong>{support.name}</strong> - spec{" "}
              {support.specPoints} / swift {support.swiftPoints} pts · pet -&gt;{" "}
              <strong>{PET_LABEL[preview.pet] ?? preview.pet}</strong>
              <span className="support-preview-totals">
                {" "}
                -&gt; <strong>{preview.spec}</strong> spec /{" "}
                <strong>{preview.swift}</strong> swift (before bracelet)
              </span>
            </div>
          )}
          <details className="advanced-collapse">
            <summary>Advanced inputs</summary>
            <div className="advanced-columns">
              <div className="advanced-column">
                <div className="advanced-column-head">Support</div>
                {supportSections.map(renderSection)}
              </div>
              {dpsSections.length > 0 && (
                <div className="advanced-column">
                  <div className="advanced-column-head">DPS</div>
                  {dpsSections.map(renderSection)}
                </div>
              )}
            </div>
          </details>
          <button
            type="button"
            className="run-btn"
            disabled={locked || !selectedKey || linksInvalid}
            onClick={() => selectedKey && submit(selectedKey)}
          >
            {submitting ? "Running..." : current.done ? "Re-run" : "Go..."}
          </button>
        </div>
      )}

      {current.status && (
        <div className={`pick-status ${current.status.tag}`}>
          {current.status.text}
        </div>
      )}
    </div>
  );
}
