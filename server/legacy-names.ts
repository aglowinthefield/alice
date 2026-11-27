// Cards opened before Bakery became Alice push `bakery/<id>`, and GitHub closes a PR whose head branch is renamed.
// This module is the one place that knows the old name; once no open card is on such a branch, inline `alice/<id>`.
import { git } from "./git-async.js";

/** The branches a card's PR may come from, newest name first. */
export const cardBranches = (cardId: string): string[] => [`alice/${cardId}`, `bakery/${cardId}`];

/**
 * The branch a card works on in `repo`: the first of `cardBranches` that exists there, locally or on origin, else
 * `alice/<id>`.
 */
export async function cardBranch(repo: string, cardId: string): Promise<string> {
  for (const branch of cardBranches(cardId)) {
    try { await git(repo, ["show-ref", "--quiet", "--", `refs/heads/${branch}`, `refs/remotes/origin/${branch}`]); return branch; }
    catch { /* Not this name. */ }
  }
  return cardBranches(cardId)[0];
}
