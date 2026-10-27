// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { currentMindOwner, getNativeCollections, type NativeCollection } from "./native-rxdb"
import { exportMindPackage, importMindPackage, PACKAGE_SCHEMAS, prepareMindPackage } from "./venice-mind-package"
import { mindFileKey, sha256, type MindPackage } from "./mind-package-format"
import type { MindFiles } from "./mind-package-storage"

vi.mock("./native-rxdb", async (original) => ({ ...await original<typeof import("./native-rxdb")>(), currentMindOwner: vi.fn(), getNativeCollections: vi.fn() }))
let collections: Record<string, NativeCollection>
let records: Record<string, Map<string, Record<string, unknown>>>
let trees: Map<string, Record<string, Uint8Array>>
let files: MindFiles

function native(name: string, version: number): NativeCollection {
  const rows = new Map<string, Record<string, unknown>>()
  records[name] = rows
  const doc = (value: Record<string, unknown>) => ({ toJSON: () => structuredClone(value) })
  const port: NativeCollection = {
    name, schema: { version, jsonSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] } },
    closed: false, database: { name: "venice-rx-db-encrypted" },
    find: ({ selector }) => ({ exec: async () => [...rows.values()].filter((row) => Object.entries(selector).every(([key, value]) => row[key] === value)).map(doc) }),
    findOne: (id) => ({ exec: async () => rows.has(id) ? doc(rows.get(id)!) : null }),
    insert: vi.fn(async (value) => {
      if (rows.has(String(value.id))) throw new Error("Collision")
      rows.set(String(value.id), structuredClone(value))
      return doc(value)
    }),
    bulkInsert: vi.fn(async (values: Record<string, unknown>[]) => ({ success: await Promise.all(values.map((value) => port.insert(value))), error: [] })),
    bulkRemove: vi.fn(async (ids: string[]) => {
      const success = ids.filter((id) => rows.has(id)).map((id) => doc(rows.get(id)!))
      ids.forEach((id) => rows.delete(id))
      return { success, error: [] }
    }),
  }
  return port
}

beforeEach(() => {
  vi.resetAllMocks()
  records = {}; trees = new Map()
  collections = Object.fromEntries(Object.entries(PACKAGE_SCHEMAS).map(([name, version]) => [name, native(name, typeof version === "number" ? version : version[0])]))
  vi.mocked(currentMindOwner).mockResolvedValue("internal-owner")
  vi.mocked(getNativeCollections).mockResolvedValue(collections)
  files = {
    exists: vi.fn(async (path) => trees.has(path)),
    readTree: vi.fn(async (path) => structuredClone(trees.get(path) ?? {})),
    writeTree: vi.fn(async (path, data) => { trees.set(path, structuredClone(data)) }),
    removeTree: vi.fn(async (path) => { trees.delete(path) }),
  }
})
afterEach(() => vi.restoreAllMocks())

async function fixture(): Promise<MindPackage> {
  const bytes = new TextEncoder().encode("Fixture resource")
  return {
    manifest: {
      format: "venice-sync-mind", version: 1, exportedAt: new Date().toISOString(),
      definition: {
        id: "original", name: "Fixture", systemPrompt: { instructions: "Do not infer" }, assets: { asset: { filename: "note.txt", description: "Note", mimeType: "text/plain" } },
        tools: { child: { type: "sub_agent", id: "child", name: "Child", description: "Test", icon: "TbBrain", system_prompt: "Test", tools: [] } },
        remoteId: "published", remoteDraftDirty: true,
      },
      assistant: {
        conversation: { id: "mind-maker-conv:original", mindId: "original", type: "maker", name: "Builder", createdAtUnixTimestamp: 1, updatedAtUnixTimestamp: 2 },
        messages: [{ id: "response", mind_conversation_id: "mind-maker-conv:original", role: "assistant", status: "completed", output_items: [
          { id: "call", type: "functionCall", name: "update_mind", call_id: "call-id", status: "completed", response_id: "response", arguments: '{"historical":"only"}' },
          { id: "output", type: "functionCallOutput", call_id: "call-id", status: "completed", output: "Restored, not replayed" },
        ] }],
        media: [], attachments: [],
      },
      files: [{ scope: "mind", path: "assets/asset.txt", size: bytes.length, sha256: await sha256(bytes) }],
    },
    files: { [mindFileKey("mind", "assets/asset.txt")]: bytes },
  }
}

