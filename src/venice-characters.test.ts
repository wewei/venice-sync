// @vitest-environment node
import { readFileSync } from "node:fs"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { parseCharacterFile } from "./character-format"
import { loadNativeModule } from "./native-runtime"
import { currentVeniceOwner, waitForVeniceOwner } from "./venice-classic"
import { exportCharacter, importCharacter, listCharacters } from "./venice-characters"

vi.mock("./native-runtime", () => ({ loadNativeModule: vi.fn() }))
vi.mock("./venice-classic", () => ({ currentVeniceOwner: vi.fn(), waitForVeniceOwner: vi.fn() }))
const json = readFileSync(path.resolve("scripts", "fixtures", "character.json"), "utf8")
const portrait = parseCharacterFile(json).character.photo
let rows: Map<string, Record<string, unknown>>
let photos: Map<string, unknown>
let add: ReturnType<typeof vi.fn>
let cleanupPhoto: ReturnType<typeof vi.fn>

beforeEach(() => {
  vi.resetAllMocks()
  rows = new Map(); photos = new Map()
  vi.mocked(currentVeniceOwner).mockReturnValue("owner")
  vi.mocked(waitForVeniceOwner).mockResolvedValue("owner")
  vi.stubGlobal("navigator", { storage: { getDirectory: async () => ({ getDirectoryHandle: async () => { throw new DOMException("Missing", "NotFoundError") } }) } })
  add = vi.fn(async (value: Record<string, unknown>) => {
    if (rows.has(String(value.id))) throw new Error("Conflict")
    rows.set(String(value.id), structuredClone(value)); return value.id
  })
  cleanupPhoto = vi.fn(async (value: Record<string, unknown>) => { photos.delete(String(value.photoMedia)) })
  const table = {
    name: "characters", get: async (id: string) => rows.get(id), add,
    where: (field: string) => ({ equals: (value: string) => ({ toArray: async () => [...rows.values()].filter((row) => row[field] === value) }) }),
    delete: async (id: string) => { rows.delete(id) },
  }
  const media = {
    C: async (value: Record<string, unknown>) => ({ ...value, ...(value.photoMedia ? { photo: photos.get(String(value.photoMedia)) } : {}) }),
    W: async (value: Record<string, unknown>) => {
      const { photo, ...rest } = value
      if (!photo) return { character: rest }
      const photoMedia = `opfs-media:character-photos-${value.ownerId}|${value.id}__photo`
      photos.set(photoMedia, photo)
      return { character: { ...rest, photoMedia }, writtenPhotoMedia: photoMedia }
    },
    n: cleanupPhoto,
  }
  vi.mocked(loadNativeModule).mockImplementation(async (id) => {
    if (id === 342219) return { db: { name: "venice-db-encrypted", verno: 31, characters: table } }
    if (id === 951225) return media
    if (id === 488857) return { D: (text: string) => ({ success: true, data: parseCharacterFile(text) }) }
    throw new Error("Unknown native module")
  })
})
afterEach(() => vi.unstubAllGlobals())

describe("native Character transfer", () => {
  it("round trips complete native definitions and portraits without publication/account links", async () => {
    const file = parseCharacterFile(json)
    const id = await importCharacter(file)
    expect(rows.get(id)).toMatchObject({ ownerId: "owner", isPublic: false, isApiVisible: false })
    expect(rows.get(id)?.photo).toBeUndefined()
    expect(rows.get(id)?.photoMedia).toBeTruthy()
    const exported = await exportCharacter(id)
    expect(exported.character.photo).toBe(portrait)
    expect(exported.character.context).toEqual(file.character.context)
    expect(exported.character.textSettings).toEqual(file.character.textSettings)
    expect(exported.character.ownerId).toBeUndefined()
    expect(exported.character.photoMedia).toBeUndefined()
    const copy = await importCharacter(exported)
    expect(copy).not.toBe(id)
    expect(rows.size).toBe(2)
    expect((await listCharacters()).length).toBe(2)
  })

  it("excludes foreign-account roles and refuses exporting them", async () => {
    rows.set("foreign", { ...parseCharacterFile(json).character, id: "foreign", ownerId: "other" })
    expect(await listCharacters()).toEqual([])
    await expect(exportCharacter("foreign")).rejects.toThrow("another account")
  })

  it("cleans a newly stored portrait when add-only insertion fails", async () => {
    rows.set("untouched", { id: "untouched", ownerId: "owner" })
    add.mockRejectedValue(new Error("Quota exceeded"))
    await expect(importCharacter(parseCharacterFile(json))).rejects.toThrow("Quota exceeded")
    expect([...rows.keys()]).toEqual(["untouched"])
    expect(photos.size).toBe(0)
    expect(cleanupPhoto).toHaveBeenCalledOnce()
  })

  it("reports missing portrait exports, parser errors and cleanup failures explicitly", async () => {
    const id = await importCharacter(parseCharacterFile(json))
    photos.clear()
    await expect(exportCharacter(id)).rejects.toThrow("portrait is missing")
    add.mockRejectedValue(new Error("Write failed"))
    cleanupPhoto.mockRejectedValue(new Error("Remove failed"))
    await expect(importCharacter(parseCharacterFile(json))).rejects.toThrow("cleanup is incomplete")
  })
})
