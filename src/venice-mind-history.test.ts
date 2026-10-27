// @vitest-environment node
import { readFileSync } from "node:fs"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { isRecord } from "./conversation-format"
import { parseMindConversation, validateAgenticConversation } from "./mind-conversation-format"
import { currentMindOwner, getMindCollections, type NativeCollection } from "./native-rxdb"
import { exportAgenticHistory, exportMindHistory, importAgenticHistory, importMindHistory, listMindHistory } from "./venice-mind-history"

vi.mock("./native-rxdb", async (original) => {
  const actual = await original<typeof import("./native-rxdb")>()
  return { ...actual, currentMindOwner: vi.fn(), getMindCollections: vi.fn() }
})

const database = { name: "venice-rx-db-encrypted" }
function collection(name: string, version: number) {
  const rows = new Map<string, Record<string, unknown>>()
  const document = (value: Record<string, unknown>) => ({ toJSON: () => structuredClone(value) })
  const port: NativeCollection = {
    name, schema: { version }, closed: false, database,
    find: ({ selector }) => ({ exec: async () => [...rows.values()].filter((row) => Object.entries(selector).every(([key, value]) => row[key] === value)).map(document) }),
    findOne: (id) => ({ exec: async () => { const row = rows.get(id); return row ? document(row) : null } }),
    insert: vi.fn(async (value) => {
      if (typeof value.id !== "string" || rows.has(value.id)) throw new Error("Conflict")
      rows.set(value.id, structuredClone(value))
      return document(value)
    }),
    bulkInsert: vi.fn(async (values) => {
      const success = []
      for (const value of values) success.push(await port.insert(value))
      return { success, error: [] }
    }),
    bulkRemove: vi.fn(async (ids) => {
      const success = []
      for (const id of ids) { const row = rows.get(id); if (row) { success.push(document(row)); rows.delete(id) } }
      return { success, error: [] }
    }),
  }
  return { port, rows }
}

let minds: ReturnType<typeof collection>
let conversations: ReturnType<typeof collection>
let messages: ReturnType<typeof collection>
const file = () => parseMindConversation(readFileSync(path.resolve("scripts", "fixtures", "mind-conversation.json"), "utf8"))
const target = { kind: "local" as const, id: "local-mind", name: "Local Mind" }

beforeEach(() => {
  vi.resetAllMocks()
  minds = collection("minds", 25); conversations = collection("mindConversations", 4); messages = collection("mindMessages", 25)
  minds.rows.set(target.id, { id: target.id, name: target.name, ownerId: "internal-owner" })
  vi.mocked(currentMindOwner).mockResolvedValue("internal-owner")
  vi.mocked(getMindCollections).mockResolvedValue({ minds: minds.port, conversations: conversations.port, messages: messages.port })
})
afterEach(() => vi.restoreAllMocks())

