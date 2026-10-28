// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest"
import { browserLibraryFiles } from "./library-files"

afterEach(() => vi.unstubAllGlobals())
describe("Library file namespace safety", () => {
  it("uses existing-only directory handles for reads and surfaces missing originals", async () => {
    const getDirectoryHandle = vi.fn(async () => { throw new DOMException("Missing original", "NotFoundError") })
    vi.stubGlobal("navigator", { storage: { getDirectory: async () => ({ getDirectoryHandle }) } })
    await expect(browserLibraryFiles().read("media/conversation/asset.png")).rejects.toThrow("Missing original")
    expect(getDirectoryHandle).toHaveBeenCalledWith("media", { create: false })
  })
  it("refuses writes and cleanup outside generated asset roots", async () => {
    const getDirectory = vi.fn()
    vi.stubGlobal("navigator", { storage: { getDirectory } })
    const files = browserLibraryFiles()
    for (const id of ["", "media", "../other", "old-conversation"]) await expect(files.remove(id)).rejects.toThrow("Unsafe")
    await expect(files.write("media/existing/asset.png", new Blob(["data"]))).rejects.toThrow("Refusing")
    expect(getDirectory).not.toHaveBeenCalled()
  })
  it("accepts only the two observed thumbnail names inside a generated namespace", async () => {
    const stream = { write: vi.fn(), close: vi.fn(), abort: vi.fn() }
    const getFileHandle = vi.fn(async () => ({ createWritable: async () => stream }))
    const root = { getDirectoryHandle: vi.fn(), getFileHandle }
    root.getDirectoryHandle.mockResolvedValue(root)
    vi.stubGlobal("navigator", { storage: { getDirectory: async () => root } })
    const id = "11111111-1111-4111-8111-111111111111", media = "22222222-2222-4222-8222-222222222222"
    const files = browserLibraryFiles()
    for (const suffix of ["thumb", "thumb500"]) await files.write(`thumbnails/${id}_${media}_${suffix}.jpg`, new Blob(["thumb"]))
    expect(getFileHandle).toHaveBeenCalledTimes(2)
    await expect(files.write(`thumbnails/${id}_${media}_thumb-other.jpg`, new Blob())).rejects.toThrow("Refusing")
  })
})
