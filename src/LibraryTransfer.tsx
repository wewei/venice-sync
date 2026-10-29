import { useEffect, useRef, useState } from "react"
import { IconDownload, IconFileMusic, IconMovie, IconRefresh, IconUpload } from "@tabler/icons-react"
import { Button } from "@/components/ui/button"
import { IconAction } from "./components/IconAction"
import { VeniceLibraryIcon } from "./components/VeniceIcons"
import {
  decodeLibraryPackage, encodeLibraryPackage, MAX_LIBRARY_ZIP, rawLibraryPackage, type LibraryPackage,
} from "./library-format"
import { exportLibraryAsset, importLibraryAsset, listLibraryAssets, readLibraryAsset, type LibraryAsset, type LibrarySourceError } from "./venice-library"
import { BasketAddAll, BasketItem } from "./BatchBasket"

const errorText = (error: unknown) => error instanceof Error ? error.message : String(error)
const sizeText = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(2)} MiB`
const sources = { chat: "Chat", "studio-image": "Studio image", "studio-audio": "Studio audio", mind: "Mind", discover: "Discover" }

function AssetPreview({ asset }: { asset: LibraryAsset }) {
  const element = useRef<HTMLDivElement>(null)
  const [url, setUrl] = useState<string>()
  const [error, setError] = useState<string>()
  useEffect(() => {
    let active = true, started = false, resource: string | undefined
    const load = () => {
      if (started) return
      started = true
      readLibraryAsset(asset).then(
        (blob) => {
          resource = URL.createObjectURL(blob)
          if (active) setUrl(resource)
          else URL.revokeObjectURL(resource)
        },
        (reason: unknown) => { if (active) setError(errorText(reason)) },
      )
    }
    const observer = typeof IntersectionObserver === "undefined" ? undefined : new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) { observer?.disconnect(); load() }
    }, { rootMargin: "200px" })
    if (observer && element.current) observer.observe(element.current)
    else load()
    return () => { active = false; observer?.disconnect(); if (resource) URL.revokeObjectURL(resource) }
  }, [asset])
  const fail = () => setError("The original media file could not be decoded.")
  return <div ref={element} className="flex aspect-video min-w-0 items-center justify-center overflow-hidden rounded-lg bg-muted">
    {url && !error ? asset.kind === "image" ?
      <img src={url} alt={asset.filename} className="size-full object-contain" onError={fail} /> : asset.kind === "video" ?
        <video src={url} aria-label={asset.filename} controls preload="metadata" className="size-full object-contain" onError={fail} /> :
        <div className="grid w-full gap-3 p-4"><IconFileMusic aria-hidden="true" className="mx-auto size-9 text-muted-foreground" /><audio src={url} aria-label={asset.filename} controls preload="metadata" className="w-full" onError={fail} /></div> :
      <div className="grid gap-2 p-4 text-center text-sm text-muted-foreground">
        {asset.kind === "video" ? <IconMovie className="mx-auto size-8" aria-hidden="true" /> : <VeniceLibraryIcon className="mx-auto size-8" aria-hidden="true" />}
        {error && <span role="status" title={error}>Original unavailable: {error}</span>}
      </div>}
  </div>
}

export function LibraryTransfer({ reloadPage }: { reloadPage: () => void }) {
  const [assets, setAssets] = useState<LibraryAsset[]>([])
  const [sourceErrors, setSourceErrors] = useState<LibrarySourceError[]>([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const [notice, setNotice] = useState<string>()
  const [preview, setPreview] = useState<LibraryPackage>()
  const [revision, setRevision] = useState(0)
  const [visible, setVisible] = useState(24)
  const input = useRef<HTMLInputElement>(null)
  useEffect(() => {
    let active = true
    listLibraryAssets().then(
      (data) => { if (active) { setAssets(data.assets); setSourceErrors(data.errors); setLoading(false) } },
      (reason: unknown) => { if (active) { setError(errorText(reason)); setLoading(false) } },
    )
    return () => { active = false }
  }, [revision])
  const refresh = () => { setError(undefined); setSourceErrors([]); setLoading(true); setRevision((value) => value + 1) }
  async function download(asset: LibraryAsset) {
    setBusy(true); setError(undefined); setNotice(undefined)
    try {
      const pkg = await exportLibraryAsset(asset.key), bytes = await encodeLibraryPackage(pkg)
      const url = URL.createObjectURL(new Blob([Uint8Array.from(bytes).buffer], { type: "application/zip" }))
      const link = document.createElement("a")
      link.href = url; link.download = `venice-library-${asset.id.replace(/[^a-zA-Z0-9_-]/g, "_")}.zip`; link.click()
      setTimeout(() => URL.revokeObjectURL(url), 1000)
      setNotice("Original media and source metadata downloaded. Library packages are unencrypted; keep them private.")
    } catch (reason) { setError(errorText(reason)) }
    finally { setBusy(false) }
  }
  async function selectFile(file: File) {
    setBusy(true); setError(undefined); setNotice(undefined); setPreview(undefined)
    try {
      if (file.size > MAX_LIBRARY_ZIP) throw new Error("Library ZIP exceeds 128 MiB.")
      setPreview(file.name.toLowerCase().endsWith(".zip") ?
        await decodeLibraryPackage(new Uint8Array(await file.arrayBuffer())) : await rawLibraryPackage(file))
    } catch (reason) { setError(errorText(reason)) }
    finally { setBusy(false) }
  }
  async function confirmImport() {
    if (!preview) { setError("Select and preview a Library asset first."); return }
    setBusy(true); setError(undefined)
    try {
      await importLibraryAsset(preview)
      setPreview(undefined); setNotice("Imported as a new independent Library asset. Reloading Venice to refresh its Library.")
      refresh()
      try { reloadPage() }
      catch (reason) { setError(`Library import succeeded, but refresh failed: ${errorText(reason)}. Reload manually; do not import a second copy.`) }
    } catch (reason) { setError(errorText(reason)) }
    finally { setBusy(false) }
  }
  return (
    <section aria-label="Library asset transfer" aria-busy={loading || busy} className="grid gap-5">
      <header className="flex items-center justify-between gap-4">
        <div><h2 className="text-xl font-medium">Library Assets</h2><p className="mt-1 text-sm text-muted-foreground">Original images, videos and audio from the native generated-media Library.</p></div>
        <div className="flex shrink-0 gap-1">
          <IconAction label="Refresh Library" disabled={loading || busy} onClick={refresh}><IconRefresh aria-hidden="true" /></IconAction>
          <IconAction label="Upload Library asset" disabled={loading || busy} onClick={() => input.current?.click()}><IconUpload aria-hidden="true" /></IconAction>
        </div>
      </header>
      <input ref={input} type="file" accept=".zip,image/png,image/jpeg,image/webp,image/gif,image/avif,image/bmp,video/mp4,video/webm,video/quicktime,audio/*"
        aria-label="Import Library asset" className="sr-only" tabIndex={-1} disabled={loading || busy}
        onChange={(event) => { const file = event.currentTarget.files?.[0]; event.currentTarget.value = ""; if (file) void selectFile(file) }} />
      {loading && <p role="status">Reading Library assets...</p>}
      {error && <p role="alert">{error}</p>}
      {sourceErrors.map(({ source, message }) => <p role="alert" key={source}>{sources[source]} unavailable: {message}</p>)}
      {!loading && <BasketAddAll items={assets.map(asset => ({ kind: "library", id: asset.key, title: asset.title }))} label="loaded Library assets" disabled={busy} />}
      {!loading && <div data-testid="library-asset-list" className="grid gap-3">
        <p className="text-sm text-muted-foreground">{assets.length} Library assets</p>
        {!assets.length && !error && !sourceErrors.length && <p className="rounded-xl border p-8 text-center text-muted-foreground">No generated Library assets in this account.</p>}
        <div className="grid min-w-0 gap-4 lg:grid-cols-2">
          {assets.slice(0, visible).map((asset) => <article key={asset.key} data-library-asset-key={asset.key} className="grid min-w-0 gap-3 rounded-xl border p-3">
            <AssetPreview asset={asset} />
            <div className="flex min-w-0 items-center gap-3">
              <div className="min-w-0 flex-1"><h3 className="truncate font-medium" title={asset.title}>{asset.title}</h3>
                <p className="mt-1 text-xs text-muted-foreground">{asset.kind} · {asset.originalSource ? "Imported copy" : sources[asset.source]}</p>
              </div>
              <BasketItem item={{ kind: "library", id: asset.key, title: asset.title }} disabled={busy} />
              <IconAction label="Export Library asset ZIP" disabled={busy} onClick={() => void download(asset)}><IconDownload aria-hidden="true" /></IconAction>
            </div>
          </article>)}
        </div>
        {visible < assets.length && <Button variant="outline" onClick={() => setVisible((value) => value + 24)}>Show more assets</Button>}
      </div>}
      <details className="rounded-lg border p-3 text-sm text-muted-foreground"><summary className="cursor-pointer">Library scope &amp; privacy</summary>
        <p className="mt-3">Each ZIP contains one original file plus source metadata and SHA-256, not its source conversation or Studio project. Limits: 100 MiB file, 8 MiB metadata, 128 MiB ZIP. Thumbnails, generated inputs and external cover artwork are not reconstructed.</p>
        <p className="mt-2">Import restores an independent media asset through a new private local media container, not the userMedia upload table. Original files/records are never overwritten, and missing originals are reported rather than deleted. No generation or publishing requests are made.</p>
      </details>
      {preview && <div data-testid="library-import-preview" className="grid gap-3 rounded-xl border p-5 text-sm">
        <h3 className="text-lg font-medium">{preview.manifest.asset.filename}</h3>
        <p>{preview.manifest.asset.kind} · {preview.manifest.asset.mimeType} · {sizeText(preview.manifest.asset.bytes)}</p>
        <p>A new permanent media container and asset IDs will be created. It may also appear in Conversations. Source chats, projects and generation settings are not recreated; source metadata is retained as provenance.</p>
        <p>The page reloads after success. Save drafts and finish generation first. Files/database writes are rolled back on failure, but closing the page during import can interrupt cleanup.</p>
        <div className="flex flex-wrap gap-2"><Button disabled={busy} onClick={() => void confirmImport()}>Confirm import as new Library asset</Button>
          <Button variant="outline" disabled={busy} onClick={() => setPreview(undefined)}>Cancel Library import</Button></div>
      </div>}
      {notice && <p role="status" className="text-sm">{notice}</p>}
    </section>
  )
}
