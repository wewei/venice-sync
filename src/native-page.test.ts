import { waitFor } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { bindNativePage, findNativePage, nativeNavigationButton } from "./native-page"
import { sidebarFixture } from "./test/sidebar-fixture"
import { nativePageFixture } from "./test/native-page-fixture"

const disposers: (() => void)[] = []
afterEach(() => {
  disposers.splice(0).forEach(dispose => dispose())
  document.body.replaceChildren()
})
function setup(mobile = false) {
  const sidebar = mobile ? undefined : sidebarFixture().aside
  const native = nativePageFixture({ sidebar, mobile }), host = document.createElement("div")
  document.body.append(host)
  const onFrameChange = vi.fn(), onUnavailable = vi.fn(), onNavigation = vi.fn()
  const dispose = bindNativePage(host, { onFrameChange, onUnavailable, onNavigation })
  disposers.push(dispose)
  return { ...native, host, onFrameChange, onUnavailable, onNavigation, dispose }
}
describe("native content-page binding", () => {
  it("finds the content sibling without depending on Venice's hashed classes", () => {
    const sidebar = sidebarFixture(), native = nativePageFixture({ sidebar: sidebar.aside })
    expect(findNativePage()).toBe(native.main)
    expect(native.main.tagName).toBe("DIV")
  })
  it("uses the mobile content ancestor and retains the native navigation opener", () => {
    const native = nativePageFixture({ mobile: true })
    expect(findNativePage()).toBe(native.main)
    expect(nativeNavigationButton()).toBe(native.opener)
  })
  it("does not choose an ambiguous right-hand content region", () => {
    const sidebar = sidebarFixture(), native = nativePageFixture({ sidebar: sidebar.aside })
    const other = document.createElement("div")
    other.getBoundingClientRect = native.main.getBoundingClientRect
    native.frame.append(other)
    expect(findNativePage()).toBeUndefined()
  })
  it("keeps the original DOM mounted and restores native attributes, inline styles and scroll", () => {
    const sidebar = sidebarFixture(), native = nativePageFixture({ sidebar: sidebar.aside })
    const host = document.createElement("div"); document.body.append(host)
    native.main.style.overflow = "auto"; native.main.scrollTop = 137
    native.content.setAttribute("aria-hidden", "false")
    native.input.setSelectionRange(2, 7)
    const dispose = bindNativePage(host, { onFrameChange: vi.fn(), onUnavailable: vi.fn(), onNavigation: vi.fn() })
    expect(host.parentElement).toBe(native.main)
    expect(native.content).toHaveAttribute("inert")
    expect(native.content).toHaveAttribute("aria-hidden", "true")
    expect(sidebar.aside).not.toHaveAttribute("inert")
    expect(native.main.style.isolation).toBe("isolate")
    native.content.scrollTop = 230
    dispose()
    expect(host.parentElement).toBe(document.body)
    expect(native.main.scrollTop).toBe(137)
    expect(native.content.scrollTop).toBe(0)
    expect(native.main.style.overflow).toBe("auto")
    expect(native.main.style.isolation).toBe("")
    expect(native.content).not.toHaveAttribute("inert")
    expect(native.content).toHaveAttribute("aria-hidden", "false")
    expect(native.input.value).toBe("Original Venice draft")
    expect([native.input.selectionStart, native.input.selectionEnd]).toEqual([2, 7])
  })
  it("isolates new native children while open without touching the native sidebar", async () => {
    const state = setup(), child = document.createElement("div")
    state.main.append(child)
    await waitFor(() => expect(child).toHaveAttribute("inert"))
    state.dispose()
    expect(child).not.toHaveAttribute("inert")
  })
  it("reattaches the same host when the native content subtree is replaced", async () => {
    const state = setup(), replacement = document.createElement("div")
    replacement.getBoundingClientRect = state.main.getBoundingClientRect
    state.main.replaceWith(replacement)
    await waitFor(() => expect(state.host.parentElement).toBe(replacement))
    expect(state.content).not.toHaveAttribute("inert")
    state.dispose()
    expect(state.host.parentElement).toBe(document.body)
  })
  it("reports missing content and hides rather than creating a viewport-covering fallback", async () => {
    const state = setup()
    state.frame.remove()
    await waitFor(() => expect(state.onUnavailable).toHaveBeenCalledWith(expect.stringContaining("unavailable")))
    expect(state.host.style.display).toBe("none")
    expect(state.host.parentElement).toBe(document.body)
    const replacement = nativePageFixture({ sidebar: sidebarFixture().aside })
    await waitFor(() => expect(state.host.parentElement).toBe(replacement.main))
    expect(state.onUnavailable).toHaveBeenLastCalledWith(undefined)
  })
  it("preserves native style changes made while the workspace was open", () => {
    const state = setup()
    state.main.style.overflow = "clip"
    state.dispose()
    expect(state.main.style.overflow).toBe("clip")
  })
})
