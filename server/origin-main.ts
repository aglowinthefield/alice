import type { Board, Card, RepoBoard } from "./board.js";
import { githubRepo } from "./github-url.js";
import { git, isAncestor as gitIsAncestor, Shared } from "./git-async.js";

// On a local board, Approve merges into local main only. When the repository has a GitHub remote, a Done card
// says whether its merge commit is on origin/main yet. This reads the remote-tracking ref from the last fetch;
// it never fetches, so rendering a board makes no network call.

export type OriginMainState = NonNullable<Card["originMain"]>;

function gitOut(repo: string, ...args: string[]): Promise<string | undefined> {
  return git(repo, args).catch(() => undefined);
}
function isAncestor(repo: string, ancestor: string, descendant: string): Promise<boolean | undefined> {
  return gitIsAncestor(repo, ancestor, descendant).catch(() => undefined);
}

/** True when the board's remote link or the repository's origin points at GitHub. */
export async function hasGithubRemote(repoBoard: Pick<RepoBoard, "repo" | "remoteUrl">): Promise<boolean> {
  return !!githubRepo(repoBoard.remoteUrl) || !!githubRepo(await gitOut(repoBoard.repo, "remote", "get-url", "origin"));
}

export class OriginMain {
  // Ancestry of a commit never changes for a given origin/main tip, so answers are cached by both.
  private cache = new Map<string, boolean>();
  // Board loads that overlap share one read of the remote and origin/main's tip, and one ancestry check per commit.
  private shared = new Shared();
  constructor(private board: Board) {}

  /** Done cards on a local board with a GitHub remote get `originMain`; every other card is returned unchanged. */
  async annotate(repoBoard: RepoBoard, cards: Card[]): Promise<Card[]> {
    if (repoBoard.integration !== "local" || !cards.some(card => card.status === "done")) return cards;
    const repo = repoBoard.repo;
    const tip = await this.shared.run(`tip\0${repo}\0${repoBoard.remoteUrl}`, async () =>
      await hasGithubRemote(repoBoard) ? gitOut(repo, "rev-parse", "--verify", "--quiet", "refs/remotes/origin/main") : undefined);
    if (!tip) return cards;
    const merges = this.board.listMergeCommits(repo);
    // One check at a time: a first load of a long Done lane would otherwise start a Git process per card at once.
    const result: Card[] = [];
    for (const card of cards) result.push(await this.annotateCard(card, repo, tip, merges.get(card.id)));
    return result;
  }
  private async annotateCard(card: Card, repo: string, tip: string, merge: string | undefined): Promise<Card> {
    if (card.status !== "done" || !merge) return card;
    const key = `${repo}\0${tip}\0${merge}`;
    let pushed = this.cache.get(key);
    if (pushed === undefined) {
      const answer = await this.shared.run(key, () => isAncestor(repo, merge, tip));
      if (answer === undefined) return card; // The merge commit is gone from this clone; say nothing.
      if (this.cache.size > 5000) this.cache.clear();
      this.cache.set(key, pushed = answer);
    }
    return { ...card, originMain: pushed ? "pushed" : "local" };
  }
}
