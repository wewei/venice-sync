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
})
