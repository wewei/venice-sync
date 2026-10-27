// @vitest-environment node
import { strToU8, zipSync } from "fflate"
import { describe, expect, it } from "vitest"
import { decodeLibraryPackage, encodeLibraryPackage, libraryKind, validateLibraryPackage, type LibraryPackage } from "./library-format"
import { sha256 } from "./mind-package-format"

async function fixture(): Promise<LibraryPackage> {
  const bytes = new Uint8Array([1, 2, 3])
  return { manifest: { format: "venice-sync-library-asset", version: 1, exportedAt: "test",
    asset: { filename: "image.png", kind: "image", mimeType: "image/png", bytes: 3, sha256: await sha256(bytes),
      source: { type: "file", id: "", metadata: {} } } }, bytes }
}
describe("Library asset archives", () => {
  it("round trips original bytes and provenance without modifying either", async () => {
    const pkg = await fixture()
    expect(await decodeLibraryPackage(await encodeLibraryPackage(pkg))).toEqual(pkg)
  })
  it("rejects mismatched bytes, types, unsafe names and unrelated ZIP contents", async () => {
    const pkg = await fixture()
    pkg.bytes[0] = 4
    await expect(validateLibraryPackage(pkg)).rejects.toThrow("checksum")
    pkg.manifest.asset.kind = "video"
    await expect(validateLibraryPackage(pkg)).rejects.toThrow("type")
    pkg.manifest.asset.kind = "image"; pkg.manifest.asset.filename = "../outside"
    await expect(validateLibraryPackage(pkg)).rejects.toThrow("filename")
    await expect(decodeLibraryPackage(zipSync({ "../outside": strToU8("data") }))).rejects.toThrow("Unexpected")
  })
  it("rejects zip expansion limits before extracting data and active image formats", async () => {
    const zip = zipSync({ "manifest.json": new Uint8Array(8 * 1024 * 1024 + 1) }, { level: 9 })
    await expect(decodeLibraryPackage(zip)).rejects.toThrow("limits")
    expect(() => libraryKind("image/svg+xml")).toThrow("Unsupported")
    expect(() => libraryKind("application/pdf")).toThrow("Unsupported")
  })
})
