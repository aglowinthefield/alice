import { useState, type FormEvent, type ReactNode } from "react";
import { Eye } from "lucide-react";
import { Badge } from "./components/ui/badge";
import { Button } from "./components/ui/button";
import { ListRow } from "./components/ui/card";
import {
  Bubble,
  Display,
  EmptyState,
  Figure,
  SmallPrint,
} from "./components/ui/drawn";
import { Input, Select } from "./components/ui/input";
import { Circled } from "./components/ui/pen-mark";
import { cn } from "./lib/utils";
import { date } from "./api.js";
import { formatCost } from "./usage.js";
import { repoName } from "./repo-appearance.js";
import {
  needsYouLabels,
  reviewOrder,
  reviewWaitText,
  statusTone,
  todaySections,
  type Board,
  type Card,
} from "./model.js";
import {
  defaultStaleReviewDays,
  isStaleReview,
  reviewAgeDays,
} from "./stale-review.js";
import aliceLine from "./alice-line.png";

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
  onCapture: (board: Board, title: string) => Promise<boolean>;
};

// Alice and her bubble stand to the right once the page is wide enough that they cover nothing; the column leaves them room.
const wide = "@min-[64rem]:block";
const column =
  "relative z-10 w-full max-w-[640px] @min-[64rem]:w-[min(640px,calc(100%-300px))]";

/** A card's short name for Alice to say: its leading ID (SIL-912, gh-6638/t1) or its quoted title. */
const shortName = (card: Card) =>
  /^[A-Za-z]+-\d+(\/t\d+)?(?=[:\s]|$)/.exec(card.title)?.[0] ??
  `“${card.title.length > 40 ? `${card.title.slice(0, 39)}…` : card.title}”`;

const days = (count: number) => `${count} ${count === 1 ? "day" : "days"}`;

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
  const today = new Date();
  const oldest = stale[0];
  return (
    <div className="@container relative min-h-[calc(100vh_-_var(--titlebar-h))] overflow-hidden px-6 py-10 lg:pl-14">
      <Figure
        src={aliceLine}
        label="Alice"
        fade={["left"]}
        className={cn(
          "absolute top-8 -right-24 hidden h-[840px] w-[500px]",
          wide,
        )}
      />
      <SmallPrint>
        {today.toLocaleDateString("en", { weekday: "short" })}{" "}
        {today.toLocaleDateString("en-CA")}
      </SmallPrint>
      <Display className="mt-2">Today</Display>
      <p
        role="status"
        aria-label="Since your last visit"
        className="small-print mt-3 flex flex-wrap gap-x-6 gap-y-1 text-ink-muted"
      >
        <span>
          <b className="text-ink">{finished.length}</b> merged
        </span>
        <span>
          <b className="text-ink">{attention.length}</b> need you
        </span>
        <span>
          <b className="text-ink">{formatCost(spent)}</b> last 24h
        </span>
      </p>
      {oldest && (
        <Bubble
          className={cn("absolute top-10 right-[300px] hidden w-[330px]", wide)}
        >
          {shortName(oldest)} has waited {days(reviewAgeDays(oldest) ?? 0)}.
          <br />
          Approve it, or close it?
        </Bubble>
      )}
      <Capture boards={boards} onCapture={onCapture} />
      {stale.length > 0 && (
        <Section title="Stale in review" count={stale.length}>
          <ul className="bg-paper">
            {stale.map((card, index) => (
              <StaleRow
                key={card.id}
                card={card}
                oldest={index === 0}
                threshold={
                  boards.find((item) => item.repo === card.repo)
                    ?.staleReviewDays ?? defaultStaleReviewDays
                }
                onOpen={onOpen}
                onApprove={onApprove}
                onRunAgain={onRunAgain}
                onClose={onClose}
              />
            ))}
          </ul>
        </Section>
      )}
      <Section title="Needs you" count={attention.length}>
        {reviews > 0 && (
          <Button className="mt-2 mb-1" onClick={onReview}>
            <Eye aria-hidden /> Review {reviews}{" "}
            {reviews === 1 ? "card" : "cards"}
          </Button>
        )}
        {attention.length === 0 && (
          <EmptyState mark="tick">Nothing needs you.</EmptyState>
        )}
        <CardList
          cards={attention}
          onOpen={onOpen}
          label={(card) => needsYouLabels[card.status] ?? card.status}
        />
      </Section>
      {approved.length > 0 && (
        <Section title="Agent approved" count={approved.length}>
          <CardList cards={approved} onOpen={onOpen} label={() => "Approve"} />
        </Section>
      )}
      {running.length > 0 && (
        <Section title="In progress" count={running.length}>
          <CardList
            cards={running}
            onOpen={onOpen}
            label={(card) =>
              card.reviewWait ? reviewWaitText(card) : "Started"
            }
          />
        </Section>
      )}
      {finished.length > 0 && (
        <Section title="Finished since your last visit" count={finished.length}>
          <CardList cards={finished} onOpen={onOpen} label={() => "Done"} />
        </Section>
      )}
    </div>
  );
}

