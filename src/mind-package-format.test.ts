// @vitest-environment node
import { strToU8, zipSync } from "fflate"
import { describe, expect, it } from "vitest"
import { decodeMindPackage, encodeMindPackage, mindFileKey, safeMindPath, sha256, validateMindManifest, type MindPackage } from "./mind-package-format"

async function fixture(): Promise<MindPackage> {
  const bytes = strToU8("Reference document")
  return {
    manifest: {
      format: "venice-sync-mind", version: 1, exportedAt: "2026-10-27T09:00:00Z",
      definition: { id: "original", name: "Synthetic Mind", systemPrompt: { instructions: "Test" }, tools: {}, assets: { asset: { filename: "note.txt", mimeType: "text/plain", description: "Test" } } },
      files: [{ scope: "mind", path: "assets/asset.txt", size: bytes.length, sha256: await sha256(bytes) }],
    },
    files: { [mindFileKey("mind", "assets/asset.txt")]: bytes },
  }
}

describe("complete Mind ZIP format", () => {
  it("round trips resources with checksums and preserves exact definitions", async () => {
    const pkg = await fixture()
    const result = await decodeMindPackage(await encodeMindPackage(pkg))
    expect(result).toEqual(pkg)
  })

  it("rejects corrupted resources, missing files and unknown formats before writes", async () => {
    const pkg = await fixture()
    pkg.files["files/mind/assets/asset.txt"][0] ^= 1
    await expect(encodeMindPackage(pkg)).rejects.toThrow("checksum")
    pkg.files = {}
    await expect(encodeMindPackage(pkg)).rejects.toThrow("missing")
    expect(() => validateMindManifest({ format: "unknown", version: 1 })).toThrow("format")
  })

  it.each(["../outside", "/absolute", "a\\b", "C:/file", "a//b", "a/./b", "a/\u0000b"])("rejects unsafe ZIP/OPFS path %s", (path) => {
    expect(() => safeMindPath(path)).toThrow("Unsafe")
  })

  it("accepts native colon-separated file IDs without treating them as filesystem paths", () => {
    expect(safeMindPath("media/mind-maker-conv:uuid")).toBe("media/mind-maker-conv:uuid")
    expect(safeMindPath("attachments/response:0.png")).toBe("attachments/response:0.png")
  })

  it("rejects pending Builder tools and mismatched deterministic history associations", async () => {
    const pkg = await fixture()
    pkg.manifest.assistant = {
      conversation: { id: "mind-maker-conv:original", mindId: "original", type: "maker" },
      messages: [{ id: "response", mind_conversation_id: "mind-maker-conv:original", status: "completed", output_items: [{ id: "call", type: "message", status: "in_progress" }] }],
      media: [], attachments: [],
    }
    expect(() => validateMindManifest(pkg.manifest)).toThrow("Active tool")
    pkg.manifest.assistant.messages[0].output_items = []
    expect(validateMindManifest(pkg.manifest).assistant).toBeDefined()
    pkg.manifest.assistant.conversation.mindId = "foreign"
    expect(() => validateMindManifest(pkg.manifest)).toThrow("different Mind")
  })

  it("rejects raw database/account fields, orphaned media and excluded-history resources", async () => {
    const pkg = await fixture()
    pkg.manifest.definition.ownerId = "other"
    expect(() => validateMindManifest(pkg.manifest)).toThrow("account")
    delete pkg.manifest.definition.ownerId
    pkg.manifest.files[0].scope = "assistant"
    expect(() => validateMindManifest(pkg.manifest)).toThrow("excluded")
  })

  it("enforces uncompressed limits before extraction", async () => {
    const zip = zipSync({ "manifest.json": new Uint8Array(8 * 1024 * 1024 + 1) }, { level: 9 })
    await expect(decodeMindPackage(zip)).rejects.toThrow("extraction limits")
    await expect(decodeMindPackage(zipSync({ "other.json": strToU8("{}") }))).rejects.toThrow("manifest")
  })
})
