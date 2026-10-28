import { cleanup, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { StudioTransfer } from "./StudioTransfer"
import { decodeStudioPackage, type StudioPackage } from "./studio-session-format"
import { importStudioSession, listStudioSessions } from "./venice-studio"

vi.mock("./venice-studio", () => ({ listStudioSessions: vi.fn(), exportStudioSession: vi.fn(), importStudioSession: vi.fn() }))
vi.mock("./studio-session-format", () => ({ decodeStudioPackage: vi.fn(), encodeStudioPackage: vi.fn(), MAX_STUDIO_ZIP: 128 * 1024 * 1024 }))
const reloadPage = vi.fn()
const pkg: StudioPackage = {
  manifest: { format: "venice-sync-studio-session", version: 1, exportedAt: "test", kind: "image", session: { name: "Fixture editor session" }, turns: [], media: [], files: [] }, files: {},
}
beforeEach(() => {
  vi.mocked(listStudioSessions).mockResolvedValue([])
  vi.mocked(decodeStudioPackage).mockResolvedValue(pkg)
})
afterEach(() => { cleanup(); vi.resetAllMocks() })
function archive() {
  const file = new File(["zip"], "session.zip", { type: "application/zip" })
  Object.defineProperty(file, "arrayBuffer", { value: async () => new ArrayBuffer(3) })
  return file
}
describe("Studio session transfer UI", () => {
  it("previews and cancels without writes, then explicitly confirms and reloads", async () => {
    const user = userEvent.setup()
    vi.mocked(importStudioSession).mockResolvedValue("new-id")
    render(<StudioTransfer reloadPage={reloadPage} />)
    await screen.findByText("No classic Studio sessions in this account.")
    await user.upload(screen.getByLabelText("Import Studio session"), archive())
    expect(await screen.findByTestId("studio-import-preview")).toHaveTextContent("Fixture editor session")
    expect(importStudioSession).not.toHaveBeenCalled()
    await user.click(screen.getByRole("button", { name: "Cancel Studio import" }))
    expect(reloadPage).not.toHaveBeenCalled()
    await user.upload(screen.getByLabelText("Import Studio session"), archive())
    await screen.findByTestId("studio-import-preview")
    await user.click(screen.getByRole("button", { name: "Confirm import as new Studio session" }))
    expect(await screen.findByText(/Studio session imported as a new editable copy/)).toBeVisible()
    expect(importStudioSession).toHaveBeenCalledWith(pkg)
    expect(reloadPage).toHaveBeenCalledOnce()
  })
  it("keeps failed import previews and distinguishes a committed import from refresh failure", async () => {
    const user = userEvent.setup()
    vi.mocked(importStudioSession).mockRejectedValueOnce(new Error("Quota exceeded")).mockResolvedValue("id")
    reloadPage.mockImplementation(() => { throw new Error("Blocked") })
    render(<StudioTransfer reloadPage={reloadPage} />)
    await screen.findByText("No classic Studio sessions in this account.")
    await user.upload(screen.getByLabelText("Import Studio session"), archive()); await screen.findByTestId("studio-import-preview")
    await user.click(screen.getByRole("button", { name: "Confirm import as new Studio session" }))
    expect(await screen.findByRole("alert")).toHaveTextContent("Quota exceeded")
    expect(screen.getByTestId("studio-import-preview")).toBeVisible()
    expect(reloadPage).not.toHaveBeenCalled()
    await user.click(screen.getByRole("button", { name: "Confirm import as new Studio session" }))
    expect(await screen.findByRole("alert")).toHaveTextContent("import succeeded, but refresh failed")
    expect(screen.queryByTestId("studio-import-preview")).toBeNull()
  })
})
