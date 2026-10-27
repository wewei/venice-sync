import { readFileSync } from "node:fs"
import path from "node:path"
import { cleanup, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { CharacterTransfer } from "./CharacterTransfer"
import { exportCharacter, importCharacter, listCharacters, loadCharacterPortrait } from "./venice-characters"
import { parseCharacterFile } from "./character-format"

vi.mock("./venice-characters", () => ({
  listCharacters: vi.fn(), exportCharacter: vi.fn(), importCharacter: vi.fn(), loadCharacterPortrait: vi.fn(),
}))
const json = readFileSync(path.resolve("scripts", "fixtures", "character.json"), "utf8")
const reloadPage = vi.fn()
beforeEach(() => { vi.mocked(listCharacters).mockResolvedValue([]) })
afterEach(() => { cleanup(); vi.resetAllMocks(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

describe("Character transfer WebUI", () => {
  it("previews native JSON and only writes/reloads after confirmation", async () => {
    const user = userEvent.setup()
    vi.mocked(importCharacter).mockResolvedValue("new-id")
    render(<CharacterTransfer reloadPage={reloadPage} />)
    await screen.findByText("No local Characters in this account.")
    await user.upload(screen.getByLabelText("Import Character JSON"), new File([json], "role.json", { type: "application/json" }))
    expect(await screen.findByTestId("character-import-preview")).toHaveTextContent("Venice Sync Character fixture")
    expect(importCharacter).not.toHaveBeenCalled()
    expect(reloadPage).not.toHaveBeenCalled()
    await user.click(screen.getByRole("button", { name: "Confirm import as new Character" }))
    expect(await screen.findByTestId("imported-character-link")).toHaveAttribute("href", "/character-chat")
    expect(importCharacter).toHaveBeenCalledWith(parseCharacterFile(json))
    expect(reloadPage).toHaveBeenCalledOnce()
  })

  it("cancels without writes and reports import failures without reloading", async () => {
    const user = userEvent.setup()
    render(<CharacterTransfer reloadPage={reloadPage} />)
    await screen.findByText("No local Characters in this account.")
    const input = screen.getByLabelText("Import Character JSON")
    await user.upload(input, new File([json], "role.json", { type: "application/json" }))
    await screen.findByTestId("character-import-preview")
    await user.click(screen.getByRole("button", { name: "Cancel Character import" }))
    expect(importCharacter).not.toHaveBeenCalled()
    vi.mocked(importCharacter).mockRejectedValue(new Error("Native insert failed"))
    await user.upload(input, new File([json], "role.json", { type: "application/json" }))
    await screen.findByTestId("character-import-preview")
    await user.click(screen.getByRole("button", { name: "Confirm import as new Character" }))
    expect(await screen.findByRole("alert")).toHaveTextContent("Native insert failed")
    expect(reloadPage).not.toHaveBeenCalled()
  })

  it("shows portraits and downloads the entire native Character using a labeled icon", async () => {
    const user = userEvent.setup()
    const file = parseCharacterFile(json)
    vi.mocked(listCharacters).mockResolvedValue([{ id: "role", name: "Fixture", description: "Test", hasPhoto: true }])
    vi.mocked(loadCharacterPortrait).mockResolvedValue(String(file.character.photo))
    vi.mocked(exportCharacter).mockResolvedValue(file)
    const NativeURL = URL
    vi.stubGlobal("URL", class extends NativeURL { static createObjectURL = vi.fn(() => "blob:role"); static revokeObjectURL = vi.fn() })
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {})
    render(<CharacterTransfer reloadPage={reloadPage} />)
    expect(await screen.findByRole("img", { name: "Fixture portrait" })).toHaveAttribute("src", file.character.photo)
    const download = screen.getByRole("button", { name: "Export Character JSON" })
    expect(download).toHaveAttribute("title", "Export Character JSON")
    await user.click(download)
    expect(await screen.findByText(/Character JSON downloaded/)).toBeVisible()
    expect(exportCharacter).toHaveBeenCalledWith("role")
  })
})
