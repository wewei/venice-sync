import { readFileSync } from "node:fs"
import path from "node:path"
import { act, cleanup, render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { ConversationTransfer } from "./ConversationTransfer"
import { MAX_CONVERSATION_BYTES, parseConversationFile } from "./conversation-format"
import { currentVeniceOwner, exportClassicConversation, importClassicConversation, listClassicConversations, waitForVeniceOwner } from "./venice-classic"
import { exportAgenticHistory, importAgenticHistory, listMindHistory } from "./venice-mind-history"
import { validateAgenticConversation } from "./mind-conversation-format"
import { loadMindAvatar } from "./venice-mind-package"

vi.mock("./venice-mind-history", () => ({ listMindHistory: vi.fn(), exportMindHistory: vi.fn(), importMindHistory: vi.fn(), exportAgenticHistory: vi.fn(), importAgenticHistory: vi.fn() }))
vi.mock("./venice-mind-package", () => ({ loadMindAvatar: vi.fn() }))
vi.mock("./venice-classic", () => ({
  currentVeniceOwner: vi.fn(),
  waitForVeniceOwner: vi.fn(),
  listClassicConversations: vi.fn(),
  exportClassicConversation: vi.fn(),
  importClassicConversation: vi.fn(),
}))
const json = readFileSync(path.resolve("scripts", "fixtures", "classic-conversation.json"), "utf8")
const reloadPage = vi.fn()

beforeEach(() => {
  vi.mocked(currentVeniceOwner).mockReturnValue("owner")
  vi.mocked(waitForVeniceOwner).mockResolvedValue("owner")
  vi.mocked(listClassicConversations).mockResolvedValue([])
  vi.mocked(listMindHistory).mockResolvedValue({ conversations: [], targets: [] })
})
afterEach(() => { cleanup(); vi.resetAllMocks(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

describe("conversation transfer panel", () => {
  it("previews a file before any writes and imports only after confirmation", async () => {
    const user = userEvent.setup()
    vi.mocked(importClassicConversation).mockResolvedValue("new-id")
    render(<ConversationTransfer reloadPage={reloadPage} />)
    await screen.findByText("No conversations in this account.")
    await user.upload(screen.getByLabelText("Import conversation JSON"), new File([json], "chat.json", { type: "application/json" }))
    const preview = await screen.findByTestId("import-preview")
    expect(within(preview).getByText("Venice Sync round-trip fixture")).toBeVisible()
    expect(importClassicConversation).not.toHaveBeenCalled()
    expect(reloadPage).not.toHaveBeenCalled()
    expect(within(preview).getByText(/Save unsent drafts/)).toBeVisible()
    await user.click(within(preview).getByRole("button", { name: "Confirm import as new chat" }))
    expect(await screen.findByTestId("imported-chat-link")).toHaveAttribute("href", "/chat/classic/new-id")
    expect(importClassicConversation).toHaveBeenCalledWith("owner", parseConversationFile(json))
    expect(reloadPage).toHaveBeenCalledOnce()
  })

  it("cancels a preview without writing and rejects malformed/oversized files", async () => {
    const user = userEvent.setup()
    render(<ConversationTransfer reloadPage={reloadPage} />)
    await screen.findByText("No conversations in this account.")
    const input = screen.getByLabelText("Import conversation JSON")
    await user.upload(input, new File([json], "chat.json", { type: "application/json" }))
    await screen.findByTestId("import-preview")
    await user.click(screen.getByRole("button", { name: "Cancel import" }))
    expect(screen.queryByTestId("import-preview")).toBeNull()
    await user.upload(input, new File(["{"], "bad.json", { type: "application/json" }))
    expect(await screen.findByRole("alert")).toHaveTextContent("Invalid JSON")
    const large = new File(["{}"], "large.json", { type: "application/json" })
    Object.defineProperty(large, "size", { value: MAX_CONVERSATION_BYTES + 1 })
    await user.upload(input, large)
    expect(await screen.findByRole("alert")).toHaveTextContent("8 MiB")
    expect(importClassicConversation).not.toHaveBeenCalled()
    expect(reloadPage).not.toHaveBeenCalled()
  })

  it("surfaces account and import errors instead of reporting success", async () => {
    const user = userEvent.setup()
    vi.mocked(importClassicConversation).mockRejectedValue(new Error("Unsupported encryption policy"))
    render(<ConversationTransfer reloadPage={reloadPage} />)
    await screen.findByText("No conversations in this account.")
    await user.upload(screen.getByLabelText("Import conversation JSON"), new File([json], "chat.json", { type: "application/json" }))
    await screen.findByTestId("import-preview")
    await user.click(screen.getByRole("button", { name: "Confirm import as new chat" }))
    expect(await screen.findByRole("alert")).toHaveTextContent("Unsupported encryption policy")
    expect(screen.queryByTestId("imported-chat-link")).toBeNull()
    expect(reloadPage).not.toHaveBeenCalled()
    vi.mocked(waitForVeniceOwner).mockRejectedValue(new Error("Sign in first"))
    await user.click(screen.getByRole("button", { name: "Refresh chats" }))
    expect(await screen.findByRole("alert")).toHaveTextContent("Sign in first")
  })

  it("exports the selected conversation as a local JSON download", async () => {
    const user = userEvent.setup()
    const NativeURL = URL
    vi.stubGlobal("URL", class extends NativeURL {
      static createObjectURL = vi.fn(() => "blob:test")
      static revokeObjectURL = vi.fn()
    })
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {})
    vi.mocked(listClassicConversations).mockResolvedValue([{
      id: "one", name: "Test conversation", modelId: "test-model", messages: 2, updatedAt: 1,
    }])
    vi.mocked(exportClassicConversation).mockResolvedValue(parseConversationFile(json))
    render(<ConversationTransfer reloadPage={reloadPage} />)
    await screen.findByText("Test conversation")
    await user.click(screen.getByRole("button", { name: "Export JSON" }))
    expect(await screen.findByText(/Conversation JSON downloaded/)).toBeVisible()
    expect(exportClassicConversation).toHaveBeenCalledWith("owner", "one")
    expect(URL.createObjectURL).toHaveBeenCalledOnce()
    expect(click).toHaveBeenCalledOnce()
    expect(reloadPage).not.toHaveBeenCalled()
  })

  it("waits for the import transaction before refreshing the page", async () => {
    const user = userEvent.setup()
    let finishImport: ((id: string) => void) | undefined
    vi.mocked(importClassicConversation).mockImplementation(() => new Promise((resolve) => { finishImport = resolve }))
    render(<ConversationTransfer reloadPage={reloadPage} />)
    await screen.findByText("No conversations in this account.")
    await user.upload(screen.getByLabelText("Import conversation JSON"), new File([json], "chat.json", { type: "application/json" }))
    await screen.findByTestId("import-preview")
    await user.click(screen.getByRole("button", { name: "Confirm import as new chat" }))
    expect(reloadPage).not.toHaveBeenCalled()
    if (!finishImport) throw new Error("Import transaction did not start")
    await act(async () => { finishImport?.("new-id") })
    expect(reloadPage).toHaveBeenCalledOnce()
  })

  it("reports a refresh failure as an already successful import, without retrying", async () => {
    const user = userEvent.setup()
    vi.mocked(importClassicConversation).mockResolvedValue("new-id")
    reloadPage.mockImplementation(() => { throw new Error("Navigation blocked") })
    render(<ConversationTransfer reloadPage={reloadPage} />)
    await screen.findByText("No conversations in this account.")
    await user.upload(screen.getByLabelText("Import conversation JSON"), new File([json], "chat.json", { type: "application/json" }))
    await screen.findByTestId("import-preview")
    await user.click(screen.getByRole("button", { name: "Confirm import as new chat" }))
    expect(await screen.findByRole("alert")).toHaveTextContent("Import succeeded, but Venice could not refresh: Navigation blocked")
    expect(screen.getByRole("alert")).toHaveTextContent("do not import the file again")
    expect(screen.getByTestId("imported-chat-link")).toHaveAttribute("href", "/chat/classic/new-id")
    expect(screen.queryByTestId("import-preview")).toBeNull()
    expect(importClassicConversation).toHaveBeenCalledOnce()
    expect(reloadPage).toHaveBeenCalledOnce()
  })

  it("keeps available conversations visible when one source fails", async () => {
    vi.mocked(listClassicConversations).mockResolvedValue([{ id: "classic", name: "Available Classic", messages: 2, modelId: "model", updatedAt: 1 }])
    vi.mocked(listMindHistory).mockRejectedValue(new Error("Native database unavailable"))
    render(<ConversationTransfer reloadPage={reloadPage} />)
    expect(await screen.findByRole("heading", { name: "Available Classic" })).toBeVisible()
    expect(screen.getByRole("alert")).toHaveTextContent("Mind / Agentic: Native database unavailable")
    expect(screen.getByText("1 conversations (some sources unavailable)")).toBeVisible()
    expect(screen.getByRole("img", { name: "Classic conversation" })).toBeVisible()
  })

  it("uses the associated Mind's avatar as the conversation icon while retaining an accessible type label", async () => {
    const NativeURL = URL
    vi.stubGlobal("URL", class extends NativeURL { static revokeObjectURL = vi.fn() })
    vi.mocked(loadMindAvatar).mockResolvedValue("blob:correct-mind-avatar")
    vi.mocked(listMindHistory).mockResolvedValue({
      targets: [], conversations: [{
        id: "history", name: "My Mind history", kind: "mind", mind: "The linked Mind", mindId: "linked-mind",
        avatar: { id: "linked-avatar", mimeType: "image/png" }, messages: 2, updatedAt: 1,
      }],
    })
    render(<ConversationTransfer reloadPage={reloadPage} />)
    const image = await screen.findByRole("img", { name: "The linked Mind avatar" })
    expect(image).toHaveAttribute("src", "blob:correct-mind-avatar")
    expect(loadMindAvatar).toHaveBeenCalledWith("linked-mind", { id: "linked-avatar", mimeType: "image/png" })
    expect(screen.getByRole("img", { name: "Mind conversation" })).toContainElement(image)
  })

  it("detects Agentic imports automatically and creates an independent native chat without a Mind selection or reload", async () => {
    const user = userEvent.setup()
    const value = JSON.parse(readFileSync(path.resolve("scripts", "fixtures", "mind-conversation.json"), "utf8"))
    value.format = "venice-sync-agentic-conversation"
    delete value.conversation.mindId
    const archive = validateAgenticConversation(value)
    vi.mocked(importAgenticHistory).mockResolvedValue("new-agentic")
    render(<ConversationTransfer reloadPage={reloadPage} />)
    await screen.findByText("No conversations in this account.")
    await user.upload(screen.getByLabelText("Import conversation JSON"), new File([JSON.stringify(archive)], "agentic.json", { type: "application/json" }))
    expect(await screen.findByTestId("agentic-import-preview")).toHaveTextContent("Agentic import preview")
    expect(screen.queryByRole("combobox")).toBeNull()
    expect(importAgenticHistory).not.toHaveBeenCalled()
    await user.click(screen.getByRole("button", { name: "Confirm Agentic history import" }))
    expect(await screen.findByTestId("imported-agentic-chat-link")).toHaveAttribute("href", "/chat/agent/new-agentic")
    expect(importAgenticHistory).toHaveBeenCalledWith(archive)
    expect(reloadPage).not.toHaveBeenCalled()
  })

  it("routes Agentic row downloads to the Agentic exporter", async () => {
    const user = userEvent.setup()
    const value = JSON.parse(readFileSync(path.resolve("scripts", "fixtures", "mind-conversation.json"), "utf8"))
    value.format = "venice-sync-agentic-conversation"
    delete value.conversation.mindId
    vi.mocked(exportAgenticHistory).mockResolvedValue(validateAgenticConversation(value))
    vi.mocked(listMindHistory).mockResolvedValue({
      targets: [], conversations: [{ id: "agentic", name: "Agentic fixture", kind: "agentic", mind: "Agentic", messages: 2, updatedAt: 1 }],
    })
    const NativeURL = URL
    vi.stubGlobal("URL", class extends NativeURL {
      static createObjectURL = vi.fn(() => "blob:agentic")
      static revokeObjectURL = vi.fn()
    })
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {})
    render(<ConversationTransfer reloadPage={reloadPage} />)
    await screen.findByRole("heading", { name: "Agentic fixture" })
    await user.click(screen.getByRole("button", { name: "Export Agentic JSON" }))
    expect(await screen.findByText(/Conversation JSON downloaded/)).toBeVisible()
    expect(exportAgenticHistory).toHaveBeenCalledWith("agentic")
  })
})
