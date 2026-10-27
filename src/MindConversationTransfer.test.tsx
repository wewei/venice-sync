import { readFileSync } from "node:fs"
import path from "node:path"
import { cleanup, render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { ConversationTransfer } from "./ConversationTransfer"
import { importMindHistory, listMindHistory } from "./venice-mind-history"
import { listClassicConversations, waitForVeniceOwner } from "./venice-classic"

vi.mock("./venice-classic", () => ({
  listClassicConversations: vi.fn(), waitForVeniceOwner: vi.fn(), currentVeniceOwner: vi.fn(),
  exportClassicConversation: vi.fn(), importClassicConversation: vi.fn(),
}))
vi.mock("./venice-mind-history", () => ({
  listMindHistory: vi.fn(), exportMindHistory: vi.fn(), importMindHistory: vi.fn(),
}))
const json = readFileSync(path.resolve("scripts", "fixtures", "mind-conversation.json"), "utf8")
beforeEach(() => {
  vi.mocked(waitForVeniceOwner).mockResolvedValue("owner")
  vi.mocked(listClassicConversations).mockResolvedValue([])
  vi.mocked(listMindHistory).mockResolvedValue({
    conversations: [], targets: [{ kind: "local", id: "destination", name: "Destination Mind" }],
  })
})
afterEach(() => { cleanup(); vi.resetAllMocks() })

describe("Mind history UI", () => {
  it("previews history and requires an explicit available destination before import", async () => {
    const user = userEvent.setup()
    vi.mocked(importMindHistory).mockResolvedValue("new-history")
    render(<ConversationTransfer reloadPage={vi.fn()} />)
    await screen.findByText("No conversations in this account.")
    await user.upload(screen.getByLabelText("Import conversation JSON"), new File([json], "mind.json", { type: "application/json" }))
    const preview = await screen.findByTestId("mind-import-preview")
    expect(within(preview).getByText("Venice Sync Mind history fixture")).toBeVisible()
    const confirm = screen.getByRole("button", { name: "Confirm Mind history import" })
    expect(confirm).toBeDisabled()
    expect(importMindHistory).not.toHaveBeenCalled()
    await user.selectOptions(screen.getByRole("combobox", { name: "Destination Mind" }), "local:destination")
    await user.click(confirm)
    expect(await screen.findByTestId("imported-mind-chat-link")).toHaveAttribute("href", "/chat/minds/local/destination/new-history")
    expect(importMindHistory).toHaveBeenCalledOnce()
    expect(screen.getByText(/without reloading/)).toBeVisible()
  })

  it("cancels without writing and surfaces native write errors without success", async () => {
    const user = userEvent.setup()
    vi.mocked(importMindHistory).mockRejectedValue(new Error("Native write failed"))
    render(<ConversationTransfer reloadPage={vi.fn()} />)
    await screen.findByText("No conversations in this account.")
    const input = screen.getByLabelText("Import conversation JSON")
    await user.upload(input, new File([json], "mind.json", { type: "application/json" }))
    await screen.findByTestId("mind-import-preview")
    await user.click(screen.getByRole("button", { name: "Cancel Mind import" }))
    expect(importMindHistory).not.toHaveBeenCalled()
    await user.upload(input, new File([json], "mind.json", { type: "application/json" }))
    await screen.findByTestId("mind-import-preview")
    await user.selectOptions(screen.getByRole("combobox", { name: "Destination Mind" }), "local:destination")
    await user.click(screen.getByRole("button", { name: "Confirm Mind history import" }))
    expect(await screen.findByRole("alert")).toHaveTextContent("Native write failed")
    expect(screen.queryByTestId("imported-mind-chat-link")).toBeNull()
  })
})
