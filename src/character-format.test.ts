import { readFileSync } from "node:fs"
import path from "node:path"
import { describe, expect, it } from "vitest"
import { parseCharacterFile, prepareCharacterImport, validateCharacterFile } from "./character-format"

const json = readFileSync(path.resolve("scripts", "fixtures", "character.json"), "utf8")
describe("native Character JSON", () => {
  it("round trips all portable fields, embedded portraits and extracted context", () => {
    const file = parseCharacterFile(json)
    expect(parseCharacterFile(JSON.stringify(file))).toEqual(file)
    expect(validateCharacterFile(file.character).character).toEqual(file.character)
  })

  it("imports private new copies and strips account/publication/native file bindings", () => {
    const file = parseCharacterFile(json)
    Object.assign(file.character, { id: "original", ownerId: "old-owner", publicId: "public", sourceId: "source", remoteId: "remote", isPublic: true, isApiVisible: true })
    const copy = prepareCharacterImport(file, "current-owner", "new-id")
    expect(copy).toMatchObject({ id: "new-id", ownerId: "current-owner", isPublic: false, isApiVisible: false, isImported: true })
    expect(copy.publicId).toBeUndefined()
    expect(copy.sourceId).toBeUndefined()
    expect(copy.remoteId).toBeUndefined()
    expect(copy.context).toEqual(file.character.context)
    expect(copy.photo).toBe(file.character.photo)
    expect(file.character.id).toBe("original")
  })

  it("rejects foreign formats, unsafe photos and raw photo/database references", () => {
    expect(() => parseCharacterFile("{")).toThrow("Invalid")
    expect(() => validateCharacterFile({ schemaVersion: "2", character: {} })).toThrow("version")
    const file = parseCharacterFile(json)
    file.character.photo = "https://invalid.example/photo.png"
    expect(() => validateCharacterFile(file)).toThrow("embedded")
    file.character.photo = "data:image/svg+xml;base64,PHN2Zy8+"
    expect(() => validateCharacterFile(file)).toThrow("embedded")
    delete file.character.photo
    file.character.photoMedia = "opfs-media:existing"
    expect(() => validateCharacterFile(file)).toThrow("raw")
    expect(() => parseCharacterFile('{"__proto__":{}}')).toThrow("unsafe")
  })
})
