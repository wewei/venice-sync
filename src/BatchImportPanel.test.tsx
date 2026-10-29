import { act, cleanup, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { readFileSync } from "node:fs"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { BatchImportPanel } from "./BatchImportPanel"
import { importBatch, planBatchImport, unresolvedBatchDestinations, type BatchImportPlan } from "./batch-import"
import { batchKey, type BatchPackage } from "./batch-format"
import { parseConversationFile } from "./conversation-format"

vi.mock("./batch-import", () => ({ importBatch: vi.fn(), planBatchImport: vi.fn(), unresolvedBatchDestinations: vi.fn() }))
const item = { kind: "classic" as const, id: "fixture", title: "Test conversation", filename: "classic.json", packaging: "json" as const, files: [] }
const archive: BatchPackage = { manifest: { format: "venice-sync-batch", version: 1, exportedAt: "test", items: [item] }, objects: {} }
const plan: BatchImportPlan = { owner: "owner", targets: [], entries: [{
  item, content: { kind: "classic", file: parseConversationFile(readFileSync(path.join("scripts", "fixtures", "classic-conversation.json"), "utf8")) },
}] }
const onBusyChange = vi.fn(), onImportingChange = vi.fn(), reloadPage = vi.fn()
beforeEach(() => {
  vi.resetAllMocks()
  vi.mocked(planBatchImport).mockResolvedValue(plan)
  vi.mocked(unresolvedBatchDestinations).mockReturnValue([])
  vi.mocked(importBatch).mockImplementation(async (_plan, _destinations, options) => {
    const result = { key: batchKey(item), kind: item.kind, title: item.title, status: "success" as const, id: "new-id" }
    options?.onResult?.(result)
    return { results: [result], stopped: false, needsReload: true }
  })
})
afterEach(cleanup)
const setup = () => render(<BatchImportPanel archive={archive} busy={false} onBusyChange={onBusyChange} onImportingChange={onImportingChange} reloadPage={reloadPage} />)
describe("selected batch import UI", () => {
  it("writes only after selection, review and explicit confirmation, with one optional final refresh", async () => {
    setup(); const user = userEvent.setup()
    expect(screen.getByRole("checkbox")).not.toBeChecked()
    await user.click(screen.getByRole("checkbox"))
    await user.click(screen.getByRole("button", { name: "Review 1 selected imports" }))
    expect(await screen.findByTestId("batch-import-preview")).toHaveTextContent("not an all-or-nothing transaction")
    expect(importBatch).not.toHaveBeenCalled()
    await user.click(screen.getByRole("button", { name: "Cancel batch import preview" }))
    expect(importBatch).not.toHaveBeenCalled()
    await user.click(screen.getByRole("button", { name: "Review 1 selected imports" }))
    await screen.findByTestId("batch-import-preview")
    await user.click(screen.getByRole("button", { name: "Confirm selected batch import" }))
    expect(await screen.findByRole("log")).toHaveTextContent("New ID: new-id")
    expect(screen.getByRole("checkbox")).toBeDisabled()
    expect(reloadPage).not.toHaveBeenCalled()
    expect(onImportingChange).toHaveBeenCalledWith(true)
    expect(onImportingChange).toHaveBeenLastCalledWith(false)
    await user.click(screen.getByRole("button", { name: "Refresh Venice after reviewing results" }))
    expect(reloadPage).toHaveBeenCalledOnce()
  })
  it("reports failed attempts explicitly and does not reload or auto-retry", async () => {
    vi.mocked(importBatch).mockImplementationOnce(async (_plan, _destinations, options) => {
      const result = { key: batchKey(item), title: item.title, kind: item.kind, status: "failed" as const, error: "Cleanup incomplete" }
      options?.onResult?.(result)
      return { results: [result], stopped: true, needsReload: false }
    })
    setup(); const user = userEvent.setup()
    await user.click(screen.getByRole("button", { name: "Select all unattempted items" }))
    await user.click(screen.getByRole("button", { name: "Review 1 selected imports" }))
    await screen.findByTestId("batch-import-preview")
    await user.click(screen.getByRole("button", { name: "Confirm selected batch import" }))
    expect(await screen.findByRole("alert")).toHaveTextContent("Successful copies remain")
    expect(screen.getByRole("checkbox")).toBeDisabled()
    expect(screen.getByRole("log")).toHaveTextContent("Cleanup incomplete")
    expect(reloadPage).not.toHaveBeenCalled()
  })
  it("stops after the current item rather than pretending to undo its write", async () => {
    let finish: (() => void) | undefined
    vi.mocked(importBatch).mockImplementationOnce((_plan, _destinations, options) => new Promise(resolve => {
      finish = () => resolve({ results: [], stopped: true, needsReload: false })
      options?.signal?.addEventListener("abort", () => finish?.())
    }))
    setup(); const user = userEvent.setup()
    await user.click(screen.getByRole("checkbox"))
    await user.click(screen.getByRole("button", { name: "Review 1 selected imports" }))
    await screen.findByTestId("batch-import-preview")
    await user.click(screen.getByRole("button", { name: "Confirm selected batch import" }))
    expect(screen.getByRole("button", { name: "Stop after current item" })).toHaveFocus()
    await act(async () => { await user.click(screen.getByRole("button", { name: "Stop after current item" })) })
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("stopped before the remaining items"))
    expect(screen.getByRole("checkbox")).toBeChecked()
    expect(screen.getByRole("status").parentElement).toHaveFocus()
    expect(reloadPage).not.toHaveBeenCalled()
  })
})