/** A small-print heading ruled across to its tally. */
function Section({
  title,
  count,
  children,
}: {
  title: string;
  count: number;
  children: ReactNode;
}) {
  const id = `today-${title.toLowerCase().replace(/\W+/g, "-")}`;
  return (
    <section aria-labelledby={id} className={cn(column, "mt-9")}>
      <div className="small-print mb-1 flex items-center gap-3">
        <h2 id={id}>{title}</h2>
        <i aria-hidden="true" className="flex-1 border-t border-ink" />
        <span>{count}</span>
      </div>
      {children}
    </section>
  );
}

/** The row's title opens the card. */
function OpenTitle({ card, onOpen }: { card: Card; onOpen: Props["onOpen"] }) {
  return (
    <button
      onClick={() => onOpen(card)}
      className="cursor-pointer text-left hover:underline"
    >
      {card.title}
    </button>
  );
}

function CardList({
  cards,
  onOpen,
  label,
}: {
  cards: Card[];
  onOpen: Props["onOpen"];
  label: (card: Card) => string;
}) {
  if (!cards.length) return null;
  return (
    <ul className="bg-paper">
      {cards.map((card) => (
        <li key={card.id}>
          <ListRow
            title={<OpenTitle card={card} onOpen={onOpen} />}
            meta={
              <span className="flex flex-wrap items-center gap-x-1.5">
                {repoName(card.repo)} ·
                <Badge
                  tone={statusTone[card.status]}
                  hollow={card.status === "running"}
                >
                  {label(card)}
                </Badge>
                {date(card.updatedAt)}
              </span>
            }
          />
        </li>
      ))}
    </ul>
  );
}

function StaleRow({
  card,
  oldest,
  threshold,
  onOpen,
  onApprove,
  onRunAgain,
  onClose,
}: {
  card: Card;
  /** The oldest card gets the pen circle round its age; Alice's bubble names it. */
  oldest: boolean;
  threshold: number;
} & Pick<Props, "onOpen" | "onApprove" | "onRunAgain" | "onClose">) {
  const age = reviewAgeDays(card) ?? 0;
  // Approve and a new run wait while an agent, CI or GitHub still has the card; Close never does.
  const waiting = card.reviewWait ? reviewWaitText(card) : "";
  return (
    <li>
      <ListRow
        // A pen star marks a card twice past its board's stale threshold.
        starred={age >= threshold * 2}
        title={<OpenTitle card={card} onOpen={onOpen} />}
        meta={
          <>
            {repoName(card.repo)} ·{" "}
            <Circled on={oldest}>
              <b className="text-ink">{age}d</b>
            </Circled>{" "}
            in review{waiting && ` · ${waiting}`}
          </>
        }
        actions={
          <>
            <Button
              variant="row"
              size="sm"
              disabled={!!waiting}
              title={waiting || "Open the review to approve it"}
              onClick={() => onApprove(card)}
            >
              Approve
            </Button>
            <Button
              size="sm"
              disabled={!!waiting}
              title={
                waiting ||
                "Start a run that brings the work up to date with main first"
              }
              onClick={() => onRunAgain(card)}
            >
              Run again on current main
            </Button>
            <Button
              variant="text"
              size="sm"
              title="Close without merging"
              onClick={() => onClose(card)}
            >
              Close
            </Button>
          </>
        }
      />
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
    <form onSubmit={submit} className={cn(column, "mt-7")}>
      <div className="flex gap-2">
        <Input
          aria-label="Capture a card"
          placeholder="What needs doing?"
          value={title}
          onChange={(event) => {
            setTitle(event.target.value);
            setAdded("");
          }}
        />
        <Select
          aria-label="Repository"
          value={board.id}
          onChange={(event) => {
            setBoardId(event.target.value);
            localStorage.setItem(captureKey, event.target.value);
          }}
          className="w-40 shrink-0"
        >
          {boards.map((item) => (
            <option key={item.id} value={item.id}>
              {repoName(item.repo)}
            </option>
          ))}
        </Select>
        <Button variant="main" type="submit" disabled={!title.trim()}>
          Add
        </Button>
      </div>
      <p
        role="status"
        className="absolute top-full left-0 mt-1 text-xs text-ink-muted"
      >
        {added}
      </p>
    </form>
  );
}
