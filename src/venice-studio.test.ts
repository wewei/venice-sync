// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest"
import { loadNativeModule } from "./native-runtime"
import { currentVeniceOwner, waitForVeniceOwner } from "./venice-classic"
import { inspectLibraryMedia } from "./library-media"
import { exportStudioSession, importStudioSession, listStudioSessions } from "./venice-studio"
import { observedStudioFixture, studioAudioFixture, studioFixture } from "./test/studio-fixture"
import { decodeStudioPackage, encodeStudioPackage } from "./studio-session-format"
import type { LibraryFiles } from "./library-files"

vi.mock("./native-runtime", () => ({ loadNativeModule: vi.fn() }))
vi.mock("./venice-classic", () => ({ currentVeniceOwner: vi.fn(), waitForVeniceOwner: vi.fn() }))
vi.mock("./library-media", () => ({ inspectLibraryMedia: vi.fn() }))
let records: Record<string, Map<string, Record<string, unknown>>>, data: Map<string, Blob>, files: LibraryFiles
let failCommit = false
beforeEach(() => {
  vi.resetAllMocks(); failCommit = false; records = {}; data = new Map()
  vi.mocked(currentVeniceOwner).mockReturnValue("owner")
  vi.mocked(waitForVeniceOwner).mockResolvedValue("owner")
  vi.mocked(inspectLibraryMedia).mockResolvedValue({ thumbnail: new Blob(["thumb"]) })
  const tables = Object.fromEntries(["studioImageSessions", "studioImageTurns", "studioImageTurnMedia", "studioAudioSessions", "studioAudioTurns", "studioAudioTurnMedia"].map((name) => {
    const rows = new Map<string, Record<string, unknown>>(); records[name] = rows
    return [name, { name, get: async (id: string) => rows.get(id),
      add: async (row: Record<string, unknown>) => {
        if (failCommit && name === "studioImageSessions") throw new Error("Quota exceeded")
        if (rows.has(String(row.id))) throw new Error("Collision")
        rows.set(String(row.id), structuredClone(row))
      },
      where: (field: string) => ({ equals: (value: string) => ({ toArray: async () => [...rows.values()].filter((row) => row[field] === value) }) }),
    }]
  }))
  const transaction = async (_mode: string, _tables: unknown, action: () => Promise<void>) => {
    const previous = structuredClone(records)
    try { await action() } catch (error) {
      for (const [name, rows] of Object.entries(records)) { rows.clear(); for (const [id, row] of previous[name]) rows.set(id, row) }
      throw error
    }
  }
  vi.mocked(loadNativeModule).mockResolvedValue({ db: { name: "venice-db-encrypted", verno: 31, transaction, ...tables } })
  files = {
    read: vi.fn(async (path) => { const blob = data.get(path); if (!blob) throw new Error("Missing original"); return blob }),
    write: vi.fn(async (path, blob) => { data.set(path, blob) }),
    containerExists: vi.fn(async () => false),
    remove: vi.fn(async (id) => { for (const path of data.keys()) if (path.startsWith(`media/${id}/`) || path.startsWith(`thumbnails/${id}_`)) data.delete(path) }),
  }
})
describe("native Studio session adapter", () => {
  it.each(["generate-optionals", "remove-background", "edit-optionals"] as const)("exports, rebuilds and reexports the observed %s case without losing fields or files", async (caseName) => {
    const pkg = await observedStudioFixture(caseName), sourceId = String(pkg.manifest.session.id)
    for (const [table, values] of [
      ["studioImageSessions", [pkg.manifest.session]], ["studioImageTurns", pkg.manifest.turns], ["studioImageTurnMedia", pkg.manifest.media],
    ] as const) for (const row of values) records[table].set(String(row.id), { ...row, ownerId: "owner" })
    for (const [path, bytes] of Object.entries(pkg.files)) data.set(path, new Blob([Uint8Array.from(bytes).buffer]))
    const before = structuredClone(records), original = await exportStudioSession(sourceId, files)
    const portable = await decodeStudioPackage(await encodeStudioPackage(original))
    const newId = await importStudioSession(portable, files), output = await exportStudioSession(newId, files)
    expect(newId).not.toBe(sourceId)
    expect(output.manifest.turns[0].mode).toBe(pkg.manifest.turns[0].mode)
    expect(output.manifest.media.map((row) => row.imageSettings)).toEqual(portable.manifest.media.map((row) => row.imageSettings))
    expect(Object.values(output.files)).toEqual(Object.values(original.files))
    expect(output.manifest.session.selectedImageId).toBe(output.manifest.media.at(-1)?.id)
    if (caseName !== "generate-optionals") expect(output.manifest.turns[0].input).toEqual({
      id: output.manifest.media[0].id, mimeType: output.manifest.media[0].mimeType, fileName: output.manifest.media[0].fileName,
    })
    for (const [name, rows] of Object.entries(before)) for (const [id, row] of rows) expect(records[name].get(id)).toEqual(row)
  })
  it("imports a complete new session and reexports unchanged original bytes and settings", async () => {
    const source = await studioFixture(), id = await importStudioSession(source, files)
    expect((await listStudioSessions()).map((row) => row.id)).toEqual([id])
    const exported = await exportStudioSession(id, files)
    expect(exported.manifest.turns[0].input).toEqual({
      id: exported.manifest.media[0].id, mimeType: "image/png", fileName: exported.manifest.media[0].fileName,
    })
    expect(Object.values(exported.files)).toEqual(Object.values(source.files))
    expect(JSON.stringify(exported)).not.toContain("ownerId")
    expect(files.write).toHaveBeenCalledTimes(4)
    expect([...data.keys()].filter((path) => path.startsWith("thumbnails/")).every((path) => path.endsWith("_thumb.jpg"))).toBe(true)
  })
  it("rolls back the entire native transaction and only the generated files", async () => {
    data.set("media/original/keep.png", new Blob(["keep"])); failCommit = true
    await expect(importStudioSession(await studioFixture(), files)).rejects.toThrow("Quota")
    expect(Object.values(records).every((rows) => rows.size === 0)).toBe(true)
    expect([...data.keys()]).toEqual(["media/original/keep.png"])
  })
  it("imports audio through its own native tables and reexports its original/settings", async () => {
    vi.mocked(inspectLibraryMedia).mockResolvedValue({})
    const pkg = await studioAudioFixture(), id = await importStudioSession(pkg, files)
    expect(records.studioImageSessions.size).toBe(0)
    expect(records.studioAudioSessions.size).toBe(1)
    expect((await listStudioSessions())[0].kind).toBe("audio")
    const output = await exportStudioSession(id, files, "audio")
    expect(Object.values(output.files)).toEqual(Object.values(pkg.files))
    expect(output.manifest.media[0].audioSettings).toEqual(pkg.manifest.media[0].audioSettings)
    expect(output.manifest.session.selectedAudioId).toBe(output.manifest.media[0].id)
  })
  it("surfaces partial file failures and incomplete cleanup", async () => {
    vi.mocked(files.write).mockRejectedValue(new Error("File write denied"))
    vi.mocked(files.remove).mockRejectedValue(new Error("Cleanup denied"))
    await expect(importStudioSession(await studioFixture(), files)).rejects.toThrow("cleanup is incomplete")
    expect(Object.values(records).every((rows) => rows.size === 0)).toBe(true)
  })
  it("does not write on validation, decoding, namespace collision or account-change failures", async () => {
    const pkg = await studioFixture()
    vi.mocked(files.containerExists).mockResolvedValue(true)
    await expect(importStudioSession(pkg, files)).rejects.toThrow("namespace")
    expect(files.write).not.toHaveBeenCalled(); expect(files.remove).not.toHaveBeenCalled()
    vi.mocked(files.containerExists).mockResolvedValue(false)
    vi.mocked(inspectLibraryMedia).mockRejectedValueOnce(new Error("Cannot decode"))
    await expect(importStudioSession(pkg, files)).rejects.toThrow("decode")
    expect(files.write).not.toHaveBeenCalled()
    vi.mocked(currentVeniceOwner).mockReturnValue("different-owner")
    await expect(importStudioSession(pkg, files)).rejects.toThrow("account changed")
    expect(Object.values(records).every((rows) => rows.size === 0)).toBe(true)
    expect(data.size).toBe(0)
  })
  it("filters account lists and rejects foreign children, missing originals and unknown native versions", async () => {
    const pkg = await studioFixture(), id = String(pkg.manifest.session.id)
    records.studioImageSessions.set(id, { ...pkg.manifest.session, ownerId: "owner" })
    records.studioImageSessions.set("foreign", { id: "foreign", ownerId: "other" })
    expect(await listStudioSessions()).toHaveLength(1)
    records.studioImageTurns.set("foreign", { ...pkg.manifest.turns[0], ownerId: "other" })
    await expect(exportStudioSession(id, files)).rejects.toThrow("foreign")
    records.studioImageTurns.clear()
    for (const row of pkg.manifest.turns) records.studioImageTurns.set(String(row.id), { ...row, ownerId: "owner" })
    for (const row of pkg.manifest.media) records.studioImageTurnMedia.set(String(row.id), { ...row, ownerId: "owner" })
    await expect(exportStudioSession(id, files)).rejects.toThrow("Missing original")
    vi.mocked(loadNativeModule).mockResolvedValue({ db: { verno: 32 } })
    await expect(listStudioSessions()).rejects.toThrow("Unsupported native")
  })
})
