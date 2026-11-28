import type * as React from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import * as TooltipPrimitive from "@radix-ui/react-tooltip";
import { cn } from "@/lib/utils";
import { toneText, type Tone } from "@/components/ui/badge";

// @house/overlay: vendored from https://aglowinthefield.github.io/house. Change it there, then re-run shadcn add.

// Floating layers get a hard ink shadow in place of a blur. Everything else sits flat on the paper.
export const floatClass = "rounded-house border border-ink bg-raised text-ink";

export function Kbd({ className, ...props }: React.ComponentProps<"kbd">) {
  return <kbd data-slot="kbd" className={cn("rounded-[2px] border border-current px-1 font-mono text-[11px] leading-4 opacity-80", className)} {...props} />;
}

export const Dialog = DialogPrimitive.Root;
export const DialogTrigger = DialogPrimitive.Trigger;
export const DialogClose = DialogPrimitive.Close;

/** The dialog's surface on its own, for static previews. DialogContent wraps it in a portal and overlay. */
export function DialogPanel({ className, ...props }: React.ComponentProps<"div">) {
  return <div data-slot="dialog-panel" className={cn(floatClass, "w-[min(420px,calc(100vw-2rem))] p-5 shadow-float", className)} {...props} />;
}

export function DialogContent({ className, children, ...props }: React.ComponentProps<typeof DialogPrimitive.Content>) {
  return (
    <DialogPrimitive.Portal>
      <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-ink/15 motion-safe:data-[state=open]:animate-fade-in" />
      <DialogPrimitive.Content
        data-slot="dialog-content"
        className={cn(floatClass, "fixed top-1/2 left-1/2 z-50 w-[min(420px,calc(100vw-2rem))] -translate-1/2 p-5 shadow-float focus:outline-none motion-safe:data-[state=open]:animate-pop-in", className)}
        {...props}
      >
        {children}
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  );
}

export function DialogTitle({ className, ...props }: React.ComponentProps<typeof DialogPrimitive.Title>) {
  return <DialogPrimitive.Title data-slot="dialog-title" className={cn("mb-1.5 text-base font-semibold", className)} {...props} />;
}

export function DialogDescription({ className, ...props }: React.ComponentProps<typeof DialogPrimitive.Description>) {
  return <DialogPrimitive.Description data-slot="dialog-description" className={cn("mb-4 text-sm text-ink-muted", className)} {...props} />;
}

export function DialogFooter({ className, ...props }: React.ComponentProps<"div">) {
  return <div data-slot="dialog-footer" className={cn("flex justify-end gap-2", className)} {...props} />;
}

export const TooltipProvider = TooltipPrimitive.Provider;
export const Tooltip = TooltipPrimitive.Root;
export const TooltipTrigger = TooltipPrimitive.Trigger;

/** Ink-filled, with the shortcut beside the label. Renders in place, so it inherits the surrounding light or dark. */
export function TooltipContent({ className, sideOffset = 6, ...props }: React.ComponentProps<typeof TooltipPrimitive.Content>) {
  return (
    <TooltipPrimitive.Content
      data-slot="tooltip"
      sideOffset={sideOffset}
      className={cn("z-50 inline-flex items-center gap-2 rounded-house bg-ink px-2 py-1 text-xs text-paper motion-safe:data-[state=delayed-open]:animate-fade-in", className)}
      {...props}
    />
  );
}

/** A notice that needs an answer: a failure with a retry, an undo. Toasts that confirm a visible change are cut. */
export function Toast({ tone = "danger", action, className, children, ...props }: { tone?: Tone; action?: React.ReactNode } & React.ComponentProps<"div">) {
  return (
    <div role={tone === "danger" ? "alert" : "status"} data-slot="toast" className={cn(floatClass, "flex w-[min(380px,calc(100vw-2rem))] items-center gap-3.5 px-3 py-2.5 shadow-ink", className)} {...props}>
      <span aria-hidden="true" className={cn("w-[3px] self-stretch rounded-full bg-current", toneText[tone])} />
      <div className="flex-1 text-sm">{children}</div>
      {action}
    </div>
  );
}

/** Command palette surface. The app owns filtering and keys; these give the look. */
export function CommandMenu({ className, ...props }: React.ComponentProps<"div">) {
  return <div data-slot="command-menu" className={cn(floatClass, "w-[min(520px,calc(100vw-2rem))] p-1 shadow-ink", className)} {...props} />;
}

export function CommandInput({ className, ...props }: React.ComponentProps<"input">) {
  return <input data-slot="command-input" className={cn("mb-1 w-full border-0 border-b border-hairline bg-transparent px-2.5 py-2 text-sm text-ink outline-none placeholder:text-ink-muted", className)} {...props} />;
}

export function CommandItem({ active = false, shortcut, className, children, ...props }: { active?: boolean; shortcut?: React.ReactNode } & React.ComponentProps<"div">) {
  return (
    <div
      role="option"
      aria-selected={active}
      data-slot="command-item"
      className={cn("flex h-8 cursor-pointer items-center justify-between rounded-[2px] px-2.5 text-sm", active ? "bg-ink text-paper" : "hovered:bg-pen-wash", className)}
      {...props}
    >
      {children}
      {shortcut && <Kbd>{shortcut}</Kbd>}
    </div>
  );
}
