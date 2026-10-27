import { IDBFactory } from "fake-indexeddb"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { readStorageOverview } from "./storage"

let factory: IDBFactory

beforeEach(() => {
  factory = new IDBFactory()
  vi.stubGlobal("indexedDB", factory)
  localStorage.clear()
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

function seedDatabase(name: string, version: number) {
  return new Promise<void>((resolve, reject) => {
    const request = factory.open(name, version)
    request.onupgradeneeded = () => {
      const chats = request.result.createObjectStore("chats")
      chats.put({ content: "private chat text" }, "one")
      chats.put({ content: "another private chat" }, "two")
      request.result.createObjectStore("settings")
    }
    request.onerror = () => reject(request.error)
    request.onsuccess = () => {
      request.result.close()
      resolve()
    }
  })
}

describe("read-only storage overview", () => {
  it("reports key sizes and store counts without returning stored values", async () => {
    localStorage.setItem("token", "private token")
    await seedDatabase("venice-test", 2)
    const result = await readStorageOverview()
    expect(result.localStorage).toEqual({
      status: "success",
      data: { entries: [{ key: "token", bytes: 36 }], bytes: 36 },
    })
    expect(result.indexedDB).toEqual({
      status: "success",
      data: [{
        name: "venice-test",
        version: 2,
        stores: { status: "success", data: [{ name: "chats", records: 2 }, { name: "settings", records: 0 }] },
      }],
    })
    expect(JSON.stringify(result)).not.toContain("private")
    expect(localStorage.getItem("token")).toBe("private token")
    expect(await factory.databases()).toEqual([{ name: "venice-test", version: 2 }])
    expect(Number.isNaN(Date.parse(result.readAt))).toBe(false)
    expect(result.origin).toBe(window.location.origin)
  })

  it("reports empty storage without creating any databases", async () => {
    const result = await readStorageOverview()
    expect(result.localStorage).toEqual({ status: "success", data: { entries: [], bytes: 0 } })
    expect(result.indexedDB).toEqual({ status: "success", data: [] })
    expect(await factory.databases()).toEqual([])
  })

  it("reports unavailable localStorage while preserving IndexedDB results", async () => {
    vi.spyOn(window, "localStorage", "get").mockImplementation(() => {
      throw new DOMException("Storage access denied", "SecurityError")
    })
    const result = await readStorageOverview()
    expect(result.localStorage).toEqual({ status: "error", message: "SecurityError: Storage access denied" })
    expect(result.indexedDB.status).toBe("success")
  })

  it("reports unsupported IndexedDB without hiding localStorage", async () => {
    vi.stubGlobal("indexedDB", undefined)
    const result = await readStorageOverview()
    expect(result.indexedDB).toEqual({
      status: "error",
      message: "Error: IndexedDB database enumeration is unavailable in this browser.",
    })
    expect(result.localStorage.status).toBe("success")
  })

  it("surfaces enumeration and per-database failures", async () => {
    vi.spyOn(factory, "databases").mockRejectedValueOnce(new Error("Enumeration denied"))
    expect((await readStorageOverview()).indexedDB).toEqual({
      status: "error", message: "Error: Enumeration denied",
    })
    await seedDatabase("healthy", 1)
    const open = factory.open.bind(factory)
    vi.spyOn(factory, "open").mockImplementation((name, version) => {
      if (name === "broken") throw new Error("Open denied")
      return open(name, version)
    })
    vi.mocked(factory.databases).mockResolvedValue([
      { name: "broken", version: 1 }, { name: "healthy", version: 1 },
    ])
    const result = (await readStorageOverview()).indexedDB
    expect(result.status).toBe("success")
    if (result.status !== "success") throw new Error("Expected database results")
    expect(result.data[0].stores).toEqual({ status: "error", message: "Error: Open denied" })
    expect(result.data[1].stores.status).toBe("success")
  })

  it("aborts creation if an enumerated database disappears", async () => {
    const enumerate = factory.databases.bind(factory)
    vi.spyOn(factory, "databases").mockResolvedValue([{ name: "deleted", version: 1 }])
    const result = (await readStorageOverview()).indexedDB
    expect(result.status).toBe("success")
    if (result.status !== "success") throw new Error("Expected database results")
    expect(result.data[0].stores).toEqual({
      status: "error", message: "Error: Database changed while opening. Refresh to retry.",
    })
    expect(await enumerate()).toEqual([])
  })

  it("reports timeouts instead of waiting indefinitely for a blocked database", async () => {
    await seedDatabase("pending", 1)
    const request = factory.open("pending")
    await new Promise<void>((resolve) => {
      request.onsuccess = () => { request.result.close(); resolve() }
    })
    vi.spyOn(factory, "open").mockReturnValue(request)
    vi.useFakeTimers()
    const reading = readStorageOverview()
    await vi.advanceTimersByTimeAsync(5000)
    const result = (await reading).indexedDB
    expect(result.status).toBe("success")
    if (result.status !== "success") throw new Error("Expected database results")
    expect(result.data[0].stores).toEqual({
      status: "error", message: "Error: Database read timed out. Refresh to retry.",
    })
  })
})
