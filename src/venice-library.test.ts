// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { loadNativeModule } from "./native-runtime"
import { currentMindOwner, getNativeCollections, type NativeCollection } from "./native-rxdb"
import { currentVeniceOwner, waitForVeniceOwner } from "./venice-classic"
import { inspectLibraryMedia } from "./library-media"
import { exportLibraryAsset, importLibraryAsset, listLibraryAssets, readLibraryAsset } from "./venice-library"
import type { LibraryFiles } from "./library-files"
import type { LibraryPackage } from "./library-format"
import { sha256 } from "./mind-package-format"

vi.mock("./native-runtime", () => ({ loadNativeModule: vi.fn() }))
vi.mock("./native-rxdb", () => ({ currentMindOwner: vi.fn(), getNativeCollections: vi.fn(), documentData: (document: { toJSON(): unknown }) => document.toJSON() }))
vi.mock("./venice-classic", () => ({ currentVeniceOwner: vi.fn(), waitForVeniceOwner: vi.fn() }))
vi.mock("./library-media", () => ({ inspectLibraryMedia: vi.fn() }))
let records: Record<string, Map<string, Record<string, unknown>>>
let data: Map<string, Blob>
let files: LibraryFiles
let failCommit = false
beforeEach(() => {
  vi.resetAllMocks(); failCommit = false; records = {}; data = new Map()
  vi.mocked(currentVeniceOwner).mockReturnValue("clerk-owner")
  vi.mocked(waitForVeniceOwner).mockResolvedValue("clerk-owner")
  vi.mocked(currentMindOwner).mockResolvedValue("internal-owner")
  const tables = Object.fromEntries(["conversations", "messages", "messageIds", "messageImages", "studioImageTurnMedia", "studioAudioTurnMedia"].map((name) => {
    const rows = new Map<string, Record<string, unknown>>(); records[name] = rows
    return [name, {
      name, get: async (id: string) => rows.get(id), toArray: async () => [...rows.values()],
      add: async (value: Record<string, unknown>) => {
        if (failCommit && name === "messages") throw new Error("Quota exceeded")
        if (rows.has(String(value.id))) throw new Error("Conflict")
        rows.set(String(value.id), structuredClone(value)); return value.id
      },
      where: (field: string) => ({
        equals: (value: string) => ({ toArray: async () => [...rows.values()].filter((row) => row[field] === value) }),
        anyOf: (values: string[]) => ({ toArray: async () => [...rows.values()].filter((row) => values.includes(String(row[field]))) }),
      }),
    }]
  }))
  const transaction = async (_mode: string, _tables: unknown[], action: () => Promise<void>) => {
    const before = structuredClone(records)
    try { await action() } catch (error) {
      for (const [name, rows] of Object.entries(records)) { rows.clear(); for (const [id, row] of before[name]) rows.set(id, row) }
      throw error
    }
  }
  vi.mocked(loadNativeModule).mockImplementation(async (id) => id === 342219 ?
    { db: { name: "venice-db-encrypted", verno: 31, transaction, ...tables } } :
    { resolveMediaLocationParams: ({ conversationId, id, mimeType }: { conversationId: string; id: string; mimeType: string }) =>
      ({ filePath: `media/${conversationId}`, fileName: `${id}.${mimeType.split("/")[1]}` }) })
  const empty = (name: string, version: number): NativeCollection => ({
    name, schema: { version }, closed: false, database: { name: "venice-rx-db-encrypted" },
    find: () => ({ exec: async () => [] }), findOne: () => ({ exec: async () => null }),
    insert: async () => { throw new Error("Read-only source fixture") },
    bulkInsert: async () => ({ success: [], error: [] }), bulkRemove: async () => ({ success: [], error: [] }),
  })
  vi.mocked(getNativeCollections).mockResolvedValue({ mindMedia: empty("mindMedia", 6), discoverGenerations: empty("discoverGenerations", 9) })
  vi.mocked(inspectLibraryMedia).mockResolvedValue({ thumbnail: new Blob(["thumbnail"], { type: "image/jpeg" }) })
  files = {
    read: vi.fn(async (path) => { const blob = data.get(path); if (!blob) throw new DOMException("Missing", "NotFoundError"); return blob }),
    containerExists: vi.fn(async (id) => [...data.keys()].some((path) => path.startsWith(`media/${id}/`))),
    write: vi.fn(async (path, blob) => { data.set(path, blob) }),
    remove: vi.fn(async (id) => { for (const path of data.keys()) if (path.startsWith(`media/${id}/`) || path.startsWith(`thumbnails/${id}_`)) data.delete(path) }),
  }
})
afterEach(() => vi.restoreAllMocks())

