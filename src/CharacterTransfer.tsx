import { useEffect, useRef, useState } from "react"
import { IconDownload, IconRefresh, IconUpload } from "@tabler/icons-react"
import { Button } from "@/components/ui/button"
import { IconAction } from "./components/IconAction"
import { VeniceCharactersIcon } from "./components/VeniceIcons"
import { MAX_CHARACTER_BYTES, parseCharacterFile, type CharacterFile } from "./character-format"
import { downloadTransferJson, readTransferFile } from "./transfer-files"
import { exportCharacter, importCharacter, listCharacters, loadCharacterPortrait } from "./venice-characters"

const errorText = (error: unknown) => error instanceof Error ? error.message : String(error)

function CharacterPortrait({ id, name, hasPhoto }: { id: string; name: string; hasPhoto: boolean }) {
  const [photo, setPhoto] = useState<string>()
  const [error, setError] = useState<string>()
  useEffect(() => {
    let active = true
    if (hasPhoto) loadCharacterPortrait(id).then(
      (value) => { if (active) setPhoto(value) },
      (reason: unknown) => { if (active) setError(errorText(reason)) },
    )
    return () => { active = false }
  }, [id, hasPhoto])
  return <span className="flex size-14 shrink-0 items-center justify-center overflow-hidden rounded-xl border bg-muted" title={error ? `Portrait unavailable: ${error}` : name}>
    {photo && !error ? <img src={photo} alt={`${name} portrait`} className="size-full object-cover" onError={() => setError("Character portrait could not be displayed.")} /> :
      <VeniceCharactersIcon aria-hidden="true" className="size-6 text-muted-foreground" />}
    {error && <span role="status" className="sr-only">Portrait unavailable: {error}</span>}
  </span>
}

export function CharacterTransfer({ reloadPage }: { reloadPage: () => void }) {
  const [characters, setCharacters] = useState<Awaited<ReturnType<typeof listCharacters>>>([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const [notice, setNotice] = useState<string>()
  const [preview, setPreview] = useState<CharacterFile>()
  const [importedId, setImportedId] = useState<string>()
  const [revision, setRevision] = useState(0)
  const input = useRef<HTMLInputElement>(null)
  useEffect(() => {
    let active = true
    listCharacters().then(
      (data) => { if (active) { setCharacters(data); setLoading(false) } },
      (reason: unknown) => { if (active) { setError(errorText(reason)); setLoading(false) } },
    )
    return () => { active = false }
  }, [revision])
  const refresh = () => { setError(undefined); setLoading(true); setRevision((value) => value + 1) }
  async function download(id: string) {
    setBusy(true); setError(undefined); setNotice(undefined)
    try {
      downloadTransferJson(await exportCharacter(id), `venice-character-${id.replace(/[^a-zA-Z0-9_-]/g, "_")}.json`)
      setNotice("Character JSON downloaded with its portrait embedded. Instructions and context are plaintext; keep it private.")
    } catch (reason) { setError(errorText(reason)) }
    finally { setBusy(false) }
  }
  async function selectFile(file: File) {
    setBusy(true); setError(undefined); setNotice(undefined); setPreview(undefined); setImportedId(undefined)
    try {
      if (file.size > MAX_CHARACTER_BYTES) throw new Error("Character JSON exceeds 8 MiB.")
      setPreview(parseCharacterFile(await readTransferFile(file)))
    } catch (reason) { setError(errorText(reason)) }
    finally { setBusy(false) }
  }
  async function confirmImport() {
    if (!preview) { setError("Select and preview a Character JSON file first."); return }
    setBusy(true); setError(undefined)
    try {
      const id = await importCharacter(preview)
      setImportedId(id); setPreview(undefined)
      setNotice("Imported as a new private local Character. Reloading Venice to refresh the native character list.")
      refresh()
      try { reloadPage() }
      catch (reason) { setError(`Character import succeeded, but the page could not refresh: ${errorText(reason)}. Reload manually; do not import a second copy.`) }
    } catch (reason) { setError(errorText(reason)) }
    finally { setBusy(false) }
  }
  return (
    <section aria-label="Character definition transfer" aria-busy={loading || busy} className="grid gap-5">
      <header className="flex items-center justify-between gap-4">
        <div><h2 className="text-xl font-medium">Characters</h2><p className="mt-1 text-sm text-muted-foreground">Your local characters, with definitions, portraits and context.</p></div>
        <div className="flex shrink-0 gap-1">
          <IconAction label="Refresh Characters" disabled={loading || busy} onClick={refresh}><IconRefresh aria-hidden="true" /></IconAction>
          <IconAction label="Upload Character file" disabled={loading || busy} onClick={() => input.current?.click()}><IconUpload aria-hidden="true" /></IconAction>
        </div>
      </header>
      <input ref={input} type="file" accept=".json,application/json" aria-label="Import Character JSON" className="sr-only" tabIndex={-1} disabled={loading || busy}
        onChange={(event) => { const file = event.currentTarget.files?.[0]; event.currentTarget.value = ""; if (file) void selectFile(file) }} />
      {loading && <p role="status">Reading Characters...</p>}
      {error && <p role="alert">{error}</p>}
      {!loading && !error && <div data-testid="character-list" className="grid gap-2">
        <p className="text-sm text-muted-foreground">{characters.length} local Characters</p>
        {characters.length === 0 && <p className="rounded-xl border p-8 text-center text-muted-foreground">No local Characters in this account.</p>}
        {characters.map((character) => <article key={character.id} data-character-id={character.id} className="flex min-w-0 items-center gap-4 rounded-xl border p-4">
          <CharacterPortrait id={character.id} name={character.name} hasPhoto={character.hasPhoto} />
          <div className="min-w-0 flex-1"><h3 className="truncate font-medium" title={character.name}>{character.name}</h3><p className="mt-1 truncate text-sm text-muted-foreground">{character.description}</p></div>
          <IconAction label="Export Character JSON" disabled={busy} onClick={() => void download(character.id)}><IconDownload aria-hidden="true" /></IconAction>
        </article>)}
      </div>}
      <details className="rounded-lg border p-3 text-sm text-muted-foreground"><summary className="cursor-pointer">Character contents &amp; privacy</summary>
        <p className="mt-3">Native Venice Character JSON (schemaVersion 1), up to 8 MiB, with embedded portraits, instructions, greetings, settings and stored context text. Role chat histories, public catalog records and original context-file binaries are not included. Other card formats are not supported.</p>
        <p className="mt-2">Imports create private local copies with new IDs. Publishing/source/account links are not inherited. No inference, publishing or cloud backup requests are made. Portraits must be embedded images, never external URLs.</p>
      </details>
      {preview && <div data-testid="character-import-preview" className="grid gap-3 rounded-xl border p-5 text-sm">
        <h3 className="text-lg font-medium">{preview.character.name}</h3>
        <p>{preview.character.photo ? "Embedded portrait included." : "No portrait."} {Array.isArray(preview.character.context) ? preview.character.context.length : 0} context documents.</p>
        <p>Creates a new private local Character. Existing roles and chats are never overwritten. The page reloads after import; save drafts and finish generation before confirming.</p>
        <div className="flex flex-wrap gap-2">
          <Button disabled={busy} onClick={() => void confirmImport()}>Confirm import as new Character</Button>
          <Button variant="outline" disabled={busy} onClick={() => setPreview(undefined)}>Cancel Character import</Button>
        </div>
      </div>}
      {notice && <p role="status" className="text-sm">{notice}</p>}
      {importedId && <a className="underline" data-testid="imported-character-link" href="/character-chat">Open Characters</a>}
    </section>
  )
}
