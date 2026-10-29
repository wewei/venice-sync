import { act, cleanup, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { BatchBasket, BasketAddAll, BasketItem } from "./BatchBasket"
import { exportBatch, validateBatchContents } from "./batch-export"
import { decodeBatch, encodeBatch, reconstructBatchItem, type BatchPackage, type BatchSelection } from "./batch-format"
import { currentVeniceOwner } from "./venice-classic"

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
  </BatchBasket>)
}
function file() {
  const file = new File(["batch"], "batch.zip", { type: "application/zip" })
  Object.defineProperty(file, "arrayBuffer", { value: async () => new ArrayBuffer(5) })
  return file
}
describe("cross-page export basket UI", () => {
  it("adds/removes unique items and add-all does not duplicate selections", async () => {
    setup(); const user = userEvent.setup()
    await user.click(screen.getByRole("button", { name: "Add to export basket: Conversation A" }))
    await user.click(screen.getByRole("button", { name: "Add all test items (2)" }))
    await user.click(screen.getByRole("button", { name: "Export basket (2)" }))
    expect(screen.getAllByLabelText(/Remove basket item:/)).toHaveLength(2)
    await user.click(screen.getByRole("button", { name: "Remove from export basket: Mind B" }))
    expect(screen.getByRole("button", { name: "Export basket (1)" })).toBeVisible()
    await user.click(screen.getByRole("button", { name: "Clear export basket" }))
    expect(screen.getByRole("button", { name: "Download export basket" })).toBeDisabled()
  })
  it("downloads one batch, preserves the basket, and explicitly surfaces failures without a partial download", async () => {
    setup(); const user = userEvent.setup()
    await user.click(screen.getByRole("button", { name: "Add all test items (2)" }))
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
    await user.upload(screen.getByLabelText("Open batch ZIP"), file())
    expect(await screen.findByRole("region", { name: "Opened batch contents" })).toBeVisible()
    expect(validateBatchContents).toHaveBeenCalledWith(pkg)
    expect(exportBatch).not.toHaveBeenCalled()
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
    await user.click(screen.getByRole("button", { name: "Download export basket" }))
    expect(await screen.findByRole("alert")).toHaveTextContent("account changed")
    expect(click).not.toHaveBeenCalled()
  })
})
