import { createRoot } from "react-dom/client"
import { App } from "./App"
import type { RuntimeInfo } from "./runtime"

export const HOST_ID = "venice-sync-userscript-host"

export function mountApp(runtime: RuntimeInfo, css: string) {
  const existing = document.getElementById(HOST_ID)
  if (existing) {
    if (!existing.shadowRoot) {
      throw new Error(`Venice Sync: #${HOST_ID} exists without a Shadow DOM`)
    }
    return { status: "already-mounted" as const, host: existing }
  }

  const host = document.createElement("div")
  host.id = HOST_ID
  host.dataset.veniceSyncMode = runtime.mode
  const shadow = host.attachShadow({ mode: "open" })
  const style = document.createElement("style")
  style.textContent = css
  const container = document.createElement("div")
  container.className = "venice-sync-root"
  container.dataset.veniceSyncApp = ""
  const reactContainer = document.createElement("div")
  container.append(reactContainer)
  shadow.append(style, container)
  document.body.append(host)

  const root = createRoot(reactContainer)
  root.render(<App runtime={runtime} host={host} />)

  return {
    status: "mounted" as const,
    host,
    unmount() {
      root.unmount()
      host.remove()
    },
  }
}
