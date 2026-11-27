import { useState } from "react";
import { ChevronDown, GitMerge, X } from "lucide-react";
import { Button } from "./components/ui/button";
import { unionMergeLine } from "./gitattributes.js";
import { conflictHotspotDays, type ConflictHotspot } from "./model.js";

/** Notices shown before the rest fold behind "Show more". */
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
  const [expanded, setExpanded] = useState(false);
  if (!hotspots.length) return null;
  const hidden = expanded ? 0 : hotspots.length - shown;
  return (
    <div className="mx-6 mt-5 grid gap-2 lg:mx-10">
      {hotspots.slice(0, hidden > 0 ? shown : undefined).map((hotspot) => (
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
            <ul className="mt-1 list-disc pl-5 text-foreground">
              <li>
                If cards only append to it, set{" "}
                <code className="font-mono">merge=union</code> for it with this
                line in <code className="font-mono">.gitattributes</code>:
                <code className="block whitespace-pre-wrap break-all font-mono">
                  {unionMergeLine(hotspot.file)}
                </code>
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
        <Button
          size="sm"
          variant="ghost"
          className="justify-self-start"
          onClick={() => setExpanded(true)}
        >
          <ChevronDown size={14} />
          Show {hidden} more {hidden === 1 ? "file" : "files"}
        </Button>
      )}
    </div>
  );
}
