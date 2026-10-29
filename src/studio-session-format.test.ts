// @vitest-environment node
import { describe, expect, it } from "vitest"
import { strToU8, zipSync } from "fflate"
import { decodeStudioPackage, encodeStudioPackage, validateStudioManifest, validateStudioPackage } from "./studio-session-format"
import { prepareStudioImport } from "./venice-studio"
import { studioAudioFixture, studioFixture } from "./test/studio-fixture"
describe("Studio session ZIP", () => {
  it("round trips all input/output originals and editable metadata", async () => {
    const pkg = await studioFixture()
    expect(await decodeStudioPackage(await encodeStudioPackage(pkg))).toEqual(pkg)
  })
  it("remaps IDs, selection and nested input paths but preserves prompt text", async () => {
    const { manifest } = await studioFixture(), prepared = prepareStudioImport(manifest, "new-owner")
    expect(prepared.sessionId).not.toBe(manifest.session.id)
    expect(prepared.session.selectedImageId).toBe(prepared.media[1].id)
    expect(prepared.turns[0].input).toEqual({ id: prepared.media[0].id, mimeType: "image/png", fileName: prepared.media[0].fileName })
    expect(prepared.turns[0].prompt).toBe(manifest.session.id)
    for (const row of [prepared.session, ...prepared.turns, ...prepared.media]) expect(row.ownerId).toBe("new-owner")
    expect(prepared.media[0].fileName).toContain(`media/${prepared.sessionId}/`)
  })
  it("rejects foreign/missing/duplicate references, active turns and unknown fields", async () => {
    const pkg = await studioFixture()
    const variants = [
      (m: typeof pkg.manifest) => { m.turns[0].sessionId = crypto.randomUUID() },
      (m: typeof pkg.manifest) => { m.media[0].id = m.media[1].id },
      (m: typeof pkg.manifest) => { m.session.selectedImageId = crypto.randomUUID() },
      (m: typeof pkg.manifest) => { m.turns[0].input = { id: crypto.randomUUID(), fileName: "https://example.com/image", mimeType: "image/png" } },
      (m: typeof pkg.manifest) => { m.media.pop() },
      (m: typeof pkg.manifest) => { m.session.jobId = "pending" },
      (m: typeof pkg.manifest) => { m.media[0].ownerId = "foreign" },
      (m: typeof pkg.manifest) => { m.media[0].imageSettings = { ownerId: "foreign" } },
      (m: typeof pkg.manifest) => { m.files.pop() },
      (m: typeof pkg.manifest) => { m.media[0].imageSettings = { reference: "media/other/file.png" } },
      (m: typeof pkg.manifest) => { m.media[0].imageSettings = { width: Infinity } },
      (m: typeof pkg.manifest) => { m.media[0].inputGroupId = crypto.randomUUID() },
      (m: typeof pkg.manifest) => { m.media[0].imageSettings = { maskMedia: { id: crypto.randomUUID() } } },
      (m: typeof pkg.manifest) => { m.media[0].unknownEvenIfAbsent = undefined },
      (m: typeof pkg.manifest) => { m.turns[0].mode = "future-mode" },
      (m: typeof pkg.manifest) => { m.media[0].imageSettings = { hideWatermark: "not-a-boolean" } },
      (m: typeof pkg.manifest) => { m.media[0].imageSettings = { loraStrength: "not-a-number" } },
    ]
    for (const change of variants) {
      const copy = structuredClone(pkg.manifest); change(copy)
      expect(() => validateStudioManifest(copy)).toThrow()
    }
  })
  it("rejects hashes, extra files, MIME disagreement, traversal and extraction overflow", async () => {
    const pkg = await studioFixture()
    pkg.files[pkg.manifest.files[0].path] = new Uint8Array([4, 5, 6])
    await expect(validateStudioPackage(pkg)).rejects.toThrow("checksum")
    const other = await studioFixture()
    other.files["unexpected.bin"] = new Uint8Array([1])
    await expect(validateStudioPackage(other)).rejects.toThrow("Unexpected")
    const manifest = structuredClone(other.manifest)
    manifest.media[0].fileName = `media/${manifest.session.id}/../image.png`
    expect(() => validateStudioManifest(manifest)).toThrow("path")
    for (const name of ["../evil", "media/other/a.png", "https://example.com"]) {
      await expect(decodeStudioPackage(zipSync({ "manifest.json": strToU8("{}"), [name]: new Uint8Array([1]) }))).rejects.toThrow("Unsafe")
    }
  })
  it("rejects beta/video formats and generated ID collisions", async () => {
    const { manifest } = await studioFixture()
    expect(() => validateStudioManifest({ ...manifest, kind: "video" })).toThrow("not supported")
    expect(() => prepareStudioImport(manifest, "owner", () => "55555555-5555-4555-8555-555555555555")).toThrow("collide")
  })
  it("preserves ordinary audio settings, subtitles and selected audio while remapping its IDs", async () => {
    const pkg = await studioAudioFixture()
    expect(await decodeStudioPackage(await encodeStudioPackage(pkg))).toEqual(pkg)
    const prepared = prepareStudioImport(pkg.manifest, "new-owner")
    expect(prepared.session.selectedAudioId).toBe(prepared.media[0].id)
    expect(prepared.media[0].subtitle).toEqual(pkg.manifest.media[0].subtitle)
    expect(prepared.turns[0].settings).toEqual(pkg.manifest.turns[0].settings)
  })
  it("explicitly rejects nonportable audio sources, voices, covers and unknown subtitle shapes", async () => {
    const { manifest } = await studioAudioFixture()
    for (const change of [
      (m: typeof manifest) => { m.turns[0].settings = { sourceAudio: { id: crypto.randomUUID() } } },
      (m: typeof manifest) => { m.media[0].audioSettings = { voice: "vv_private" } },
      (m: typeof manifest) => { m.media[0].coverAssetPath = "audio-thumbnails/private.webp" },
      (m: typeof manifest) => { m.media[0].subtitle = { sentences: [], jobId: "unknown" } },
    ]) {
      const copy = structuredClone(manifest); change(copy)
      expect(() => validateStudioManifest(copy)).toThrow()
    }
  })
})
