import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

// @house/button: vendored from https://aglowinthefield.github.io/house. Change it there, then re-run shadcn add.

// Importance sets the look: main (the one main action), row (a primary repeated on every row), secondary, text.
export const buttonVariants = cva(
  "inline-flex shrink-0 cursor-pointer items-center justify-center gap-1.5 whitespace-nowrap rounded-house border font-medium transition-[background-color,color,box-shadow,translate] duration-150 ease-out motion-reduce:transition-none focused:outline-2 focused:outline-offset-2 focused:outline-pen pressed:translate-x-0.5 pressed:translate-y-0.5 pressed:shadow-none motion-reduce:pressed:translate-0 disabled:pointer-events-none disabled:border-dashed disabled:border-ink-faint disabled:bg-paper disabled:text-ink-muted disabled:shadow-none [&_svg]:size-4 [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        main: "border-ink bg-ink text-paper shadow-pen hovered:shadow-[3px_3px_0_var(--color-pen)]",
        row: "border-ink bg-paper text-ink shadow-ink hovered:bg-ink hovered:text-paper",
        secondary: "border-ink bg-paper text-ink hovered:bg-ink hovered:text-paper",
        text: "border-transparent bg-transparent text-ink-muted underline decoration-ink-faint underline-offset-3 hovered:text-ink hovered:decoration-ink disabled:border-transparent disabled:bg-transparent",
      },
      size: { md: "h-8 px-3 text-[13px]", sm: "h-6.5 px-2.5 text-xs" },
    },
    compoundVariants: [{ variant: "text", className: "px-1" }],
    defaultVariants: { variant: "secondary", size: "md" },
  },
);

export type ButtonProps = React.ComponentProps<"button"> & VariantProps<typeof buttonVariants> & { asChild?: boolean };

export function Button({ className, variant, size, asChild = false, ...props }: ButtonProps) {
  const Comp = asChild ? Slot : "button";
  return <Comp data-slot="button" className={cn(buttonVariants({ variant, size }), className)} {...props} />;
}
