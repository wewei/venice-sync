import { useEffect, useRef, useState } from "react"
import { IconDownload, IconFileMusic, IconPhoto, IconRefresh, IconUpload } from "@tabler/icons-react"
import { Button } from "@/components/ui/button"
import { IconAction } from "./components/IconAction"
import { decodeStudioPackage, encodeStudioPackage, MAX_STUDIO_ZIP, type StudioPackage } from "./studio-session-format"
import { exportStudioSession, importStudioSession, listStudioSessions, type StudioSession } from "./venice-studio"

const errorText = (error: unknown) => error instanceof Error ? error.message : String(error)
export function StudioTransfer({ reloadPage }: { reloadPage: () => void }) {
  const [sessions, setSessions] = useState<StudioSession[]>([])
  const [loading, setLoading] = useState(true), [busy, setBusy] = useState(false)
  const [revision, setRevision] = useState(0), [visible, setVisible] = useState(24)
  const [error, setError] = useState<string>(), [notice, setNotice] = useState<string>()
  const [preview, setPreview] = useState<StudioPackage>()
  const input = useRef<HTMLInputElement>(null)
  useEffect(() => {
    let active = true
    listStudioSessions().then(
      (rows) => { if (active) { setSessions(rows); setLoading(false) } },
      (reason: unknown) => { if (active) { setError(errorText(reason)); setLoading(false) } },
    )
    return () => { active = false }
  }, [revision])
  const refresh = () => { setLoading(true); setError(undefined); setRevision((value) => value + 1) }
  async function download(session: StudioSession) {
    setBusy(true); setError(undefined); setNotice(undefined)
    try {
      const bytes = await encodeStudioPackage(await exportStudioSession(session.id, undefined, session.kind))
      const url = URL.createObjectURL(new Blob([Uint8Array.from(bytes).buffer], { type: "application/zip" }))
      const link = document.createElement("a")
      link.href = url; link.download = `venice-studio-${session.id}.zip`; link.click()
      setTimeout(() => URL.revokeObjectURL(url), 1000)
      setNotice("Session and all input/output originals downloaded. Archives are unencrypted; keep them private.")
    } catch (reason) { setError(errorText(reason)) }
    finally { setBusy(false) }
  }
  async function selectFile(file: File) {
    setBusy(true); setPreview(undefined); setError(undefined); setNotice(undefined)
    try {
      if (file.size > MAX_STUDIO_ZIP) throw new Error("Studio ZIP exceeds 128 MiB.")
      setPreview(await decodeStudioPackage(new Uint8Array(await file.arrayBuffer())))
    } catch (reason) { setError(errorText(reason)) }
    finally { setBusy(false) }
  }
  async function confirmImport() {
    if (!preview) { setError("Select and preview a Studio session first."); return }
    setBusy(true); setError(undefined)
    try {
      await importStudioSession(preview)
      setPreview(undefined); setNotice("Studio session imported as a new editable copy. Reloading Venice.")
      refresh()
      try { reloadPage() }
      catch (reason) { setError(`Studio import succeeded, but refresh failed: ${errorText(reason)}. Reload manually; do not import a second copy.`) }
    } catch (reason) { setError(errorText(reason)) }
    finally { setBusy(false) }
  }
  return <section aria-label="Studio session transfer" aria-busy={loading || busy} className="grid gap-5">
    <header className="flex items-center justify-between gap-4">
      <div><h2 className="text-xl font-medium">Studio Sessions</h2><p className="mt-1 text-sm text-muted-foreground">Editable classic image/audio sessions, with prompts, settings and originals.</p></div>
      <div className="flex shrink-0 gap-1">
        <IconAction label="Refresh Studio sessions" disabled={loading || busy} onClick={refresh}><IconRefresh aria-hidden="true" /></IconAction>
        <IconAction label="Upload Studio session" disabled={loading || busy} onClick={() => input.current?.click()}><IconUpload aria-hidden="true" /></IconAction>
      </div>
    </header>
    <p className="text-xs text-muted-foreground">Finish editing and generation before exporting. This is separate from individual Library assets; beta projects and video sessions are not supported.</p>
    <p className="text-xs text-muted-foreground">Audio source attachments, cloned voices, custom covers and unknown subtitle shapes are not portable yet and are rejected explicitly.</p>
    <input ref={input} type="file" accept=".zip" aria-label="Import Studio session" className="sr-only" tabIndex={-1} disabled={loading || busy}
      onChange={(event) => { const file = event.currentTarget.files?.[0]; event.currentTarget.value = ""; if (file) void selectFile(file) }} />
    {loading && <p role="status">Reading Studio sessions...</p>}
    {error && <p role="alert">{error}</p>}
    {!loading && <div data-testid="studio-session-list" className="grid gap-3">
      <p className="text-sm text-muted-foreground">{sessions.length} Studio sessions</p>
      {!sessions.length && !error && <p>No classic Studio sessions in this account.</p>}
      {sessions.slice(0, visible).map((session) => <article key={session.id} data-studio-session-id={session.id} className="flex min-w-0 items-center gap-3 rounded-xl border p-4">
        {session.kind === "audio" ? <IconFileMusic className="size-8 shrink-0 text-muted-foreground" aria-hidden="true" /> : <IconPhoto className="size-8 shrink-0 text-muted-foreground" aria-hidden="true" />}
        <div className="min-w-0 flex-1"><h3 className="truncate font-medium" title={session.name}>{session.name}</h3>
          <p className="mt-1 text-xs text-muted-foreground">{session.kind} · {session.type} · {new Date(session.updatedAt).toLocaleString()}</p></div>
        <IconAction label="Export Studio session ZIP" disabled={busy || loading} onClick={() => void download(session)}><IconDownload aria-hidden="true" /></IconAction>
      </article>)}
      {sessions.length > visible && <Button variant="outline" disabled={busy} onClick={() => setVisible((value) => value + 24)}>Show more sessions</Button>}
    </div>}
    {preview && <section data-testid="studio-import-preview" aria-label="Studio import preview" className="grid gap-3 rounded-xl border p-5">
      <h3 className="font-medium">{String(preview.manifest.session.name) || "Untitled Studio session"}</h3>
      <p className="text-sm">{preview.manifest.kind} · {preview.manifest.turns.length} turns · {preview.manifest.files.length} originals</p>
      <p className="text-sm text-muted-foreground">Creates a new editable Studio session with fresh IDs. Originals and account preferences are not overwritten. No generation is started.</p>
      <p className="text-sm text-muted-foreground">Venice reloads after import. Save unsent drafts and finish ongoing generation first. Keep this page open until import finishes.</p>
      <div className="flex flex-wrap gap-2"><Button disabled={busy} onClick={() => void confirmImport()}>Confirm import as new Studio session</Button>
        <Button variant="outline" disabled={busy} onClick={() => setPreview(undefined)}>Cancel Studio import</Button></div>
    </section>}
    {notice && <p role="status">{notice}</p>}
  </section>
}
