import type * as React from "react";
import { cn } from "@/lib/utils";

// @house/badge: vendored from https://aglowinthefield.github.io/house. Change it there, then re-run shadcn add.

// Status is where colour still carries meaning. Apps map their own states onto these tones.
export type Tone = "neutral" | "attention" | "info" | "success" | "danger" | "warning" | "other";

export const toneText: Record<Tone, string> = {
  neutral: "text-status-neutral",
  attention: "text-status-attention",
  info: "text-status-info",
  success: "text-status-success",
  danger: "text-status-danger",
  warning: "text-status-warning",
  other: "text-status-other",
};

/** A status dot and label in small print. `hollow` marks a state that is still moving, like running. */
export function Badge({ tone = "neutral", hollow = false, className, children, ...props }: { tone?: Tone; hollow?: boolean } & React.ComponentProps<"span">) {
  return (
    <span data-slot="badge" className={cn("small-print inline-flex items-center gap-1.5 text-ink", className)} {...props}>
      <span aria-hidden="true" className={cn("size-2 rounded-full border-[1.5px] border-current", toneText[tone], hollow ? "bg-transparent" : "bg-current")} />
      {children}
    </span>
  );
}
