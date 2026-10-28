import { waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { bindSidebarLauncher, findSidebarTarget, prepareSidebarOpen } from "./sidebar-launcher"
import { sidebarFixture } from "./test/sidebar-fixture"

const disposers: (() => void)[] = []
beforeEach(() => {
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => window.setTimeout(() => callback(performance.now()), 16))
  vi.stubGlobal("cancelAnimationFrame", (id: number) => window.clearTimeout(id))
})
afterEach(() => {
  disposers.splice(0).forEach(dispose => dispose())
  document.body.replaceChildren()
  vi.useRealTimers(); vi.unstubAllGlobals()
})
function bind() {
  const host = document.createElement("span")
  host.dataset.testLauncher = ""
  disposers.push(bindSidebarLauncher(host))
  return host
}
describe("native Logo-adjacent launcher binding", () => {
  it("adds only its own host between the Logo and native toggle without moving native nodes", async () => {
    const native = sidebarFixture(), host = bind()
    expect(findSidebarTarget()?.header).toBe(native.header)
    expect([...native.header.children]).toEqual([native.logo, host, native.toggle])
    native.header.className = "changed"
    await waitFor(() => expect(document.querySelectorAll("[data-test-launcher]")).toHaveLength(1))
    expect(native.logo.parentElement).toBe(native.header)
  })
  it("reuses its one host when the native header is replaced", async () => {
    const old = sidebarFixture(), host = bind()
    old.aside.remove()
    const replacement = sidebarFixture()
    await waitFor(() => expect(host.parentElement).toBe(replacement.header))
    expect(document.querySelectorAll("[data-test-launcher]")).toHaveLength(1)
  })
  it("recognizes native DOM elements from another realm without instanceof checks", () => {
    const iframe = document.createElement("iframe"); document.body.append(iframe)
    const native = sidebarFixture(iframe.contentDocument!.body)
    document.body.append(native.aside)
    expect(native.toggle).not.toBeInstanceOf(HTMLButtonElement)
    const host = bind()
    expect(host.parentElement).toBe(native.header)
  })
  it("hides on collapse, modal hiding or insufficient space and reconnects when suitable", async () => {
    const native = sidebarFixture(), host = bind()
    native.brand.setAttribute("viewBox", "0 0 24 24")
    await waitFor(() => expect(host.isConnected).toBe(false))
    native.brand.setAttribute("viewBox", "0 0 549 307")
    await waitFor(() => expect(host.isConnected).toBe(true))
    native.aside.setAttribute("aria-hidden", "true")
    await waitFor(() => expect(host.isConnected).toBe(false))
    native.aside.removeAttribute("aria-hidden")
    await waitFor(() => expect(host.isConnected).toBe(true))
    native.setToggleLeft(140); window.dispatchEvent(new Event("resize"))
    await waitFor(() => expect(host.isConnected).toBe(false))
    native.setToggleLeft(288); window.dispatchEvent(new Event("resize"))
    await waitFor(() => expect(host.isConnected).toBe(true))
  })
  it("does not attach to ambiguous headers or create a body-floating fallback", () => {
    const native = sidebarFixture()
    native.header.append(document.createElement("button"))
    const host = bind()
    expect(host.isConnected).toBe(false)
    expect(document.body.contains(host)).toBe(false)
  })
  it("disconnects observers and removes the host on disposal", async () => {
    const native = sidebarFixture(), host = bind()
    disposers.pop()!()
    native.header.className = "after-disposal"
    await new Promise(resolve => setTimeout(resolve, 40))
    expect(host.isConnected).toBe(false)
  })
})
describe("opening after the native mobile Drawer", () => {
  it("does not toggle the desktop sidebar and rejects stale hosts", async () => {
    const native = sidebarFixture(), host = bind(), click = vi.fn()
    native.toggle.addEventListener("click", click)
    await expect(prepareSidebarOpen(host)).resolves.toBeUndefined()
    expect(click).not.toHaveBeenCalled()
    native.aside.remove()
    await expect(prepareSidebarOpen(host)).rejects.toThrow("sidebar changed")
  })
  it("waits for both Drawer removal and body-root aria restoration, retaining the native opener", async () => {
    const drawer = document.createElement("section")
    drawer.setAttribute("role", "dialog"); drawer.setAttribute("aria-modal", "true"); document.body.append(drawer)
    const native = sidebarFixture(drawer), host = bind()
    const opener = document.createElement("button"); opener.setAttribute("aria-label", "Show Sidebar"); document.body.append(opener)
    const panel = document.createElement("div"); panel.id = "venice-sync-userscript-host"; panel.setAttribute("aria-hidden", "true"); document.body.append(panel)
    native.toggle.addEventListener("click", () => { drawer.remove(); setTimeout(() => panel.removeAttribute("aria-hidden"), 40) })
    let opened = false
    const opening = prepareSidebarOpen(host).then(result => { opened = true; return result })
    await Promise.resolve()
    expect(opened).toBe(false)
    await expect(opening).resolves.toBe(opener)
    expect(panel).not.toHaveAttribute("aria-hidden")
  })
  it("explicitly rejects a Drawer that cannot close instead of opening beneath it", async () => {
    vi.useFakeTimers()
    const drawer = document.createElement("section")
    drawer.setAttribute("role", "dialog"); drawer.setAttribute("aria-modal", "true"); document.body.append(drawer)
    sidebarFixture(drawer)
    const host = bind(), result = expect(prepareSidebarOpen(host)).rejects.toThrow("did not close")
    await vi.advanceTimersByTimeAsync(3000)
    await result
  })
})
