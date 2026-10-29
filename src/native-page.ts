import { findSidebarTarget } from "./sidebar-launcher"

function html(element: Element): element is HTMLElement {
  return element.namespaceURI === "http://www.w3.org/1999/xhtml"
}

function shown(element: HTMLElement): boolean {
  const box = element.getBoundingClientRect(), style = getComputedStyle(element)
  return element.isConnected && style.display !== "none" && style.visibility !== "hidden" && box.width > 0 && box.height > 0
}

export function nativeNavigationButton(): HTMLButtonElement | undefined {
  return [...document.querySelectorAll<HTMLButtonElement>('button[aria-label="Show Sidebar"]')].find(shown)
}

export function findNativePage(preview = false): HTMLElement | undefined {
  if (preview) return document.querySelector<HTMLElement>("[data-venice-sync-preview-main]") ?? document.querySelector<HTMLElement>("main") ?? undefined
  const sidebar = findSidebarTarget()
  if (sidebar && !sidebar.header.closest('[role="dialog"][aria-modal="true"]')) {
    let node: HTMLElement | null = sidebar.header
    for (let depth = 0; node?.parentElement && depth < 10; depth++, node = node.parentElement) {
      const edge = node.getBoundingClientRect().right
      const candidates = [...node.parentElement.children].filter((child): child is HTMLElement => html(child) && child !== node && shown(child))
        .filter(child => {
          const box = child.getBoundingClientRect()
          return box.left >= edge - 1 && box.width >= 160 && box.height >= innerHeight * 0.7
        })
      if (candidates.length === 1) return candidates[0]
    }
  }
  let node: HTMLElement | null = nativeNavigationButton()?.parentElement ?? null
  for (let depth = 0; node && node !== document.body && depth < 12; depth++, node = node.parentElement) {
    const box = node.getBoundingClientRect()
    if (shown(node) && box.width >= innerWidth * 0.9 && box.height >= innerHeight * 0.7) return node
  }
  const landmarks = [...document.querySelectorAll<HTMLElement>('main,[role="main"]')].filter(shown)
    .filter(element => !element.contains(sidebar?.header ?? null) && element.getBoundingClientRect().height >= innerHeight * 0.7)
  return landmarks.length === 1 ? landmarks[0] : undefined
}

function restoreAttribute(element: HTMLElement, name: string, value: string | null, owned: string) {
  if (element.getAttribute(name) !== owned) return
  if (value === null) element.removeAttribute(name)
  else element.setAttribute(name, value)
}

export function bindNativePage(host: HTMLElement, {
  preview = false, onFrameChange, onUnavailable, onNavigation,
}: {
  preview?: boolean
  onFrameChange: (navigation: HTMLButtonElement | undefined) => void
  onUnavailable: (message: string | undefined) => void
  onNavigation: () => void
}): () => void {
  const home = host.parentElement ?? document.body, next = host.nextSibling, originalStyle = host.getAttribute("style")
  let current: HTMLElement | undefined, restore: (() => void) | undefined, frame: number | undefined, disposed = false
  let href = location.href, missing = false
  const inert = new Map<HTMLElement, { inert: string | null; aria: string | null }>()
  const resize = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(() => schedule())
  function release() {
    resize?.disconnect()
    for (const [element, state] of inert) {
      restoreAttribute(element, "inert", state.inert, "")
      restoreAttribute(element, "aria-hidden", state.aria, "true")
    }
    inert.clear(); restore?.(); restore = undefined; current = undefined
  }
  function update() {
    frame = undefined
    if (disposed) return
    if (href !== location.href) { href = location.href; onNavigation() }
    const target = findNativePage(preview)
    if (target !== current) {
      release()
      if (target) {
        current = target
        const scroll = [target, ...target.querySelectorAll("*")].filter(element => element === target || element.scrollTop || element.scrollLeft || element.scrollHeight > element.clientHeight || element.scrollWidth > element.clientWidth)
          .map(element => ({ element, top: element.scrollTop, left: element.scrollLeft }))
        // Contain the high-z Shadow host below Venice's navigation portals.
        const values = {
          position: ["", "static"].includes(getComputedStyle(target).position) ? "relative" : getComputedStyle(target).position,
          overflow: "hidden", isolation: "isolate",
        }
        const saved = Object.keys(values).map(name => ({ name, value: target.style.getPropertyValue(name), priority: target.style.getPropertyPriority(name) }))
        for (const [name, value] of Object.entries(values)) target.style.setProperty(name, value, "important")
        target.scrollTop = 0; target.scrollLeft = 0
        restore = () => {
          for (const { name, value, priority } of saved) {
            if (target.style.getPropertyValue(name) === values[name as keyof typeof values] && target.style.getPropertyPriority(name) === "important") {
              if (value) target.style.setProperty(name, value, priority)
              else target.style.removeProperty(name)
            }
          }
          for (const item of scroll) { item.element.scrollTop = item.top; item.element.scrollLeft = item.left }
        }
        resize?.observe(target)
      }
    }
    if (!target) {
      if (host.style.display !== "none") host.style.display = "none"
      if (host.parentElement !== document.body) document.body.append(host)
      if (!missing) { missing = true; onUnavailable("Venice's content area is unavailable. Reopen Sync after the native page finishes loading. Any running batch is retained.") }
      return
    }
    if (missing) { missing = false; onUnavailable(undefined) }
    for (const child of target.children) if (child !== host && html(child)) {
      if (!inert.has(child)) inert.set(child, { inert: child.getAttribute("inert"), aria: child.getAttribute("aria-hidden") })
      if (child.getAttribute("inert") !== "") child.setAttribute("inert", "")
      if (child.getAttribute("aria-hidden") !== "true") child.setAttribute("aria-hidden", "true")
    }
    for (const [name, value] of Object.entries({ position: "absolute", inset: "0px", display: "block", "z-index": "2147483647", "pointer-events": "auto" })) {
      if (host.style.getPropertyValue(name) !== value) host.style.setProperty(name, value)
    }
    if (host.parentElement !== target) target.append(host)
    onFrameChange(nativeNavigationButton())
  }
  function schedule() {
    if (!disposed && frame === undefined) frame = requestAnimationFrame(update)
  }
  const observer = new MutationObserver(schedule)
  observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ["style", "class", "hidden", "inert", "aria-hidden"] })
  window.addEventListener("resize", schedule)
  document.addEventListener("transitionend", schedule, true)
  update()
  return () => {
    disposed = true; observer.disconnect(); resize?.disconnect()
    if (frame !== undefined) cancelAnimationFrame(frame)
    window.removeEventListener("resize", schedule)
    document.removeEventListener("transitionend", schedule, true)
    release()
    if (originalStyle === null) host.removeAttribute("style")
    else host.setAttribute("style", originalStyle)
    const parent = home.isConnected ? home : document.body
    if (next?.parentNode === parent) parent.insertBefore(host, next)
    else parent.append(host)
  }
}
