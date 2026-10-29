import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react"
import { IconArrowLeft, IconArrowsExchange, IconMenu2 } from "@tabler/icons-react"
import { Button } from "@/components/ui/button"
import { IconAction } from "./components/IconAction"
import type { RuntimeInfo } from "./runtime"
import { SyncPanel } from "./SyncPanel"
import { SidebarLauncher } from "./SidebarLauncher"
import { bindNativePage, findNativePage } from "./native-page"

interface AppProps {
  runtime: RuntimeInfo
  host: HTMLElement
}

export function App({ runtime, host }: AppProps) {
  const [clicks, setClicks] = useState(0)
  const [open, setOpen] = useState(false)
  const [importing, setImporting] = useState(false)
  const [opened, setOpened] = useState(false)
  const [error, setError] = useState<string>(), [notice, setNotice] = useState<string>()
  const [navigationButton, setNavigationButton] = useState<HTMLButtonElement>()
  const importingRef = useRef(false)
  const launcher = useRef<HTMLButtonElement>(null)
  const returnFocus = useRef<HTMLElement | undefined>(undefined)
  const heading = useRef<HTMLHeadingElement>(null)
  const setImportingState = useCallback((value: boolean) => { importingRef.current = value; setImporting(value) }, [])
  const restoreFocus = useCallback(() => {
    const target = launcher.current?.isConnected ? launcher.current : returnFocus.current?.isConnected ? returnFocus.current : undefined
    target?.focus({ preventScroll: true })
  }, [])
  const close = useCallback(() => {
    if (importingRef.current) { setNotice("Batch import is running. Stop after the current item or wait for completion before returning to Venice."); return }
    setOpen(false)
  }, [])
  function launch(element?: HTMLElement) {
    if (!findNativePage(runtime.mode === "preview")) {
      const message = "Venice's content area is unavailable. Wait for the native page to load, then reopen Sync."
      console.error("Venice Sync:", message); setError(message); return
    }
    returnFocus.current = element; setError(undefined); setNotice(undefined); setOpened(true); setOpen(true)
  }
  useLayoutEffect(() => {
    if (!open) return
    const release = bindNativePage(host, {
      preview: runtime.mode === "preview",
      onFrameChange: setNavigationButton,
      onUnavailable: message => { if (message) console.error("Venice Sync:", message); setError(message) },
      onNavigation: close,
    })
    const onClick = (event: MouseEvent) => {
      if (event.defaultPrevented || event.button || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.composedPath().includes(host)) return
      const target = event.target
      if (!target || !("nodeType" in target) || target.nodeType !== 1) return
      const link = (target as Element).closest<HTMLAnchorElement>("a[href]")
      if (!link || link.origin !== location.origin || link.target && link.target !== "_self" || link.hasAttribute("download") || link.getAttribute("href")?.startsWith("#")) return
      if (importingRef.current) { event.preventDefault(); event.stopPropagation() }
      close()
    }
    document.addEventListener("click", onClick, true)
    window.addEventListener("popstate", close)
    return () => {
      document.removeEventListener("click", onClick, true)
      window.removeEventListener("popstate", close)
      release()
      queueMicrotask(restoreFocus)
    }
  }, [open, host, runtime.mode, close, restoreFocus])
  useEffect(() => {
    if (open && !heading.current?.closest("[hidden]")) heading.current?.focus({ preventScroll: true })
  }, [open])
  const navigation = navigationButton && <IconAction label="Open Venice navigation" className="size-11 shrink-0" disabled={importing} onClick={() => navigationButton.click()}><IconMenu2 aria-hidden="true" /></IconAction>

  return <>
      {runtime.mode === "preview" ? !open && <>
        <Button
          ref={launcher}
          className="pointer-events-auto fixed right-6 bottom-6 gap-2"
          size="lg"
          onClick={() => launch()}
        >
          <IconArrowsExchange aria-hidden="true" />
          Venice Sync
        </Button>
        {error && <p role="alert" className="pointer-events-auto fixed right-6 bottom-20 max-w-xs bg-background p-3">{error}</p>}
      </> : <SidebarLauncher buttonRef={launcher} expanded={open} onOpen={launch} onClose={close} notice={error} />}
      {opened && <section
        role="region"
        aria-label="Venice Sync"
        data-testid="sync-workspace"
        hidden={!open}
        aria-busy={importing}
        className="pointer-events-auto absolute inset-0 flex min-h-0 min-w-0 flex-col gap-3 overflow-hidden bg-background p-4 text-foreground @container/sync sm:p-6"
        onClick={event => event.stopPropagation()}
        onKeyDown={event => {
          event.stopPropagation()
          if (event.key === "Escape") { event.preventDefault(); close() }
        }}
      >
        {error && <p role="alert">{error}</p>}
        {notice && <p role="status">{notice}</p>}
          <SyncPanel
            visible={open}
            navigation={navigation}
            header={<div className="flex min-w-0 items-center gap-2">
              <IconAction label="Back to Venice" className="size-11 shrink-0" disabled={importing} onClick={close}><IconArrowLeft aria-hidden="true" /></IconAction>
              {navigation}
              <h1 ref={heading} tabIndex={-1} className="min-w-0 truncate text-lg font-medium outline-none">Venice Sync</h1>
            </div>}
            runtime={runtime}
            clicks={clicks}
            onTestInteraction={() => setClicks((value) => value + 1)}
            reloadPage={() => window.location.reload()}
            onImportingChange={setImportingState}
          />
      </section>}
  </>
}
