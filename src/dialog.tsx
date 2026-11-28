import type * as React from "react";
import { X } from "lucide-react";
import { cn } from "./lib/utils";
import {
  DialogClose,
  DialogContent as HouseDialogContent,
} from "./components/ui/overlay";

export {
  Dialog,
  DialogClose,
  DialogDescription,
  DialogTitle,
  DialogTrigger,
} from "./components/ui/overlay";

/** The house dialog with Alice's defaults: room for a form, a scroll past 90vh, and a close button. A non-modal Dialog draws no overlay. */
export function DialogContent({
  className,
  showClose = true,
  children,
  ...props
}: React.ComponentProps<typeof HouseDialogContent> & { showClose?: boolean }) {
  return (
    <HouseDialogContent
      className={cn(
        "max-h-[90vh] w-[min(92vw,600px)] overflow-y-auto p-6",
        className,
      )}
      {...props}
    >
      {children}
      {showClose && (
        <DialogClose
          aria-label="Close"
          className="absolute top-5 right-5 cursor-pointer text-ink-muted hover:text-ink"
        >
          <X size={17} />
        </DialogClose>
      )}
    </HouseDialogContent>
  );
}
