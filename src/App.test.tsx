import { cleanup, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { ReactNode } from "react"
import { App } from "./App"
import { BatchBasket, BasketItem } from "./BatchBasket"
import { nativePageFixture } from "./test/native-page-fixture"

vi.mock("./SyncPanel", () => ({
  SyncPanel: ({ onImportingChange, header, visible }: { onImportingChange: (busy: boolean) => void; header: ReactNode; visible: boolean }) => <BatchBasket header={header} visible={visible}>
    <button onClick={() => onImportingChange(true)}>Begin test import</button>
    <button onClick={() => onImportingChange(false)}>Finish test import</button>
    <input aria-label="Workspace preview" defaultValue="Keep this preview" />
    <BasketItem item={{ kind: "classic", id: "fixture", title: "Test conversation" }} />
  </BatchBasket>,
}))
afterEach(() => { cleanup(); document.body.replaceChildren() })
function setup(mobile = false) {
  const native = nativePageFixture({ preview: true, mobile }), host = document.createElement("div")
  document.body.append(host)
  render(<App runtime={{ mode: "preview", handler: "Test", version: "test" }} host={host} />, { container: host })
  return { ...native, host, user: userEvent.setup() }
}
const workspace = () => screen.getByRole("region", { name: "Venice Sync" })
describe("native-looking Sync page lifetime", () => {
  it("fills the native content area without a dialog, backdrop or URL change and restores the original page", async () => {
    const state = setup(), url = location.href, length = history.length
    state.main.scrollTop = 137
    await state.user.click(screen.getByRole("button", { name: "Venice Sync" }))
    expect(state.host.parentElement).toBe(state.main)
    expect(state.content).toHaveAttribute("inert")
    expect(screen.queryByRole("dialog")).toBeNull()
    expect(screen.queryByTestId("sync-backdrop")).toBeNull()
    expect(screen.getByRole("heading", { name: "Venice Sync" })).toHaveFocus()
    expect(location.href).toBe(url); expect(history.length).toBe(length)
    await state.user.click(document.body)
    expect(workspace()).toBeVisible()
    await state.user.click(screen.getByRole("button", { name: "Back to Venice" }))
    expect(screen.queryByRole("region", { name: "Venice Sync" })).toBeNull()
    expect(state.host.parentElement).toBe(document.body)
    expect(state.content).not.toHaveAttribute("inert")
    expect(state.main.scrollTop).toBe(137)
    expect(state.input.value).toBe("Original Venice draft")
  })
  it("retains the workspace preview and basket while returning to Venice and reopening", async () => {
    const { user } = setup()
    await user.click(screen.getByRole("button", { name: "Venice Sync" }))
    await user.type(screen.getByRole("textbox", { name: "Workspace preview" }), " edited")
    await user.click(screen.getByRole("button", { name: "Add to export basket: Test conversation" }))
    await user.click(screen.getByRole("button", { name: "Back to Venice" }))
    await user.click(screen.getByRole("button", { name: "Venice Sync" }))
    expect(screen.getByRole("textbox", { name: "Workspace preview" })).toHaveValue("Keep this preview edited")
    expect(screen.getByRole("button", { name: "Export basket (1)" })).toBeVisible()
  })
  it("blocks return, native navigation and Escape while batch writes are running", async () => {
    const { user } = setup()
    const link = document.createElement("a"); link.href = "/minds"; document.body.append(link)
    await user.click(screen.getByRole("button", { name: "Venice Sync" }))
    await user.click(screen.getByRole("button", { name: "Begin test import" }))
    expect(workspace()).toHaveAttribute("aria-busy", "true")
    expect(screen.getByRole("button", { name: "Back to Venice" })).toBeDisabled()
    const click = new MouseEvent("click", { bubbles: true, cancelable: true })
    link.dispatchEvent(click)
    expect(click.defaultPrevented).toBe(true)
    await user.keyboard("{Escape}")
    await user.click(document.body)
    expect(workspace()).toBeVisible()
    expect(screen.getByRole("status")).toHaveTextContent("Batch import is running")
    await user.click(screen.getByRole("button", { name: "Finish test import" }))
    expect(workspace()).toHaveAttribute("aria-busy", "false")
    await user.click(screen.getByRole("button", { name: "Back to Venice" }))
    expect(screen.queryByRole("region", { name: "Venice Sync" })).toBeNull()
  })
  it("uses Escape to return from the basket before returning to Venice", async () => {
    const { user } = setup()
    await user.click(screen.getByRole("button", { name: "Venice Sync" }))
    await user.click(screen.getByRole("button", { name: "Export basket (0)" }))
    expect(screen.getByRole("region", { name: "Content basket" })).toBeVisible()
    expect(screen.queryByRole("dialog")).toBeNull()
    await user.keyboard("{Escape}")
    expect(workspace()).toBeVisible()
    expect(screen.queryByRole("region", { name: "Content basket" })).toBeNull()
    await user.keyboard("{Escape}")
    expect(screen.queryByRole("region", { name: "Venice Sync" })).toBeNull()
  })
  it("returns before normal native navigation without changing the route itself", async () => {
    const { user } = setup(), link = document.createElement("a")
    link.href = "/minds"; link.textContent = "Native Minds"; document.body.append(link)
    link.addEventListener("click", event => event.preventDefault())
    await user.click(screen.getByRole("button", { name: "Venice Sync" }))
    await user.click(link)
    await waitFor(() => expect(screen.queryByRole("region", { name: "Venice Sync" })).toBeNull())
  })
  it("opens real mobile navigation through its original button rather than cloning it", async () => {
    const state = setup(true), opened = vi.fn()
    state.opener!.addEventListener("click", opened)
    await state.user.click(screen.getByRole("button", { name: "Venice Sync" }))
    await state.user.click(screen.getByRole("button", { name: "Open Venice navigation" }))
    expect(opened).toHaveBeenCalledOnce()
    expect(workspace()).toBeVisible()
  })
})
