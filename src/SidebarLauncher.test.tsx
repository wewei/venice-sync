import { act, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, describe, expect, it } from "vitest"
import { mountApp, HOST_ID } from "./mount"
import { LAUNCHER_ID } from "./sidebar-launcher"
import { sidebarFixture } from "./test/sidebar-fixture"

let mounted: ReturnType<typeof mountApp> | undefined
afterEach(() => {
  act(() => { if (mounted?.status === "mounted") mounted.unmount() })
  mounted = undefined; document.body.replaceChildren()
})
function setup() {
  act(() => { mounted = mountApp({ mode: "userscript", handler: "Tampermonkey", version: "test" }, "") })
  const body = document.getElementById(HOST_ID)!.shadowRoot!.querySelector<HTMLElement>("[data-venice-sync-app]")!
  const launcher = document.getElementById(LAUNCHER_ID)!
  return { ui: within(body), launcher: within(launcher.shadowRoot!.querySelector<HTMLElement>("[data-venice-sync-launcher]")!) }
}
describe("isolated sidebar launcher", () => {
  it("opens the existing panel from a separate Shadow root and restores desktop focus", async () => {
    sidebarFixture()
    const { ui, launcher } = setup(), user = userEvent.setup()
    expect(ui.queryByRole("button", { name: "Venice Sync" })).toBeNull()
    const button = launcher.getByRole("button", { name: "Venice Sync" })
    expect(button).toHaveAttribute("title", "Venice Sync")
    await user.click(button)
    expect(await ui.findByRole("dialog", { name: "Venice Sync" })).toBeVisible()
    await user.click(ui.getByRole("button", { name: "Close" }))
    await waitFor(() => expect(button.getRootNode()).toHaveProperty("activeElement", button))
  })
  it("closes the native Drawer before opening and returns focus to Show Sidebar", async () => {
    const drawer = document.createElement("section")
    drawer.setAttribute("role", "dialog"); drawer.setAttribute("aria-modal", "true"); document.body.append(drawer)
    const native = sidebarFixture(drawer), opener = document.createElement("button")
    opener.setAttribute("aria-label", "Show Sidebar"); document.body.append(opener)
    const { ui, launcher } = setup(), body = document.getElementById(HOST_ID)!
    body.setAttribute("aria-hidden", "true")
    native.toggle.addEventListener("click", () => { drawer.remove(); body.removeAttribute("aria-hidden") })
    await userEvent.click(launcher.getByRole("button", { name: "Venice Sync" }))
    expect(await ui.findByRole("dialog", { name: "Venice Sync" })).toBeVisible()
    expect(drawer.isConnected).toBe(false)
    await userEvent.click(ui.getByRole("button", { name: "Close" }))
    await waitFor(() => expect(document.activeElement).toBe(opener))
  })
  it("preserves trigger toggling and announces the expanded state", async () => {
    sidebarFixture()
    const { ui, launcher } = setup(), user = userEvent.setup()
    const button = launcher.getByRole("button", { name: "Venice Sync" })
    expect(button).toHaveAttribute("aria-expanded", "false")
    await user.click(button)
    expect(await ui.findByRole("dialog", { name: "Venice Sync" })).toBeVisible()
    expect(button).toHaveAttribute("aria-expanded", "true")
    await user.click(button)
    await waitFor(() => expect(ui.queryByRole("dialog", { name: "Venice Sync" })).toBeNull())
    expect(button).toHaveAttribute("aria-expanded", "false")
  })
})
