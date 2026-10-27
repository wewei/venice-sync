import { MAX_CONVERSATION_BYTES } from "./conversation-format"

export function readTransferFile(file: File): Promise<string> {
  if (file.size > MAX_CONVERSATION_BYTES) return Promise.reject(new Error("Conversation JSON exceeds 8 MiB."))
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => typeof reader.result === "string"
      ? resolve(reader.result) : reject(new Error("Could not read conversation JSON as text."))
    reader.onerror = () => reject(reader.error ?? new Error("Could not read the selected file."))
    reader.onabort = () => reject(new Error("File reading was cancelled."))
    reader.readAsText(file)
  })
}

export function downloadTransferJson(value: unknown, filename: string): void {
  const json = JSON.stringify(value, null, 2)
  if (new TextEncoder().encode(json).byteLength > MAX_CONVERSATION_BYTES) {
    throw new Error("This conversation exceeds the 8 MiB transfer limit.")
  }
  const url = URL.createObjectURL(new Blob([json], { type: "application/json" }))
  const link = document.createElement("a")
  link.href = url
  link.download = filename
  link.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