describe("complete Mind native import/export", () => {
  it("restores definition/files/Builder with fresh IDs, strips publishing and never executes tools", async () => {
    const pkg = await fixture()
    const id = await importMindPackage(pkg, { assistant: true, preview: true }, files)
    expect(records.minds.get(id)).toMatchObject({ name: "Fixture", ownerId: "internal-owner" })
    expect(records.minds.get(id)?.remoteId).toBeUndefined()
    trees.get(`minds/${id}`)!["assets/reference_thumb.jpg"] = new Uint8Array([0])
    expect(trees.get(`minds/${id}`)?.["assets/asset.txt"]).toEqual(pkg.files["files/mind/assets/asset.txt"])
    const conversation = records.mindConversations.get(`mind-maker-conv:${id}`)
    expect(conversation?.mindId).toBe(id)
    const response = [...records.mindMessages.values()][0]
    expect(response.id).not.toBe("response")
    expect(response.mind_conversation_id).toBe(`mind-maker-conv:${id}`)
    const exported = await exportMindPackage(id, { assistant: true, preview: true }, files)
    expect(exported.manifest.assistant?.messages).toHaveLength(1)
    expect(exported.manifest.definition.tools).toEqual(pkg.manifest.definition.tools)
    expect(exported.files).toEqual(pkg.files)
    expect(exported.manifest.definition.ownerId).toBeUndefined()
    const next = await importMindPackage(exported, { assistant: true, preview: true }, files)
    expect(next).not.toBe(id)
    expect(records.minds.size).toBe(2)
    expect(records.mindMessages.size).toBe(2)
  })

  it("omits unselected histories without changing the source", async () => {
    const pkg = await fixture()
    const id = await importMindPackage(pkg, { assistant: false, preview: false }, files)
    expect(records.mindMessages.size).toBe(0)
    expect(records.mindConversations.size).toBe(0)
    expect(pkg.manifest.assistant?.conversation.id).toBe("mind-maker-conv:original")
    expect(records.minds.has(id)).toBe(true)
  })

  it("rolls back files and partial histories if the final Mind insert fails", async () => {
    records.minds.set("untouched", { id: "untouched", ownerId: "internal-owner" })
    vi.mocked(collections.minds.bulkInsert).mockResolvedValue({ success: [], error: [new Error("Write failed")] })
    await expect(importMindPackage(await fixture(), { assistant: true, preview: true }, files)).rejects.toThrow("minds import")
    expect([...records.minds.keys()]).toEqual(["untouched"])
    expect(records.mindMessages.size).toBe(0)
    expect(records.mindConversations.size).toBe(0)
    expect(trees.size).toBe(0)
  })

  it("reports incomplete rollback and never deletes a pre-existing colliding resource", async () => {
    files.exists = vi.fn(async () => true)
    await expect(importMindPackage(await fixture(), { assistant: true, preview: true }, files)).rejects.toThrow("already exists")
    expect(files.removeTree).not.toHaveBeenCalled()
    files.exists = vi.fn(async () => false)
    files.writeTree = vi.fn(async () => { throw new Error("Quota exceeded") })
    files.removeTree = vi.fn(async () => { throw new Error("Cleanup denied") })
    await expect(importMindPackage(await fixture(), { assistant: true, preview: true }, files)).rejects.toThrow("cleanup is incomplete")
  })

  it("rejects missing references and incompatible native schema before writes", async () => {
    const pkg = await fixture()
    pkg.manifest.definition.avatarImage = { id: "missing", mimeType: "image/png" }
    await expect(importMindPackage(pkg, { assistant: true, preview: true }, files)).rejects.toThrow("Missing referenced")
    delete pkg.manifest.definition.avatarImage
    collections.minds.schema.jsonSchema = { type: "object", properties: { name: { type: "number" } } }
    await expect(importMindPackage(pkg, { assistant: true, preview: true }, files)).rejects.toThrow("schema")
    expect(files.writeTree).not.toHaveBeenCalled()
    expect(records.minds.size).toBe(0)
  })

  it("refuses foreign ownership and mid-export edits", async () => {
    records.minds.set("original", { ...(await fixture()).manifest.definition, ownerId: "other" })
    await expect(exportMindPackage("original", { assistant: false, preview: false }, files)).rejects.toThrow("another account")
    records.minds.get("original")!.ownerId = "internal-owner"
    files.readTree = vi.fn(async () => { records.minds.get("original")!.name = "Edited"; return {} })
    await expect(exportMindPackage("original", { assistant: false, preview: false }, files)).rejects.toThrow("changed during export")
  })

  it("remaps media records, content references and filenames together", async () => {
    const pkg = await fixture()
    if (!pkg.manifest.assistant) throw new Error("Missing fixture")
    const bytes = new Uint8Array([1, 2, 3])
    pkg.manifest.assistant.attachments.push({ id: "document", mindMessageId: "response", mindConversationId: "mind-maker-conv:original", mimeType: "text/plain" })
    pkg.manifest.assistant.messages[0].output_items = [{ id: "input", type: "message", status: "completed", content: [{ id: "part", type: "input_file", media_id: "document" }] }]
    pkg.manifest.files.push({ scope: "assistant", path: "attachments/document.txt", size: 3, sha256: await sha256(bytes) })
    pkg.files["files/assistant/attachments/document.txt"] = bytes
    const prepared = prepareMindPackage(pkg, "owner", { assistant: true, preview: true })
    const document = prepared.rows.mindAttachments[0]
    const historyFiles = prepared.trees.find((tree) => tree.path.startsWith("media/"))?.files
    expect(historyFiles?.[`attachments/${document.id}.txt`]).toEqual(bytes)
    expect(document.mindConversationId).toBe(`mind-maker-conv:${prepared.id}`)
  })
})
