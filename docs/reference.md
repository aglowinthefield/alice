# Alice reference

The full feature reference. For an overview, see the [README](../README.md).

Alice is a local kanban board that hands coding tasks to Pi agents, one Git worktree per card. Nothing reaches your `main` branch until you approve it.

Alice doesn't push, deploy, or write to an issue tracker unless you turn it on. PRs open only on GitHub pull request boards, and a board can opt in to pushing `main` after each local merge (see [Reviewing and merging](#reviewing-and-merging)).

```mermaid
flowchart LR
  you([You]) -->|browser| ui[Board UI]
  you -->|terminal| cli[alice]
  ui --> server
  cli --> server
  server[Alice server<br/>127.0.0.1:4317] --> db[(SQLite)]
  server -->|one per card| wt[Git worktree<br/>branch alice/CARD_ID]
  server -->|spawns| pi[pi agent]
  pi -->|edits| wt
  wt -->|Approve and merge into local main| main[local main]
```

## Contents

- [Quick start](#quick-start)
- [Today](#today)
- [Card lifecycle](#card-lifecycle)
- [Dependencies](#dependencies)
- [Visualizer](#visualizer)
- [Reviewing and merging](#reviewing-and-merging)
- [GitHub pull request mode](#github-pull-request-mode)
- [Watching a run](#watching-a-run)
- [Automation (opt-in)](#automation-opt-in)
- [CLI](#cli)
- [Boards and lanes](#boards-and-lanes)
- [Server, data, and restarts](#server-data-and-restarts)
- [Safety](#safety)
- [Development](#development)
- [Releasing](#releasing)

## Quick start

You need Node 24, Git, and `pi` on your `PATH` with a configured provider.

```sh
npm install
npm run dev
```

Open http://127.0.0.1:5173.

`npm run dev` runs the server under a supervisor that owns ports 4317 and 5173 (the server listens on 14317 and Vite on 15173) and reloads the server when code changes. While the server or Vite is down, page loads on either port get a static status page with elapsed and typical restart time, which reloads when the server is back.

To run a single production server instead, run `npm run build && ALICE_SERVE_UI=1 npm start` and open http://127.0.0.1:4317. To keep it running in the background, see [Running as a service](#running-as-a-service).

Then:

1. Add a repository by entering its Git root, either an absolute path or a `~/` path. The repository needs at least one commit, because worktrees start from `HEAD`.
2. Create a card. New cards start in **Triage**. To attach files, use **Attach files** or paste an image (such as a screenshot) into the form. A pasted screenshot is named `pasted-image-1.png`, `pasted-image-2.png` and so on. A paste that also has text, such as cells copied from a spreadsheet, pastes the text and attaches nothing.
3. Move the card to **Ready**, then start it. Starting a run uses paid model tokens.
4. When Pi finishes, the card moves to **Review**. Read the diff, then **Approve and merge into local main** (or **Approve and open PR** on a github-pr board) or **Request changes**.

Uncommitted or untracked files in your checkout don't appear in card worktrees.

## Today

Alice opens on **Today**, which covers every repository at once. After you open a board, Alice reopens on that board until you click **Today** in the sidebar again.

- **Since your last visit** gives a count of cards merged since you last opened Alice, how many cards need you, and the last-24h cost across repositories.
- **Capture** adds a Triage card to the repository you pick. Alice remembers the repository. From a terminal, `alice add ...` does the same thing for the repository you're in.
- **Needs you** lists Review cards (longest-waiting first), then Failed and Interrupted cards. The sidebar shows the same count next to **Today**.
- **Review N cards** opens Review cards one at a time, oldest first. When a card leaves Review, either because you approved it or because it ran again, the next card opens. **Next card** skips ahead. Closing the card ends the queue.
- **Running** and **Finished since your last visit** list the rest. Click any card to open its details.

### Worktrunk hooks

If [Worktrunk](https://worktrunk.dev) is installed, Alice runs your repository's creation hooks in each new card worktree before Pi starts. Use them to install dependencies or copy `.env` and other ignored files (`wt step copy-ignored`). Hooks live in `.config/wt.toml` in the repository, or in `~/.config/worktrunk/config.toml`.

- `pre-start` hooks run first, and Pi waits for them. If one fails, the attempt fails with the hook output in its transcript. Alice removes the new worktree and branch so the next attempt runs the hooks again.
- `post-start` hooks start in the background, as they do under `wt switch`.
- Hooks run only when Alice creates the worktree. Retries and conflict repairs reuse it without running them.
- Alice passes `--yes`, so project hooks run without Worktrunk's approval prompt. Pi runs commands in the same worktree anyway.
- Alice still picks the worktree path and handles review and merge itself. It doesn't call `wt switch` or `wt merge`.

## Card lifecycle

```mermaid
stateDiagram-v2
  direction LR
  [*] --> Triage
  Triage --> Ready: approve
  Ready --> Running: start
  Running --> Review: Pi finished
  Running --> Failed: error or stop
  Running --> Interrupted: server died
  Interrupted --> Failed: release
  Failed --> Running: run again
  Review --> Running: request changes
  Review --> Done: approve and merge
  Review --> Done: close without merging
  Done --> Archived: archive
```

- **A finished run only reaches Review.** Only your approval, or a pull request opened by unattended review merging on GitHub, moves a card to Done.
- **Stop** and the 60-minute run timeout both end a run as Failed. Ten minutes before the timeout, Alice steers a run that is still going to stop starting new work, commit nothing, and write its report with evidence attached. A run that settles before the timeout keeps that report and reaches Review. Alice loads `scripts/pi-wrap-up.mjs` into each run with `pi -e` to deliver the message, since Pi's JSON mode reads no input.
- **Close without merging** moves a Triage, Ready, Failed or Review card to Done, or from the CLI with `alice close CARD_ID`. The dialog asks why: duplicate, wrong approach, not needed, superseded, or other with a note. One click on a reason closes the card, and **Close without a reason** skips it. The CLI takes `--reason duplicate` (or `wrong-approach`, `not-needed`, `superseded`, `other`) and `--note TEXT`. The reason shows in the card's history, and Statistics counts closes by reason, with closes from before reasons existed counted as not given. The worktree and branch stay, and **Reopen** returns it to Review. It never touches Linear or GitHub.
- **Mark done** closes a Triage or Ready card that never ran. An unrun Ready card can also go back to Triage.
- **Retries reuse the card's worktree and Pi session**, so Pi continues where it left off.
- **A timed-out run is continued, not restarted.** The attempt after a run timeout (Run again or pickup) resumes that run's Pi session with a short message, "You ran out of time on the previous attempt…", plus any review comments or feedback added since, instead of the whole task again. When the session file is missing, it starts a fresh session with the whole task and the last report instead. A continued session the provider rejects gets the fresh-session recovery below. Alice learns where Pi keeps each session from `scripts/pi-wrap-up.mjs`. Other failures retry with the whole task in the same session.
- **A rejected session is recovered, not resumed.** When the provider answers HTTP 400 `invalid_request_error` about the `messages` array (for example `messages.103: role 'system' must precede an 'assistant' message`), the saved session replays the same history and fails every time. The run is marked as a provider failure, not a clean exit, and Run again refuses it (HTTP 409 `session_rejected`). Alice starts one automatic recovery: a fresh Pi session in the same worktree, with the card's uncommitted edits, review comments, CI feedback and last report. A recovery that is rejected again stops; **Recover in a fresh session** on the card (or `alice recover CARD_ID --yes`) tries again by hand. The old session file and run log are kept, and the card history records each recovery. Billing, authentication, other HTTP 400 errors and temporary errors (429, 5xx, network) are never recovered this way.
- **Interrupted** cards can't be retried until you check the worktree and release the card. Alice first confirms that the recorded PID is no longer running. A PID reused by an unrelated process also blocks release.
- **Reopen** returns a Done card to Review when its work was left unmerged in the worktree. If the card was already merged, it returns to Ready.
- **History** (Details tab, collapsed) lists every status change with its reason, plus agent-review verdicts and notes such as a failed restart after the reviewer sent a card back. Changes made before this existed show attempts and reviews only.
- **Restore to Done** brings an archived card back. **Archive** only changes the lane. Runs, worktrees, branches, and history stay.
- Only Done cards can be archived. To archive several at once, use **Select** in the Done lane.
- **Moving a Triage card to Ready** (its button, a drag, or a bulk move) checks the card's text first, since these are the cards reviewers send back most. A card that asks for something only a person can do (a physical device, screenshots or recordings by hand, staging or production, someone's sign-off) or never says what done looks like (no Acceptance section, checklist, or "should"/"must" sentence) shows its flags with **Edit** and **Ready anyway**. Nothing is blocked: **Ready anyway** moves it, **Edit** opens the card's edit form, and closing the dialog leaves it in Triage. Cards that already ran are not checked. The rules are plain text matching in `src/card-lint.ts`.
- **Drag a card** to move it to a lane its buttons could also reach: Triage ↔ Ready, an unrun card to Done, Ready or Failed to Running (this starts Pi and asks first if run confirmations are on), Done ↔ Archive. While you drag, valid lanes are outlined and the others fade. Review, Interrupted, and Reopen still go through the card's buttons, since they need a diff review or a worktree check.

## Dependencies

A card can depend on other cards on the same board. It doesn't start until every card it depends on is Done or archived, so its worktree is cut from a `main` that already has their work.

- A blocked card stays in Ready and shows **Waiting on N**. Its details list the cards it depends on, each linking to that card, and let you add or remove one. The cards it blocks show under **Needed by**.
- Automatic pickup skips blocked cards. They don't use a concurrency slot or the daily limit.
- Starting a blocked card from the UI, API, or CLI fails with an error naming the unfinished cards. Retrying a card that already has attempts isn't blocked, because it already has a worktree.
- When a card merges (Approve on a local board, or its pull request merging), Alice brings each card in Review that depends on it up to date with `main` (`origin/main` on a pull-request board), so it doesn't conflict later. The card's work stays uncommitted, and anything staged stays staged. The branch fast-forwards, or gets a merge commit when it has commits of its own. A clean update queues agent review again. A conflict, or a local file Git ignores that main now tracks, changes nothing and shows as the usual merge conflict, with **Fix conflict with Pi**. A card with an agent review or an approval in progress is updated once that finishes, and then reviewed again. On a pull-request board, an agent approval given while the card waits for that update opens no pull request; the review on the updated card does. Cards with an open pull request are left alone, since GitHub already checks them against main.
- Alice rejects a card depending on itself, on a card from another board, or on a card that would create a cycle.
- If a card you depend on is gone from the database, Alice drops that dependency on startup.
- The API takes `dependsOn: [ids]` when creating a card, `POST /api/boards/:board/cards/:id/dependencies` with `{ "dependsOn": id }`, and `DELETE .../dependencies/:dependsOn`. Card JSON includes `dependsOn` and `blocked`.
- Done means Alice's own Done. If a card's work reaches `main` some other way, such as a squash-merged PR you `git pull`, Alice doesn't notice, and a started card can't be marked Done by hand. Remove the dependency with `undepend` instead.

## Visualizer

**Visualizer** under a repository in the sidebar draws that board's cards as a dependency graph, with each card pointing at the cards that depend on it. Colors and motion show state: a working card pulses, a blocked one is dashed, a done one is solid.

- Hover a card to trace its whole chain, upstream and downstream. Everything else dims.
- Click a card to open its details over the graph, the same panel the board uses. Escape closes it. Drag to pan, scroll to zoom, `f` or double-click to fit.
- The header counts cards per state and has the **Done** filter. **Relevant** (the default) keeps finished cards only while an unfinished card still depends on them. **All** and **Hide** do what they say. The legend sits in the corner of the graph.
- Without WebGL, the graph is drawn as plain SVG from the same layout, with the same colors and labels but no animation.
- The graph updates from the same 2 s card poll as the board. The **Glow** control only applies to the WebGL view.

## Reviewing and merging

The Review diff shows what the card changed since its branch split from `main`, including unignored files the agent didn't commit. Newer work on `main` doesn't show up as deletions.

The diff toolbar switches between unified and split layouts and picks a syntax theme (Alice, GitHub, One, Catppuccin, Solarized, Gruvbox, Rosé Pine, or Vitesse). Each theme has a light and a dark variant that follows Alice's theme. This browser remembers both choices.

To request revisions:

1. Select a line, write a comment, and add it as a draft.
2. Click **Request changes** to submit the drafts. Alice starts the next attempt right away, and Pi gets your comments in its prompt. If the attempt can't start (Alice is restarting, say), the card says why; click **Run again** once it can.

Drafts must be submitted or removed before you can approve. Comments stay as history on later diffs, where their line positions may have moved.

When you approve:

```mermaid
flowchart TD
  A[Approve and merge into local main] --> B{Worktree or main changed<br/>since the diff loaded?}
  B -->|yes| R[Refuse: refresh the diff]
  B -->|no| C[Commit all unignored changes<br/>on the card branch]
  C --> D[Merge with current main<br/>in a temporary worktree]
  D --> E{Conflicts or<br/>whitespace errors?}
  E -->|yes| F[Card stays in Review<br/>and shows the conflicting files]
  F --> G[Fix conflict with Pi,<br/>or resolve it yourself]
  G --> A
  E -->|no| H[Fast-forward main]
  H --> I[Done]
```

In the repository's settings, **Push main to origin after merging** (local-merge boards, off by default) runs `git push origin main` after the fast-forward, for agent-reviewer merges too. If the push fails, the card stays Done and its History says why.

- Manual approval doesn't run tests or CI, and doesn't push.
- Alice commits and merges as you: your Git `user.name` and `user.email`, signed if your config signs commits (`commit.gpgsign`). Only a repository with no name or email configured gets `Alice <alice@localhost>` in its place.
- Your own uncommitted edits on `main` stay in place. Git refuses a merge that would overwrite them.
- **Fix conflict with Pi** starts a new attempt in the card's worktree. Pi may merge `main` into the card branch and commit there, but must not touch `main`.
- After a conflict fix, you review the result again before it merges.
- If approval fails in another way, **Withdraw approval** unlocks the card for revision. It never removes commits or worktrees. If `main` has already moved, Alice refuses and asks you to inspect.
- Diffs over 200 files or 2 MB can't be approved in Alice. Binary files need checking in the worktree.
- If you merge a card's branch into `main` yourself, Alice notices on its next tick and marks the card Done. This only applies when the worktree is clean and the merge actually changed `main`.

## GitHub pull request mode

A board integrates either locally, where Approve merges into local `main`, or through GitHub pull requests, where a card is Done only when its PR has merged on GitHub and the merge commit is on `origin/main`.

The default depends on the repository. When you give a board a GitHub remote link (`https://github.com/OWNER/REPO`), Alice asks GitHub whether `main` accepts direct pushes: `gh api repos/OWNER/REPO/rules/branches/main` for rulesets, then `gh api repos/OWNER/REPO/branches/main/protection` for branch protection. If a ruleset requires a pull request or a merge queue, or branch protection requires pull request reviews, the board switches to **GitHub pull requests**. Otherwise it stays **Local merge**. The board's settings show what Alice found.

- **Your choice wins.** Once you pick a mode under Integration in the board's settings, or with `alice board --integration local|github-pr`, Alice never changes it.
- **Protected main on a local board.** If a board is on Local merge, `main` only accepts pull requests, and you haven't chosen Local yourself, Approve refuses and points you to the Integration setting. Merging locally would leave local `main` ahead of GitHub with no way to push. Pick **GitHub pull requests**, or click **Keep Local merge** (or run `alice board --integration local`) to merge locally anyway. Boards that already had a GitHub remote are checked once when the server starts. That check only records protection; it doesn't change their mode.
- **When Alice can't tell.** If `gh` is missing, isn't signed in, or can't read the rules (branch protection needs admin access unless a ruleset already answered), the mode is left as it was, local Approve works as before, and the board's settings say why. The check runs again the next time the server starts or the remote changes.

Add a repository as a board from the terminal with `alice board-add [PATH]` (the current directory by default).

To switch by hand, pick **GitHub pull requests** under Integration in the board's settings, or run `alice board --integration github-pr`. Either way, the repository's `origin` must be that GitHub repository, and its default branch must be `main`.

[`gh`](https://cli.github.com) is required. If `gh` is missing or `gh auth status` fails, the board shows the error and Alice does nothing on that board: no PR polling, no fetch, no automatic pickup. It never falls back to local detection. Set `ALICE_GH_BIN` to use a different `gh` binary.

What changes in this mode:

- **New card worktrees** start from a freshly fetched `origin/main`, not from the local checkout's `HEAD`.
- **Approve and open PR** opens a dialog with a draft title and body to edit, then commits the reviewed changes on `alice/<card>`, pushes that branch to `origin`, and runs `gh pr create` with them. Alice appends a footer naming the card and its `--key` when it has one, plus the run summary. If the repository has a pull request template (`.github/PULL_REQUEST_TEMPLATE.md`, also at the root or in `docs/`) or a semantic-PR title check (an `amannn/action-semantic-pull-request` workflow, or `.github/semantic.yml`), Pi drafts the title and body from them, the card, the run output, and the diff. The drafting run has no tools and uses the board's review model. Otherwise the draft is the card title and description, and no agent runs. A title that fails the check's types or scopes is refused before anything is pushed. Nothing merges locally. If the branch already has an open PR, Approve pushes the new commits to it and leaves its title and body alone. `gh` errors appear on the card word for word. Pi is still told never to push or open PRs. Your Approve is the authorization (or the agent reviewer's approval, with unattended review on). Alice comments on the PR at each turning point: when it pushes an update (and whether a person approved it or it was an automatic CI fix), when it sends the card back for failing CI, and when it gives up after the fix-run limit. A CI fix run may also add or remove labels on its own PR, edit its description, and comment to explain why, for checks that a label or description line satisfies.
- **Getting ready at Review.** When a run reaches Review, Alice drafts the PR title and body and runs the repository's hooks on the work while you review it, so Approve only pushes. It commits the work on `alice/<card>` (pre-commit and commit-msg hooks run), then runs the pre-push hook on that commit with `git push --dry-run`, which pushes nothing. It checks one card at a time per repository. If you approve exactly that commit, Alice pushes with `--no-verify`. If the work changed since, or Alice couldn't run the check, the hooks run on Approve as before. A hook that refuses the work at Review goes back to the implementer right away, as a refused push does, up to 2 times in a row; after that the card waits for you. A hook that rewrites files (a formatter) changes the diff under review. Boards with auto-review or automatic pull requests skip this, since they push at Review anyway. A new attempt stops a check that's still running.
- **Linking a PR.** Alice finds a card's PR by its `alice/<card>` branch, or `bakery/<card>` for cards whose PR opened before the rename. If your branch naming differs, attach the PR link on the card, or run `alice pr CARD_ID URL` (`off` clears it). A linked PR is only watched; Alice doesn't push to it.
- **Polling.** About once a minute per board, Alice makes one `gh pr list` call for the board's Review cards:
  - **Open:** the card stays in Review and shows the PR number and checks state. The button becomes **Approve and update PR #N**, which pushes new reviewed work to that PR.
  - **Open with failing CI:** once the failed checks have finished (and the rest have too, or 10 minutes have passed), Alice sends the card back to Pi with each failed check's name, link, and the tail of its `gh run view --log-failed` log. When the fix run reaches Review, the next sync pushes it to the same PR without waiting for Approve, unless you've left review comments on it. Runs you start yourself still wait for Approve, and the PR still needs its normal review to merge. Each pushed commit is sent back once, only when the card worktree is clean and holds that commit, and at most 3 times per card; after that the card shows why it stopped. Cancelled and action-required checks are shown but not sent back, and only the newest run of each check counts. If CI passes before the fix run starts, the failures are dropped. A linked PR (one Alice doesn't push to) is never sent back. Neither is a draft PR, since many repositories skip CI on drafts; the card says so, and marking the PR ready lets the next sync send it back.
  - **Merged:** Alice fetches `origin` and checks that the merge commit is an ancestor of `origin/main`. If it is, the card moves to Done and the merge is recorded. If not yet, the card stays in Review and Alice checks again next time.
  - **Closed without merging:** the card goes to Needs you with the reason.
- **Cleanup.** After a card is Done, Alice removes its worktree and local branch (with `wt remove` when Worktrunk is installed). Squash merges aren't ancestors of the branch, so the branch is force-deleted, but only after GitHub has confirmed the merge.
- **Retries.** When you rerun a card whose committed branch is behind `origin/main` and hasn't been pushed, Alice rebases it onto `origin/main` before Pi starts. If the rebase conflicts, the attempt goes to Needs you and the branch is left as it was. Cards in Review are never rebased, because that would change what you reviewed.
- **Requesting changes from the PR.** A comment on an open PR that starts with `/alice` sends the card back to Pi with the comment as requested changes. So does a submitted review (Request changes or Comment) whose summary starts that way (`@alice` is not used: it would notify an unrelated GitHub account): its inline comments go along, with their file and line. Only the repository's owner, members and collaborators count; anyone else's comment is ignored, and Pi is told these are requests to weigh, not orders. Alice replies on the PR. Each comment is sent once, comments from before Alice first looked at the PR are not replayed, and a linked PR (one Alice doesn't push to) is never sent back. It is sent only when the card worktree is clean and holds the PR head; until then the request waits. Unlike a CI fix, the new attempt waits for your Approve before it is pushed. Alice reads comments on its normal sync (every minute).
- **Automatic pull requests.** In the repository's settings, **Open pull requests automatically** (pull-request boards, off by default) pushes `alice/<card>` and opens the PR as soon as a run reaches Review, drafting the title and body as Approve does, without waiting for you. Its PR comment says no person reviewed the push. Only runs that finish after you turn it on are pushed, and only a card's first PR (later pushes still need Approve, apart from CI fixes). If the draft needs a person, or the push or `gh` fails, the card stays in Review with the reason in its History. A pre-push hook refusal goes back to the implementer; after three automatic attempts on one card, it waits for Approve. With auto-review on, the two combine: the agent reviewer goes first and never blocks the PR. Its approval opens the PR; a request for changes reruns the card (waiting for a free slot if the repository is at its run limit); and a card it hands to a person, or that is out of reruns, gets a **draft** PR with the reviewer's findings posted on it.
- **Unattended review.** With auto-review on, an agent approval does what Approve does: Alice drafts the title and body the same way, pushes `alice/<card>`, and opens the PR (or updates the open one). Its PR comment says the agent reviewer approved the push and no person reviewed it. The card then waits on GitHub and goes Done when the PR merges. If the draft needs a person (the title fails the semantic-PR check, or drafting fails), or the push or `gh` fails, the card stays in Review for you. A pre-push hook refusal goes back to the implementer, as it does after Approve. See [Unattended review](#unattended-review).
- Local merge detection is off for these boards.

### Keeping local main current

In this mode the main checkout is never a workspace. Every card works in its own worktree, so local `main` should always be clean and at or behind `origin/main`. On each sync, and right after a card goes Done, Alice runs `git fetch origin --prune` and then `git merge --ff-only origin/main` in the main checkout.

Main only ever fast-forwards. If it has uncommitted changes, has local commits, has diverged, or isn't checked out, Alice doesn't reset, rebase, stash, or force anything. It shows the problem on the board and pauses automatic pickup there until a later sync succeeds. Untracked files don't block the sync unless the fast-forward would overwrite them.

### Cards merged locally before the switch

A card approved while the board used local merge is Done, but its work may only be on local `main`. Board settings list these cards (Done, merged by Alice, approved commit not on `origin/main`). On a GitHub pull request board each has **Publish as PR**, also shown on the card. It pushes the approved commit to `alice/<card>`, opens the PR the same way Approve does, clears the local merge record, and moves the card back to Review. The card goes Done again when the PR merges and reaches `origin/main`.

Publishing is refused when the approved commit sits on top of other local merges that `origin/main` lacks, since they would ride along in the PR. Publish the earlier card first, or rebase the card branch onto `origin/main` yourself. A plain push is used, so an existing `alice/<card>` on GitHub with other commits is never overwritten.

Publishing doesn't touch local `main`. Once every local commit on `main` is an Alice card merge whose work is on `origin`, Alice offers to reset `main` to `origin/main`. It saves the old tip as `alice-recovery/<sha>` first and resets only after you confirm that tip. It won't offer the reset if `main` isn't checked out, has uncommitted changes, or holds any other commit, and `git reset --keep` refuses rather than overwrite untracked files.

### Not detected

- **Reverts after merge.** Once a card is Done, Alice doesn't watch for its PR being reverted.
- Force-pushes that rewrite `origin/main` after a card is Done.
- PRs merged into a branch other than `main`. They never reach `origin/main`, so the card stays in Review.

## Watching a run

Each attempt in a card's **Attempts** list shows:

- The agent that ran it as `provider/model`, for example `anthropic/claude-…` or `openai-codex/gpt-…`. The board card shows the latest run and review agents.
- A transcript: assistant text, plus one line per turn with tool counts, failures, and changed files. Tool arguments and results aren't stored. Pi's own session has the full conversation.
- Its cost, as reported by Pi on each assistant message. Hover it for input, output, and cache token counts. Attempts from before Alice tracked usage show `—`, not `$0.00`. The heading shows the card's total across all attempts and agent reviews.
- The worktree path, with **Copy path**. Failed attempts have **Copy error** instead, which copies a prompt you can paste into an agent: card, repo, worktree, error, and the end of the output.

The clock on a card counts completed Pi turns across attempts. Older runs show an estimate marked with `~` or `?`.

A card that has run more than once shows an amber attempt count, in every lane including Done and Archive, so cards that needed rework stand out. The **Attempts** list in card details starts with the attempt count and the number of review rounds, meaning reviews that ended in **Request changes**.

Provider errors show only their HTTP status. Pi's stderr goes to the server console, not the board, because it can contain request details.

## Automation (opt-in)

Both features are off by default and set per repository in **Settings**. Both can start paid Pi runs, and both need the server to keep running.

The board header shows **Last 24h**: the cost of attempts and agent reviews that are running or finished in the last 24 hours.

### Automatic pickup

The server starts Ready cards for you, highest priority first, then oldest first. Priority is a whole number from -100 to 100 (default 0); `low`, `normal`, `high` and `urgent` are shorthands for -10, 0, 50 and 100. Set it when you create or edit a card, or from its details. Lanes list higher-priority cards first, and a card with a non-zero priority shows the number in its footer, warmer the higher it is.

- **Concurrency:** 1 to 4 runs at once (default 2). Manually started runs count toward it.
- **Agents at once, all boards:** card runs and agent reviews on every board share this many slots, since each ends with the repository's tests. Automatic (the default) is a quarter of the CPU cores, at least 2. Set it in **Settings > General** or with `alice agents N|auto`. Automatic work (pickup, reviewer send-backs, CI, hook and conflict fixes, agent reviews) waits for a slot. A run you start yourself counts toward the limit but always starts.
- **Limits:** the daily limit, the daily cost budget and the agent reviewer's diff caps are spend limits. They apply only when the board's **Limits** switch is on, which is off by default, so a development board runs unthrottled. Turn it on in the board's settings or with `alice limits on`; the stored values are kept while it's off. Concurrency and the loop guards (reviewer and hook send-backs, CI-fix runs, conflict repairs, automatic retries, the 60-minute run timeout) always apply. All of them are decided in `server/repo-limits.ts`.
- **Daily limit** (when limits are on): 1 to 99 automatic starts in any rolling 24 hours (default 6), or 0 for no limit (`--limit off` in the CLI). At the limit, pickup waits and the board shows when the next slot opens. **Reset start limit** starts a new window and may start runs immediately.
- **Daily cost budget** (when limits are on): optional, off by default. When the board's last-24h cost reaches it, pickup waits and the board says why. Pickup resumes as older spend leaves the window, or when you raise or clear the budget. Running work isn't stopped, and manual starts still work. Cost comes from Pi's own pricing, so it's an estimate and can overshoot by whatever runs were already in progress.
- **Failed runs:** a card whose automatic run fails waits in Failed, and pickup carries on with the other Ready cards. Pickup never restarts a failed card, except for the automatic retry of a provider error.
- **Pauses:** pickup pauses on an interrupted card, a startup error, or an authentication or billing refusal from the provider (which would fail every card), and the board shows why. Turn it back on once you have dealt with it.
- Turning pickup off stops new starts. Runs already in progress keep going.

### Unattended review

A separate Pi agent reviews finished cards without you. It never merges into local `main`: on a local board an approved card waits for your **Approve**, and on a [GitHub pull request](#github-pull-request-mode) board Alice opens the PR and GitHub decides the merge.

```mermaid
flowchart LR
  A[Run reaches Review] --> C[Separate Pi reviewer<br/>runs the repo's checks itself]
  C -- request_changes --> S[Sent back to the implementer<br/>at most twice]
  C -- approve, local board --> H[Waits for your Approve]
  C -- approve, pull-request board --> P[Pushes and opens the PR]
  C -. needs a person or unclear verdict .-> H
```

- It's set per repository. Open the repository's edit (pencil) dialog and enable it.
- Alice only considers runs that reach Review after you enable it.
- Failed reviews aren't retried.
- The reviewer reads the repository's `AGENTS.md`, `CLAUDE.md` and review instructions and runs the checks they ask for itself, instead of sending the card back for missing proof. Checks only a person can do, such as device runs, screenshots or staging access, leave the card for you.
- Turning the setting off stops a review in progress from opening a PR.
- The reviewer is a full Pi agent in the card's worktree, with the same tools, extensions, skills, and context files as a card run. It can read code and run builds or tests, and runs locally with your permissions. It's told not to change anything; if the work changes during review, the card is left for you.

## CLI

The CLI talks to the running server's HTTP API, so it goes through the same checks as the UI.

```sh
npm run alice -- add fix the flaky login test [--priority 80]
npm run alice -- doctor
npm run alice -- boards
npm run alice -- cards [--all] [--watch]
npm run alice -- tui
npm run alice -- create --title "..." --body "..." [--key KEY] [--priority -100..100|low|normal|high|urgent] [--after CARD_ID]...
npm run alice -- show CARD_ID
npm run alice -- depend CARD_ID --on CARD_ID
npm run alice -- undepend CARD_ID --on CARD_ID
npm run alice -- edit CARD_ID [--title "..."] [--body "..."]
npm run alice -- archive CARD_ID...
npm run alice -- restore CARD_ID
npm run alice -- stats
npm run alice -- ready CARD_ID [--yes]
npm run alice -- triage CARD_ID
npm run alice -- start CARD_ID... --yes
npm run alice -- recover CARD_ID --yes
npm run alice -- runs CARD_ID
npm run alice -- conflicts
npm run alice -- pickup [on|off|reset] [--concurrency 2] [--limit 6] [--budget 5|off] [--yes]
npm run alice -- board [--integration local|github-pr]
npm run alice -- pr CARD_ID [URL|off]
```

- `doctor` runs setup checks and prints `PASS`, `WARN` or `FAIL` for each, then a count; it exits 1 if any check fails. It checks Node 24, git and its committer identity, `pi` and its model list, Worktrunk (optional), `gh` sign-in (a failure only on boards using GitHub pull requests), the data directory and its lock, whether the server answers, and each board's repository and integration or pickup errors. The server line comes right after the versions and says which instance you reached and whether it's local or remote. Against a non-loopback `ALICE_URL` it checks only the server and boards, since tools and paths are on the server's machine, and names each board `<host>:<path>`. After the checks come `INFO` rows that never pass or fail: the CLI's path, every `ALICE_*` variable the CLI sees (names containing `TOKEN`, `SECRET`, `KEY`, `PASSWORD`, `WEBHOOK` or `ENDPOINT` print as `set (hidden)`), and what the server reports about itself: host, active runs, agent models, telemetry and whether a Discord webhook is set. A remote server's own environment variables stay on its machine. `--json` prints the checks.
- `add` is quick capture: the words after it become the title of a new Triage card. It takes the same `--body`, `--priority` and `--source` as `create`.
- Without `--board`, commands use the board whose repository contains your current directory. Outside every repository, they use the only board, or ask for `--board ID|PATH` if you have several. Add `--json` for full API responses.
- Commands that can start paid runs need `--yes`: `start`, `pickup on`, `pickup reset`, and `ready` on a board with pickup enabled.
- `ready` runs the same check as the board's Move to Ready (see [Card lifecycle](#card-lifecycle)). A flagged card is listed with its flags and stays in Triage; repeat with `--yes` to move it anyway, and the flags still print to stderr. In `tui`, `r` on a flagged card lists the flags and asks `y/N`. The API is `GET /api/boards/BOARD/cards/CARD/ready-check`, which returns `{ flags }` and moves nothing.
- `create --key KEY` makes re-runs safe. If the board already has a card with that key, in any status including archived, the CLI prints that card instead of creating another. Keys are unique per board and up to 200 characters. The API takes the same value as `idempotencyKey` and returns 200 for an existing card, 201 for a new one.
- `create --source NAME` (also on `add`) records where the card came from; the CLI sends `cli` when you leave it out. An agent should give its own name, such as `hermes`. The API takes the same value as `source`: a lower-case name of up to 40 letters, digits, dots, dashes or underscores. An API caller that sends none gets the source its `idempotencyKey` prefix implies (`hermes:`, `plan:`, `follow-up:`), otherwise `api`. Alice itself records `ui`, `plan` and `follow-up`, and callers can't claim `manual` or `plan`. Cards made before sources existed say `manual` unless their key prefix named their path. The card's Details tab shows the source.
- `cards` on a terminal prints the board's lanes with the web board's badges (failure reason, Your turn, quiet, retries, PR). Archive and all but the 5 newest Done cards need `--all`; `--watch` redraws every 2 seconds. Piped, it prints one tab-separated line per card: ID, status, priority, attempt count, review rounds, and title.
- `tui` draws the web app across the whole terminal. A sidebar (on terminals 140 columns or wider, or with `b`) numbers the boards: `1`–`9` open one and `0` opens Today, which lists what's running, what needs you and what's approved on every board, as on the web. It opens on Today when you have several boards and didn't pick one with `--board` or the current directory. The board header shows its spend in the last 24 hours and its merge conflicts. A board has lanes side by side, a tile per card with its title and one live fact (the running tool, a failure reason, what it waits on), and empty or off-screen lanes as thin strips with their counts. `h`/`l` or the arrows move between lanes and `j`/`k` within one; enter opens the card over the board with its description and latest attempt, and tab shows every attempt. `/` finds a card by its title or id, as the web's command palette does: on the board you're on, or on every board from Today. ↑/↓ pick a match and enter opens it, moving the board's selection to it. `o` opens it in the browser and `?` lists every key. The mouse works too: a click selects a card, a board in the sidebar, a Today row, a dialog tab or a key in the footer, a second click on a card opens it, a click outside a dialog closes it, and the wheel scrolls. Hold Shift to select text while the TUI has the mouse. `s` starts or reruns, `x` stops, `a` approves, accepts findings or updates an open PR, `R` recovers, and `r`/`t` move between Ready and Triage. Paid runs, merges and stops ask for `y` first. Opening a new pull request needs its drafted title and body, so the TUI sends that to the browser.
- `show` prints a card's title, status, repository, description, each attempt's status, agent and error, the latest auto-review verdict, and the cards it depends on and that depend on it, each with its status.
- `create --after CARD_ID` makes the new card depend on that card. Repeat it for several. `depend` and `undepend` add or remove one dependency on an existing card. See [Dependencies](#dependencies).
- `edit` changes a card's title, description, or both. `--body ""` clears the description. You can't edit a running card.
- `archive` follows the same rules as the UI: it accepts only Done cards, and if any card isn't Done, nothing is archived. `restore` moves one archived card back to Done.
- `stats` prints the board's card count in each lane and its pickup state.
- `start` takes several cards and starts each one separately. `runs` shows each attempt's error, so you can find failed attempts and retry them. It also shows each attempt's and review's tokens and cost, and the card total. `runs --json` prints `{ cardId, total, runs, reviews }`.
- `open [CARD_ID]` opens the board, or one card, in your browser (`$BROWSER`, else the system opener) and prints the URL. A card ID may be the 8-character prefix. `--print` only prints it, and so does a shell with no display.
- `agents [N|auto]` shows or sets how many agents run at once across all boards.
- `limits [on|off]` shows the board's spend limits, or turns them on or off.
- `pickup` shows the last-24h cost and any budget. `--budget` sets the daily cost budget in USD, and `--budget off` clears it.
- The CLI can't approve merges.
- `board [--integration local|github-pr]` shows the board and switches its integration mode. `pr CARD_ID [URL|off]` shows, attaches, or clears a card's PR link. See [GitHub pull request mode](#github-pull-request-mode).
- To use a different server, set `ALICE_URL` or `ALICE_PORT`. To get `alice` on your `PATH`, run `npm link`. `alice help` lists the commands, and `alice help COMMAND` shows one command's options. On a terminal the output is laid out in coloured columns (`NO_COLOR` turns the colour off); piped, it stays tab-separated.

## Boards and lanes

- Alice expands `~`, stores the canonical Git root, and shows the absolute path.
- To fix a board's path, edit the board. Its cards move only if none has run yet, because attempts keep their worktrees in the original repository.
- **Remove repository** hides a board without deleting anything, attached files included. Add the same repository again to restore it.
- Alice never deletes cards, so a card's attached files stay in `<data dir>/attachments/<card>` until you delete the attachment or purge an archived card's attachments (below). At startup Alice removes files that no attachment points to, such as an upload cut off by a crash.
- Any lane can be collapsed, even with active cards. Auto-collapse only applies to lanes without active cards, and a board's **Auto-collapse** setting persists. Manual choices last until you reload the page.
- Card descriptions support common Markdown: headings, emphasis, lists and task lists, quotes, code, and `http`, `https`, or `mailto` links. Card details render it, and board cards show a plain-text preview. Raw HTML appears as text and is never rendered.
- In **Settings**, you can turn on a confirmation before each run and choose whether card details open as a popup or a side panel.
- Each repository can have an optional `http` or `https` remote link, such as its GitHub page. Set it with the pencil button next to the repository (Edit repository). It appears below the board heading. The link itself is only a link; pushing is the separate opt-in setting below.

### Pi models

Alice starts Pi for three kinds of runs. Each can use its own model and thinking level:

- **Card runs**: normal runs and, unless the repository sets Card retries, retries.
- **Conflict fixes**: runs that repair a merge conflict.
- **Agent review**: the reviewer used by [unattended review](#unattended-review).

Set global defaults in **Settings → Pi models**. To override them for one repository, use **Pi models** in its Edit repository dialog. A blank field inherits: the repository value comes first, then the global value, then the default in your Pi settings. Model and thinking level inherit separately, so a repository can change only the model and keep the global thinking level.

A model is a Pi model pattern such as `anthropic/claude-sonnet-4-5` or `openai-codex/gpt-5.5`. Alice passes it as `--model`, and the thinking level as `--thinking` (`off`, `minimal`, `low`, `medium`, `high`, `xhigh`, or `max`). It only passes flags you set. The model field suggests the models `pi --list-models` reports. Alice caches that list for 10 minutes. A change applies to runs that start after you save it. Retries keep their Pi session but use the current model.

A repository can also set **Card retries**, a model ladder for card runs: a card's first attempt uses the Card runs model, and every later attempt (after a failure, a send-back, or a CI, hook or comment fix) uses the Card retries model. A blank Card retries thinking level keeps the Card runs level. Leave Card retries blank to run every attempt on Card runs. It is per repository only and does not change conflict fixes, agent review or PR drafts. The attempt history shows which model each attempt used.

## Server, data, and restarts

- The server listens only on `127.0.0.1` and has no authentication. Don't expose it on a network.
- Data and worktrees live in `~/.local/share/alice/`. To change this, set `ALICE_DATA_DIR`. You can also set `ALICE_PORT`, `ALICE_PI_BIN` to use a different `pi` binary, and `ALICE_WT_BIN` to use a different `wt` binary. Set `ALICE_WT_BIN=` (empty) to turn off Worktrunk hooks. Paste a Discord channel webhook into Settings (or set `ALICE_DISCORD_WEBHOOK_URL`, which applies when Settings has none) and Alice posts a message when a run finishes: the card title and the run summary for a card ready for review, or the error for a failed run. Stopped runs are not posted. The URL is a secret: Settings hides it, and it must be a discord.com webhook. **Notify this browser when a card needs you** in Settings turns on Web Push for that browser: a notification when a card becomes your turn in Review (nothing else, such as the agent reviewer or GitHub CI, still holds it) or fails, even with no Alice tab open. Clicking one opens the card. At most once a day, and only when some Review card has sat there longer than its board's **Days in Review before a card is stale** (board settings, 3 by default, 0 for off), a digest lists those cards and opens Today, where each has Approve, **Run again on current main** (a run that first brings the work up to date with main) and Close; the board marks them **Stale**. Each browser turns it on separately, it needs HTTPS or localhost (see [HTTPS on a tailnet](#https-on-a-tailnet)), and cards that already needed you are not replayed. Brave needs **Use Google services for push messaging** turned on (Settings → Privacy and security); without it, and in Chromium builds without Google services, subscribing fails with "push service error". The server checks every 10 seconds and keeps its push key in `push-vapid.json` in the data directory. Set `ALICE_TELEMETRY_ENDPOINT` to an OTLP/HTTP endpoint to show an opt-in Settings toggle for anonymous usage counts; nothing is sent without both. [docs/telemetry.md](telemetry.md) lists every field. Set `ALICE_METRICS=1` to serve Prometheus metrics on `/metrics` for your own scraper; [docs/metrics.md](metrics.md) lists them.
- On Windows, Alice finds `pi`, `wt` and `gh` through `PATH` and `PATHEXT`, and runs npm's `pi.cmd` shim as `node cli.js`. Repository paths can be `C:\\code\\app` or `~\\code\\app`. Data lives in `%USERPROFILE%\\.local\\share\\alice`. A run's **Stop** ends Pi but not any processes Pi started. An auto-review verification command runs under `cmd.exe`, so write it for that shell.
- Files attached to cards and discussion messages live in `<data dir>/attachments/<card id>/`. Clicking an image thumbnail opens it in a lightbox: the arrow keys, the side buttons or the thumbnail strip step through the other images in the same list, **Full size** shows the image at its natural size (scroll to pan), and **Open original** opens the file in a new tab. Cmd- or Ctrl-click on a thumbnail still opens the file in a new tab directly. Deleting an attachment removes its file. Archiving a card or removing its board keeps the files, because both can be undone. To reclaim the space, use **Purge attachments** on an archived card or `alice purge-attachments CARD_ID... --yes`. It deletes the card's folder and its attachment records, and it cannot be undone, even if you restore the card.
- Agents keep evidence as attachments too. A work run's prompt tells the agent to save screenshots and other generated files with `alice attach CARD_ID FILE... --board ID` instead of reporting `/tmp` paths. The command reads each file as the agent's own user, uploads it through the normal attachment route (nothing leaves Alice), and prints a markdown line such as `![before.png](/api/boards/…/cards/…/attachments/…)` to paste into the report. The report shows attached images inline and falls back to a link when a file is missing. Only Alice's own attachment and chat-image URLs render as images; a local path in report text is never read. In a GitHub pull request body or comment, Alice rewrites those relative links to plain text saying the file is kept in Alice, because screenshots are never published to GitHub.
- Only one server can own a data directory, which it locks with `server.lock`. If the PID in the lock is no longer running, the next server takes over the lock.
- **Stop** ends a run and marks it Failed. Runs time out after 30 minutes.

In `npm run dev`, code changes don't kill running agents. This matters because approving an Alice card changes Alice's own server code:

```mermaid
sequenceDiagram
  participant S as dev supervisor
  participant B as Alice server
  participant P as running Pi agents
  Note over S: server file changes,<br/>for example after a merge
  S->>B: drain
  B->>B: refuse new runs and reviews, pause pickup
  P-->>B: runs and the agent review in progress finish on their own
  B->>S: drained
  S->>B: restart with the new code
```

If the server stops during an agent review anyway (a crash, or stopping `npm run dev`), the review is queued again when it starts. A second interruption of the same review leaves the card for you.

If the server crashes, the supervisor restarts it after 1 second, backing off to 30 seconds while it keeps failing. A file change restarts it immediately. Stopping `npm run dev` stops running agents.

The browser takes UI changes from a merge as hot updates, so the board and an open card stay where they were. When Vite has to reload the page instead, each tab reopens its own view, repository and open card.

## Hosting on another machine

By default the server binds to 127.0.0.1 and only accepts local `Host` and `Origin` headers. To run it on an always-on box, put it on a private network such as Tailscale (Alice has no login of its own):

```sh
alice service install --host <tailnet IP>
```

Then add `ALICE_ALLOWED_HOSTS=mochi,mochi.tailnet.ts.net` to `~/.config/alice/alice.env` and run `alice service restart`.

`ALICE_HOST` is the bind address (prefer the tailnet IP). `ALICE_ALLOWED_HOSTS` lists extra hostnames, without ports, accepted in `Host` and `Origin`. From another machine, `ALICE_URL=mochi ALICE_ALLOW_REMOTE=1 alice ...` reaches it. Like the desktop and iOS apps, an address without a scheme tries HTTPS, then HTTP, and one without a port uses 4317. Repository paths and merges are on the server's disk.

### HTTPS on a tailnet

Browsers only allow notifications, service workers and installing the page as an app on HTTPS or localhost, so a server reached at `http://<tailnet IP>:4317` can't use them. `tailscale serve` adds HTTPS with the tailnet's own certificate, reachable only from the tailnet:

```sh
tailscale serve --bg --https=443 http://<tailnet IP>:4317
```

Then open `https://<machine>.<tailnet>.ts.net`. Add that name to `ALICE_ALLOWED_HOSTS`; Alice accepts HTTPS origins for allowed hosts, so nothing else changes. Serve on a port Alice isn't using: when `ALICE_HOST` is the tailnet IP, `--https=4317` collides with Alice's own listener on that IP and the TLS handshake fails. `tailscale serve status` lists what is served, and `tailscale serve --https=443 off` removes it. The plain HTTP address keeps working for the CLI and the apps.

**Logs** in the sidebar (`g l`) shows the server's own console output: warnings, errors, and a debug line for each API request that fails. It keeps the last 2,000 lines in memory and starts empty after a restart. For older output, read the service manager's log, for example `journalctl --user -u alice`.

### Running as a service

`alice service install` runs this checkout in the background: a systemd user service on Linux, or a launchd agent on macOS. It starts at login, restarts after a crash, and checks for updates every 2 minutes. It builds the UI first if `dist/` is missing.

- Settings go in `~/.config/alice/alice.env`. Install creates the file once with `ALICE_SERVE_UI=1` and `ALICE_HOST` (`--host`, default `127.0.0.1`) and never overwrites.
- `alice service restart` applies a changed env file. It waits for active runs to finish, as an update does.
- `status` and `logs` show the server's state and its last 200 log lines. `stop` and `uninstall` end active runs at once, so they need `--yes`. Uninstall keeps the env file and the data directory.
- On Linux the service starts at login. To start it at boot and keep it running after logout, run `loginctl enable-linger`; install says so when it is off.
- The unit records where node, npm, `pi`, `wt`, `gh` and git are. After moving any of them, run install again. `alice doctor` fails while the recorded npm is missing.
- Install rewrites `~/.config/systemd/user/alice.service`. Keep your own changes in drop-ins under `alice.service.d/`.
- Windows has no `service` command yet. Start `npm start` from Task Scheduler at logon instead.

### Keeping a hosted server up to date

`npm start` has no file watcher. The service's update check runs `scripts/update.sh` every 2 minutes, which only fetches `origin/main`.

When the fetch brings new commits, a notice in the bottom-left corner says how many and opens their subjects as a changelog. **Update and restart** runs `scripts/update.sh install` (fast-forward `main`, `npm install`, build the UI into `dist-next`). The server then refuses new runs, pauses pickup, waits for active runs and the agent review to finish, and exits. Until then it keeps serving the UI that matches its own API; the restarted server moves `dist-next` over `dist`. When every pending change is UI-only (under `src/`, `public/` or `index.html`, outside the modules the server imports, plus tests and docs), the server installs them by itself within 30 seconds of the fetch (the button reads **Update interface** if you get there first): it swaps the new build over `dist` at once without draining or restarting, keeps the old build's chunks so open pages still work, and open pages offer **Reload**. Updates that need a restart install only when you ask. Run it under a service manager that restarts it, such as a systemd user unit with `Restart=always`. A server under `npm run dev` never updates itself.

## Safety

- Pi is told not to commit, push, or publish during a run. **That instruction isn't a sandbox.** Only run agents on repositories you trust.
- The unattended reviewer runs builds and tests with your permissions.
- Alice sets `IMPRESSION_SESSION` on every Pi process it starts. Card runs get `read`: [Impression](https://github.com/aglowinthefield/impression), if installed, gives them memories but never uploads their transcripts. Reviewers, PR drafts and chat topics get `off`, so a reviewer judges from the card, the diff and the repository alone. Chats and card discussions run Pi as you would.
- Every run, retry, pickup, and review can spend model tokens. Alice records the tokens and cost Pi reports, but only a daily cost budget stops automatic pickup. Nothing stops a run that is already going.

## Development

```sh
npm test
npm run build          # runs format:check, tsrs, and vite build
npm run format         # fixes formatting in the covered frontend files
```

The formatter check covers the board, card details, review, attempts, usage, API, and model modules. It doesn't cover server or test files yet.

Tests use a fake offline `pi` and temporary Git repositories. They don't call a model or touch repositories you've added to Alice.

### Next

- Read-only Linear import into local cards, keyed by issue ID. Alice won't write to Linear.
- Better process identity checks for interrupted runs, beyond PID liveness.
- External CI before approval and automatic card creation.

## Releasing

From a clean checkout of `main`, run `npm run release -- 0.2.0`. It sets that version in `package.json`, `package-lock.json`, `src-tauri/tauri.conf.json`, `src-tauri/Cargo.toml` and `src-tauri/Cargo.lock`, adds a `CHANGELOG.md` section from the merge commit subjects since the last `v*` tag, commits, and creates the tag `v0.2.0`. It doesn't push.

Review the commit, then `git push origin main v0.2.0`. Pushing the tag runs `.github/workflows/release.yml`, which creates a GitHub release using that changelog section as its notes.

## Colleagues prototype (fixture data)

A clickable, fixture-backed prototype of persistent colleagues and group rooms, built from the draft spec in PR #13 for operator review. It is not the feature. It calls no Alice API, starts no agent, creates no card, writes no memory, and keeps all state in the browser tab (the Reset button restores the fixtures). It is a separate page that is not part of the production build or the board.

```sh
npm run prototype:colleagues
```

Open http://127.0.0.1:5180/prototype-colleagues.html. The code lives in `src/prototype/colleagues/`. Simulated rounds advance only when you click Advance fixture round. The Prototype assumptions page in the app lists the spec choices the prototype made to stay clickable.
