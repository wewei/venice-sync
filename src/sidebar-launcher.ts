export const LAUNCHER_ID = "venice-sync-sidebar-launcher"

interface SidebarTarget {
  header: HTMLElement
  logo: HTMLElement
  toggle: HTMLButtonElement
}

function htmlElement(element: Element): element is HTMLElement {
  return element.namespaceURI === "http://www.w3.org/1999/xhtml"
}

function visible(element: HTMLElement): boolean {
  const box = element.getBoundingClientRect()
  return element.isConnected && !element.closest('[aria-hidden="true"],[inert],[hidden]') &&
    getComputedStyle(element).display !== "none" && getComputedStyle(element).visibility !== "hidden" &&
    box.width > 0 && box.height > 0 && box.right > 0 && box.left < innerWidth
}

export function findSidebarTarget(): SidebarTarget | undefined {
  for (const brand of document.querySelectorAll('svg[viewBox="0 0 549 307"]')) {
    let node = brand.parentElement
    for (let depth = 0; node && depth < 8; depth++, node = node.parentElement) {
      const buttons = Array.from(node.children).filter((child): child is HTMLButtonElement => htmlElement(child) && child.localName === "button")
      if (buttons.length !== 1 || !node.parentElement?.querySelector('a[href="/minds"],a[href="/chat/agent"]')) continue
      const logo = Array.from(node.children).find((child) => child.contains(brand))
      if (!logo || !htmlElement(logo) || !visible(node) || !visible(logo) || !visible(buttons[0])) continue
      const headerBox = node.getBoundingClientRect()
      if (headerBox.height < 48 || headerBox.height > 110) continue
      return { header: node, logo, toggle: buttons[0] }
    }
  }
}

export function bindSidebarLauncher(host: HTMLElement): () => void {
  let frame: number | undefined, current: HTMLElement | undefined, disposed = false
  const resize = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(() => schedule())
  const update = () => {
    frame = undefined
    if (disposed) return
    const target = findSidebarTarget()
    if (current !== target?.header) {
      resize?.disconnect(); current = target?.header
      if (current) resize?.observe(current)
    }
    const room = target && target.toggle.getBoundingClientRect().left - target.logo.getBoundingClientRect().right
    if (!target || room === undefined || room < 60) { if (host.parentElement) host.remove(); return }
    if (host.parentElement !== target.header || host.nextElementSibling !== target.toggle) target.header.insertBefore(host, target.toggle)
  }
  const schedule = () => { if (!disposed && frame === undefined) frame = requestAnimationFrame(update) }
  const mutations = new MutationObserver(schedule)
  mutations.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ["style", "class", "aria-hidden", "hidden", "inert", "viewBox"] })
  window.addEventListener("resize", schedule)
  document.addEventListener("transitionend", schedule, true)
  update()
  return () => {
    disposed = true; mutations.disconnect(); resize?.disconnect()
    if (frame !== undefined) cancelAnimationFrame(frame)
    window.removeEventListener("resize", schedule)
    document.removeEventListener("transitionend", schedule, true)
    host.remove()
  }
}

export async function prepareSidebarOpen(host: HTMLElement): Promise<HTMLElement | undefined> {
  const target = findSidebarTarget()
  if (!target || host.parentElement !== target.header) throw new Error("The native sidebar changed. Reopen it and try again.")
  const drawer = target.header.closest<HTMLElement>('[role="dialog"][aria-modal="true"]')
  if (!drawer) return
  const returnFocus = document.querySelector<HTMLButtonElement>('button[aria-label="Show Sidebar"]') ?? undefined
  await new Promise<void>((resolve, reject) => {
    let frame: number | undefined
    const finish = (error?: Error) => {
      clearTimeout(timer); observer.disconnect()
      if (frame !== undefined) cancelAnimationFrame(frame)
      if (error) reject(error)
      else resolve()
    }
    const check = () => {
      frame = undefined
      const hidden = drawer.getAttribute("aria-hidden") === "true" || !drawer.isConnected || getComputedStyle(drawer).display === "none"
      const panel = document.getElementById("venice-sync-userscript-host")
      if (hidden && !panel?.closest('[aria-hidden="true"],[inert]')) finish()
      else frame = requestAnimationFrame(check)
    }
    const observer = new MutationObserver(() => { if (frame === undefined) frame = requestAnimationFrame(check) })
    const timer = setTimeout(() => finish(new Error("Venice's mobile sidebar did not close. Close it and retry.")), 3000)
    observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ["aria-hidden", "style", "inert"] })
    target.toggle.click()
    if (frame === undefined) frame = requestAnimationFrame(check)
  })
  return returnFocus
}
