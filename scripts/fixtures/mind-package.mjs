import { createHash } from "node:crypto"
import { strToU8, zipSync } from "fflate"

export function syntheticMindPackage(name = "Venice Sync complete Mind fixture") {
  const id = "synthetic-mind"
  const now = 1793091600000
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=", "base64")
  const note = strToU8("Synthetic reference file for complete Mind round-trip verification.")
  const maker = `mind-maker-conv:${id}`, preview = `mind-preview-conv:${id}`
  const message = (thread, prefix, role, content) => ({
    id: `${prefix}-response`, mind_conversation_id: thread, role, status: "completed",
    created_at_unix_timestamp: now, updated_at_unix_timestamp: now + 1,
    output_items: [{ id: `${prefix}-item`, type: "message", response_id: `${prefix}-response`, status: "completed", output_index: 0,
      content: [{ id: `${prefix}-text`, item_id: `${prefix}-item`, response_id: `${prefix}-response`, type: "output_text", text: content, content_index: 0 }] }],
  })
  const assistantMessage = message(maker, "builder", "assistant", "Synthetic Builder history restored without replaying edits.")
  assistantMessage.output_items.push(
    { id: "builder-call", type: "functionCall", response_id: assistantMessage.id, call_id: "builder-call-id", name: "update_mind", status: "completed", output_index: 1,
      arguments: JSON.stringify({ id, name: "THIS MUST NEVER BE REPLAYED" }) },
    { id: "builder-call-result", type: "functionCallOutput", response_id: assistantMessage.id, call_id: "builder-call-id", status: "completed", output_index: 2, output: '{"ok":true,"historical":true}' },
  )
  const previewMessage = message(preview, "preview", "user", "Synthetic Preview history restored with its reference attachment.")
  previewMessage.output_items[0].content.push({ id: "preview-file", type: "input_file", item_id: "preview-item", response_id: previewMessage.id, media_id: "attachment", filename: "note.txt", mime_type: "text/plain", content_index: 1 })
  previewMessage.output_items[0].content.push({ id: "preview-image", type: "input_image", item_id: "preview-item", response_id: previewMessage.id, media_id: "image", mime_type: "image/png", content_index: 2 })
  const manifest = {
    format: "venice-sync-mind", version: 1, exportedAt: new Date().toISOString(),
    definition: {
      id, name, modelId: "venice-uncensored", systemPrompt: { instructions: "Synthetic system instructions. This is a local backup verification fixture, not an inference request." },
      tools: {
        child: { type: "sub_agent", id: "child", name: "Synthetic helper", description: "Test sub-agent", icon: "TbBrain", system_prompt: "Synthetic child instructions.", tools: [{ type: "clock" }] },
        web_search: { type: "web_search" },
      },
      assets: { reference: { filename: "reference.txt", mimeType: "text/plain", description: "Synthetic reference document" } },
      avatarImage: { id: "avatar", mimeType: "image/png" }, coverImage: { id: "cover", mimeType: "image/png" },
      reasoningMode: "adaptive", hideReasoning: true, description: "Synthetic Mind package test", category: "productivity",
      openingInstruction: "Synthetic opening instruction.", createdAtUnixTimestamp: now, updatedAtUnixTimestamp: now,
    },
    assistant: {
      conversation: { id: maker, mindId: id, type: "maker", name: "Synthetic Builder", createdAtUnixTimestamp: now, updatedAtUnixTimestamp: now + 1 },
      messages: [assistantMessage], attachments: [], media: [],
    },
    preview: {
      conversation: { id: preview, mindId: id, type: "preview", name: "Synthetic Preview", createdAtUnixTimestamp: now, updatedAtUnixTimestamp: now + 1 },
      messages: [previewMessage],
      attachments: [{ id: "attachment", mindConversationId: preview, mindMessageId: previewMessage.id, filename: "note.txt", mimeType: "text/plain", size: note.length,
        createdAtUnixTimestamp: now, updatedAtUnixTimestamp: now }],
      media: [{ id: "image", mindConversationId: preview, mindMessageId: previewMessage.id, data: { mediaType: "materializedImage", mimeType: "image/png", size: png.length },
        createdAtUnixTimestamp: now, updatedAtUnixTimestamp: now }],
    },
    files: [],
  }
  const files = {
    "files/mind/avatar_images/avatar.png": png,
    "files/mind/cover_images/cover.png": png,
    "files/mind/assets/reference.txt": note,
    "files/preview/attachments/attachment.txt": note,
    "files/preview/image.png": png,
  }
  manifest.files = Object.entries(files).map(([path, bytes]) => {
    const [, scope, ...relative] = path.split("/")
    return { scope, path: relative.join("/"), size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") }
  })
  return { manifest, files, zip: zipSync({ "manifest.json": strToU8(JSON.stringify(manifest)), ...files }, { level: 0 }) }
}
