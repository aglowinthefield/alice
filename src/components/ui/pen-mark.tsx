import type * as React from "react";
import { cn } from "@/lib/utils";

// @house/pen-mark: vendored from https://aglowinthefield.github.io/house. Change it there, then re-run shadcn add.

// The pen layer's vocabulary. Each mark points at something true: see house-style's illustration.md.
const marks = {
  circle: { viewBox: "0 0 200 40", stretch: true, d: "M10 22 C 8 6, 120 2, 186 10 C 200 14, 196 34, 150 36 C 90 40, 20 38, 12 26 C 8 18, 30 8, 60 6" },
  underline: { viewBox: "0 0 100 12", stretch: true, d: "M3 7 C 25 4, 50 9, 72 6 S 92 5, 97 7" },
  star: { viewBox: "0 0 20 20", stretch: false, d: "M10 1.5 L11.8 8 L18.5 8.6 L13 12.4 L15 18.6 L10 14.6 L4.8 18.4 L7 12.3 L1.6 8.4 L8.2 8 Z" },
  arrow: { viewBox: "0 0 100 50", stretch: false, d: "M6 40 C 30 10, 60 6, 90 18 M78 8 L91 18 L76 26" },
  tick: { viewBox: "0 0 20 20", stretch: false, d: "M3 11 C 5 12, 7 14, 8 16 C 10 11, 13 7, 18 3" },
  cross: { viewBox: "0 0 20 20", stretch: false, d: "M4 4 C 8 8, 12 12, 16 17 M16 3 C 12 8, 8 12, 4 16" },
  heart: { viewBox: "0 0 20 20", stretch: false, d: "M10 17 C 4 12, 2 9, 3 6 C 4 3, 8 3, 10 6 C 12 3, 16 3, 17 6 C 18 9, 16 12, 10 17 Z" },
} as const;

export type Mark = keyof typeof marks;

export function PenMark({ mark, className, ...props }: { mark: Mark } & React.SVGProps<SVGSVGElement>) {
  const m = marks[mark];
  return (
    <svg
      aria-hidden="true"
      viewBox={m.viewBox}
      preserveAspectRatio={m.stretch ? "none" : undefined}
      className={cn("text-pen", className)}
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      vectorEffect="non-scaling-stroke"
      {...props}
    >
      <path d={m.d} vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

/** Draws a pen circle around its children when `on`. */
export function Circled({ on = true, className, children }: { on?: boolean; className?: string; children: React.ReactNode }) {
  return (
    <span className={cn("relative inline-flex", className)}>
      {children}
      {on && <PenMark mark="circle" className="pointer-events-none absolute -inset-x-2.5 -inset-y-1.5 h-[calc(100%+12px)] w-[calc(100%+20px)]" />}
    </span>
  );
}
