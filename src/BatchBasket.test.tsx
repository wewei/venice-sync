import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { BatchBasket, BasketAddAll, BasketItem } from "./BatchBasket"
import { exportBatch, validateBatchContents } from "./batch-export"
import { batchKey, decodeBatch, encodeBatch, reconstructBatchItem, type BatchPackage, type BatchSelection } from "./batch-format"
import { currentVeniceOwner } from "./venice-classic"
import { importBatch, planBatchImport, unresolvedBatchDestinations, type BatchImportResult } from "./batch-import"

vi.mock("./batch-import", () => ({ importBatch: vi.fn(), planBatchImport: vi.fn(), unresolvedBatchDestinations: vi.fn() }))
vi.mock("./venice-classic", () => ({ currentVeniceOwner: vi.fn() }))
vi.mock("./batch-export", () => ({ exportBatch: vi.fn(), validateBatchContents: vi.fn() }))
vi.mock("./batch-format", async importOriginal => ({
  ...await importOriginal<typeof import("./batch-format")>(), decodeBatch: vi.fn(), encodeBatch: vi.fn(), reconstructBatchItem: vi.fn(),
}))
const selections: BatchSelection[] = [
  { kind: "classic", id: "a", title: "Conversation A" }, { kind: "mind", id: "b", title: "Mind B" },
]
const pkg: BatchPackage = {
  manifest: { format: "venice-sync-batch", version: 1, exportedAt: "2026-10-29T00:00:00.000Z",
    items: [{ ...selections[0], filename: "classic.json", packaging: "json", files: [{ path: "export.json", object: "a".repeat(64), bytes: 2 }] }] },
  objects: { ["a".repeat(64)]: new Uint8Array([123, 125]) },
}
let click: ReturnType<typeof vi.spyOn>
beforeEach(() => {
  vi.resetAllMocks()
  vi.mocked(currentVeniceOwner).mockReturnValue("owner")
  vi.stubGlobal("URL", { createObjectURL: vi.fn(() => "blob:test"), revokeObjectURL: vi.fn() })
  click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined)
  vi.mocked(exportBatch).mockResolvedValue(pkg)
  vi.mocked(encodeBatch).mockResolvedValue(new Uint8Array([1, 2]))
  vi.mocked(decodeBatch).mockResolvedValue(pkg)
  vi.mocked(reconstructBatchItem).mockReturnValue(new Uint8Array([123, 125]))
  vi.mocked(validateBatchContents).mockResolvedValue(undefined)
})
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals() })
function setup() {
  return render(<BatchBasket>
    <BasketItem item={selections[0]} />
    <BasketItem item={selections[1]} />
    <BasketAddAll items={selections} label="test items" />
    <button>Existing import</button>
    <input aria-label="Existing page preview" defaultValue="Keep my preview" />
  </BatchBasket>)
}
function file() {
  const file = new File(["batch"], "batch.zip", { type: "application/zip" })
  Object.defineProperty(file, "arrayBuffer", { value: async () => new ArrayBuffer(5) })
  return file
}
describe("cross-page export basket UI", () => {
  it("uses a compact trigger, keeps the content mounted and restores focus and page position on Back/Escape", async () => {
    setup(); const user = userEvent.setup()
    const preview = screen.getByRole("textbox", { name: "Existing page preview" })
    preview.parentElement!.scrollTop = 137
    expect(screen.queryByRole("region", { name: "Export basket" })).toBeNull()
    expect(screen.queryByRole("button", { name: "Download export basket" })).toBeNull()
    const trigger = screen.getByRole("button", { name: "Export basket (0)" })
    expect(trigger).toHaveAttribute("aria-expanded", "false")
    await user.click(trigger)
    expect(preview.closest("[inert]")).not.toBeNull()
    const back = screen.getByRole("button", { name: "Back to content" })
    expect(back).toHaveFocus()
    act(() => preview.focus())
    expect(back).toHaveFocus()
    await user.tab({ shift: true })
    expect(screen.getByRole("button", { name: "Import from backup" })).toHaveFocus()
    await user.tab()
    expect(back).toHaveFocus()
    await user.keyboard("{Escape}")
    expect(trigger).toHaveFocus()
    expect(trigger).toHaveAttribute("aria-expanded", "false")
    expect(preview.closest("[inert]")).toBeNull()
    expect(preview).toHaveValue("Keep my preview")
    expect(preview.parentElement!.scrollTop).toBe(137)
    await user.click(trigger)
    await user.click(screen.getByTestId("batch-basket-overlay").firstElementChild!)
    expect(trigger).toHaveFocus()
  })
  it("traps keyboard focus within its own Shadow DOM without a body portal", async () => {
    const host = document.createElement("div"); document.body.append(host)
    const shadow = host.attachShadow({ mode: "open" }), container = document.createElement("div")
    shadow.append(container)
    const mounted = render(<BatchBasket><button>Content action</button></BatchBasket>, { container })
    const ui = within(container), user = userEvent.setup()
    const trigger = ui.getByRole("button", { name: "Export basket (0)" })
    await user.click(trigger)
    const back = ui.getByLabelText("Back to content")
    expect(shadow.activeElement).toBe(back)
    await user.tab({ shift: true })
    expect(shadow.activeElement).toBe(ui.getByRole("button", { name: "Import from backup", hidden: true }))
    await user.keyboard("{Escape}")
    expect(shadow.activeElement).toBe(trigger)
    expect(ui.getByTestId("batch-basket-overlay")).toHaveAttribute("hidden")
    expect(document.body.querySelector('[aria-label="Basket views"]')).toBeNull()
    mounted.unmount(); host.remove()
  })
  it("adds/removes unique items and add-all does not duplicate selections", async () => {
    setup(); const user = userEvent.setup()
    await user.click(screen.getByRole("button", { name: "Add to export basket: Conversation A" }))
    await user.click(screen.getByRole("button", { name: "Add all test items (2)" }))
    await user.click(screen.getByRole("button", { name: "Export basket (2)" }))
    expect(screen.getAllByLabelText(/Remove basket item:/)).toHaveLength(2)
    await user.click(screen.getByRole("button", { name: "Back to content" }))
    await user.click(screen.getByRole("button", { name: "Remove from export basket: Mind B" }))
    expect(screen.getByRole("button", { name: "Export basket (1)" })).toBeVisible()
    await user.click(screen.getByRole("button", { name: "Export basket (1)" }))
    await user.click(screen.getByRole("button", { name: "Clear export basket" }))
    expect(screen.getByRole("button", { name: "Download export basket" })).toBeDisabled()
  })
  it("downloads one batch, preserves the basket, and explicitly surfaces failures without a partial download", async () => {
    setup(); const user = userEvent.setup()
    await user.click(screen.getByRole("button", { name: "Add all test items (2)" }))
    await user.click(screen.getByRole("button", { name: "Export basket (2)" }))
    await user.click(screen.getByRole("button", { name: "Download export basket" }))
    expect(await screen.findByText(/2 items exported in one batch/)).toBeVisible()
    expect(exportBatch).toHaveBeenCalledWith(selections, expect.objectContaining({ signal: expect.any(AbortSignal) }))
    expect(click).toHaveBeenCalledOnce()
    vi.mocked(exportBatch).mockRejectedValueOnce(new Error("Missing original. No partial batch was downloaded."))
    await user.click(screen.getByRole("button", { name: "Download export basket" }))
    expect(await screen.findByRole("alert")).toHaveTextContent("Missing original")
    expect(click).toHaveBeenCalledOnce()
    expect(screen.getByRole("button", { name: "Export basket (2)" })).toBeVisible()
  })
  it("disables page actions and cancels without downloading after an in-flight exporter resolves", async () => {
    let resolve: (value: BatchPackage) => void = () => { throw new Error("Export did not start") }
    vi.mocked(exportBatch).mockImplementationOnce((_items, options) => {
      options?.onProgress?.(1)
      return new Promise(done => { resolve = done })
    })
    setup(); const user = userEvent.setup()
    await user.click(screen.getByRole("button", { name: "Add all test items (2)" }))
    await user.click(screen.getByRole("button", { name: "Export basket (2)" }))
    await user.click(screen.getByRole("button", { name: "Download export basket" }))
    expect(screen.getByRole("button", { name: "Existing import" })).toBeDisabled()
    expect(screen.getByText("Preparing 1/2 items...")).toBeVisible()
    await user.click(screen.getByRole("button", { name: "Cancel batch export" }))
    await act(async () => { resolve(pkg) })
    expect(await screen.findByText(/Batch export cancelled/)).toBeVisible()
    expect(click).not.toHaveBeenCalled()
    expect(screen.getByRole("button", { name: "Export basket (2)" })).toBeVisible()
  })
  it("opens a batch read-only and lets users take an existing-format file out", async () => {
    setup(); const user = userEvent.setup()
    await user.click(screen.getByRole("button", { name: "Export basket (0)" }))
    await user.click(screen.getByRole("button", { name: "Import from backup" }))
    await user.upload(screen.getByLabelText("Open batch ZIP"), file())
    expect(await screen.findByRole("region", { name: "Opened batch contents" })).toBeVisible()
    expect(validateBatchContents).toHaveBeenCalledWith(pkg)
    expect(exportBatch).not.toHaveBeenCalled()
    await user.click(screen.getByText("Take out original files"))
    await user.click(screen.getByRole("button", { name: "Take out item: Conversation A" }))
    expect(reconstructBatchItem).toHaveBeenCalledWith(pkg, pkg.manifest.items[0])
    expect(click).toHaveBeenCalledOnce()
    expect(click.mock.instances[0]).toHaveAttribute("download", "classic.json")
    vi.mocked(validateBatchContents).mockRejectedValueOnce(new Error("Invalid original Mind manifest"))
    await user.upload(screen.getByLabelText("Open batch ZIP"), file())
    expect(await screen.findByRole("alert")).toHaveTextContent("Invalid original Mind manifest")
    expect(screen.queryByRole("region", { name: "Opened batch contents" })).toBeNull()
  })
  it("does not download after the panel is closed during an export", async () => {
    let resolve: (value: BatchPackage) => void = () => { throw new Error("Export did not start") }
    vi.mocked(exportBatch).mockImplementationOnce(() => new Promise(done => { resolve = done }))
    const mounted = setup(), user = userEvent.setup()
    await user.click(screen.getByRole("button", { name: "Add all test items (2)" }))
    await user.click(screen.getByRole("button", { name: "Export basket (2)" }))
    await user.click(screen.getByRole("button", { name: "Download export basket" }))
    mounted.unmount()
    await act(async () => { resolve(pkg) })
    await waitFor(() => expect(click).not.toHaveBeenCalled())
  })
  it("rechecks the account immediately before download after archive encoding", async () => {
    vi.mocked(encodeBatch).mockImplementationOnce(async () => {
      vi.mocked(currentVeniceOwner).mockReturnValue("other")
      return new Uint8Array([1])
    })
    setup(); const user = userEvent.setup()
    await user.click(screen.getByRole("button", { name: "Add all test items (2)" }))
    await user.click(screen.getByRole("button", { name: "Export basket (2)" }))
    await user.click(screen.getByRole("button", { name: "Download export basket" }))
    expect(await screen.findByRole("alert")).toHaveTextContent("account changed")
    expect(click).not.toHaveBeenCalled()
  })
  it("keeps a running import and its results when switching views or collapsing the basket", async () => {
    vi.mocked(planBatchImport).mockResolvedValue({ owner: "owner", targets: [], entries: [] })
    vi.mocked(unresolvedBatchDestinations).mockReturnValue([])
    let finish: (() => void) | undefined
    let signal: AbortSignal | undefined
    vi.mocked(importBatch).mockImplementationOnce((_plan, _destinations, options) => {
      signal = options?.signal
      return new Promise(resolve => {
        finish = () => {
          const result: BatchImportResult = { key: batchKey(selections[0]), kind: "classic", title: "Conversation A", status: "success", id: "new-copy" }
          options?.onResult?.(result)
          resolve({ results: [result], stopped: false, needsReload: true })
        }
      })
    })
    const onImportingChange = vi.fn(), reloadPage = vi.fn(), user = userEvent.setup()
    render(<BatchBasket reloadPage={reloadPage} onImportingChange={onImportingChange}><BasketAddAll items={selections} label="test items" /></BatchBasket>)
    await user.click(screen.getByRole("button", { name: "Add all test items (2)" }))
    await user.click(screen.getByRole("button", { name: "Export basket (2)" }))
    await user.click(screen.getByRole("button", { name: "Import from backup" }))
    expect(screen.queryByRole("button", { name: "Remove basket item: Mind B" })).toBeNull()
    await user.upload(screen.getByLabelText("Open batch ZIP"), file())
    await screen.findByRole("checkbox")
    await user.click(screen.getByRole("checkbox"))
    await user.click(screen.getByRole("button", { name: "Review 1 selected imports" }))
    await screen.findByTestId("batch-import-preview")
    await user.click(screen.getByRole("button", { name: "Confirm selected batch import" }))
    expect(onImportingChange).toHaveBeenLastCalledWith(true)
    await user.click(screen.getByRole("button", { name: "To export (2)" }))
    expect(screen.getByRole("button", { name: "Remove basket item: Mind B" })).toBeDisabled()
    await user.click(screen.getByRole("button", { name: "Back to content" }))
    expect(onImportingChange).toHaveBeenLastCalledWith(true)
    expect(signal?.aborted).toBe(false)
    expect(importBatch).toHaveBeenCalledOnce()
    await act(async () => { finish?.() })
    expect(onImportingChange).toHaveBeenLastCalledWith(false)
    expect(signal?.aborted).toBe(false)
    await user.click(screen.getByRole("button", { name: "Export basket (2)" }))
    await user.click(screen.getByRole("button", { name: "Import from backup" }))
    expect(screen.getByRole("log")).toHaveTextContent("New ID: new-copy")
    expect(screen.getByRole("checkbox")).toBeDisabled()
    expect(reloadPage).not.toHaveBeenCalled()
    await user.click(screen.getByRole("button", { name: "Refresh Venice after reviewing results" }))
    expect(reloadPage).toHaveBeenCalledOnce()
  })
})
