import type * as React from "react";
import * as CheckboxPrimitive from "@radix-ui/react-checkbox";
import * as SwitchPrimitive from "@radix-ui/react-switch";
import { cn } from "@/lib/utils";
import { PenMark } from "@/components/ui/pen-mark";

// @house/checkbox: vendored from https://aglowinthefield.github.io/house. Change it there, then re-run shadcn add.

const focusRing = "focused:outline-2 focused:outline-offset-2 focused:outline-pen";

/** A checkbox ticked in pen. */
export function Checkbox({ className, ...props }: React.ComponentProps<typeof CheckboxPrimitive.Root>) {
  return (
    <CheckboxPrimitive.Root
      data-slot="checkbox"
      className={cn("relative inline-grid size-4 shrink-0 cursor-pointer place-items-center rounded-[2px] border border-ink bg-paper disabled:cursor-not-allowed disabled:border-dashed disabled:border-ink-faint", focusRing, className)}
      {...props}
    >
      <CheckboxPrimitive.Indicator>
        <PenMark mark="tick" className="absolute -top-1 -left-0.5 size-5" />
      </CheckboxPrimitive.Indicator>
    </CheckboxPrimitive.Root>
  );
}

export function Switch({ className, ...props }: React.ComponentProps<typeof SwitchPrimitive.Root>) {
  return (
    <SwitchPrimitive.Root
      data-slot="switch"
      className={cn("inline-flex h-5 w-8.5 shrink-0 cursor-pointer items-center rounded-full border border-ink bg-paper p-0.5 transition-colors duration-150 data-[state=checked]:bg-ink disabled:cursor-not-allowed disabled:border-dashed disabled:border-ink-faint motion-reduce:transition-none", focusRing, className)}
      {...props}
    >
      <SwitchPrimitive.Thumb className="block size-3.5 rounded-full bg-ink transition-[translate,background-color] duration-150 data-[state=checked]:translate-x-3.5 data-[state=checked]:bg-paper motion-reduce:transition-none" />
    </SwitchPrimitive.Root>
  );
}
