import type * as React from "react";
import { Slot, Slottable } from "@radix-ui/react-slot";
import * as TabsPrimitive from "@radix-ui/react-tabs";
import { cn } from "@/lib/utils";
import { PenMark } from "@/components/ui/pen-mark";

// @house/navigation: vendored from https://aglowinthefield.github.io/house. Change it there, then re-run shadcn add.

/** A sidebar entry. The current one gets a pen circle instead of a filled pill. */
export function SidebarItem({ active = false, count, asChild = false, className, children, ...props }: { active?: boolean; count?: React.ReactNode; asChild?: boolean } & React.ComponentProps<"a">) {
  const Comp = asChild ? Slot : "a";
  return (
    <Comp
      data-slot="sidebar-item"
      aria-current={active ? "page" : undefined}
      className={cn(
        "relative flex cursor-pointer items-center justify-between gap-2 rounded-house px-2 py-1.5 text-[13px] text-ink-muted no-underline hovered:bg-pen-wash hovered:text-ink focused:outline-2 focused:outline-pen",
        active && "font-semibold text-ink hovered:bg-transparent",
        className,
      )}
      {...props}
    >
      {/* With asChild, Slottable marks the child that becomes the root; the count and circle go inside it. */}
      <Slottable>{children}</Slottable>
      {count != null && <span className="small-print text-[11px]">{count}</span>}
      {active && <PenMark mark="circle" className="pointer-events-none absolute -inset-x-3 -inset-y-1.5 h-[calc(100%+12px)] w-[calc(100%+24px)]" />}
    </Comp>
  );
}

export const Tabs = TabsPrimitive.Root;
export const TabsContent = TabsPrimitive.Content;

export function TabsList({ className, ...props }: React.ComponentProps<typeof TabsPrimitive.List>) {
  return <TabsPrimitive.List data-slot="tabs-list" className={cn("flex gap-5 border-b border-ink", className)} {...props} />;
}

/** The active tab is underlined in pen. */
export function TabsTrigger({ className, children, ...props }: React.ComponentProps<typeof TabsPrimitive.Trigger>) {
  return (
    <TabsPrimitive.Trigger
      data-slot="tabs-trigger"
      className={cn("group relative cursor-pointer pb-2 text-sm text-ink-muted hovered:text-ink focused:outline-2 focused:outline-offset-2 focused:outline-pen data-[state=active]:font-semibold data-[state=active]:text-ink", className)}
      {...props}
    >
      {children}
      <PenMark mark="underline" className="pointer-events-none absolute -bottom-1.5 -left-1 hidden h-3 w-[calc(100%+8px)] group-data-[state=active]:block" />
    </TabsPrimitive.Trigger>
  );
}
