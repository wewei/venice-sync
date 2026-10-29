import { cleanup, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, describe, expect, it, vi } from "vitest"
import { App } from "./App"
import type { ReactNode } from "react"
import { BatchBasket } from "./BatchBasket"

vi.mock("./SyncPanel", () => ({
  SyncPanel: ({ onImportingChange, header }: { onImportingChange: (busy: boolean) => void; header: ReactNode }) => <BatchBasket header={header}>
    <button onClick={() => onImportingChange(true)}>Begin test import</button>
    <button onClick={() => onImportingChange(false)}>Finish test import</button>
  </BatchBasket>,
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
  it("lets Escape dismiss only the basket, including while Sync is locked for import", async () => {
    const portal = document.createElement("div"); document.body.append(portal)
    render(<App runtime={{ mode: "preview", handler: "Test", version: "test" }} portalContainer={portal} />)
    const user = userEvent.setup()
    await user.click(screen.getByRole("button", { name: "Venice Sync" }))
    await user.click(screen.getByRole("button", { name: "Export basket (0)" }))
    await user.keyboard("{Escape}")
    expect(screen.getByRole("dialog", { name: "Venice Sync" })).toBeVisible()
    expect(screen.queryByRole("dialog", { name: "Content basket" })).toBeNull()
    await user.click(screen.getByRole("button", { name: "Begin test import" }))
    await user.click(screen.getByRole("button", { name: "Export basket (0)" }))
    await user.keyboard("{Escape}")
    expect(screen.queryByRole("dialog", { name: "Content basket" })).toBeNull()
    await user.keyboard("{Escape}")
    await user.click(document.body)
    expect(screen.getByRole("dialog", { name: "Venice Sync" })).toBeVisible()
    await user.click(screen.getByRole("button", { name: "Finish test import" }))
    await user.keyboard("{Escape}")
    expect(screen.queryByRole("dialog", { name: "Venice Sync" })).toBeNull()
  })
})
