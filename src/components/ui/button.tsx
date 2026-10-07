import { cva, type VariantProps } from "class-variance-authority";
import type { ButtonHTMLAttributes } from "react";
import { cn } from "@/lib/cn";

const buttonVariants = cva(
  "zone-btn inline-flex items-center justify-center gap-2 font-medium select-none cursor-pointer disabled:pointer-events-none disabled:opacity-40",
  {
    variants: {
      variant: {
        primary: "zone-btn-primary bg-accent text-accent-fg",
        quiet: "zone-btn-quiet bg-raised text-paper",
        ghost: "zone-btn-ghost bg-transparent text-paper",
      },
      size: {
        md: "h-11 px-3 text-sm rounded-md",
        sm: "h-8 px-2 text-xs rounded-sm",
        icon: "size-11 rounded-md",
      },
    },
    defaultVariants: { variant: "ghost", size: "md" },
  },
);

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & VariantProps<typeof buttonVariants>;

export function Button({ className, variant, size, type = "button", ...props }: ButtonProps) {
  return <button type={type} className={cn(buttonVariants({ variant, size }), className)} {...props} />;
}
