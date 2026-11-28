import { useEffect, useRef, useState } from "react";
import { ChevronDown, ChevronUp } from "lucide-react";
import { api } from "./api.js";
import { Button } from "./components/ui/button.js";

type WaitingCard = { id: string; title: string; repo: string };
type Updates = {
  commits: { sha: string; subject: string }[];
  installing: boolean;
  error: string | null;
  /** Installing restarts the server; false when only the browser UI changes. Missing on older servers. */
  restart?: boolean;
  /** The commit the served UI was built from. */
  ui?: string | null;
};
type Status = {
  draining: boolean;
  activeRuns: number;
  cards?: WaitingCard[];
  updates?: Updates | null;
  version?: string;
  commit?: string | null;
  date?: string | null;
};

const runs = (count: number) => `${count} active run${count === 1 ? "" : "s"}`;
const installLabel = (updates: Updates) =>
  updates.restart === false ? "Update interface" : "Update and restart";
const installHint = (updates: Updates, activeRuns: number) =>
  updates.restart === false
    ? "Only the interface changed, so runs keep going."
    : activeRuns > 0
      ? `Restarts after ${runs(activeRuns)} finish.`
      : "Nothing is running, so it restarts right away.";

// Every card commit starts "Alice card: ", which says nothing in a list of mostly card commits.
const subjectText = (subject: string) => subject.replace(/^Alice card: /, "");

/** The pending commits, newest first: short hash in a fixed column so wrapped subjects line up. */
function Changelog({
  commits,
  testId,
  className,
}: {
  commits: Updates["commits"];
  testId: string;
  className?: string;
}) {
  return (
    <ul
      data-testid={testId}
      className={`overflow-y-auto overscroll-contain ${className ?? ""}`}
    >
      {commits.map((commit) => (
        <li
          key={commit.sha}
          className="grid grid-cols-[auto_1fr] items-baseline gap-x-3 py-1"
        >
          <span className="font-mono text-xs tabular-nums text-muted-foreground">
            {commit.sha}
          </span>
          <span className="text-foreground">{subjectText(commit.subject)}</span>
        </li>
      ))}
    </ul>
  );
}

