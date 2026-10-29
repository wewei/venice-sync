import { useEffect, useRef, useState, type RefObject } from "react"
import { createPortal } from "react-dom"
import { IconArrowsExchange } from "@tabler/icons-react"
import { bindSidebarLauncher, LAUNCHER_ID, prepareSidebarOpen } from "./sidebar-launcher"

const launcherStyles = `
:host{all:initial;display:block;position:relative;flex:0 0 44px;width:44px;height:44px;align-self:center;margin-inline-start:8px;margin-inline-end:auto;color:inherit;font:inherit}
button{all:unset;box-sizing:border-box;display:flex;align-items:center;justify-content:center;width:44px;height:44px;border-radius:8px;cursor:pointer;color:inherit}
button:hover{background:color-mix(in srgb,currentColor 10%,transparent)}
button[aria-current=page]{background:color-mix(in srgb,currentColor 14%,transparent)}
button:focus-visible{outline:2px solid currentColor;outline-offset:2px}
button:disabled{opacity:.5;cursor:wait}
svg{width:20px;height:20px;pointer-events:none}
[role=alert]{position:absolute;top:48px;left:0;width:220px;padding:8px;border:1px solid currentColor;border-radius:6px;background:Canvas;color:CanvasText;font:12px/1.5 system-ui;z-index:1}
`

export function SidebarLauncher({ buttonRef, expanded, onOpen, onClose, notice }: {
  buttonRef: RefObject<HTMLButtonElement | null>
  expanded: boolean
  onOpen: (returnFocus?: HTMLElement) => void
  onClose: () => void
  notice?: string
}) {
  const [{ host, container }] = useState(() => {
    const element = document.createElement("span")
    element.id = LAUNCHER_ID
    const shadow = element.attachShadow({ mode: "open" }), style = document.createElement("style"), container = document.createElement("div")
    container.dataset.veniceSyncLauncher = ""
    style.textContent = launcherStyles; shadow.append(style, container)
    return { host: element, container }
  })
  const [busy, setBusy] = useState(false), [error, setError] = useState<string>()
  const mounted = useRef(false)
  useEffect(() => {
    mounted.current = true
    const dispose = bindSidebarLauncher(host)
    return () => { mounted.current = false; dispose() }
  }, [host])
  async function launch() {
    setBusy(true); setError(undefined)
    try {
      const returnFocus = await prepareSidebarOpen(host)
      if (mounted.current) {
        if (expanded) onClose()
        else onOpen(returnFocus)
      }
    } catch (reason) {
      console.error("Venice Sync: could not open from the sidebar.", reason)
      if (mounted.current) setError(reason instanceof Error ? reason.message : String(reason))
    } finally { if (mounted.current) setBusy(false) }
  }
  return createPortal(<>
    <button ref={buttonRef} type="button" aria-label="Venice Sync" title="Venice Sync" aria-current={expanded ? "page" : undefined} aria-expanded={expanded} disabled={busy}
      onClick={(event) => { event.stopPropagation(); void launch() }}>
      <IconArrowsExchange aria-hidden="true" />
    </button>
    {(error || notice) && <span role="alert">{error || notice}</span>}
  </>, container)
}
