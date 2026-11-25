import { useState, type FormEvent, type ReactNode } from "react";
import { CalendarClock, Check, RotateCcw, X, Eye } from "lucide-react";
import { Button } from "./components/ui/button";
import { date } from "./api.js";
import { formatCost } from "./usage.js";
import { RepoBadge } from "./repo-badge.js";
import { repoName } from "./repo-appearance.js";
import {
  agentApproved,
  needsYourReview,
  reviewWaitText,
  type Board,
  type Card,
  type Status,
} from "./model.js";
import { isSentinelJob } from "./sentinels.js";
import {
  defaultStaleReviewDays,
  isStaleReview,
  reviewAgeDays,
} from "./stale-review.js";

// What each status asks of you. Statuses not listed (Triage, Ready, Archived) stay on their boards.
const needsYou: Partial<Record<Status, string>> = {
  review: "Review",
  failed: "Failed",
  interrupted: "Interrupted",
};
export const needsYouStatuses = Object.keys(needsYou) as Status[];
const oldestFirst = (a: Card, b: Card) =>
  a.updatedAt.localeCompare(b.updatedAt);

/**
 * Review cards in the order the queue walks them: the longest-waiting first. Cards an agent, CI or GitHub
 * still has are left out until they need you.
 */
export const reviewOrder = (cards: Card[]) =>
  cards.filter(needsYourReview).sort(oldestFirst);

/** Review cards past their board's stale threshold, oldest first: what the daily push digest lists. */
export const staleReviewCards = (
  cards: Card[],
  boards: Board[],
  now = Date.now(),
) =>
  cards
    .filter((card) => {
      const board = boards.find((item) => item.repo === card.repo);
      return (
        !!board &&
        !isSentinelJob(card) &&
        isStaleReview(
          card,
          board.staleReviewDays ?? defaultStaleReviewDays,
          now,
        )
      );
    })
    .sort((a, b) => (a.reviewSince ?? "").localeCompare(b.reviewSince ?? ""));

type Props = {
  boards: Board[];
  cards: Card[];
  /** When you last opened Bakery. Cards finished after it count as new. */
  since: string;
  onOpen: (card: Card) => void;
  onReview: () => void;
  /** Opens the card's review, where Approve is. */
  onApprove: (card: Card) => void;
  /** Starts a run that first brings the card's work up to date with main. */
  onRunAgain: (card: Card) => void;
  onClose: (card: Card) => void;
  onCapture: (board: Board, title: string) => Promise<boolean>;
};

