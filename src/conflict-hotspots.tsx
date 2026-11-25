import { GitMerge, X } from "lucide-react";
import { Button } from "./components/ui/button";
import { conflictHotspotDays, type ConflictHotspot } from "./model.js";

/** Notices shown at once; dismissing one brings up the next. */
const shown = 3;

/**
 * Files that conflicted on several cards recently (server/board.ts `conflictHotspots`), each with the structural fixes
 * that stop the next card conflicting there. Dismissing a file hides it until it conflicts again.
 */
export function ConflictHotspots({
  hotspots,
  busy,
  onDismiss,
}: {
  hotspots: ConflictHotspot[];
  busy: boolean;
  onDismiss: (file: string) => void;
}) {
  if (!hotspots.length) return null;
  const hidden = hotspots.length - shown;
  return (
    <div className="mx-6 mt-5 grid gap-2 lg:mx-10">
      {hotspots.slice(0, shown).map((hotspot) => (
        <div
          key={hotspot.file}
          role="status"
          aria-label={`Conflict hint for ${hotspot.file}`}
          data-testid="conflict-hotspot"
          className="flex items-start gap-3 rounded-md border border-status-interrupted/40 bg-status-interrupted/10 px-4 py-3 text-sm"
        >
          <GitMerge
            size={16}
            className="mt-0.5 shrink-0 text-status-interrupted"
          />
          <div className="min-w-0 flex-1 break-words">
            <p>
              <code className="font-mono">{hotspot.file}</code> conflicted on{" "}
              {hotspot.cards} cards in the last {conflictHotspotDays} days. Fix
              it once instead of repairing each card:
            </p>
            <ul className="mt-1 list-disc pl-5 text-muted-foreground">
              <li>
                If cards only append to it, add{" "}
                <code className="font-mono">{hotspot.file} merge=union</code> to{" "}
                <code className="font-mono">.gitattributes</code>.
              </li>
              <li>
                Generate it from its sources instead of editing it in each card.
              </li>
              <li>
                Make cards that touch it depend on each other so they merge one
                at a time.
              </li>
            </ul>
          </div>
          <Button
            size="sm"
            variant="outline"
            disabled={busy}
            aria-label={`Dismiss conflict hint for ${hotspot.file}`}
            onClick={() => onDismiss(hotspot.file)}
          >
            <X size={14} />
            Dismiss
          </Button>
        </div>
      ))}
      {hidden > 0 && (
        <p className="text-xs text-muted-foreground">
          {hidden} more {hidden === 1 ? "file keeps" : "files keep"}{" "}
          conflicting.
        </p>
      )}
    </div>
  );
}
