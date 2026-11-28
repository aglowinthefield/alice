import type * as React from "react";
import { cn } from "@/lib/utils";
import { PenMark } from "@/components/ui/pen-mark";
import type { Tone } from "@/components/ui/badge";

// @house/card: vendored from https://aglowinthefield.github.io/house. Change it there, then re-run shadcn add.

const stripe: Record<Tone, string> = {
  neutral: "border-l-status-neutral",
  attention: "border-l-status-attention",
  info: "border-l-status-info",
  success: "border-l-status-success",
  danger: "border-l-status-danger",
  warning: "border-l-status-warning",
  other: "border-l-status-other",
};

/** Content on a raised surface. A tone adds a status stripe on the left. Cards never hold cards. */
export function Card({ tone, className, ...props }: { tone?: Tone } & React.ComponentProps<"div">) {
  return <div data-slot="card" className={cn("rounded-house border border-ink bg-raised px-3 py-2.5", tone && ["border-l-[3px]", stripe[tone]], className)} {...props} />;
}

/** A dense list row: title, small-print meta, actions. `starred` puts a pen star in the gutter for items that need you. */
export function ListRow({ title, meta, actions, starred = false, className }: { title: React.ReactNode; meta?: React.ReactNode; actions?: React.ReactNode; starred?: boolean; className?: string }) {
  return (
    <div data-slot="list-row" className={cn("relative border-b border-hairline py-2.5", className)}>
      {starred && <PenMark mark="star" className="absolute top-3 -left-6 size-4" />}
      <div className="text-sm leading-snug font-medium">{title}</div>
      {meta && <div className="small-print mt-1 text-ink-muted">{meta}</div>}
      {actions && <div className="mt-2 flex items-center gap-2">{actions}</div>}
    </div>
  );
}
