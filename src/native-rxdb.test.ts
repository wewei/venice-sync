// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { isRecord } from "./conversation-format"

beforeEach(() => {
  vi.resetModules()
  vi.stubGlobal("location", { origin: "https://venice.ai" })
  vi.stubGlobal("window", { location: { origin: "https://venice.ai" } })
})
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

describe("native RxDB integration", () => {
  it("reads public existing collections without replacing native modules or opening another database", async () => {
    const database = { name: "venice-rx-db-encrypted" }
    const collection = (name: string, version: number) => ({
      name, schema: { version }, database, closed: false,
      find() {}, findOne() {}, insert() {}, bulkInsert() {}, bulkRemove() {},
    })
    const values = [collection("minds", 25), collection("mindConversations", 4), collection("mindMessages", 25)]
    const factories = new Map<string, unknown>()
    const push = vi.fn((chunk: unknown) => {
      if (!Array.isArray(chunk)) throw new Error("Bad chunk")
      if (chunk.length === 3 && typeof chunk[1] === "string") factories.set(chunk[1], chunk[2])
      if (chunk.length === 2 && isRecord(chunk[1]) && Array.isArray(chunk[1].runtimeModuleIds)) {
        for (const id of chunk[1].runtimeModuleIds) {
          const factory = factories.get(String(id))
          if (typeof factory !== "function") throw new Error("Missing bridge")
          factory({ r: () => ({ OPEN_COLLECTIONS: new Set(values) }) })
        }
      }
    })
    vi.stubGlobal("unsafeWindow", { TURBOPACK: { push } })
    const { getMindCollections } = await import("./native-rxdb")
    expect((await getMindCollections()).conversations).toBe(values[1])
    await getMindCollections()
    expect(push).toHaveBeenCalledTimes(2)
    values[1].schema.version = 5
    expect((await getMindCollections()).conversations).toBe(values[1])
    values[1].schema.version = 99
    await expect(getMindCollections()).rejects.toThrow("Unsupported")
  })

  it("verifies the internal owner using only Venice's first-party endpoint and never sends chat contents", async () => {
    const account = { id: "clerk-user" }
    const body = { token: `header.${Buffer.from(JSON.stringify({ userId: "internal-owner" })).toString("base64url")}.signature` }
    const fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => body })
    vi.stubGlobal("unsafeWindow", { Clerk: { user: account, session: { getToken: async () => "synthetic-token" } }, fetch })
    const { currentMindOwner } = await import("./native-rxdb")
    expect(await currentMindOwner()).toBe("internal-owner")
    expect(fetch).toHaveBeenCalledWith("https://outerface.venice.ai/api/user/session", expect.objectContaining({
      credentials: "include", redirect: "error", headers: { Accept: "application/json", Authorization: "Bearer synthetic-token" },
    }))
    expect(fetch.mock.calls[0][1].body).toBeUndefined()
    fetch.mockResolvedValue({ ok: false, status: 401 })
    await expect(currentMindOwner()).rejects.toThrow("HTTP 401")
  })

  it("waits for native sign-in initialization before requesting account metadata", async () => {
    const clerk: { loaded: boolean; user?: { id: string }; session?: { getToken: () => Promise<string> } } = { loaded: true }
    const token = `header.${Buffer.from(JSON.stringify({ userId: "internal-owner" })).toString("base64url")}.signature`
    const fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ token }) })
    vi.stubGlobal("unsafeWindow", { Clerk: clerk, fetch })
    const { currentMindOwner } = await import("./native-rxdb")
    const result = currentMindOwner()
    expect(fetch).not.toHaveBeenCalled()
    clerk.loaded = true
    clerk.user = { id: "clerk-user" }
    clerk.session = { getToken: async () => "synthetic-token" }
    expect(await result).toBe("internal-owner")
    expect(fetch).toHaveBeenCalledOnce()
  })
})
