import * as React from "react"
import { cva } from "class-variance-authority"
import { cn } from "@/lib/utils"

const buttonVariants = cva(
  "inline-flex items-center justify-center whitespace-nowrap rounded-md text-sm font-medium transition-all duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white focus-visible:ring-offset-2 focus-visible:ring-offset-black disabled:pointer-events-none disabled:opacity-50",
  {
    variants: {
      variant: {
        default:
          "bg-white text-black shadow hover:bg-white/90 active:bg-white/80",

        destructive:
          "bg-red-600 text-white shadow-sm hover:bg-red-500 active:bg-red-400",

        outline:
          "border border-white/40 text-white bg-transparent hover:bg-white/10 hover:border-white",

        secondary:
          "bg-zinc-800 text-white border border-zinc-700 hover:bg-zinc-700 active:bg-zinc-600",

        ghost:
          "text-white hover:bg-white/10 active:bg-white/20",

        link:
          "text-white underline underline-offset-4 hover:text-white/80",
      },

      size: {
        default: "h-10 px-4 py-2",
        sm: "h-9 px-3",
        lg: "h-11 px-8",
        xl: "h-12 px-8 text-base",
        icon: "h-10 w-10",
      },
    },

    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
)

const Button = React.forwardRef(({ className, variant, size, ...props }, ref) => {
  return (
    <button
      className={cn(buttonVariants({ variant, size, className }))}
      ref={ref}
      {...props}
    />
  )
})
Button.displayName = "Button"

export { Button, buttonVariants }