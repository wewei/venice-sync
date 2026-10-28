import { act, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, describe, expect, it } from "vitest"
import { HOST_ID, mountApp } from "./mount"

let mounted: ReturnType<typeof mountApp> | undefined

afterEach(() => {
  act(() => {
    if (mounted?.status === "mounted") mounted.unmount()
  })
  mounted = undefined
  document.getElementById(HOST_ID)?.remove()
})

function setup() {
  act(() => {
    mounted = mountApp(
      { mode: "preview", handler: "Test preview", version: "test" },
      ":host { color: red; }",
    )
  })
  const host = document.getElementById(HOST_ID)
  const container =
    host?.shadowRoot?.querySelector<HTMLElement>("[data-venice-sync-app]")
  if (!host || !container) throw new Error("UI was not mounted")
  return { host, container, ui: within(container) }
}

describe("isolated UI", () => {
  it("mounts styles and content inside one Shadow DOM", () => {
    const { host, ui } = setup()
    expect(host.shadowRoot?.querySelector("style")).toHaveTextContent(
      ":host { color: red; }",
    )
    expect(ui.getByRole("button", { name: "Venice Sync" })).toBeVisible()
    expect(document.querySelector("style")).toBeNull()
    expect(document.querySelector("[data-slot=button]")).toBeNull()
  })

  it("does not inject duplicate hosts", () => {
    setup()
    const result = mountApp(
      { mode: "preview", handler: "Test", version: "test" },
      "",
    )
    expect(result.status).toBe("already-mounted")
    expect(document.querySelectorAll(`#${HOST_ID}`)).toHaveLength(1)
  })

  it("portals the dialog into the shadow tree and supports interaction", async () => {
    const user = userEvent.setup()
    const { host, ui } = setup()
    await user.click(ui.getByRole("button", { name: "Venice Sync" }))
    const dialog = ui.getByRole("dialog", { name: "Venice Sync" })
    expect(dialog.getRootNode()).toBe(host.shadowRoot)
    expect(document.querySelector('[role="dialog"]')).toBeNull()
    expect(ui.getByRole("heading", { name: "Download & upload" })).toBeVisible()
    expect(ui.queryByTestId("runtime-handler")).toBeNull()
    expect(host.shadowRoot?.activeElement).toBe(ui.getByRole("button", { name: "Overview" }))
    await user.click(ui.getByRole("button", { name: "Details" }))
    await user.click(ui.getByText("UI smoke test", { exact: true }))
    await user.click(ui.getByRole("button", { name: "Test interaction" }))
    expect(ui.getByRole("status")).toHaveTextContent("Test clicks: 1")
    await user.click(ui.getByRole("button", { name: "Close" }))
    expect(ui.queryByRole("dialog")).toBeNull()
  })

  it("reports an incompatible host instead of silently skipping", () => {
    const collision = document.createElement("div")
    collision.id = HOST_ID
    document.body.append(collision)
    expect(() =>
      mountApp({ mode: "preview", handler: "Test", version: "test" }, ""),
    ).toThrow("exists without a Shadow DOM")
  })

  it("stays open when the host page moves focus outside the shadow tree", async () => {
    const user = userEvent.setup()
    const { ui } = setup()
    await user.click(ui.getByRole("button", { name: "Venice Sync" }))
    const input = document.createElement("input")
    document.body.append(input)
    try {
      act(() => input.focus())
      expect(document.activeElement).toBe(input)
      expect(ui.getByRole("dialog", { name: "Venice Sync" })).toBeVisible()
    } finally {
      input.remove()
    }
  })
})
