import { useEffect, useState } from "react"
import { loadMindAvatar } from "./venice-mind-package"
import { VeniceMindIcon } from "./components/VeniceIcons"
import { remoteMindAvatarUrl, type MindAvatarReference } from "./mind-avatars"

export function MindAvatar({ mindId, remoteMindId, name, avatar, compact = false }: {
  mindId?: string; remoteMindId?: string; name: string; avatar?: MindAvatarReference; compact?: boolean
}) {
  const avatarId = avatar?.id
  const mimeType = avatar?.mimeType
  const source = remoteMindId ? `remote:${remoteMindId}` : `${mindId}:${avatarId ?? ""}:${mimeType ?? ""}`
  const [result, setResult] = useState<{ source: string; url?: string; error?: string }>()
  const url = remoteMindId ? remoteMindAvatarUrl(remoteMindId) : result?.source === source ? result.url : undefined
  const error = result?.source === source ? result.error : undefined
  useEffect(() => {
    let active = true
    let resource: string | undefined
    if (remoteMindId || !mindId || !avatarId || !mimeType) return
    loadMindAvatar(mindId, { id: avatarId, mimeType }).then(
      (value) => {
        resource = value
        if (active) setResult({ source, url: value })
        else URL.revokeObjectURL(value)
      },
      (reason: unknown) => {
        if (active) setResult({ source, error: reason instanceof Error ? reason.message : String(reason) })
      },
    )
    return () => { active = false; if (resource) URL.revokeObjectURL(resource) }
  }, [mindId, remoteMindId, avatarId, mimeType, source])
  return (
    <span className={`flex shrink-0 items-center justify-center overflow-hidden border bg-muted ${compact ? "size-11 rounded-lg" : "size-14 rounded-xl"}`} title={error ? `Avatar unavailable: ${error}` : name}>
      {url && !error ? <img src={url} alt={`${name} avatar`} referrerPolicy="no-referrer" className="size-full object-cover" onError={() => setResult({ source, url, error: "The Mind avatar image could not be displayed." })} /> :
        <VeniceMindIcon aria-hidden="true" className="size-6 text-muted-foreground" />}
      {error && <span className="sr-only" role="status">Avatar unavailable: {error}</span>}
    </span>
  )
}
