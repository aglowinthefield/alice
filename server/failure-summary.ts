import { isProviderFailureKind, type ProviderFailureKind } from "./provider-failure.js";

const providerSummaries: Record<ProviderFailureKind, string> = {
  "invalid-history": "Session history rejected",
  "output-blocked": "Blocked by provider",
  billing: "Billing or quota",
  auth: "Provider auth failed",
  "invalid-request": "Provider rejected request",
  "rate-limit": "Rate limited",
  transient: "Provider or network error",
  unknown: "Provider request failed",
};

/**
 * A few words on why a Failed card failed, for its board tile. Reads the latest run's error text (see the worker's
 * `finish` calls) and the PR state; the full text stays on the card's details. Null when nothing explains it.
 */
export function summarizeFailure(input: { error: string | null; failureKind: string | null; prState?: string | null }): string | null {
  const { error, failureKind } = input;
  if (isProviderFailureKind(failureKind)) return providerSummaries[failureKind];
  if (!error) return input.prState === "CLOSED" ? "PR closed unmerged" : null;
  const timeout = error.match(/Bakery sent SIGTERM: (\d+)-minute run timeout/);
  if (timeout) return `Timed out after ${timeout[1]} min`;
  if (/Bakery sent SIGTERM: manual stop/.test(error)) return "Stopped by hand";
  if (/Bakery sent SIGTERM: server received SIGTERM|^Server restarted while this run was active/.test(error)) return "Server restarted mid-run";
  if (/termination source unknown/.test(error)) return "Killed by unknown signal";
  if (error.startsWith("Worktrunk pre-start hooks")) return "Worktree setup failed";
  if (error.startsWith("Pi could not start")) return "Pi could not start";
  if (/Provider request failed/.test(error)) return "Provider request failed";
  if (/Invalid Pi event stream/.test(error)) return "Garbled Pi output";
  const exit = error.match(/^Pi exited \((\w+)\)/);
  if (exit && exit[1] !== "0") return `Pi crashed (exit ${exit[1]})`;
  if (/no settlement event/.test(error)) return "Pi ended without finishing";
  const first = error.split(/[;\n]/)[0].trim();
  return first.length > 40 ? `${first.slice(0, 39)}…` : first || null;
}
