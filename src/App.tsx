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
import { SidebarLauncher } from "./SidebarLauncher"

interface AppProps {
  runtime: RuntimeInfo
  portalContainer: HTMLElement
}

export function App({ runtime, portalContainer }: AppProps) {
  const [clicks, setClicks] = useState(0)
  const [open, setOpen] = useState(false)
  const [importing, setImporting] = useState(false)
  const launcher = useRef<HTMLButtonElement>(null)
  const returnFocus = useRef<HTMLElement | undefined>(undefined)
  const panel = useRef<HTMLDivElement>(null)

  return (
    <Dialog modal={false} open={open} onOpenChange={(value) => { if (!importing) setOpen(value) }}>
      {runtime.mode === "preview" ? <DialogTrigger asChild>
        <Button
          ref={launcher}
          className="pointer-events-auto fixed right-6 bottom-6 gap-2"
          size="lg"
        >
          <IconArrowsExchange aria-hidden="true" />
          Venice Sync
        </Button>
      </DialogTrigger> : <SidebarLauncher buttonRef={launcher} expanded={open} onOpen={(element) => { returnFocus.current = element; setOpen(true) }} onClose={() => { if (!importing) setOpen(false) }} />}
      <DialogContent
        portalContainer={portalContainer}
        showCloseButton={!importing}
        className="pointer-events-auto flex h-[min(54rem,calc(100dvh-2rem))] max-h-[calc(100dvh-2rem)] flex-col gap-6 overflow-hidden p-5 sm:max-w-[min(72rem,calc(100vw-4rem))] sm:p-7"
        onFocusOutside={(event) => event.preventDefault()}
        onPointerDownOutside={(event) => {
          if (importing || (launcher.current && event.detail.originalEvent.composedPath().includes(launcher.current))) event.preventDefault()
        }}
        onEscapeKeyDown={(event) => { if (importing) event.preventDefault() }}
        onOpenAutoFocus={(event) => {
          event.preventDefault()
          panel.current?.querySelector<HTMLButtonElement>('[aria-current="page"]')?.focus()
        }}
        onCloseAutoFocus={(event) => {
          event.preventDefault()
          if (launcher.current?.isConnected) launcher.current.focus()
          else if (returnFocus.current?.isConnected) returnFocus.current.focus()
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
            onImportingChange={setImporting}
          />
        </div>
      </DialogContent>
    </Dialog>
  )
}