describe("native Mind history adapter", () => {
  it("uses native inserts, preserves structured records and never changes the Mind definition", async () => {
    const before = structuredClone(minds.rows.get(target.id))
    const id = await importMindHistory(file(), target)
    const exported = await exportMindHistory(id)
    expect(exported.messages).toHaveLength(2)
    expect(exported.messages[1].output_items.map((item) => item.type)).toEqual(["reasoning", "message"])
    expect(exported.conversation.mindId).toBe(target.id)
    expect(exported.conversation.ownerId).toBeUndefined()
    expect(exported.messages.every((entry) => entry.owner_id === undefined)).toBe(true)
    const content = exported.messages[0].output_items[0].content
    if (!Array.isArray(content) || !isRecord(content[0])) throw new Error("Missing content")
    expect(content[0].response_id).toBe(exported.messages[0].id)
    const copy = await importMindHistory(exported, target)
    expect(copy).not.toBe(id)
    expect(conversations.rows.size).toBe(2)
    expect(messages.rows.size).toBe(4)
    expect(minds.rows.get(target.id)).toEqual(before)
    expect((await listMindHistory()).conversations).toHaveLength(2)
  })

  it("includes Agentic metadata but excludes builder and foreign-account histories", async () => {
    conversations.rows.set("agentic", { id: "agentic", ownerId: "internal-owner", type: "chat", name: "Agentic" })
    conversations.rows.set("builder", { id: "builder", ownerId: "internal-owner", type: "maker", mindId: target.id, name: "Builder" })
    conversations.rows.set("studio", { id: "studio", ownerId: "internal-owner", type: "studio", studioProjectId: "project", name: "Studio" })
    conversations.rows.set("foreign", { id: "foreign", ownerId: "other", type: "chat", mindId: target.id, name: "Other" })
    expect((await listMindHistory()).conversations).toEqual([
      { id: "agentic", name: "Agentic", kind: "agentic", mind: "Agentic", messages: 0, updatedAt: 0 },
    ])
    await expect(exportMindHistory("foreign")).rejects.toThrow("another account")
  })

  it("requires a real destination in the current account", async () => {
    await expect(importMindHistory(file(), { ...target, id: "missing" })).rejects.toThrow("unavailable")
    expect(messages.rows.size).toBe(0)
    expect(conversations.rows.size).toBe(0)
  })

  it("associates local history with its own Mind avatar and remote history with its public Mind, not a local draft", async () => {
    minds.rows.get(target.id)!.avatarImage = { id: "local-avatar", mimeType: "image/png" }
    minds.rows.get(target.id)!.remoteId = "published"
    await importMindHistory(file(), target)
    conversations.rows.set("remote", { id: "remote", name: "Published history", ownerId: "internal-owner", type: "chat", remoteMindId: "published" })
    const data = await listMindHistory()
    const local = data.conversations.find((entry) => entry.kind === "mind" && entry.mindId)
    expect(local).toMatchObject({ mindId: target.id, avatar: { id: "local-avatar", mimeType: "image/png" } })
    const remote = data.conversations.find((entry) => entry.id === "remote")
    expect(remote).toMatchObject({ remoteMindId: "published" })
    expect(remote?.avatar).toBeUndefined()
    expect(remote?.mindId).toBeUndefined()
  })

  it("rolls back only newly added messages if the final conversation insert fails", async () => {
    messages.rows.set("untouched", { id: "untouched", owner_id: "internal-owner", mind_conversation_id: "existing" })
    vi.mocked(conversations.port.insert).mockRejectedValue(new Error("Native insert failed"))
    await expect(importMindHistory(file(), target)).rejects.toThrow("Native insert failed")
    expect([...messages.rows.keys()]).toEqual(["untouched"])
    expect(conversations.rows.size).toBe(0)
  })

  it("rolls back partial native bulk writes and reports rollback failures explicitly", async () => {
    vi.mocked(messages.port.bulkInsert).mockImplementation(async (values) => ({
      success: [await messages.port.insert(values[0])], error: [new Error("Write failed")],
    }))
    await expect(importMindHistory(file(), target)).rejects.toThrow("Some conversation messages")
    expect(messages.rows.size).toBe(0)
    vi.mocked(messages.port.bulkRemove).mockResolvedValue({ success: [], error: [new Error("Remove failed")] })
    await expect(importMindHistory(file(), target)).rejects.toThrow("could not be rolled back")
    expect(conversations.rows.size).toBe(0)
  })

  it("never overwrites colliding IDs or exports a foreign message", async () => {
    const id = await importMindHistory(file(), target)
    const first = [...messages.rows.values()][0]
    first.owner_id = "other"
    await expect(exportMindHistory(id)).rejects.toThrow("another account")
    vi.spyOn(crypto, "randomUUID").mockReturnValue("00000000-0000-4000-8000-000000000001")
    await expect(importMindHistory(file(), target)).rejects.toThrow("unique IDs")
    vi.restoreAllMocks()
    expect(conversations.rows.size).toBe(1)
  })

  it("round trips independent Agentic chats without a Mind definition or binding", async () => {
    const source = file()
    delete source.conversation.mindId
    const archive = validateAgenticConversation({ ...source, format: "venice-sync-agentic-conversation" })
    minds.rows.clear()
    const id = await importAgenticHistory(archive)
    const original = conversations.rows.get(id)
    expect(original?.mindId).toBeUndefined()
    expect(original?.remoteMindId).toBeUndefined()
    expect(original?.ownerId).toBe("internal-owner")
    const exported = await exportAgenticHistory(id)
    expect(exported.format).toBe("venice-sync-agentic-conversation")
    expect(exported.messages.map((entry) => entry.output_items.map((item) => item.content)))
      .toEqual(archive.messages.map((entry) => entry.output_items.map((item) => item.content)).map((items) => items.map((content) =>
        Array.isArray(content) ? content.map((part) => {
          if (!isRecord(part)) throw new Error("Invalid fixture")
          return expect.objectContaining({ type: part.type, text: part.text })
        }) : content)))
    const copy = await importAgenticHistory(exported)
    expect(copy).not.toBe(id)
    expect((await listMindHistory()).conversations.every((entry) => entry.kind === "agentic")).toBe(true)
    await expect(exportMindHistory(id)).rejects.toThrow("Mind history")
  })

  it("refuses relabeling Mind history as Agentic and rolls back Agentic message writes", async () => {
    const mindId = await importMindHistory(file(), target)
    await expect(exportAgenticHistory(mindId)).rejects.toThrow("must not reference a Mind")
    const source = file()
    delete source.conversation.mindId
    const archive = validateAgenticConversation({ ...source, format: "venice-sync-agentic-conversation" })
    vi.mocked(conversations.port.insert).mockRejectedValue(new Error("Agentic write failed"))
    await expect(importAgenticHistory(archive)).rejects.toThrow("Agentic write failed")
    expect(conversations.rows.size).toBe(1)
    expect(messages.rows.size).toBe(2)
  })
})
