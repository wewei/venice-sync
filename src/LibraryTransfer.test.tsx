import { cleanup, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { LibraryTransfer } from "./LibraryTransfer"
import { decodeLibraryPackage, rawLibraryPackage, type LibraryPackage } from "./library-format"
import { importLibraryAsset, listLibraryAssets } from "./venice-library"

vi.mock("./venice-library", () => ({
  listLibraryAssets: vi.fn(), readLibraryAsset: vi.fn(), exportLibraryAsset: vi.fn(), importLibraryAsset: vi.fn(),
}))
vi.mock("./library-format", () => ({
  decodeLibraryPackage: vi.fn(), encodeLibraryPackage: vi.fn(), rawLibraryPackage: vi.fn(), MAX_LIBRARY_ZIP: 128 * 1024 * 1024,
}))
const reloadPage = vi.fn()
const pkg: LibraryPackage = {
  manifest: { format: "venice-sync-library-asset", version: 1, exportedAt: "test",
    asset: { filename: "fixture.png", kind: "image", mimeType: "image/png", bytes: 3, sha256: "0".repeat(64), source: { type: "file", id: "", metadata: {} } } },
  bytes: new Uint8Array([1, 2, 3]),
}
beforeEach(() => {
  vi.mocked(listLibraryAssets).mockResolvedValue([])
  vi.mocked(decodeLibraryPackage).mockResolvedValue(pkg)
})
afterEach(() => { cleanup(); vi.resetAllMocks() })
function archive() {
  const file = new File(["zip"], "asset.zip", { type: "application/zip" })
  Object.defineProperty(file, "arrayBuffer", { value: async () => new ArrayBuffer(3) })
  return file
}
describe("Library asset WebUI", () => {
  it("previews checksummed archives before creating an independent media container", async () => {
    const user = userEvent.setup()
    vi.mocked(importLibraryAsset).mockResolvedValue("new-asset")
    render(<LibraryTransfer reloadPage={reloadPage} />)
    await screen.findByText("No generated Library assets in this account.")
    await user.upload(screen.getByLabelText("Import Library asset"), archive())
    const preview = await screen.findByTestId("library-import-preview")
    expect(preview).toHaveTextContent("fixture.png")
    expect(preview).toHaveTextContent("It may also appear in Conversations")
    expect(importLibraryAsset).not.toHaveBeenCalled()
    await user.click(screen.getByRole("button", { name: "Confirm import as new Library asset" }))
    expect(await screen.findByText(/Imported as a new independent Library asset/)).toBeVisible()
    expect(importLibraryAsset).toHaveBeenCalledWith(pkg)
    expect(reloadPage).toHaveBeenCalledOnce()
  })
  it("cancels without writing and exposes validation failures", async () => {
    const user = userEvent.setup()
    render(<LibraryTransfer reloadPage={reloadPage} />)
    await screen.findByText("No generated Library assets in this account.")
    const input = screen.getByLabelText("Import Library asset")
    await user.upload(input, archive()); await screen.findByTestId("library-import-preview")
    await user.click(screen.getByRole("button", { name: "Cancel Library import" }))
    expect(importLibraryAsset).not.toHaveBeenCalled()
    vi.mocked(decodeLibraryPackage).mockRejectedValue(new Error("Checksum mismatch"))
    await user.upload(input, archive())
    expect(await screen.findByRole("alert")).toHaveTextContent("Checksum mismatch")
    expect(reloadPage).not.toHaveBeenCalled()
  })
  it("previews raw files and keeps failed imports available without reloading", async () => {
    const user = userEvent.setup()
    vi.mocked(rawLibraryPackage).mockResolvedValue(pkg)
    vi.mocked(importLibraryAsset).mockRejectedValue(new Error("File cleanup is incomplete"))
    render(<LibraryTransfer reloadPage={reloadPage} />)
    await screen.findByText("No generated Library assets in this account.")
    await user.upload(screen.getByLabelText("Import Library asset"), new File(["png"], "fixture.png", { type: "image/png" }))
    await screen.findByTestId("library-import-preview")
    expect(rawLibraryPackage).toHaveBeenCalledOnce()
    expect(decodeLibraryPackage).not.toHaveBeenCalled()
    await user.click(screen.getByRole("button", { name: "Confirm import as new Library asset" }))
    expect(await screen.findByRole("alert")).toHaveTextContent("File cleanup is incomplete")
    expect(screen.getByTestId("library-import-preview")).toBeVisible()
    expect(reloadPage).not.toHaveBeenCalled()
  })
})
