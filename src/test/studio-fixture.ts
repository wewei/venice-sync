import { sha256 } from "../mind-package-format"
import type { StudioPackage } from "../studio-session-format"

export async function studioFixture(): Promise<StudioPackage> {
  const sessionId = "11111111-1111-4111-8111-111111111111", turnId = "22222222-2222-4222-8222-222222222222"
  const inputId = "33333333-3333-4333-8333-333333333333", outputId = "44444444-4444-4444-8444-444444444444"
  const bytes = new Uint8Array([1, 2, 3])
  const media = [inputId, outputId].map((id, index) => ({
    id, sessionId, turnId, createdAtUnixTimestamp: 2, mimeType: "image/png",
    fileName: `media/${sessionId}/${id}.png`, mediaRole: index ? "output" : "input",
    ...(index ? { modelId: "test-model", source: "edit", prompt: "Synthetic fixture", imageSettings: { width: 1, height: 1 } } : {}),
  }))
  return {
    manifest: { format: "venice-sync-studio-session", version: 1, exportedAt: "test", kind: "image",
      session: { id: sessionId, type: "edit", name: "Synthetic Studio", selectedImageId: outputId, createdAtUnixTimestamp: 1, updatedAtUnixTimestamp: 3 },
      turns: [{ id: turnId, sessionId, createdAtUnixTimestamp: 2, prompt: sessionId, mode: "edit",
        input: { id: inputId, mimeType: "image/png", fileName: media[0].fileName } }],
      media, files: await Promise.all(media.map(async (row) => ({ id: row.id, path: row.fileName, mimeType: row.mimeType, size: 3, sha256: await sha256(bytes) }))) },
    files: Object.fromEntries(media.map((row) => [row.fileName, bytes])),
  }

}

export async function studioAudioFixture(): Promise<StudioPackage> {
  const pkg = await studioFixture(), session = pkg.manifest.session, turn = pkg.manifest.turns[0], media = pkg.manifest.media[1]
  const id = String(media.id), sessionId = String(session.id), bytes = new Uint8Array([1, 2, 3]), path = `media/${sessionId}/${id}.mp3`
  return {
    manifest: { format: "venice-sync-studio-session", version: 1, exportedAt: "test", kind: "audio",
      session: { id: sessionId, type: "audio-generate", name: "Synthetic audio", selectedAudioId: id, createdAtUnixTimestamp: 1, updatedAtUnixTimestamp: 3 },
      turns: [{ id: turn.id, sessionId, createdAtUnixTimestamp: 2, prompt: "Music", effectivePrompt: "Piano", lyricsPrompt: "", settings: { musicSubcategory: "music", forceInstrumental: true } }],
      media: [{ id, turnId: turn.id, sessionId, createdAtUnixTimestamp: 2, mimeType: "audio/mpeg", fileName: path,
        prompt: "Music", effectivePrompt: "Piano", audioSettings: { musicSubcategory: "music", forceInstrumental: true },
        coverAssetPath: "/images/VeniceKeys_circle_blue.svg", durationSeconds: 4,
        subtitle: { sentences: [{ text: "Synthetic", start_time: 0, end_time: 1, words: [{ text: "Synthetic", start_time: 0, end_time: 1 }] }] } }],
      files: [{ id, path, mimeType: "audio/mpeg", size: 3, sha256: await sha256(bytes) }] },
    files: { [path]: bytes },
  }

}

export async function observedStudioFixture(caseName: "generate-optionals" | "remove-background" | "edit-optionals"): Promise<StudioPackage> {
  const pkg = await studioFixture()
  if (caseName === "generate-optionals") {
    pkg.manifest.session.type = "generate"
    delete pkg.manifest.turns[0].input
    delete pkg.manifest.turns[0].mode
    delete pkg.files[String(pkg.manifest.media[0].fileName)]
    pkg.manifest.media = [pkg.manifest.media[1]]
    pkg.manifest.files = [pkg.manifest.files[1]]
    const media = pkg.manifest.media[0]
    media.prompt = undefined
    media.inputGroupId = undefined
    media.isUserUploaded = undefined
    media.source = "image"
    media.imageSettings = { loraStrength: 75, hideWatermark: false, resolution: undefined, quality: undefined,
      enableWebSearch: undefined, disablePromptOptimizationThinking: undefined, transparentBackground: undefined, suggestedModel: undefined }
  } else {
    pkg.manifest.turns[0].mode = caseName === "remove-background" ? "remove" : "edit"
    pkg.manifest.media[1].source = caseName === "remove-background" ? "remove-bg" : "edit"
    pkg.manifest.media[1].imageSettings = { width: 1, height: 1, resolution: undefined, quality: undefined }
  }
  return pkg
}
