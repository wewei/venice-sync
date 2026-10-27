import { cleanup, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, describe, expect, it, vi } from "vitest"
import { StorageOverview } from "./StorageOverview"
import { readStorageOverview, type StorageOverview as Overview } from "./storage"

vi.mock("./storage", () => ({ readStorageOverview: vi.fn() }))
afterEach(() => { cleanup(); vi.resetAllMocks() })

const overview: Overview = {
  origin: "https://venice.ai",
  readAt: "2026-10-27T04:30:00.000Z",
  localStorage: { status: "success", data: { entries: [{ key: "preferences", bytes: 100 }], bytes: 100 } },
  indexedDB: {
    status: "success",
    data: [{ name: "venice", version: 1, stores: { status: "success", data: [{ name: "chats", records: 2 }] } }],
  },
}

describe("storage overview panel", () => {
  it("loads metadata on mount and refreshes it on demand", async () => {
    vi.mocked(readStorageOverview).mockResolvedValue(overview)
    render(<StorageOverview />)
    expect(screen.getByRole("button", { name: "Refresh storage" })).toBeDisabled()
    expect(await screen.findByText("chats - 2 records")).toBeVisible()
    expect(screen.getByText("preferences - 100 bytes")).toBeVisible()
    vi.mocked(readStorageOverview).mockResolvedValue({
      ...overview,
      localStorage: { status: "success", data: { entries: [], bytes: 0 } },
    })
    await userEvent.click(screen.getByRole("button", { name: "Refresh storage" }))
    expect(await screen.findByText("No localStorage entries.")).toBeVisible()
    expect(readStorageOverview).toHaveBeenCalledTimes(2)
  })

  it("shows partial errors and keeps available metadata", async () => {
    vi.mocked(readStorageOverview).mockResolvedValue({
      ...overview,
      localStorage: { status: "error", message: "Access denied" },
      indexedDB: { status: "success", data: [{ name: "venice", version: 1, stores: { status: "error", message: "Blocked" } }] },
    })
    render(<StorageOverview />)
    expect(await screen.findAllByRole("alert")).toHaveLength(2)
    expect(screen.getByText("localStorage: Access denied")).toBeVisible()
    expect(screen.getByText("venice: Blocked")).toBeVisible()
    expect(screen.getByText("1 databases")).toBeVisible()
  })

  it("surfaces unexpected errors and allows retry", async () => {
    vi.mocked(readStorageOverview).mockRejectedValue(new Error("Unexpected read failure"))
    render(<StorageOverview />)
    expect(await screen.findByRole("alert")).toHaveTextContent("Unexpected read failure")
    await waitFor(() => expect(screen.getByRole("button", { name: "Refresh storage" })).toBeEnabled())
  })
})
