import type * as React from "react";
import { cn } from "@/lib/utils";
import { PenMark, type Mark } from "@/components/ui/pen-mark";

// @house/drawn: vendored from https://aglowinthefield.github.io/house. Change it there, then re-run shadcn add.

/** The one display title per page, over small print. */
export function Display({ className, ...props }: React.ComponentProps<"h1">) {
  return <h1 data-slot="display" className={cn("m-0 font-display text-[76px] leading-none font-normal tracking-[-0.02em]", className)} {...props} />;
}

export function SmallPrint({ className, ...props }: React.ComponentProps<"span">) {
  return <span data-slot="small-print" className={cn("small-print text-ink-muted", className)} {...props} />;
}

type Edge = "left" | "right" | "top" | "bottom";

/**
 * A character drawn in line, from a line-art image whose lines are opaque and background transparent.
 * The lines take the ink colour, so they invert with the mode. Fade the edges the page crops.
 */
export function Figure({ src, label, fade = [], className, style }: { src: string; label: string; fade?: Edge[]; className?: string; style?: React.CSSProperties }) {
  const layers = [`url("${src}") center / contain no-repeat`, ...fade.map((e) => `linear-gradient(to ${opposite[e]}, transparent, #000 30%)`)];
  return (
    <div
      role="img"
      aria-label={label}
      data-slot="figure"
      className={cn("pointer-events-none bg-ink opacity-85", className)}
      style={{ mask: layers.join(", "), maskComposite: "intersect", WebkitMask: layers.join(", "), WebkitMaskComposite: "source-in", ...style }}
    />
  );
}
const opposite: Record<Edge, Edge> = { left: "right", right: "left", top: "bottom", bottom: "top" };

/** The app speaking, in pen. One bubble per view, saying the most useful thing on the page. */
export function Bubble({ tail = "right", className, children }: { tail?: "left" | "right" | "down"; className?: string; children: React.ReactNode }) {
  const tailPos = { right: "-right-8 top-1/2 rotate-[50deg]", left: "-left-8 top-1/2 -scale-x-100 -rotate-[50deg]", down: "-bottom-6 left-8 h-6 w-9 rotate-[110deg]" }[tail];
  return (
    <div data-slot="bubble" className={cn("relative -rotate-2 border-2 border-pen bg-paper px-6 py-4 font-pen text-[15px] leading-normal text-pen", className)} style={{ borderRadius: "46% 54% 50% 50% / 55% 50% 50% 45%" }}>
      {children}
      <svg aria-hidden="true" viewBox="0 0 50 34" className={cn("absolute h-8.5 w-12.5", tailPos)}>
        <path d="M2 4 C 18 8, 32 14, 48 26 C 34 22, 18 24, 2 28" className="fill-paper stroke-pen" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </div>
  );
}

/** One pen mark, one line in the pen hand, one action. */
export function EmptyState({ mark = "star", action, className, children }: { mark?: Mark; action?: React.ReactNode; className?: string; children: React.ReactNode }) {
  return (
    <div data-slot="empty-state" className={cn("flex flex-col items-center gap-2 py-3 text-center", className)}>
      <PenMark mark={mark} className="size-11" />
      <p className="m-0 font-pen text-lg text-pen">{children}</p>
      {action}
    </div>
  );
}