export function Today({
  boards,
  cards,
  since,
  onOpen,
  onReview,
  onApprove,
  onRunAgain,
  onClose,
  onCapture,
}: Props) {
  const stale = staleReviewCards(cards, boards);
  const attention = cards
    .filter(
      (card) =>
        card.status in needsYou &&
        (card.status !== "review" ||
          (needsYourReview(card) && !agentApproved(card))),
    )
    .sort(
      (a, b) =>
        needsYouStatuses.indexOf(a.status) -
          needsYouStatuses.indexOf(b.status) || oldestFirst(a, b),
    );
  // Approved by the agent reviewer: only your Approve is left, so they stay out of "Needs you".
  const approved = cards.filter(agentApproved).sort(oldestFirst);
  const running = cards.filter(
    (card) =>
      card.status === "running" ||
      (card.status === "review" && card.reviewWait),
  );
  const finished = cards
    .filter((card) => card.status === "done" && card.updatedAt > since)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const reviews = reviewOrder(cards).length;
  const spent = boards.reduce((sum, board) => sum + (board.cost24h ?? 0), 0);
  return (
    <div className="mx-auto max-w-3xl px-6 py-10 lg:px-10">
      <div className="mb-2 text-sm text-muted-foreground">
        {new Date().toLocaleDateString([], {
          weekday: "long",
          month: "long",
          day: "numeric",
        })}
      </div>
      <h1 className="text-[27px] font-semibold tracking-[-.05em]">Today</h1>
      <p
        role="status"
        aria-label="Since your last visit"
        className="mt-1 text-sm text-muted-foreground"
      >
        {finished.length} merged · {attention.length} need you ·{" "}
        {formatCost(spent)} in the last 24h
      </p>
      <Capture boards={boards} onCapture={onCapture} />
      {stale.length > 0 && (
        <Section title="Stale in Review">
          <ul className="divide-y divide-border rounded-xl border border-border bg-card">
            {stale.map((card) => (
              <StaleRow
                key={card.id}
                card={card}
                board={boards.find((item) => item.repo === card.repo)}
                onOpen={onOpen}
                onApprove={onApprove}
                onRunAgain={onRunAgain}
                onClose={onClose}
              />
            ))}
          </ul>
        </Section>
      )}
      <Section title="Needs you">
        {attention.length === 0 && (
          <p className="text-sm text-muted-foreground">
            All caught up. Nothing needs you.
          </p>
        )}
        {reviews > 0 && (
          <Button className="mb-3" onClick={onReview}>
            <Eye size={15} /> Review {reviews}{" "}
            {reviews === 1 ? "card" : "cards"}
          </Button>
        )}
        <CardList
          cards={attention}
          boards={boards}
          onOpen={onOpen}
          label={(card) => needsYou[card.status] ?? card.status}
        />
      </Section>
      {approved.length > 0 && (
        <Section title="Agent approved">
          <CardList
            cards={approved}
            boards={boards}
            onOpen={onOpen}
            label={() => "Approve"}
          />
        </Section>
      )}
      {running.length > 0 && (
        <Section title="In progress">
          <CardList
            cards={running}
            boards={boards}
            onOpen={onOpen}
            label={(card) =>
              card.reviewWait ? reviewWaitText(card) : "Started"
            }
          />
        </Section>
      )}
      {finished.length > 0 && (
        <Section title="Finished since your last visit">
          <CardList
            cards={finished}
            boards={boards}
            onOpen={onOpen}
            label={() => "Done"}
          />
        </Section>
      )}
    </div>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  const id = `today-${title.toLowerCase().replace(/\W+/g, "-")}`;
  return (
    <section aria-labelledby={id} className="mt-10">
      <h2 id={id} className="mb-3 text-sm font-semibold text-muted-foreground">
        {title}
      </h2>
      {children}
    </section>
  );
}

function CardList({
  cards,
  boards,
  onOpen,
  label,
}: {
  cards: Card[];
  boards: Board[];
  onOpen: (card: Card) => void;
  label: (card: Card) => string;
}) {
  if (!cards.length) return null;
  return (
    <ul className="divide-y divide-border rounded-xl border border-border bg-card">
      {cards.map((card) => {
        const board = boards.find((item) => item.repo === card.repo);
        return (
          <li key={card.id}>
            <button
              onClick={() => onOpen(card)}
              className="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-accent/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              {board && <RepoBadge board={board} size={14} />}
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium">
                  {card.title}
                </span>
                <span className="block truncate text-xs text-muted-foreground">
                  {repoName(card.repo)} · {label(card)} {date(card.updatedAt)}
                </span>
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

function StaleRow({
  card,
  board,
  onOpen,
  onApprove,
  onRunAgain,
  onClose,
}: {
  card: Card;
  board: Board | undefined;
} & Pick<Props, "onOpen" | "onApprove" | "onRunAgain" | "onClose">) {
  const days = reviewAgeDays(card) ?? 0;
  // Approve and a new run wait while an agent, CI or GitHub still has the card; Close never does.
  const waiting = card.reviewWait ? reviewWaitText(card) : "";
  return (
    <li className="flex items-start gap-3 px-4 py-3">
      {board && <RepoBadge board={board} size={14} />}
      <div className="min-w-0 flex-1">
        <button
          onClick={() => onOpen(card)}
          className="block w-full min-w-0 rounded text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <span className="block truncate text-sm font-medium">
            {card.title}
          </span>
          <span className="flex items-center gap-1 truncate text-xs text-muted-foreground">
            <CalendarClock
              size={11}
              className="shrink-0 text-status-interrupted"
              aria-hidden
            />
            {repoName(card.repo)} · {days} {days === 1 ? "day" : "days"} in
            Review{waiting && ` · ${waiting}`}
          </span>
        </button>
        <span className="mt-2 flex flex-wrap gap-1.5">
          <Button
            size="sm"
            variant="outline"
            disabled={!!waiting}
            title={waiting || "Open the review to approve it"}
            onClick={() => onApprove(card)}
          >
            <Check size={13} aria-hidden /> Approve
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={!!waiting}
            title={
              waiting ||
              "Start a run that brings the work up to date with main first"
            }
            onClick={() => onRunAgain(card)}
          >
            <RotateCcw size={13} aria-hidden /> Run again on current main
          </Button>
          <Button
            size="sm"
            variant="ghost"
            title="Close without merging"
            onClick={() => onClose(card)}
          >
            <X size={13} aria-hidden /> Close
          </Button>
        </span>
      </div>
    </li>
  );
}

const captureKey = "bakery-capture-board";

function Capture({
  boards,
  onCapture,
}: {
  boards: Board[];
  onCapture: Props["onCapture"];
}) {
  const [title, setTitle] = useState("");
  const [boardId, setBoardId] = useState(
    () => localStorage.getItem(captureKey) ?? "",
  );
  const [added, setAdded] = useState("");
  const board =
    boards.find((item) => item.id === boardId) ?? boards[0] ?? undefined;
  if (!board) return null;
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!title.trim()) return;
    if (!(await onCapture(board, title.trim()))) return;
    setTitle("");
    setAdded(`Added to ${repoName(board.repo)} Triage`);
  };
  return (
    <form onSubmit={submit} className="mt-8">
      <div className="flex gap-2">
        <input
          aria-label="Capture a card"
          placeholder="What needs doing?"
          value={title}
          onChange={(event) => {
            setTitle(event.target.value);
            setAdded("");
          }}
          className="h-9 min-w-0 flex-1 rounded-md border border-input bg-background px-3 text-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        />
        <select
          aria-label="Repository"
          value={board.id}
          onChange={(event) => {
            setBoardId(event.target.value);
            localStorage.setItem(captureKey, event.target.value);
          }}
          className="h-9 rounded-md border border-input bg-background px-2 text-sm text-foreground"
        >
          {boards.map((item) => (
            <option key={item.id} value={item.id}>
              {repoName(item.repo)}
            </option>
          ))}
        </select>
        <Button type="submit" disabled={!title.trim()}>
          Add
        </Button>
      </div>
      <p role="status" className="mt-2 min-h-4 text-xs text-muted-foreground">
        {added}
      </p>
    </form>
  );
}
