import { useEffect, useRef, useState } from "react"
import {
  IconArrowDown, IconArrowUp, IconHome, IconInfoCircle,
} from "@tabler/icons-react"
import { Button } from "@/components/ui/button"
import { ConversationTransfer } from "./ConversationTransfer"
import { MindDefinitionTransfer } from "./MindDefinitionTransfer"
import { CharacterTransfer } from "./CharacterTransfer"
import { LibraryTransfer } from "./LibraryTransfer"
import { StudioTransfer } from "./StudioTransfer"
import type { RuntimeInfo } from "./runtime"
import { StorageOverview } from "./StorageOverview"
import { VeniceCharactersIcon, VeniceClassicIcon, VeniceLibraryIcon, VeniceMindIcon } from "./components/VeniceIcons"
import { BatchBasket } from "./BatchBasket"

const contentPages = [
  { id: "conversations", title: "Conversations", Icon: VeniceClassicIcon, ready: true,
    description: "Agentic, Classic and Mind conversation histories.",
    note: "Classic, Mind and Agentic text-history JSON are ready." },
  { id: "assets", title: "Library Assets", Icon: VeniceLibraryIcon, ready: true,
    description: "Assets from your Studio / Library.",
    note: "Independent Library originals, or complete editable classic Studio session ZIPs. Beta projects are not supported." },
  { id: "mind", title: "Mind", Icon: VeniceMindIcon, ready: true,
    description: "Mind definitions, separate from Mind conversation histories.",
    note: "Complete definition ZIP with resources, Assistant and Preview histories. Ordinary chats stay in Conversations." },
  { id: "characters", title: "Characters", Icon: VeniceCharactersIcon, ready: true,
    description: "Your character definitions.",
    note: "Native Character JSON with embedded portraits and stored context. Import as a new private copy." },
] as const

type ContentPage = typeof contentPages[number]["id"]
type Page = "overview" | ContentPage | "details"

interface SyncPanelProps {
  runtime: RuntimeInfo
  clicks: number
  onTestInteraction: () => void
  reloadPage: () => void
}

function TransferDirections({ ready, mind = false, characters = false, library = false }: { ready: boolean; mind?: boolean; characters?: boolean; library?: boolean }) {
  return (
    <dl className="grid gap-2 text-xs">
      <div className="flex items-center justify-between gap-3">
        <dt className="flex items-center gap-1.5 text-muted-foreground"><IconArrowDown size={16} aria-hidden="true" />Download</dt>
        <dd>{ready ? mind ? "Mind ZIP available" : characters ? "Character JSON available" : library ? "Asset ZIP available" : "Classic / Mind / Agentic JSON available" : "Export planned"}</dd>
      </div>
      <div className="flex items-center justify-between gap-3">
        <dt className="flex items-center gap-1.5 text-muted-foreground"><IconArrowUp size={16} aria-hidden="true" />Upload</dt>
        <dd>{ready ? mind ? "Mind ZIP available" : characters ? "Character JSON available" : library ? "Asset ZIP or media file" : "Classic / Mind / Agentic JSON available" : "Not available"}</dd>
      </div>
    </dl>
  )
}

function DetailsPage({ runtime, clicks, onTestInteraction }: Omit<SyncPanelProps, "reloadPage">) {
  const [storageOpen, setStorageOpen] = useState(false)
  return (
    <section aria-label="Details page" className="grid gap-4 text-sm">
      <div className="grid gap-2">
        <h2 className="text-lg font-medium">Details</h2>
        <p className="text-muted-foreground">Runtime and read-only diagnostics. These are not downloadable content categories.</p>
      </div>
      <details open className="rounded-lg border p-3">
        <summary className="cursor-pointer font-medium">Runtime information</summary>
        <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-xs">
          <dt className="text-muted-foreground">Runtime</dt><dd data-testid="runtime-handler">{runtime.handler}</dd>
          <dt className="text-muted-foreground">Version</dt><dd>{runtime.version}</dd>
          <dt className="text-muted-foreground">Mode</dt><dd data-testid="runtime-mode">{runtime.mode}</dd>
        </dl>
      </details>
      <details data-testid="storage-diagnostics" className="rounded-lg border p-3" onToggle={(event) => setStorageOpen(event.currentTarget.open)}>
        <summary className="cursor-pointer font-medium">Storage metadata</summary>
        {storageOpen && <div className="mt-3"><StorageOverview /></div>}
      </details>
      <details data-testid="ui-diagnostics" className="rounded-lg border p-3">
        <summary className="cursor-pointer font-medium">UI smoke test</summary>
        <div className="mt-3 grid gap-2">
          <Button onClick={onTestInteraction}>Test interaction</Button>
          <p role="status" aria-live="polite">Test clicks: {clicks}</p>
          <p className="text-xs text-muted-foreground">This counter lives in memory and resets when the page reloads.</p>
        </div>
      </details>
    </section>
  )
}

