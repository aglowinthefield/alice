import { useEffect, useState } from "react";
import { TriangleAlert } from "lucide-react";
import { planningCard, readyFlags, type ReadyFlag } from "./card-lint.js";
import { api } from "./api.js";
import { Button } from "./components/ui/button.js";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "./components/ui/dialog.js";
import type { Card } from "./model.js";

/**
 * What the person chose: move anyway, edit the (first flagged) card, turn the wide cards into planning cards and then
 * move everything, or close the dialog and move nothing.
 */
export type ReadyChoice =
  | { choice: "ready" }
  | { choice: "edit"; card: Card }
  | { choice: "plan"; cards: Card[] }
  | { choice: "cancel" };

/**
 * Rewrites each card to ask for a plan instead of code (see planningCard). Its run then ends with a alice-plan block,
 * which Alice turns into small cards once you accept it. Call it before moving the cards to Ready.
 */
export async function turnIntoPlans(boardId: string, cards: Card[]) {
  for (const card of cards)
    await api(`/boards/${boardId}/cards/${card.id}`, {
      method: "PATCH",
      body: JSON.stringify(planningCard(card)),
    });
}

type Flagged = { card: Card; flags: ReadyFlag[] };
type Ask = {
  flagged: Flagged[];
  total: number;
  resolve: (choice: ReadyChoice) => void;
};
let listener: ((ask: Ask) => void) | undefined;

/**
 * Runs the card text checks (see card-lint.ts) on cards about to move to Ready. Nothing flagged resolves to "ready"
 * at once; otherwise the dialog lists the flags with Edit and Ready anyway, so a move takes one more click.
 */
export function checkBeforeReady(cards: Card[]): Promise<ReadyChoice> {
  const flagged = cards
    .map((card) => ({ card, flags: readyFlags(card) }))
    .filter((item) => item.flags.length > 0);
  if (flagged.length === 0 || !listener)
    return Promise.resolve({ choice: "ready" });
  return new Promise((resolve) =>
    listener?.({ flagged, total: cards.length, resolve }),
  );
}

/** Mount once near the root; it shows the dialog that checkBeforeReady opens. */
export function ReadyCheckHost() {
  const [ask, setAsk] = useState<Ask | null>(null);
  // The last ask stays rendered while the dialog animates closed.
  const [open, setOpen] = useState(false);
  useEffect(() => {
    listener = (next) => {
      setAsk(next);
      setOpen(true);
    };
    return () => {
      listener = undefined;
    };
  }, []);
  const answer = (choice: ReadyChoice) => {
    if (!open) return;
    ask?.resolve(choice);
    setOpen(false);
  };
  const several = (ask?.total ?? 0) > 1;
  const wide =
    ask?.flagged
      .filter(({ flags }) => flags.some((flag) => flag.rule === "wide"))
      .map(({ card }) => card) ?? [];
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => !next && answer({ choice: "cancel" })}
    >
      <DialogContent className="w-[min(92vw,520px)]">
        <DialogTitle className="text-base font-semibold">
          {several
            ? `${ask?.flagged.length} of ${ask?.total} cards may need another pass`
            : "This card may need another pass"}
        </DialogTitle>
        <DialogDescription className="mt-2 text-sm text-muted-foreground">
          Reviewers often send cards like {several ? "these" : "this"} back.
          Edit {several ? "the first one" : "it"} now, or move{" "}
          {several ? "them" : "it"} to Ready anyway.
          {wide.length > 0 &&
            ` Turn into a plan rewrites ${several ? (wide.length > 1 ? `the ${wide.length} wide cards` : "the wide card") : "it"} to ask for a breakdown instead of code. The run proposes small cards for you to review.`}
        </DialogDescription>
        <div
          className="mt-4 max-h-[50vh] space-y-3 overflow-y-auto"
          data-testid="ready-flags"
        >
          {ask?.flagged.map(({ card, flags }) => (
            <div key={card.id}>
              {several && (
                <p className="mb-1 truncate text-sm font-medium">
                  {card.title}
                </p>
              )}
              <ul className="space-y-1.5">
                {flags.map((flag) => (
                  <li key={flag.message} className="flex gap-2 text-sm">
                    <TriangleAlert
                      aria-hidden
                      className="mt-0.5 size-4 shrink-0 text-status-interrupted"
                    />
                    <span>
                      {flag.message}
                      {flag.quote && (
                        <span className="mt-0.5 block text-xs text-muted-foreground">
                          “{flag.quote}”
                        </span>
                      )}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
        <div className="mt-5 flex justify-end gap-2">
          <Button
            variant="outline"
            autoFocus
            onClick={() =>
              ask && answer({ choice: "edit", card: ask.flagged[0].card })
            }
          >
            Edit
          </Button>
          {wide.length > 0 && (
            <Button
              variant="outline"
              onClick={() => answer({ choice: "plan", cards: wide })}
            >
              Turn into a plan
            </Button>
          )}
          <Button onClick={() => answer({ choice: "ready" })}>
            Ready anyway
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
