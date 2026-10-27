import { useEffect, useRef, useState } from "react"
import { IconDownload, IconRefresh, IconUpload } from "@tabler/icons-react"
import { Button } from "@/components/ui/button"
import { decodeMindPackage, encodeMindPackage, MAX_MIND_PACKAGE_BYTES, type MindPackage } from "./mind-package-format"
import { exportMindPackage, importMindPackage, listMindDefinitions } from "./venice-mind-package"
import { IconAction } from "./components/IconAction"
import { MindAvatar } from "./MindAvatar"

const errorText = (error: unknown) => error instanceof Error ? error.message : String(error)

export function MindDefinitionTransfer() {
  const [minds, setMinds] = useState<Awaited<ReturnType<typeof listMindDefinitions>>>([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const [notice, setNotice] = useState<string>()
  const [archive, setArchive] = useState<MindPackage>()
  const [importedId, setImportedId] = useState<string>()
  const [revision, setRevision] = useState(0)
  const input = useRef<HTMLInputElement>(null)
  useEffect(() => {
    let active = true
    listMindDefinitions().then(
      (data) => { if (active) { setMinds(data); setLoading(false) } },
      (reason: unknown) => { if (active) { setError(errorText(reason)); setLoading(false) } },
    )
    return () => { active = false }
  }, [revision])
  const refresh = () => { setError(undefined); setLoading(true); setRevision((value) => value + 1) }
  async function download(id: string) {
    setBusy(true); setError(undefined); setNotice(undefined)
    try {
      const pkg = await exportMindPackage(id, { assistant: true, preview: true })
      const bytes = await encodeMindPackage(pkg)
      const url = URL.createObjectURL(new Blob([Uint8Array.from(bytes).buffer], { type: "application/zip" }))
      const link = document.createElement("a")
      link.href = url; link.download = `venice-mind-${id}.zip`; link.click()
      setTimeout(() => URL.revokeObjectURL(url), 1000)
      setNotice("Complete Mind package downloaded. Instructions, files and all saved editor histories are plaintext; keep it private.")
    } catch (reason) { setError(errorText(reason)) }
    finally { setBusy(false) }
  }
  async function selectFile(file: File) {
    setBusy(true); setError(undefined); setNotice(undefined); setArchive(undefined); setImportedId(undefined)
    try {
      if (file.size > MAX_MIND_PACKAGE_BYTES) throw new Error("Mind package exceeds 128 MiB.")
      setArchive(await decodeMindPackage(new Uint8Array(await file.arrayBuffer())))
    } catch (reason) { setError(errorText(reason)) }
    finally { setBusy(false) }
  }
  async function confirmImport() {
    if (!archive) { setError("Select a validated Mind package first."); return }
    setBusy(true); setError(undefined)
    try {
      const id = await importMindPackage(archive, { assistant: true, preview: true })
      setImportedId(id); setArchive(undefined)
      setNotice("Imported as a new local unpublished Mind. No history tools were replayed and no inference or publishing request was sent.")
      refresh()
    } catch (reason) { setError(errorText(reason)) }
    finally { setBusy(false) }
  }
  return (
    <section aria-label="Mind definition transfer" aria-busy={loading || busy} className="grid gap-5">
      <div className="flex items-center justify-between gap-4">
        <div><h2 className="text-xl font-medium">Mind</h2><p className="mt-1 text-sm text-muted-foreground">Definitions, resources and all saved editor histories in one package.</p></div>
        <div className="flex shrink-0 gap-1">
          <IconAction label="Refresh Minds" disabled={loading || busy} onClick={refresh}><IconRefresh aria-hidden="true" /></IconAction>
          <IconAction label="Upload Mind package" disabled={loading || busy} onClick={() => input.current?.click()}><IconUpload aria-hidden="true" /></IconAction>
        </div>
      </div>
      <input ref={input} type="file" aria-label="Import Mind package" accept=".zip,application/zip" disabled={busy || loading} className="sr-only" tabIndex={-1}
        onChange={(event) => { const file = event.currentTarget.files?.[0]; event.currentTarget.value = ""; if (file) void selectFile(file) }} />
      {loading && <p role="status">Reading Mind definitions...</p>}
      {error && <p role="alert">{error}</p>}
      {!loading && !error && <div data-testid="mind-definition-list" className="grid gap-2">
        <p className="text-sm text-muted-foreground">{minds.length} local Mind definitions</p>
        {minds.length === 0 && <p>No local Mind definitions in this account.</p>}
        {minds.map((mind) => <article key={mind.id} data-mind-definition-id={mind.id} className="flex min-w-0 items-center gap-4 rounded-xl border p-4">
          <MindAvatar mindId={mind.id} name={mind.name} avatar={mind.avatar} />
          <div className="min-w-0 flex-1"><h3 className="truncate font-medium" title={mind.name}>{mind.name}</h3>
            <p className="mt-1 text-sm text-muted-foreground">{mind.assets} reference files{mind.published ? " · Published source" : " · Local Mind"}</p>
          </div>
          <IconAction label="Export Mind package" disabled={busy} onClick={() => void download(mind.id)}><IconDownload aria-hidden="true" /></IconAction>
        </article>)}
      </div>}
      <details className="rounded-lg border p-3 text-sm text-muted-foreground"><summary className="cursor-pointer">Package contents &amp; privacy</summary>
        <p className="mt-3">Every export includes the definition, tools/sub-agents, avatar, cover, references, Builder Assistant and Preview histories where saved. Ordinary chat histories stay in Conversations.</p>
        <p className="mt-2">Only ended histories can be restored; pending approvals/generations and missing media are rejected. Limits: 25 MiB per file, 128 MiB total, 2048 files. Packages are plaintext; keep them private.</p>
      </details>
      {archive && <div data-testid="mind-package-preview" className="grid gap-3 rounded-xl border p-5 text-sm">
        <h3 className="text-lg font-medium">{String(archive.manifest.definition.name) || "Untitled Mind"}</h3>
        <p>{archive.manifest.files.length} files; {archive.manifest.assistant?.messages.length ?? 0} Assistant messages; {archive.manifest.preview?.messages.length ?? 0} Preview messages</p>
        <p>Creates a new unpublished Mind with a new ID and current-account ownership. Existing Minds are never overwritten. Publication links are removed.</p>
        <p>History is restored as data only, not executed. Keep this page open until completion. Files and RxDB cannot share a transaction; failed imports attempt targeted cleanup and report any incomplete cleanup.</p>
        <Button disabled={busy} onClick={() => void confirmImport()}>Confirm import as new Mind</Button>
        <Button variant="outline" disabled={busy} onClick={() => setArchive(undefined)}>Cancel Mind package import</Button>
      </div>}
      {notice && <p role="status">{notice}</p>}
      {importedId && <a className="underline" data-testid="imported-mind-definition-link" href={`/minds/local/${encodeURIComponent(importedId)}/edit`}>Open imported Mind editor</a>}
    </section>
  )
}