export function SyncPanel({ runtime, clicks, onTestInteraction, reloadPage }: SyncPanelProps) {
  const [page, setPage] = useState<Page>("overview")
  const [conversationsOpened, setConversationsOpened] = useState(false)
  const [mindOpened, setMindOpened] = useState(false)
  const [charactersOpened, setCharactersOpened] = useState(false)
  const [libraryOpened, setLibraryOpened] = useState(false)
  const [studioOpened, setStudioOpened] = useState(false)
  const [libraryMode, setLibraryMode] = useState<"assets" | "sessions">("assets")
  const navigation = useRef<HTMLElement>(null)
  const navigate = (next: Page) => {
    if (next === "conversations") setConversationsOpened(true)
    if (next === "mind") setMindOpened(true)
    if (next === "characters") setCharactersOpened(true)
    if (next === "assets") setLibraryOpened(true)
    setPage(next)
  }
  useEffect(() => {
    navigation.current?.querySelector<HTMLButtonElement>('[aria-current="page"]')?.focus()
  }, [page])
  const links = [
    { id: "overview", title: "Overview", Icon: IconHome },
    ...contentPages,
    { id: "details", title: "Details", Icon: IconInfoCircle },
  ] as const

  return (
    <BatchBasket><div data-testid="sync-panel" className="flex min-h-0 min-w-0 flex-1 flex-col gap-6 sm:flex-row">
      <nav ref={navigation} aria-label="Sync pages" className="grid shrink-0 grid-cols-2 gap-1 border-b pb-3 sm:flex sm:w-48 sm:flex-col sm:border-r sm:border-b-0 sm:pr-4 sm:pb-0">
        {links.map(({ id, title, Icon }) => (
          <Button key={id} variant={page === id ? "secondary" : "ghost"} className="h-10 min-w-0 justify-start gap-3" aria-current={page === id ? "page" : undefined} onClick={() => navigate(id)}>
            <Icon aria-hidden="true" /><span className="truncate">{title}</span>
          </Button>
        ))}
      </nav>
      <div className="min-h-0 min-w-0 flex-1 overflow-y-auto pr-1 sm:pr-3">
        {page === "overview" && (
          <section aria-label="Transfer overview" className="grid gap-4">
            <div className="grid gap-2">
              <h2 className="text-xl font-medium">Download &amp; upload</h2>
              <p className="text-sm text-muted-foreground">Four kinds of local content. Upload means importing a file into this browser, not sending it to a cloud service.</p>
            </div>
            <div className="grid gap-5 md:grid-cols-2">
              {contentPages.map(({ id, title, Icon, description, note, ready }) => (
                <section key={id} aria-label={`${title} transfer options`} className="flex min-w-0 flex-col gap-4 rounded-xl border p-5">
                  <div className="flex items-start gap-2">
                    <Icon className="size-5 shrink-0" aria-hidden="true" />
                    <div className="grid min-w-0 gap-1">
                      <h3 className="font-medium">{title}</h3>
                      <span className="w-fit rounded-full border px-2 py-0.5 text-[0.65rem] text-muted-foreground">{ready ? "Available" : "Planned"}</span>
                    </div>
                  </div>
                  <p className="text-xs text-muted-foreground">{description}</p>
                  <TransferDirections ready={ready} mind={id === "mind"} characters={id === "characters"} library={id === "assets"} />
                  <p className="text-xs text-muted-foreground">{note}</p>
                  <Button size="sm" variant="outline" className="mt-auto" aria-label={`Open ${title}`} onClick={() => navigate(id)}>
                    {ready ? id === "mind" ? "Open Mind packages" : id === "characters" ? "Open Characters" : id === "assets" ? "Open Library" : "Open conversations" : "View export page"}
                  </Button>
                </section>
              ))}
            </div>
          </section>
        )}
        {conversationsOpened && <div hidden={page !== "conversations"}><ConversationTransfer reloadPage={reloadPage} /></div>}
        {mindOpened && <div hidden={page !== "mind"}><MindDefinitionTransfer /></div>}
        {charactersOpened && <div hidden={page !== "characters"}><CharacterTransfer reloadPage={reloadPage} /></div>}
        {libraryOpened && <div hidden={page !== "assets"} className="grid gap-5">
          <div role="group" aria-label="Library transfer scope" className="flex gap-2">
            <Button variant={libraryMode === "assets" ? "secondary" : "ghost"} aria-pressed={libraryMode === "assets"} onClick={() => setLibraryMode("assets")}>Assets</Button>
            <Button variant={libraryMode === "sessions" ? "secondary" : "ghost"} aria-pressed={libraryMode === "sessions"} onClick={() => { setStudioOpened(true); setLibraryMode("sessions") }}>Studio Sessions</Button>
          </div>
          <div hidden={libraryMode !== "assets"}><LibraryTransfer reloadPage={reloadPage} /></div>
          {studioOpened && <div hidden={libraryMode !== "sessions"}><StudioTransfer reloadPage={reloadPage} /></div>}
        </div>}
        {page === "details" && <DetailsPage runtime={runtime} clicks={clicks} onTestInteraction={onTestInteraction} />}
      </div>
    </div></BatchBasket>
  )
}
