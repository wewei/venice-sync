import { cleanup, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { MindDefinitionTransfer } from "./MindDefinitionTransfer"
import { decodeMindPackage, encodeMindPackage, type MindPackage } from "./mind-package-format"
import { exportMindPackage, importMindPackage, listMindDefinitions } from "./venice-mind-package"

vi.mock("./venice-mind-package", () => ({
  listMindDefinitions: vi.fn(), exportMindPackage: vi.fn(), importMindPackage: vi.fn(), loadMindAvatar: vi.fn(),
}))
vi.mock("./mind-package-format", () => ({
  decodeMindPackage: vi.fn(), encodeMindPackage: vi.fn(), MAX_MIND_PACKAGE_BYTES: 128 * 1024 * 1024,
}))
const pkg: MindPackage = {
  manifest: { format: "venice-sync-mind", version: 1, exportedAt: "test", definition: { id: "original", name: "Fixture Mind" }, files: [] },
  files: {},
}
beforeEach(() => {
  vi.mocked(listMindDefinitions).mockResolvedValue([])
  vi.mocked(decodeMindPackage).mockResolvedValue(pkg)
})
afterEach(() => { cleanup(); vi.resetAllMocks(); vi.restoreAllMocks(); vi.unstubAllGlobals() })
function archive() {
  const file = new File(["zip"], "mind.zip", { type: "application/zip" })
  Object.defineProperty(file, "arrayBuffer", { value: async () => new ArrayBuffer(3) })
  return file
}

describe("Mind definition package UI", () => {
  it("previews before writing and always restores all editor histories without checkboxes", async () => {
    const user = userEvent.setup()
    vi.mocked(importMindPackage).mockResolvedValue("new-id")
    render(<MindDefinitionTransfer />)
    await screen.findByText("No local Mind definitions in this account.")
    await user.upload(screen.getByLabelText("Import Mind package"), archive())
    expect(await screen.findByTestId("mind-package-preview")).toHaveTextContent("Fixture Mind")
    expect(importMindPackage).not.toHaveBeenCalled()
    expect(screen.queryByRole("checkbox")).toBeNull()
    await user.click(screen.getByRole("button", { name: "Confirm import as new Mind" }))
    expect(await screen.findByTestId("imported-mind-definition-link")).toHaveAttribute("href", "/minds/local/new-id/edit")
    expect(importMindPackage).toHaveBeenCalledWith(pkg, { assistant: true, preview: true })
    expect(screen.getByText(/No history tools were replayed/)).toBeVisible()
  })

  it("exports all contents from an accessible icon action", async () => {
    const user = userEvent.setup()
    vi.mocked(listMindDefinitions).mockResolvedValue([{ id: "original", name: "Fixture Mind", assets: 1, published: false }])
    vi.mocked(exportMindPackage).mockResolvedValue(pkg)
    vi.mocked(encodeMindPackage).mockResolvedValue(new Uint8Array([1, 2]))
    const NativeURL = URL
    vi.stubGlobal("URL", class extends NativeURL {
      static createObjectURL = vi.fn(() => "blob:test")
      static revokeObjectURL = vi.fn()
    })
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {})
    render(<MindDefinitionTransfer />)
    await screen.findByRole("heading", { name: "Fixture Mind" })
    const button = screen.getByRole("button", { name: "Export Mind package" })
    expect(button).toHaveAttribute("title", "Export Mind package")
    expect(button.textContent).toBe("")
    await user.click(button)
    expect(await screen.findByText(/Complete Mind package downloaded/)).toBeVisible()
    expect(exportMindPackage).toHaveBeenCalledWith("original", { assistant: true, preview: true })
    expect(click).toHaveBeenCalledOnce()
  })

  it("cancels without writing and surfaces validation/import errors", async () => {
    const user = userEvent.setup()
    render(<MindDefinitionTransfer />)
    await screen.findByText("No local Mind definitions in this account.")
    await user.upload(screen.getByLabelText("Import Mind package"), archive())
    await screen.findByTestId("mind-package-preview")
    await user.click(screen.getByRole("button", { name: "Cancel Mind package import" }))
    expect(importMindPackage).not.toHaveBeenCalled()
    vi.mocked(decodeMindPackage).mockRejectedValue(new Error("Checksum mismatch"))
    await user.upload(screen.getByLabelText("Import Mind package"), archive())
    expect(await screen.findByRole("alert")).toHaveTextContent("Checksum mismatch")
    expect(importMindPackage).not.toHaveBeenCalled()
    vi.mocked(decodeMindPackage).mockResolvedValue(pkg)
    vi.mocked(importMindPackage).mockRejectedValue(new Error("Native write failed; rolled back"))
    await user.upload(screen.getByLabelText("Import Mind package"), archive())
    await screen.findByTestId("mind-package-preview")
    await user.click(screen.getByRole("button", { name: "Confirm import as new Mind" }))
    expect(await screen.findByRole("alert")).toHaveTextContent("Native write failed")
    expect(screen.queryByTestId("imported-mind-definition-link")).toBeNull()
  })
})