async function fixture(): Promise<LibraryPackage> {
  const bytes = new Uint8Array([1, 2, 3])
  return { manifest: { format: "venice-sync-library-asset", version: 1, exportedAt: "test",
    asset: { filename: "test.png", kind: "image", mimeType: "image/png", bytes: 3, sha256: await sha256(bytes),
      source: { type: "file", id: "", metadata: { note: "Original asset" } } } }, bytes }
}
describe("native Library assets", () => {
  it("creates an independent permanent Library container, preserves bytes/provenance and reexports losslessly", async () => {
    const source = await fixture(), id = await importLibraryAsset(source, files)
    expect(records.conversations.size).toBe(1)
    expect(records.messages.size).toBe(1)
    expect(records.messageIds.has(id)).toBe(true)
    const asset = (await listLibraryAssets()).assets.find((asset) => asset.id === id)
    expect(asset?.title).toBe("test.png")
    expect(asset?.kind).toBe("image")
    expect(records.messages.get(id)?.modelName).toBe("Imported Library asset")
    const exported = await exportLibraryAsset(`chat:${id}`, files)
    expect(exported.bytes).toEqual(source.bytes)
    expect(exported.manifest.asset.source).toEqual(source.manifest.asset.source)
    expect(JSON.stringify(exported)).not.toContain("clerk-owner")
  })
  it("joins legacy media through owned nontemporary conversations and excludes Studio inputs/foreign data", async () => {
    records.conversations.set("owned", { id: "owned", ownerId: "clerk-owner" })
    records.conversations.set("temporary", { id: "temporary", ownerId: "clerk-owner", isTemporary: true })
    for (const conversationId of ["owned", "temporary", "foreign"]) records.messages.set(conversationId, {
      id: conversationId, conversationId, role: "assistant", modelType: "video", fileType: "video/mp4",
    })
    records.studioImageTurnMedia.set("output", { id: "output", ownerId: "clerk-owner", sessionId: "studio", mediaRole: "output", mimeType: "image/png" })
    records.studioImageTurnMedia.set("input", { id: "input", ownerId: "clerk-owner", sessionId: "studio", mediaRole: "input", mimeType: "image/png" })
    expect((await listLibraryAssets()).assets.map((asset) => asset.key).sort()).toEqual(["chat:owned", "studio-image:output"])
  })
  it("uses native MIME defaults and isolates unsupported assets without hiding supported rows", async () => {
    records.studioImageTurnMedia.set("default", { id: "default", ownerId: "clerk-owner", sessionId: "studio" })
    records.studioImageTurnMedia.set("unsupported", { id: "unsupported", ownerId: "clerk-owner", sessionId: "studio", mimeType: "image/svg+xml" })
    const { assets } = await listLibraryAssets()
    expect(assets).toHaveLength(2)
    expect(assets.find((asset) => asset.id === "default")?.mimeType).toBe("image/webp")
    const unsupported = assets.find((asset) => asset.id === "unsupported")!
    await expect(readLibraryAsset(unsupported, files)).rejects.toThrow("Unsupported Library media")
    expect(files.read).not.toHaveBeenCalled()
  })
  it("retains legacy embedded originals when no OPFS copy exists", async () => {
    records.conversations.set("owned", { id: "owned", ownerId: "clerk-owner" })
    records.messages.set("embedded", { id: "embedded", conversationId: "owned", role: "assistant", modelType: "image", fileType: "image/png" })
    records.messageImages.set("embedded", { id: "embedded", contentBinary: new Uint8Array([5, 6, 7]) })
    const exported = await exportLibraryAsset("chat:embedded", files)
    expect(exported.bytes).toEqual(new Uint8Array([5, 6, 7]))
    expect(exported.manifest.asset.source.metadata).not.toHaveProperty("contentBinary")
    expect(records.messageImages.size).toBe(1)
  })
  it("maps internally owned Mind/Discover generations and Clerk-owned Studio audio to their real paths", async () => {
    const collections = await getNativeCollections({ mindMedia: 6, discoverGenerations: 9 })
    collections.mindMedia.find = vi.fn(({ selector }) => {
      expect(selector).toEqual({ ownerId: "internal-owner" })
      return { exec: async () => [{ toJSON: () => ({ id: "mind-image", ownerId: "internal-owner", mindConversationId: "mind-thread",
        data: { mediaType: "generatedImage", mimeType: "image/png", owner_id: "internal-owner" } }) }] }
    })
    collections.discoverGenerations.find = vi.fn(({ selector }) => {
      expect(selector).toEqual({ ownerId: "internal-owner", status: "completed" })
      return { exec: async () => [{ toJSON: () => ({ id: "discover-video", ownerId: "internal-owner",
        data: { mediaType: "generatedVideo", mimeType: "video/mp4" } }) }] }
    })
    records.studioAudioTurnMedia.set("studio-audio", { id: "studio-audio", ownerId: "clerk-owner", sessionId: "studio-session", mimeType: "audio/wav" })
    const { assets } = await listLibraryAssets()
    expect(assets.map((asset) => asset.path).sort()).toEqual([
      "discover/generations/discover-video.mp4", "media/mind-thread/mind-image.png", "media/studio-session/studio-audio.wav",
    ])
    expect(JSON.stringify(assets.map((asset) => asset.metadata))).not.toMatch(/internal-owner|clerk-owner/)
  })
  it("refuses account changes and cleans only the uncommitted import namespace", async () => {
    vi.mocked(currentVeniceOwner).mockReturnValue("another-owner")
    await expect(importLibraryAsset(await fixture(), files)).rejects.toThrow("account changed")
    expect(data.size).toBe(0)
    expect(records.conversations.size).toBe(0)
    await expect(listLibraryAssets()).rejects.toThrow("account changed")
  })
  it("isolates incompatible Discover from native and Mind sources and refuses exports from that source", async () => {
    records.studioImageTurnMedia.set("output", { id: "output", ownerId: "clerk-owner", sessionId: "studio", mediaRole: "output", mimeType: "image/png" })
    const collections = await getNativeCollections({ mindMedia: 6 })
    collections.mindMedia.find = () => ({ exec: async () => [{ toJSON: () => ({
      id: "mind", mindConversationId: "thread", data: { mediaType: "generatedImage", mimeType: "image/png" },
    }) }] })
    vi.mocked(getNativeCollections).mockImplementation(async (versions) => {
      if ("discoverGenerations" in versions) throw new Error("Unsupported Discover schema 11")
      return collections
    })
    const result = await listLibraryAssets()
    expect(result.assets.map((asset) => asset.key).sort()).toEqual(["mind:mind", "studio-image:output"])
    expect(result.errors).toEqual([{ source: "discover", message: "Unsupported Discover schema 11" }])
    await expect(exportLibraryAsset("discover:missing", files)).rejects.toThrow("Unsupported Discover schema 11")
    expect(files.read).not.toHaveBeenCalled()
  })
  it("reports internal identity failures without hiding available Dexie sources", async () => {
    records.studioAudioTurnMedia.set("audio", { id: "audio", ownerId: "clerk-owner", sessionId: "studio", mimeType: "audio/wav" })
    vi.mocked(currentMindOwner).mockRejectedValue(new Error("Account verification failed"))
    const result = await listLibraryAssets()
    expect(result.assets.map((asset) => asset.key)).toEqual(["studio-audio:audio"])
    expect(result.errors).toEqual([
      { source: "mind", message: "Account verification failed" }, { source: "discover", message: "Account verification failed" },
    ])
  })
  it("isolates a missing native Studio table from chat, audio and RxDB sources", async () => {
    const repository = await loadNativeModule(342219)
    if (typeof repository !== "object" || repository === null || !("db" in repository)) throw new Error("Missing fixture")
    if (typeof repository.db !== "object" || repository.db === null) throw new Error("Missing fixture database")
    Reflect.deleteProperty(repository.db, "studioImageTurnMedia")
    const load = vi.mocked(loadNativeModule).getMockImplementation()!
    vi.mocked(loadNativeModule).mockImplementation(async (id) => id === 342219 ? repository : load(id))
    records.conversations.set("owned", { id: "owned", ownerId: "clerk-owner" })
    records.messages.set("chat", { id: "chat", conversationId: "owned", role: "assistant", modelType: "image" })
    const result = await listLibraryAssets()
    expect(result.assets.map((asset) => asset.key)).toEqual(["chat:chat"])
    expect(result.errors).toEqual([{ source: "studio-image", message: "Native Library table studioImageTurnMedia is unavailable." }])
    const pkg = await fixture(), id = await importLibraryAsset(pkg, files)
    expect((await exportLibraryAsset(`chat:${id}`, files)).bytes).toEqual(pkg.bytes)
  })
  it("requests only the observed Discover versions and preserves completed-file paths and input provenance", async () => {
    const collections = await getNativeCollections({ discoverGenerations: 9 })
    collections.discoverGenerations.schema.version = 10
    const inputs = [{ id: "reference", kind: "image", mimeType: "image/png", source: "userMedia", slotId: "reference-slot" }]
    collections.discoverGenerations.find = () => ({ exec: async () => [{ toJSON: () => ({
      id: "completed", ownerId: "internal-owner", status: "completed", inputs,
      data: { mediaType: "generatedImage", mimeType: "image/png", modelId: "synthetic", size: 3 },
    }) }] })
    const result = await listLibraryAssets()
    expect(getNativeCollections).toHaveBeenCalledWith({ discoverGenerations: [9, 10] })
    expect(result.errors).toEqual([])
    expect(result.assets[0].path).toBe("discover/generations/completed.png")
    expect(result.assets[0].metadata.inputs).toEqual(inputs)
  })
  it("rolls back native rows and generated files if insertion fails, while preserving originals", async () => {
    records.conversations.set("original", { id: "original", ownerId: "clerk-owner" })
    failCommit = true
    await expect(importLibraryAsset(await fixture(), files)).rejects.toThrow("Quota exceeded")
    expect([...records.conversations.keys()]).toEqual(["original"])
    expect(records.messages.size).toBe(0)
    expect(data.size).toBe(0)
  })
  it("rejects collisions and invalid media before any file writes and reports cleanup failures", async () => {
    files.containerExists = vi.fn(async () => true)
    await expect(importLibraryAsset(await fixture(), files)).rejects.toThrow("already exist")
    expect(files.write).not.toHaveBeenCalled()
    files.containerExists = vi.fn(async () => false)
    vi.mocked(inspectLibraryMedia).mockRejectedValueOnce(new Error("Cannot decode"))
    await expect(importLibraryAsset(await fixture(), files)).rejects.toThrow("Cannot decode")
    expect(files.write).not.toHaveBeenCalled()
    failCommit = true
    files.remove = vi.fn(async () => { throw new Error("Cleanup denied") })
    await expect(importLibraryAsset(await fixture(), files)).rejects.toThrow("cleanup is incomplete")
  })
  it("fails explicitly for missing originals without deleting asset records", async () => {
    records.studioImageTurnMedia.set("asset", { id: "asset", ownerId: "clerk-owner", sessionId: "studio", mediaRole: "output", mimeType: "image/png" })
    await expect(exportLibraryAsset("studio-image:asset", files)).rejects.toThrow("missing or unreadable")
    expect(records.studioImageTurnMedia.has("asset")).toBe(true)
    expect(files.remove).not.toHaveBeenCalled()
  })
})
