import { useRef, useState } from "react"
import { IconArrowsExchange } from "@tabler/icons-react"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import type { RuntimeInfo } from "./runtime"
import { SyncPanel } from "./SyncPanel"

interface AppProps {
  runtime: RuntimeInfo
  portalContainer: HTMLElement
}

export function App({ runtime, portalContainer }: AppProps) {
  const [clicks, setClicks] = useState(0)
  const launcher = useRef<HTMLButtonElement>(null)
  const panel = useRef<HTMLDivElement>(null)

  return (
    <Dialog modal={false}>
      <DialogTrigger asChild>
        <Button
          ref={launcher}
          className="pointer-events-auto fixed right-6 bottom-6 gap-2"
          size="lg"
        >
          <IconArrowsExchange aria-hidden="true" />
          Venice Sync
        </Button>
      </DialogTrigger>
      <DialogContent
        portalContainer={portalContainer}
        className="pointer-events-auto flex h-[min(54rem,calc(100dvh-2rem))] max-h-[calc(100dvh-2rem)] flex-col gap-6 overflow-hidden p-5 sm:max-w-[min(72rem,calc(100vw-4rem))] sm:p-7"
        onFocusOutside={(event) => event.preventDefault()}
        onOpenAutoFocus={(event) => {
          event.preventDefault()
          panel.current?.querySelector<HTMLButtonElement>('[aria-current="page"]')?.focus()
        }}
        onCloseAutoFocus={(event) => {
          event.preventDefault()
          launcher.current?.focus()
        }}
      >
        <DialogHeader className="shrink-0 pr-8">
          <DialogTitle>Venice Sync</DialogTitle>
          <DialogDescription>
            Download and upload your local Venice content. No cloud synchronization.
          </DialogDescription>
        </DialogHeader>
        <div ref={panel} className="flex min-h-0 flex-1">
          <SyncPanel
            runtime={runtime}
            clicks={clicks}
            onTestInteraction={() => setClicks((value) => value + 1)}
            reloadPage={() => window.location.reload()}
          />
        </div>
      </DialogContent>
    </Dialog>
  )
}
