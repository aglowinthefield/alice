// Cards opened before Bakery became Alice push `bakery/<id>`, and GitHub closes a PR whose head branch is renamed.
// This module is the one place that knows the old name; once no open card is on such a branch, inline `alice/<id>`.
import { execFileSync } from "node:child_process";

/** The branches a card's PR may come from, newest name first. */
export const cardBranches = (cardId: string): string[] => [`alice/${cardId}`, `bakery/${cardId}`];

/**
 * The branch a card works on in `repo`: the first of `cardBranches` that exists there, locally or on origin, else
 * `alice/<id>`.
 */
export function cardBranch(repo: string, cardId: string): string {
  const branches = cardBranches(cardId);
  const exists = (branch: string) => {
    try { execFileSync("git", ["-C", repo, "show-ref", "--quiet", "--", `refs/heads/${branch}`, `refs/remotes/origin/${branch}`], { stdio: "ignore" }); return true; }
    catch { return false; }
  };
  return branches.find(exists) ?? branches[0];
}
