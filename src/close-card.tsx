import { useState } from "react";
import { Button } from "./components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "./components/ui/dialog";

/** Mirrors `closeReasons` in server/board.ts. */
export const closeReasonLabels = {
  duplicate: "Duplicate",
  "wrong-approach": "Wrong approach",
  "not-needed": "Not needed",
  superseded: "Superseded",
  other: "Other",
} as const;
export type CloseReason = keyof typeof closeReasonLabels;
export type CloseChoice = { reason?: CloseReason; note?: string };

/**
 * Close without merging. One click on a reason closes the card; Other asks for a note first. The reason is optional,
 * so "Close without a reason" closes it too.
 */
export function CloseCardDialog({
  open,
  busy,
  onOpenChange,
  onClose,
}: {
  open: boolean;
  busy: boolean;
  onOpenChange: (open: boolean) => void;
  onClose: (choice: CloseChoice) => void;
}) {
  const [other, setOther] = useState(false);
  const [note, setNote] = useState("");
  // Each time the dialog closes, the next one starts with no note.
  const finish = (next: () => void) => {
    setOther(false);
    setNote("");
    next();
  };
  const reasons = Object.entries(closeReasonLabels) as [CloseReason, string][];
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => finish(() => onOpenChange(next))}
    >
      <DialogContent
        className="w-[min(92vw,560px)]"
        data-testid="close-card-dialog"
      >
        <DialogTitle className="text-base font-semibold">
          Close without merging?
        </DialogTitle>
        <DialogDescription className="mt-2 text-sm text-muted-foreground">
          Its worktree and branch stay, and Reopen brings it back. Why are you
          closing it?
        </DialogDescription>
        <div
          className="mt-4 flex flex-wrap gap-2"
          role="group"
          aria-label="Reason"
        >
          {reasons.map(([reason, label]) => (
            <Button
              key={reason}
              variant="outline"
              size="sm"
              disabled={busy}
              aria-pressed={reason === "other" ? other : undefined}
              className={reason === "other" && other ? "bg-accent" : undefined}
              onClick={() =>
                reason === "other"
                  ? setOther(true)
                  : finish(() => onClose({ reason }))
              }
            >
              {label}
            </Button>
          ))}
        </div>
        {other && (
          <form
            className="mt-3 flex gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              const text = note.trim() || undefined;
              finish(() => onClose({ reason: "other", note: text }));
            }}
          >
            <input
              autoFocus
              aria-label="Other reason"
              value={note}
              maxLength={500}
              disabled={busy}
              onChange={(event) => setNote(event.target.value)}
              placeholder="What happened?"
              className="min-w-0 flex-1 rounded-md border border-border bg-background px-2 py-1 text-sm text-foreground"
            />
            <Button type="submit" size="sm" disabled={busy}>
              Close card
            </Button>
          </form>
        )}
        <div className="mt-5 flex justify-end gap-2">
          <Button
            variant="outline"
            disabled={busy}
            onClick={() => finish(() => onOpenChange(false))}
          >
            Cancel
          </Button>
          <Button
            variant="ghost"
            disabled={busy}
            onClick={() => finish(() => onClose({}))}
          >
            Close without a reason
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
