import { isRecord } from "./conversation-format"

export interface MindAvatarReference { id: string; mimeType: string }

export function mindAvatarReference(value: unknown): MindAvatarReference | undefined {
  if (isRecord(value) && typeof value.id === "string" && value.id && typeof value.mimeType === "string") {
    return { id: value.id, mimeType: value.mimeType }
  }
}

export function remoteMindAvatarUrl(id: string): string {
  return `https://outerface.venice.ai/api/v2/agents/${encodeURIComponent(id)}/avatar`
}
