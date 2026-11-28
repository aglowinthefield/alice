import { useRef, useState, type FormEvent, type ReactNode } from "react";
import { CalendarClock, Check, RotateCcw, X, Eye } from "lucide-react";
import { Button } from "./components/ui/button";
import { date } from "./api.js";
import { formatCost } from "./usage.js";
import { RepoBadge } from "./repo-badge.js";
import { repoName } from "./repo-appearance.js";
import {
  needsYouLabels,
  reviewOrder,
  reviewWaitText,
  todaySections,
  type Board,
  type Card,
} from "./model.js";
import {
  defaultStaleReviewDays,
  isStaleReview,
  reviewAgeDays,
} from "./stale-review.js";

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
  /** When you last opened Alice. Cards finished after it count as new. */
  since: string;
  onOpen: (card: Card) => void;
  onReview: () => void;
  /** Opens the card's review, where Approve is. */
  onApprove: (card: Card) => void;
  /** Starts a run that first brings the card's work up to date with main. */
  onRunAgain: (card: Card) => void;
  onClose: (card: Card) => void;
  /** Captured cards start in Ready unless `triage` holds them for review. Resolves to the new card, or null on failure. */
  onCapture: (
    board: Board,
    title: string,
    triage: boolean,
  ) => Promise<Card | null>;
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
  const { attention, approved, running, finished } = todaySections(
    cards,
    since,
  );
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
          label={(card) => needsYouLabels[card.status] ?? card.status}
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

const captureKey = "alice-capture-board";

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
  const [triage, setTriage] = useState(false);
  const [added, setAdded] = useState("");
  // A second Enter before the first reply would create a second card, and with pickup on a second paid run. The ref
  // blocks it at once; the state disables Add.
  const pending = useRef(false);
  const [adding, setAdding] = useState(false);
  const board =
    boards.find((item) => item.id === boardId) ?? boards[0] ?? undefined;
  if (!board) return null;
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!title.trim() || pending.current) return;
    pending.current = true;
    setAdding(true);
    const card = await onCapture(board, title.trim(), triage).finally(() => {
      pending.current = false;
      setAdding(false);
    });
    if (!card) return;
    setTitle("");
    setTriage(false);
    // The server decides the lane, so the confirmation names the one it reported.
    setAdded(
      `Added to ${repoName(board.repo)} ${card.status === "triage" ? "Triage" : "Ready"}`,
    );
  };
  return (
    <form onSubmit={submit} className="mt-8">
      {/* The title keeps at least 16rem; on a narrow screen the other controls wrap below it instead of squeezing it. */}
      <div className="flex flex-wrap items-center gap-2">
        <input
          aria-label="Capture a card"
          placeholder="What needs doing?"
          value={title}
          onChange={(event) => {
            setTitle(event.target.value);
            setAdded("");
          }}
          className="h-9 min-w-0 flex-[1_1_16rem] rounded-md border border-input bg-background px-3 text-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        />
        <select
          aria-label="Repository"
          value={board.id}
          onChange={(event) => {
            setBoardId(event.target.value);
            localStorage.setItem(captureKey, event.target.value);
          }}
          className="h-9 max-w-full min-w-0 rounded-md border border-input bg-background px-2 text-sm text-foreground"
        >
          {boards.map((item) => (
            <option key={item.id} value={item.id}>
              {repoName(item.repo)}
            </option>
          ))}
        </select>
        <label className="flex items-center gap-1.5 text-sm text-muted-foreground">
          <input
            type="checkbox"
            className="accent-primary"
            checked={triage}
            onChange={(event) => {
              setTriage(event.target.checked);
              setAdded("");
            }}
          />
          Triage
        </label>
        <Button type="submit" disabled={!title.trim() || adding}>
          Add
        </Button>
      </div>
      <p role="status" className="mt-2 min-h-4 text-xs text-muted-foreground">
        {added}
      </p>
    </form>
  );
}
