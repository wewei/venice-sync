import { cleanup, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, describe, expect, it, vi } from "vitest"
import { App } from "./App"

vi.mock("./SyncPanel", () => ({
  SyncPanel: ({ onImportingChange }: { onImportingChange: (busy: boolean) => void }) => <div>
    <button onClick={() => onImportingChange(true)}>Begin test import</button>
    <button onClick={() => onImportingChange(false)}>Finish test import</button>
  </div>,
}))
afterEach(() => { cleanup(); document.body.replaceChildren() })
describe("batch write dialog lifetime", () => {
  it("prevents close, Escape and outside dismissal while a batch write is running", async () => {
    const portal = document.createElement("div"); document.body.append(portal)
    render(<App runtime={{ mode: "preview", handler: "Test", version: "test" }} portalContainer={portal} />)
    const user = userEvent.setup()
    await user.click(screen.getByRole("button", { name: "Venice Sync" }))
    await user.click(screen.getByRole("button", { name: "Begin test import" }))
    expect(screen.queryByRole("button", { name: "Close" })).toBeNull()
    await user.keyboard("{Escape}")
    expect(screen.getByRole("dialog", { name: "Venice Sync" })).toBeVisible()
    await user.click(document.body)
    expect(screen.getByRole("dialog", { name: "Venice Sync" })).toBeVisible()
    await user.click(screen.getByRole("button", { name: "Finish test import" }))
    expect(screen.getByRole("button", { name: "Close" })).toBeVisible()
    await user.keyboard("{Escape}")
    expect(screen.queryByRole("dialog", { name: "Venice Sync" })).toBeNull()
  })
})
