// @vitest-environment node
import { describe, expect, it } from "vitest"
import { strToU8, unzipSync, zipSync } from "fflate"
import { batchKey, buildBatch, canonicalJson, decodeBatch, encodeBatch, MAX_BATCH_BYTES, reconstructBatchItem, validateBatchManifest, validateBatchPackage, type PreparedBatchItem } from "./batch-format"
import { sha256 } from "./mind-package-format"

const date = "2026-10-29T00:00:00.000Z"
async function* source(items: PreparedBatchItem[]) { yield* items }
const item = (id: string): PreparedBatchItem => ({
  selection: { kind: "library", id, title: `Title ${id}` }, packaging: "zip", filename: `asset-${id}.zip`,
  files: { "manifest.json": canonicalJson({ originalId: id }), "asset.bin": new Uint8Array([5, 6, 7]) },
})
describe("CAS-ready batch transport", () => {
  it("uses stable JSON ordering, preserving arrays and JSON-compatible undefined semantics", () => {
    expect(canonicalJson({ z: 2, a: { y: 1, x: undefined }, b: [undefined, 3] })).toEqual(canonicalJson({ b: [null, 3], a: { y: 1 }, z: 2 }))
    expect(() => canonicalJson({ x: Infinity })).toThrow("portable JSON")
    let deep: unknown = {}
    for (let depth = 0; depth < 82; depth++) deep = { deep }
    expect(() => canonicalJson(deep)).toThrow("deeply nested")
  })
  it("deduplicates unchanged original bytes across items and reconstructs standalone ZIP contents", async () => {
    const pkg = await buildBatch(source([item("a"), item("b")]), { exportedAt: date })
    expect(Object.keys(pkg.objects)).toHaveLength(3)
    expect(pkg.manifest.items[0].files.find(file => file.path === "asset.bin")?.object).toBe(await sha256(new Uint8Array([5, 6, 7])))
    const encoded = await encodeBatch(pkg), entries = unzipSync(encoded)
    expect(Object.keys(entries).every(path => path === "manifest.json" || /^objects\/[a-f0-9]{64}$/.test(path))).toBe(true)
    const decoded = await decodeBatch(encoded)
    expect(decoded).toEqual(pkg)
    for (const [index, original] of [item("a"), item("b")].entries()) expect(unzipSync(reconstructBatchItem(decoded, decoded.manifest.items[index]))).toEqual(original.files)
  })
  it("restores JSON and keeps identities isolated by type rather than title or native ID alone", async () => {
    const value = canonicalJson({ content: "unchanged" })
    const pkg = await buildBatch(source([
      { selection: { kind: "classic", id: "same", title: "Same" }, packaging: "json", filename: "classic.json", files: { "export.json": value } },
      { selection: { kind: "character", id: "same", title: "Same" }, packaging: "json", filename: "character.json", files: { "export.json": value } },
    ]), { exportedAt: date })
    expect(Object.keys(pkg.objects)).toHaveLength(1)
    expect(new Set(pkg.manifest.items.map(batchKey)).size).toBe(2)
    expect(reconstructBatchItem(pkg, pkg.manifest.items[0])).toEqual(value)
    expect(await encodeBatch(pkg)).toEqual(await encodeBatch(await decodeBatch(await encodeBatch(pkg))))
  })
  it("rejects foreign/missing/modified objects, duplicate selections and invalid manifest layouts", async () => {
    const pkg = await buildBatch(source([item("a")]), { exportedAt: date })
    const hash = Object.keys(pkg.objects)[0]
    await expect(validateBatchPackage({ ...pkg, objects: { ...pkg.objects, [hash]: new Uint8Array([1]) } })).rejects.toThrow("checksum")
    await expect(validateBatchPackage({ ...pkg, objects: {} })).rejects.toThrow("missing")
    await expect(validateBatchPackage({ ...pkg, objects: { ...pkg.objects, ["0".repeat(64)]: new Uint8Array() } })).rejects.toThrow("Unexpected")
    for (const mutate of [
      (m: typeof pkg.manifest) => { m.items.push(m.items[0]) },
      (m: typeof pkg.manifest) => { m.items[0].filename = "../escape.zip" },
      (m: typeof pkg.manifest) => { m.items[0].files[0].path = "../escape" },
      (m: typeof pkg.manifest) => { m.items[0].files.push(m.items[0].files[0]) },
      (m: typeof pkg.manifest) => { m.items[0].packaging = "json" },
      (m: typeof pkg.manifest) => { m.version = 2 as 1 },
    ]) {
      const copy = structuredClone(pkg.manifest); mutate(copy)
      expect(() => validateBatchManifest(copy)).toThrow()
    }
  })
  it("stops preparation on cancellation or oversized logical content, with no silent omissions", async () => {
    const controller = new AbortController(), progress: number[] = []
    await expect(buildBatch(source([item("a"), item("b")]), { signal: controller.signal, onProgress: completed => {
      progress.push(completed); controller.abort()
    } })).rejects.toThrow()
    expect(progress).toEqual([1])
    const pkg = await buildBatch(source([item("a")]), { exportedAt: date })
    pkg.manifest.items[0].files[0].bytes = MAX_BATCH_BYTES
    expect(() => validateBatchManifest(pkg.manifest)).toThrow("logical content")
    await expect(buildBatch(source(Array.from({ length: 201 }, (_, index) => item(String(index)))))).rejects.toThrow("200")
  })
  it("rejects unexpected ZIP paths and fake or incomplete archives before exposure", async () => {
    for (const path of ["../evil", "objects/invalid", "nested.zip", "manifest.json/"]) {
      await expect(decodeBatch(zipSync({ [path]: strToU8("{}") }))).rejects.toThrow("Unsafe")
    }
    await expect(decodeBatch(zipSync({}))).rejects.toThrow("Missing")
    await expect(decodeBatch(zipSync({ "manifest.json": strToU8('{"format":"other"}') }))).rejects.toThrow("batch v1")
    await expect(decodeBatch(zipSync({ "manifest.json": strToU8('{"constructor":{}}') }))).rejects.toThrow("unsafe")
  })
})
