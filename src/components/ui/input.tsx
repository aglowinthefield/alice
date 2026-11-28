import type * as React from "react";
import { ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";

// @house/input: vendored from https://aglowinthefield.github.io/house. Change it there, then re-run shadcn add.

// Outlined fields on paper. Focus draws a pen ring; aria-invalid turns the border to danger.
export const fieldClass =
  "w-full min-w-0 rounded-house border border-ink bg-paper px-2.5 text-sm text-ink placeholder:text-ink-muted focused:outline-2 focused:outline-offset-2 focused:outline-pen aria-invalid:border-status-danger disabled:cursor-not-allowed disabled:border-dashed disabled:border-ink-faint disabled:text-ink-muted";

export function Input({ className, ...props }: React.ComponentProps<"input">) {
  return <input data-slot="input" className={cn(fieldClass, "h-8", className)} {...props} />;
}

export function Textarea({ className, ...props }: React.ComponentProps<"textarea">) {
  return <textarea data-slot="textarea" className={cn(fieldClass, "min-h-16 py-1.5", className)} {...props} />;
}

/** A native select, so keyboard and mobile pickers work for free. */
export function Select({ className, children, ...props }: React.ComponentProps<"select">) {
  return (
    <span className={cn("relative inline-flex w-full", className)}>
      <select data-slot="select" className={cn(fieldClass, "h-8 appearance-none pr-8")} {...props}>
        {children}
      </select>
      <ChevronDown aria-hidden="true" className="pointer-events-none absolute top-1/2 right-2.5 size-4 -translate-y-1/2 text-ink-muted" />
    </span>
  );
}

/** One line under a field saying what to fix. Link it with aria-describedby. */
export function FieldError({ className, ...props }: React.ComponentProps<"p">) {
  return <p data-slot="field-error" className={cn("mt-1 text-xs text-status-danger", className)} {...props} />;
}