// Bottom-left notice for server updates: the pending commits as a changelog with a button to install them, then
// the wait for active runs to finish before the server restarts to load the new code. A UI-only update needs no
// restart; the notice then offers to reload the page onto the new UI.
export function UpdateNotice({
  onOpenCard,
  onOpenSettings,
}: {
  onOpenCard?: (card: WaitingCard) => void;
  onOpenSettings?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState<Status | null>(null);
  const [down, setDown] = useState(false);
  const [requestError, setRequestError] = useState<string | null>(null);
  // The UI build this page loaded. The server reports a new one after a UI-only update.
  const loadedUi = useRef<string | null | undefined>(undefined);
  useEffect(() => {
    let restarting = false;
    const poll = () =>
      api<Status>("/status")
        .then((next) => {
          restarting = next.draining || !!next.updates?.installing;
          if (loadedUi.current === undefined && next.updates?.ui)
            loadedUi.current = next.updates.ui;
          setStatus(next);
          setDown(false);
        })
        .catch(() => setDown(restarting));
    void poll();
    const timer = setInterval(poll, 3000);
    return () => clearInterval(timer);
  }, []);
  const updates = status?.updates;
  const newUi =
    !down &&
    !!loadedUi.current &&
    !!updates?.ui &&
    updates.ui !== loadedUi.current;
  const pending =
    !down &&
    !status?.draining &&
    !updates?.installing &&
    (updates?.commits.length ?? 0) > 0;
  if (!down && !status?.draining && !updates?.installing && !pending) {
    if (!newUi) return null;
    return (
      <div
        role="status"
        className="fixed bottom-3 left-3 z-50 lg:bottom-20 flex items-center gap-3 rounded-lg border border-border bg-popover py-1.5 pr-1.5 pl-3 text-sm text-foreground shadow-lg"
      >
        <span className="size-2 shrink-0 rounded-full bg-status-review" />
        Alice's interface was updated.
        <Button
          size="sm"
          variant="secondary"
          data-testid="update-notice-reload"
          onClick={() => window.location.reload()}
        >
          Reload
        </Button>
      </div>
    );
  }
  const install = () => {
    setRequestError(null);
    api<Updates>("/update", { method: "POST" })
      .then((next) =>
        setStatus((previous) => previous && { ...previous, updates: next }),
      )
      .catch((error: Error) => setRequestError(error.message));
  };
  const count = updates?.commits.length ?? 0;
  const text = down
    ? "Restarting to load updates…"
    : status!.draining
      ? status!.activeRuns > 0
        ? `Update ready. Waiting for ${runs(status!.activeRuns)} to finish. New runs are paused.`
        : "Update ready. Restarting…"
      : updates!.installing
        ? "Installing update…"
        : `${count} update${count === 1 ? "" : "s"} available`;
  const cards = down || !status?.draining ? [] : (status.cards ?? []);
  const expandable = pending || cards.length > 0;
  const error = requestError ?? updates?.error;
  // Only work in progress loops; a waiting update is a still mark.
  const busy = down || !!status?.draining || !!updates?.installing;
  const Chevron = open ? ChevronDown : ChevronUp;
  return (
    <div
      role="status"
      className={`fixed bottom-3 left-3 z-50 lg:bottom-20 max-w-[calc(100vw-1.5rem)] rounded-lg border border-border bg-popover text-sm text-foreground shadow-lg ${open && expandable ? "w-[28rem]" : ""}`}
    >
      <button
        type="button"
        data-testid="update-notice-toggle"
        aria-expanded={expandable ? open : undefined}
        disabled={!expandable}
        onClick={() => setOpen((value) => !value)}
        className="flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left enabled:cursor-pointer enabled:hover:bg-accent"
      >
        <span
          className={`size-2 shrink-0 rounded-full bg-status-review ${busy ? "motion-safe:animate-pulse" : ""}`}
        />
        <span className="flex-1">{text}</span>
        {expandable && (
          <Chevron
            aria-hidden
            className="size-4 shrink-0 text-muted-foreground"
          />
        )}
      </button>
      {pending && error && (
        <p className="border-t border-border px-3 py-2 whitespace-pre-wrap text-destructive">
          Update failed: {error}
        </p>
      )}
      {open && pending && (
        <div
          data-testid="update-notice-changelog"
          className="border-t border-border"
        >
          <Changelog
            commits={updates!.commits}
            testId="update-notice-changelog-list"
            className="max-h-[min(20rem,50vh)] px-3 py-2"
          />
          <div className="border-t border-border px-3 py-2.5">
            <p className="mb-2 text-xs text-muted-foreground">
              {installHint(updates!, status!.activeRuns)}
            </p>
            <div className="flex items-center gap-2">
              <Button variant="main" size="sm" onClick={install}>
                {installLabel(updates!)}
              </Button>
              {onOpenSettings && (
                <Button size="sm" variant="text" onClick={onOpenSettings}>
                  Open in settings
                </Button>
              )}
            </div>
          </div>
        </div>
      )}
      {open && cards.length > 0 && (
        <ul
          data-testid="update-notice-cards"
          className="border-t border-border p-1"
        >
          {cards.map((card) => (
            <li key={card.id}>
              <button
                type="button"
                onClick={() => onOpenCard?.(card)}
                className="block w-full truncate rounded-md px-2 py-1.5 text-left hover:bg-accent"
              >
                {card.title}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Settings → Updates: the running version, then the pending commits with the same install action as the notice. */
export function UpdatesPanel() {
  const [status, setStatus] = useState<Status | null>(null);
  const [failed, setFailed] = useState(false);
  const [requestError, setRequestError] = useState<string | null>(null);
  useEffect(() => {
    const poll = () =>
      api<Status>("/status")
        .then((next) => {
          setStatus(next);
          setFailed(false);
        })
        .catch(() => setFailed(true));
    void poll();
    const timer = setInterval(poll, 3000);
    return () => clearInterval(timer);
  }, []);
  if (!status)
    return (
      <p className="text-sm text-muted-foreground">
        {failed
          ? "Alice is not responding. It may be restarting."
          : "Loading…"}
      </p>
    );
  const updates = status.updates;
  const commits = updates?.commits ?? [];
  const error = requestError ?? updates?.error;
  const install = () => {
    setRequestError(null);
    api<Updates>("/update", { method: "POST" })
      .then((next) =>
        setStatus((previous) => previous && { ...previous, updates: next }),
      )
      .catch((requestFailure: Error) =>
        setRequestError(requestFailure.message),
      );
  };
  return (
    <div className="text-sm">
      <dl className="grid grid-cols-[7rem_1fr] gap-y-2">
        <dt className="text-muted-foreground">Version</dt>
        <dd data-testid="settings-version">{status.version ?? "unknown"}</dd>
        <dt className="text-muted-foreground">Commit</dt>
        <dd className="font-mono">
          {status.commit ?? "unknown"}
          {status.date && (
            <span className="ml-2 font-sans text-muted-foreground">
              {new Date(status.date).toLocaleDateString(undefined, {
                day: "numeric",
                month: "short",
                year: "numeric",
              })}
            </span>
          )}
        </dd>
      </dl>
      <div className="mt-6 border-t border-border pt-5">
        {updates === null || updates === undefined ? (
          <p className="text-muted-foreground">
            This server was not started with npm start, so it does not install
            updates by itself.
          </p>
        ) : updates.installing || status.draining ? (
          <p>
            {status.draining && status.activeRuns > 0
              ? `Update ready. Waiting for ${runs(status.activeRuns)} to finish. New runs are paused.`
              : "Installing update…"}
          </p>
        ) : commits.length === 0 ? (
          <p data-testid="settings-up-to-date">Up to date.</p>
        ) : (
          <>
            <p className="font-medium">
              {commits.length} update{commits.length === 1 ? "" : "s"} available
            </p>
            <Changelog
              commits={commits}
              testId="settings-changelog"
              className="mt-3 max-h-72"
            />
            <Button variant="main" className="mt-4" size="sm" onClick={install}>
              {installLabel(updates)}
            </Button>
            <p className="mt-2 text-xs text-muted-foreground">
              {installHint(updates, status.activeRuns)}
            </p>
          </>
        )}
        {error && (
          <p role="alert" className="mt-3 whitespace-pre-wrap text-destructive">
            Update failed: {error}
          </p>
        )}
      </div>
    </div>
  );
}
