import { readFileSync } from "node:fs"
import path from "node:path"
import { cleanup, render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { SyncPanel } from "./SyncPanel"
import { readStorageOverview } from "./storage"
import { listClassicConversations, waitForVeniceOwner } from "./venice-classic"
import { listMindHistory } from "./venice-mind-history"
import { listMindDefinitions } from "./venice-mind-package"
import { listCharacters } from "./venice-characters"
import { listLibraryAssets } from "./venice-library"
import { listStudioSessions } from "./venice-studio"

vi.mock("./venice-studio", () => ({ listStudioSessions: vi.fn(), exportStudioSession: vi.fn(), importStudioSession: vi.fn() }))
vi.mock("./venice-library", () => ({
  listLibraryAssets: vi.fn(), readLibraryAsset: vi.fn(), exportLibraryAsset: vi.fn(), importLibraryAsset: vi.fn(),
}))
vi.mock("./venice-characters", () => ({
  listCharacters: vi.fn(), loadCharacterPortrait: vi.fn(), exportCharacter: vi.fn(), importCharacter: vi.fn(),
}))
vi.mock("./storage", () => ({ readStorageOverview: vi.fn() }))
vi.mock("./venice-mind-package", () => ({
  listMindDefinitions: vi.fn(), exportMindPackage: vi.fn(), importMindPackage: vi.fn(), loadMindAvatar: vi.fn(),
}))
vi.mock("./venice-mind-history", () => ({
  listMindHistory: vi.fn(), exportMindHistory: vi.fn(), importMindHistory: vi.fn(), exportAgenticHistory: vi.fn(), importAgenticHistory: vi.fn(),
}))
vi.mock("./venice-classic", () => ({
  currentVeniceOwner: vi.fn(),
  waitForVeniceOwner: vi.fn(),
  listClassicConversations: vi.fn(),
  exportClassicConversation: vi.fn(),
  importClassicConversation: vi.fn(),
}))

const props = {
  runtime: { handler: "Test manager", mode: "userscript" as const, version: "test" },
  clicks: 0,
  onTestInteraction: vi.fn(),
  reloadPage: vi.fn(),
}

beforeEach(() => {
  vi.mocked(waitForVeniceOwner).mockResolvedValue("owner")
  vi.mocked(listClassicConversations).mockResolvedValue([])
  vi.mocked(listMindHistory).mockResolvedValue({ conversations: [], targets: [] })
  vi.mocked(listMindDefinitions).mockResolvedValue([])
  vi.mocked(listCharacters).mockResolvedValue([])
  vi.mocked(listLibraryAssets).mockResolvedValue({ assets: [], errors: [] })
  vi.mocked(listStudioSessions).mockResolvedValue([])
  vi.mocked(readStorageOverview).mockResolvedValue({
    origin: "https://venice.ai", readAt: "2026-10-27T05:00:00Z",
    localStorage: { status: "success", data: { entries: [], bytes: 0 } },
    indexedDB: { status: "success", data: [] },
  })
})
afterEach(() => { cleanup(); vi.resetAllMocks() })

async function navigate(name: string) {
  await userEvent.click(within(screen.getByRole("navigation", { name: "Sync pages" })).getByRole("button", { name }))
}

describe("transfer-focused WebUI", () => {
  it("shows exactly four content categories and keeps diagnostics off the overview", () => {
    render(<SyncPanel {...props} />)
    const overview = screen.getByRole("region", { name: "Transfer overview" })
    expect(within(overview).getAllByRole("region")).toHaveLength(4)
    for (const name of ["Conversations", "Library Assets", "Mind", "Characters"]) {
      expect(within(overview).getByRole("heading", { name })).toBeVisible()
    }
    const conversations = within(overview).getByRole("region", { name: "Conversations transfer options" })
    expect(within(conversations).getAllByText("Classic / Mind / Agentic JSON available")).toHaveLength(2)
    expect(within(conversations).getByText(/Agentic text-history JSON are ready/)).toBeVisible()
    expect(screen.queryByTestId("runtime-handler")).toBeNull()
    expect(screen.queryByTestId("storage-result")).toBeNull()
    expect(screen.queryByText("Test clicks: 0")).toBeNull()
    expect(readStorageOverview).not.toHaveBeenCalled()
    expect(listClassicConversations).not.toHaveBeenCalled()
    expect(listMindHistory).not.toHaveBeenCalled()
  })

  it("loads the Library asset page lazily with real import actions", async () => {
    render(<SyncPanel {...props} />)
    expect(listLibraryAssets).not.toHaveBeenCalled()
    await navigate("Library Assets")
    expect(await screen.findByText("No generated Library assets in this account.")).toBeVisible()
    expect(screen.getByRole("button", { name: "Upload Library asset" })).toBeVisible()
    expect(screen.queryByLabelText("Import conversation JSON")).toBeNull()
    expect(readStorageOverview).not.toHaveBeenCalled()
    expect(listClassicConversations).not.toHaveBeenCalled()
  })
  it("retains a cross-page shopping basket while keeping the four category pages separate", async () => {
    vi.mocked(listClassicConversations).mockResolvedValue([{ id: "a", name: "Chat A", modelId: "model", messages: 1, updatedAt: 1 }])
    vi.mocked(listCharacters).mockResolvedValue([{ id: "b", name: "Character B", description: "", hasPhoto: false }])
    render(<SyncPanel {...props} />)
    await navigate("Conversations")
    await userEvent.click(await screen.findByRole("button", { name: "Add to export basket: Chat A" }))
    await navigate("Characters")
    await userEvent.click(await screen.findByRole("button", { name: "Add to export basket: Character B" }))
    expect(screen.getByRole("button", { name: "Export basket (2)" })).toBeVisible()
    await navigate("Conversations")
    expect(screen.getByRole("button", { name: "Remove from export basket: Chat A" })).toHaveAttribute("aria-pressed", "true")
    await userEvent.click(screen.getByRole("button", { name: "Export basket (2)" }))
    expect(screen.getByRole("button", { name: "Remove basket item: Character B" })).toBeVisible()
  })
  it("adds every loaded Studio session, including rows beyond the 24-item display page", async () => {
    vi.mocked(listStudioSessions).mockResolvedValue(Array.from({ length: 25 }, (_, index) => ({
      id: `session-${index}`, kind: "image", name: `Session ${index}`, type: "edit", updatedAt: 1,
    })))
    render(<SyncPanel {...props} />)
    await navigate("Library Assets")
    await userEvent.click(screen.getByRole("button", { name: "Studio Sessions" }))
    await screen.findByText("25 Studio sessions")
    expect(screen.queryByRole("heading", { name: "Session 24" })).toBeNull()
    await userEvent.click(screen.getByRole("button", { name: "Add all loaded Studio sessions (25)" }))
    await userEvent.click(screen.getByRole("button", { name: "Export basket (25)" }))
    expect(screen.getByRole("button", { name: "Remove basket item: Session 24" })).toBeVisible()
  })

  it("opens real Character transfer separately from conversations", async () => {
    render(<SyncPanel {...props} />)
    expect(listCharacters).not.toHaveBeenCalled()
    await navigate("Characters")
    expect(await screen.findByText("No local Characters in this account.")).toBeVisible()
    expect(screen.getByRole("button", { name: "Upload Character file" })).toBeVisible()
    expect(listClassicConversations).not.toHaveBeenCalled()
  })

  it("keeps complete Studio sessions separate from asset-only transfer and loads them lazily", async () => {
    const user = userEvent.setup()
    render(<SyncPanel {...props} />)
    await navigate("Library Assets")
    await screen.findByText("No generated Library assets in this account.")
    expect(listStudioSessions).not.toHaveBeenCalled()
    await user.click(screen.getByRole("button", { name: "Studio Sessions" }))
    expect(await screen.findByText("No classic Studio sessions in this account.")).toBeVisible()
    expect(screen.getByRole("button", { name: "Upload Studio session" })).toBeVisible()
    expect(screen.getByRole("button", { name: "Upload Library asset", hidden: true })).not.toBeVisible()
    await user.click(screen.getByRole("button", { name: "Assets" }))
    expect(screen.getByRole("button", { name: "Upload Library asset" })).toBeVisible()
    expect(listLibraryAssets).toHaveBeenCalledOnce()
    expect(listStudioSessions).toHaveBeenCalledOnce()
  })

  it("shows a unified mixed-type history list separately from Mind definitions", async () => {
    vi.mocked(listClassicConversations).mockResolvedValue([{ id: "classic", name: "Classic fixture", modelId: "model", messages: 2, updatedAt: 1 }])
    vi.mocked(listMindHistory).mockResolvedValue({
      targets: [], conversations: [
        { id: "mind", name: "Mind fixture", kind: "mind", mind: "My Mind", messages: 3, updatedAt: 3 },
        { id: "agentic", name: "Agentic fixture", kind: "agentic", mind: "Agentic", messages: 1, updatedAt: 2 },
      ],
    })
    render(<SyncPanel {...props} />)
    await navigate("Conversations")
    await screen.findByRole("heading", { name: "Mind fixture" })
    expect(screen.queryByRole("group", { name: "Conversation type" })).toBeNull()
    for (const kind of ["Classic", "Mind", "Agentic"]) expect(screen.getByRole("img", { name: `${kind} conversation` })).toBeVisible()
    expect(within(screen.getByTestId("conversation-list")).getAllByRole("heading").map((heading) => heading.textContent))
      .toEqual(["Mind fixture", "Agentic fixture", "Classic fixture"])
    expect(screen.getByRole("button", { name: "Export Agentic JSON" })).toBeEnabled()
    expect(screen.getByRole("button", { name: "Upload conversation file" })).toBeVisible()
    expect(listMindHistory).toHaveBeenCalledOnce()
    await navigate("Mind")
    expect(screen.getByRole("heading", { name: "Mind" })).toBeVisible()
    expect(await screen.findByText("No local Mind definitions in this account.")).toBeVisible()
    expect(screen.getByRole("button", { name: "Upload Mind package" })).toBeVisible()
    expect(listClassicConversations).toHaveBeenCalledOnce()
  })

  it("preserves an import preview when switching subpages", async () => {
    render(<SyncPanel {...props} />)
    await navigate("Conversations")
    await screen.findByText("No conversations in this account.")
    const json = readFileSync(path.resolve("scripts", "fixtures", "classic-conversation.json"), "utf8")
    await userEvent.upload(screen.getByLabelText("Import conversation JSON"), new File([json], "chat.json", { type: "application/json" }))
    expect(await screen.findByTestId("import-preview")).toBeVisible()
    await navigate("Details")
    expect(screen.getByTestId("import-preview")).not.toBeVisible()
    await navigate("Conversations")
    expect(screen.getByTestId("import-preview")).toBeVisible()
    const preview = screen.getByTestId("import-preview")
    const content = screen.getByTestId("sync-panel").lastElementChild!
    content.scrollTop = 137
    await userEvent.click(screen.getByRole("button", { name: "Export basket (0)" }))
    await userEvent.click(screen.getByRole("button", { name: "Import from backup" }))
    await userEvent.click(screen.getByRole("button", { name: "Back to content" }))
    expect(screen.getByTestId("import-preview")).toBe(preview)
    expect(preview).toBeVisible()
    expect(content.scrollTop).toBe(137)
    expect(listClassicConversations).toHaveBeenCalledOnce()
    expect(props.reloadPage).not.toHaveBeenCalled()
  })

  it("loads storage diagnostics only after Details and its disclosure are opened", async () => {
    render(<SyncPanel {...props} />)
    await navigate("Details")
    expect(screen.getByTestId("runtime-handler")).toHaveTextContent("Test manager")
    expect(readStorageOverview).not.toHaveBeenCalled()
    await userEvent.click(screen.getByText("Storage metadata", { exact: true }))
    expect(await screen.findByTestId("storage-result")).toBeVisible()
    expect(readStorageOverview).toHaveBeenCalledOnce()
    await userEvent.click(screen.getByText("UI smoke test", { exact: true }))
    await userEvent.click(screen.getByRole("button", { name: "Test interaction" }))
    expect(props.onTestInteraction).toHaveBeenCalledOnce()
    await navigate("Overview")
    expect(screen.queryByTestId("runtime-handler")).toBeNull()
    expect(screen.queryByTestId("storage-result")).toBeNull()
  })

  it("moves focus to the active navigation item after an overview action", async () => {
    render(<SyncPanel {...props} />)
    await userEvent.click(screen.getByRole("button", { name: "Open Library Assets" }))
    const active = within(screen.getByRole("navigation", { name: "Sync pages" }))
      .getByRole("button", { name: "Library Assets" })
    expect(active).toHaveAttribute("aria-current", "page")
    expect(active).toHaveFocus()
  })
})
