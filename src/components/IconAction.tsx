import type { ComponentProps } from "react"
import { Button } from "@/components/ui/button"

export function IconAction({ label, ...props }: ComponentProps<typeof Button> & { label: string }) {
  return <Button variant="ghost" size="icon" aria-label={label} title={label} {...props} />
}
