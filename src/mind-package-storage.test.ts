// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest"
import { browserMindFiles } from "./mind-package-storage"

afterEach(() => vi.unstubAllGlobals())

describe("Mind OPFS boundaries", () => {
  it("does not create directories when reading missing files", async () => {
    const getDirectoryHandle = vi.fn(async () => { throw new DOMException("Missing", "NotFoundError") })
    vi.stubGlobal("navigator", { storage: { getDirectory: async () => ({ getDirectoryHandle }) } })
    const files = browserMindFiles()
    expect(await files.readTree("minds/original")).toEqual({})
    expect(await files.exists("minds/original")).toBe(false)
    expect(getDirectoryHandle).toHaveBeenCalledWith("minds", { create: false })
  })

  it("surfaces denied reads rather than returning an empty archive", async () => {
    vi.stubGlobal("navigator", { storage: { getDirectory: async () => { throw new DOMException("Denied", "SecurityError") } } })
    await expect(browserMindFiles().readTree("minds/original")).rejects.toThrow("Denied")
  })

  it("refuses cleanup outside uniquely generated import roots", async () => {
    const getDirectory = vi.fn()
    vi.stubGlobal("navigator", { storage: { getDirectory } })
    for (const path of ["minds", "media", "minds/original", "minds/../outside", "media/existing-chat"]) {
      await expect(browserMindFiles().removeTree(path)).rejects.toThrow("Refusing")
    }
    expect(getDirectory).not.toHaveBeenCalled()
  })
})
