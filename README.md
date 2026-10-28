# Venice Sync

A React + TypeScript + shadcn userscript for Venice, **installed and executed by
Tampermonkey**. Its WebUI organizes local content into four categories:
conversations, Library assets, Mind definitions and Characters. Classic / Mind /
Agentic text-history JSON, complete local Mind ZIP packages, and native Character
JSON import/export work today, together with original Library image/video/audio
asset ZIP import/export. Classic Studio image/audio sessions can also be
transferred as editable session ZIPs, separately from individual Library assets.
Cloud synchronization is not implemented.

## Storage model

See [Venice.ai 存储模型](docs/venice-storage-model.md) for the observed business
entities, account identities, versioned Dexie/RxDB schemas, OPFS relationships,
archive boundaries and validation guidance. It documents observations as of
2026-10-27, not an official stable Venice API.

## Requirements

- Node.js 22.12+ (or a supported newer LTS) and npm.
- Chrome with Tampermonkey, allowed to run user scripts and access `venice.ai`.
- A Venice page; the overview does not require account access and reports only
  the storage available to that page's origin in the current browser profile.

## Development

```powershell
npm ci
npm run dev
```

Open `http://127.0.0.1:5173/` for the local host-page preview. It deliberately
identifies itself as a preview, not a Tampermonkey E2E result.

The floating launcher opens a non-modal shadcn dialog. Its styles and portal
stay inside a Shadow DOM so the host page remains usable. Host-page focus changes do not dismiss the dialog; its
close button, Escape, and outside pointer clicks still close it.
The dialog opens on **Overview**, showing what can be downloaded or uploaded:

| Content page | Download | Upload |
| --- | --- | --- |
| Conversations: Classic | JSON available | JSON available |
| Conversations: Mind text / reasoning | JSON available | JSON available; existing destination Mind required |
| Conversations: Agentic text / reasoning | JSON available | JSON available; creates an independent Agentic chat |
| Library Assets (generated images / videos / audio) | Single-asset ZIP available | ZIP or media file; creates an independent local copy |
| Library > Studio Sessions (classic image / audio) | Session ZIP available | ZIP; creates a new editable session |
| Mind definitions + resources + all saved Builder / Preview histories | ZIP available | ZIP available; creates a new local unpublished Mind |
| Characters: local definitions + embedded portraits/context | Native JSON available | Native JSON available; creates a new private local Character |

Mind conversation history belongs under **Conversations**, not the **Mind**
definition page. The latter includes its saved editor Assistant and
Preview threads, not ordinary chat sessions. Upload means local file import, not cloud upload.
The dialog is up to 1152px wide and 864px high on desktop, constrained to the
viewport on small screens. Content rows emphasize titles and local Mind avatars;
download/upload/refresh actions use Tabler icons with accessible names and hover
titles. Confirmation and cancel actions retain text to make writes explicit.

**Conversations is one mixed list**, newest first: Classic, Mind and Agentic each
have a labeled type indicator, not separate type tabs. Mind conversations use the
associated Mind's avatar; local histories read that Mind's OPFS image, while
published-Mind histories use Venice's own public avatar endpoint, not a local
draft's potentially different image. Missing images retain a labeled native
Mind-icon fallback and report loading errors accessibly. All three conversation
types have working text-history download actions. If one storage source fails, its
error is shown and the other source's loaded rows remain usable. A single upload
icon/file input detects Classic, Mind and Agentic archive formats before preview.
Conversation file previews survive switching subpages
while the dialog stays open; closing the dialog discards the preview.

Runtime identity, the in-memory smoke-test counter, and raw storage information
are kept under **Details**, away from the transfer overview. Open **Details >
Storage metadata** to load the read-only inventory on demand:

- localStorage key names and approximate UTF-16 byte sizes (keys + values).
- IndexedDB database names and versions, object store names and record counts.
- Read timestamp, explicit per-source/per-database errors, and a refresh button.

The metadata overview never displays stored values. It accesses localStorage
values only to calculate their lengths and uses readonly IndexedDB `count()`
transactions. Conversation transfer separately reads the selected chat's data
and writes only after explicit import confirmation. Connections are closed after
use. A database disappearing or changing version while opening aborts the
attempted upgrade rather than creating or migrating it. There are no cloud
synchronization requests or persisted userscript settings.
The local preview shows its own origin's storage, not Venice's storage.
Conversation transfer is unavailable in the preview.
The Classic chat (`Message`), Characters (`MasksTheater`) and Library (`Folder`)
icons match the corresponding native Venice SVG paths, via MIT-licensed
`@tabler/icons-react`. The Library path also matches the user-supplied reference.
Mind and Agentic glyphs are custom: they are reused from the current host page's
`/minds` and `/chat/agent` navigation/conversation SVGs at runtime, copying only safe geometry primitives/attributes,
never scripts, event handlers or external image references. Its artwork is not
vendored into the bundle. Agentic rows use Venice's actual glyph, not a generic
Tabler robot. Until native navigation is available (or in the
standalone preview), a Tabler fallback is used. `components.json` selects Tabler
for future shadcn components too.

## Library asset transfer

Open **Library Assets** to browse the current account's generated images, videos
and audio, with lazy original-file previews and per-asset ZIP downloads. Sources
follow the observed native `/studio/library` aggregate: permanent Classic media
chats, Dexie Studio image outputs/audio, generated Mind media, and completed
Discover generations. This is not a dump of every OPFS file or `userMedia`
upload; newer Studio project/output stores are not assumed to be equivalent.
Missing originals and unsupported media are reported per asset, never deleted.

The download contains the unchanged original and available provenance metadata,
with size and SHA-256 checks (`venice-sync-library-asset` v1). Source metadata
may include private prompts/settings. Archives are **unencrypted**; keep them
private. External cover artwork, thumbnail caches, source generation inputs,
conversations, and full Studio projects are not included.

The upload icon accepts that ZIP or a raw supported image/video/audio file.
Preview and cancel are read-only. Confirming creates fresh IDs and a dedicated
permanent local media-chat container, which **may also appear in Conversations**.
It does not overwrite originals or recreate generation settings, source chats
or projects. No generation, inference or publishing is performed.

Files must decode successfully before persistence. Original bytes are retained;
image/video thumbnails are generated locally for native Library compatibility.
Files are written before one add-only native Dexie transaction inserts the
container, media message and message-ID projection. Failure removes only that
new file namespace; incomplete cleanup is explicitly reported. Successful imports
reload the same URL; save drafts first. Cancelled or failed imports do not reload.

Limits: 100 MiB per original, 8 MiB metadata, 128 MiB ZIP; decoded image/video
frames at most 64 megapixels, and a 15-second media-load timeout. Supported MIME
types: PNG/JPEG/WebP/GIF/AVIF/BMP; MP4/WebM/QuickTime; MPEG/WAV/OGG/MP4/FLAC/WebM/AAC
audio. Playback depends on Chrome's codecs. SVG, documents and remote-file
references are not imported.

## Editable Studio session transfer

Open **Library Assets > Studio Sessions**, then download one classic image or
audio session ZIP. The separate **Assets** view keeps its original asset-only
behavior. A `venice-sync-studio-session` v1 ZIP contains `manifest.json` with the
session/turn/media records and a manifest of every original, plus unchanged
`media/{sessionId}/{mediaId}.{ext}` files. Image-edit input originals are included,
not just generated outputs. Prompts, settings, timestamps, supported audio
subtitles and selected-media references are preserved.

Select **Upload Studio session**, review, and explicitly confirm a new copy.
Preview/cancel never writes. Import assigns fresh UUIDs and current Clerk
ownership, rewrites session/turn/media IDs, selections and nested image-input
paths, validates media decoding, writes originals and generated image
`_thumb.jpg` caches, then uses one native Dexie add-only transaction for the
three matching image/audio tables. The native repository handles destination
encryption; no source key is archived. Failure rolls back the database transaction
and cleans only this import's new file namespace; incomplete cleanup is explicit.
Success reloads the same URL. Save drafts and finish ongoing generation first.
No generation, inference, publishing or account-preference import is performed.

Only the observed classic Dexie v31 (IndexedDB 310) format is supported.
Image generation/edit sessions and ordinary audio sessions are supported.
Audio source-file attachments, account-bound cloned voices (`vv_*`), custom or
remote album covers, unknown subtitle shapes, foreign/missing file references,
incomplete turns without outputs, jobs and unknown native fields are rejected
explicitly rather than producing a partial archive. Beta RxDB projects/outputs
and video sessions remain unsupported. Exports verify that records did not change
during the snapshot; this is not a lock against simultaneous edits/generation.

Limits: ZIP and total expanded content 128 MiB, each original 100 MiB, JSON
metadata 8 MiB, 2048 originals and 10000 turns. Every original is checked by byte
size and SHA-256. Archives contain private prompts/settings in plaintext: keep
them private. Native-editor tests use synthetic image and silent-audio sessions,
preserve original-record fingerprints and restore the previous active-session
selection; no paid generation is needed.

See the [Studio investigation](docs/studio-sessions-investigation.md) for the
original findings and the [storage model](docs/venice-storage-model.md#83-经典-studio-可编辑-session)
for the implemented boundaries.

## Basic Classic conversation transfer

1. Sign in to Venice, open **Venice Sync > Conversations**.
   The refresh icon rereads the unified title/model/message-count list.
2. Use the download icon on a Classic text chat to download one JSON file
   (accessible name / tooltip: **Export JSON**).
3. Use the upload icon (**Upload conversation file**) and select a JSON file.
   Review its title, model and
   message count. Selecting a file does not write anything.
4. Choose **Confirm import as new chat**, or **Cancel import**. Import generates
   new conversation/message IDs, binds the current account, removes folder and
   temporary-session state, and inserts a permanent chat. Existing IDs are never
   overwritten. After the transaction succeeds, the current page automatically
   reloads at the same URL so Venice's native sidebar refreshes too. The dialog
   closes; reopen it with the launcher if needed. Save unsent drafts and finish
   ongoing generation before confirming, as the preview warns.

Failed or cancelled imports do not reload the page. If the import commits but
reloading is blocked, the panel explicitly reports that the import succeeded and
offers the imported-chat link; reload manually rather than importing a second
copy. The script does not use private React internals to alter Venice's cache.

Exports contain **plaintext chat content**. Keep the files private. Encryption
keys, login tokens, unrelated storage, and the original account owner ID are not
exported. No chat data is logged or sent to a service. Import/export does not
submit prompts or run inference.

The versioned `venice-sync-classic` v1 format contains `conversation` and
`messages`, so its shape is also compatible with Venice's observed native Classic
JSON transfer. Native `{ conversation, messages }` exports can be imported too.
The limit is 8 MiB per file. Text content, roles, message order, model/configuration
fields and original message timestamps are preserved; the conversation's update
timestamp changes on import. Venice attaches default `imageSettings` (and other
generation settings) even to text messages; these are preserved as configuration,
not mistaken for attachments. Actual media paths, mask/doodle media references,
and nonempty attachments remain unsupported. Invalid JSON, unsupported versions, foreign or
duplicate message IDs, edited/branched messages (`parentMessageId`), attachments,
media, character chats, and Agent/Minds data are rejected explicitly, never
silently flattened or partially imported.

The initial adapter is intentionally limited to observed Classic schema **310**
in `venice-db-encrypted`. It does not confuse Agent/Minds' separate RxDB stores
with Classic history. It reads both plaintext and NaCl-encrypted rows, including
Venice's Typeson `undefined`/built-in serialization annotations, checks
Venice's existing encryption key against `_encryptionSettings`, and supports
only the observed `NON_INDEXED_FIELDS` write policy. A single add-only transaction
inserts encrypted `conversations` / `messages` and the native plaintext
`messageIds` index. Collision, quota or request failures abort the whole
transaction. Missing databases, unknown schema versions/encryption policies and
missing/mismatched keys cause explicit errors, not migrations or key resets.

The [synthetic example](scripts/fixtures/classic-conversation.json) contains no
real chat data and can be used to try the workflow.

## Mind conversation histories

Open **Conversations**, not the **Mind** definition page. Brain icons identify
Mind histories in the combined list. The current
`venice-sync-mind-conversation` v1 JSON format supports completed/failed/cancelled
ordinary Mind chat histories containing text, refusals and reasoning. It keeps
structured `output_items`, annotations, timestamps, status, turn grouping and
nested message/item/content references. It does not flatten a Mind transcript
into Classic messages.

Tool execution, sub-agent containers, media/attachments, active generations,
and builder/preview histories are explicitly
rejected. No unsupported items are silently removed. The size limit is 8 MiB.
Mind definitions and their assets are **not** included in a history file.

Use the shared **Upload conversation file** icon, select a Mind JSON archive,
review the detected format, and choose a
destination. Local destinations must already exist in the current account;
remote destinations are drawn from that account's existing remote-Mind histories.
If the original destination exists it is preselected; otherwise an explicit
selection is required. The selected Mind's current configuration is used.
Remote Mind availability and permissions remain controlled by Venice.

Confirmation generates a new conversation and remaps message, item, content,
turn and response references to new IDs. The native RxDB instance receives the
messages first and the conversation last, updating Venice's live sidebar without
reloading the page. A normal write failure attempts to remove only that import's
new message records. This is **not a cross-collection atomic transaction**:
do not close the page during import. A failed cleanup is reported explicitly
rather than inviting an unsafe retry. Existing histories and Mind definitions
are never overwritten.

The adapter reuses RxDB's public `OPEN_COLLECTIONS` registry from the running
Venice runtime, via a uniquely named Turbopack bridge module. It does not replace
native modules, inspect React internals, copy premium storage implementation,
open another database instance, or write raw IndexedDB rows. The current ABI is
guarded to Mind schema 25, conversation schema 4 or 5 and message schema 25.
The verified v5 addition is `studioProjectId` plus the `studio` conversation
type; Studio-linked histories are not imported as ordinary Mind chats.
An incompatible runtime/schema fails explicitly and requires an adapter update.

Mind records belong to Venice's internal user ID, not the Classic Clerk ID.
The adapter obtains a Clerk session credential in memory and requests only
authentication metadata from Venice's own
`https://outerface.venice.ai/api/user/session` endpoint to verify that ID.
Credentials are never logged, exported or persisted by this tool. No chat
contents are sent in that request; transfer makes no inference or publishing
request. Exported chat JSON is plaintext and must be kept private.

## Agentic conversation histories

The unified **Conversations** list offers **Export Agentic JSON** on Agentic rows.
`venice-sync-agentic-conversation` v1 archives use the same validated structured
text/refusal/reasoning representation as Mind histories, but **must not** contain
`mindId` or `remoteMindId` associations. Classic, Mind, Agentic, builder/preview
and Studio-linked archives are not interchangeable.

The shared upload action detects an Agentic archive and shows its preview.
Confirmation creates a new native Agentic chat with fresh conversation, message,
item, content, turn and response IDs, current internal account ownership and no
Mind/folder binding. Existing conversations are never overwritten. The native
sidebar updates without reloading; the imported chat opens at `/chat/agent/{id}`.
Future replies use Venice's current default agent/model configuration; an archive
does not recreate historical global account settings.

This initial Agentic transfer supports ended text and reasoning histories, up to
8 MiB per JSON file. Tool execution, attachments/media, ongoing generations and
Studio-linked histories are rejected explicitly, never partially exported.
It makes no inference requests and reuses the same native add-only writes,
owner checks and partial-failure rollback used by Mind histories. Keep the page
open until import completes. Archives contain plaintext messages and should be
kept private.

## Complete Mind packages

Open **Mind** in the Sync navigation (separate from Conversations). Its rows
show local avatar images with the native Mind icon fallback when no avatar exists.
Missing/unreadable avatar files show an accessible error rather than fetching
an external substitute. Object URLs are released when the image/page unmounts.
Use a row's download icon (**Export Mind package**) to download a
`venice-sync-mind` v1 ZIP containing:

- The local Mind definition, instructions, model/reasoning settings and complete
  tool/sub-agent configuration.
- Avatar, cover and reference-asset bytes from its own OPFS directory.
- All saved **Builder Assistant** and **Preview** histories, including structured
  completed tool calls/results, reasoning, attachments, media metadata and files.

Builder histories use `mindConversations.type = maker` and the deterministic ID
`mind-maker-conv:{mindId}`. Preview uses type `preview` and
`mind-preview-conv:{mindId}`. Both have messages in `mindMessages`; files live in
`media/{conversationId}` with attachments in its `attachments` subdirectory.
These are not ordinary Mind chat histories.
Only referenced original files are included; Venice's generated thumbnail caches
and orphaned/unrelated files are not backup content.

The package has a JSON manifest and per-file SHA-256/size checks. Paths, manifest
associations and native schemas are validated before any file/database writes.
Limits are 128 MiB compressed and expanded, 25 MiB per file, 8 MiB metadata and
2048 resource files. Read-only export never creates missing OPFS directories.
Missing referenced files, external-only media, unfinished generations/tools,
pending approvals and resumable assistant continuations fail explicitly instead
of producing an incomplete or executable-restoration package.

Use the upload icon (**Upload Mind package**) to inspect the name, file count
and editor-history counts. There are no inclusion checkboxes: export always
includes all saved content and import restores all content present in the archive.
Confirmation creates a **new local unpublished Mind** owned by the current
account. Publication and remote-media bindings and derived privacy/credit metadata
are removed; it never replaces or republishes an existing Mind. If you later
use or publish the imported Mind, Venice's current model/tool availability and
permissions apply. Ordinary chat histories are not imported by this operation.

Import regenerates the Mind and history/message/item/media/call IDs and their
references, renames resource files to match and rebuilds the deterministic editor
thread IDs. Tool argument/output strings remain historical text; **restoration
does not run tools, generate a reply, or send an inference/publishing request**.
Only terminal, paired tool calls/results are accepted. An absent saved Assistant
or Preview thread contributes no history, not a fabricated conversation.

The adapter writes files and auxiliary records first, editor conversations next,
and publishes the new local definition to RxDB last. Because OPFS and several RxDB
collections have no shared transaction, do not close the page during import.
Failures attempt to remove only generated rows/directories and explicitly report
incomplete cleanup. A browser crash or forced close cannot guarantee rollback.
The native schema guards are Mind 25, conversation 4 or 5, message 25, attachment 0 and
media 6. Existing Mind definitions, chats and unrelated Library assets are untouched.

Packages are **unencrypted** and may contain private instructions, files and
editor conversations. No account credentials or internal RxDB metadata are
included. Only your local package download contains these bytes; no backup
service is contacted.

## Characters

The **Characters** page shows current-account local roles and portraits, with
icon-only upload/download/refresh actions. It uses Venice's native Character
JSON schema version `"1"`: `{ character, exportedAt, schemaVersion }`. Native
bare Character definition objects are accepted too; other card/PNG formats are
not inferred or converted.

Exports include all portable role fields (instructions, description, intro,
model/advanced settings, tags, voice and custom-prompt settings, stored context
text and private definition extensions). Native OPFS portrait references are
hydrated into embedded image data so a JSON file is self-contained.
Supported portrait formats are PNG/JPEG/WebP/GIF/AVIF. Missing native portrait
files and external-only image URLs are explicit errors, not incomplete exports.
The total file limit is 8 MiB.

Select the upload icon, preview the role name/portrait/context count, then confirm.
Import validates both the local portable format and Venice's own native parser,
assigns a new ID and current Clerk ownership, and clears publication/source links.
The copy is private (`isPublic=false`, `isApiVisible=false`) and never overwrites
the source. Portrait storage uses Venice's own normalization helper; the role is
inserted with native Dexie `add`, not `put`, into its existing Character table.
The current guarded repository is `venice-db-encrypted` Dexie version 31
(IndexedDB version 310). Character definitions use this repository, not the
similarly named legacy RxDB Character collection.

After a committed import the current page reloads to refresh native lists; save
unsent drafts and finish generation first. Failed/cancelled imports do not reload.
A stored portrait is cleaned if insertion fails; cleanup also checks only the
new UUID's photo namespace, never removes the shared account photo directory,
and reports incomplete cleanup explicitly. A forced tab close cannot guarantee
rollback across OPFS and the database.

Role chats, memories/insights, public catalog records and original binary context
documents are not included. The context included here is the extracted text
actually stored in the native definition. No publishing or inference requests
are made. JSON files contain private content in plaintext; keep them secure.

## Build and install

```powershell
npm run build
npm run preview
```

Open `http://127.0.0.1:4173/venice-sync.user.js` in Chrome and approve installation
in Tampermonkey. If Chrome displays source or downloads the file instead, use
Tampermonkey's dashboard to create a script and paste the contents of
`dist/venice-sync.user.js`.

The production userscript bundles its UI and CSS, matches only
`https://venice.ai/*`, does not run in frames, and requests `GM_info` plus
`unsafeWindow`. Classic uses `Clerk.user.id`; Mind history additionally accesses
the native collection registry and uses the public Clerk session getter solely
for the first-party account metadata request described above.
No CDN-hosted React or external font is needed at runtime.

On Venice, click **Venice Sync** and confirm:

1. Overview shows the four content categories and distinguishes available
   JSON, ZIP and Library media transfer entry points.
2. In **Details**, runtime is **Tampermonkey**, mode is **userscript**, and version
   is **0.1.0**. Expanding **UI smoke test** and clicking **Test interaction**
   changes **Dummy clicks: 0** to **Dummy clicks: 1**.
3. Closing and reopening the dialog works.
4. Reloading the page mounts one launcher and resets the counter.
5. Venice's existing interface and styles remain intact.
6. Expanded **Details > Storage metadata** shows the current origin's keys, databases and counts;
   **Refresh storage** rereads them. Long lists scroll without hiding the close
   button. Metadata does not show stored values or chat content.
7. Conversation JSON selection shows a preview and reload warning; confirmation
   creates a new chat and automatically reloads the same page. Venice's native
   sidebar shows the imported chat without another manual refresh or navigation.
   The original conversation remains unchanged.

Installing the script through Tampermonkey is essential: evaluating the bundle
with Playwright or `page.addScriptTag()` is not a userscript E2E test.

## Checks

```powershell
npm run typecheck
npm run lint
npm test
npm run build
```

Unit tests cover runtime identity, isolated mounting, duplicate injection, dialog
portal placement, button interaction, storage metadata/counts, refresh, denied
access, partial failures, timeouts, and avoiding accidental database creation.
IndexedDB fixtures use fake-indexeddb only in tests. Browser and Tampermonkey
checks are a separate validation layer.
Conversation tests cover plaintext/NaCl round trips, owner filtering, fresh IDs,
encryption policy/key failures, unsupported inputs, preview/cancel/confirm,
downloads, collision rollback, and avoiding accidental schema creation/upgrades.
Refresh tests verify that reloading happens only after a successful transaction,
never on failed/cancelled imports, and that blocked navigation is reported as an
already committed import rather than a failed import that should be retried.

## Real Chrome / Tampermonkey E2E

Enable remote debugging at `chrome://inspect/#remote-debugging` in your existing
Chrome and approve the connection prompt. Alternatively set `CDP_ENDPOINT` to a
Chrome CDP WebSocket or HTTP endpoint. The Windows default reads Chrome's
`DevToolsActivePort` file; it does not copy a browser profile or credentials.

In Chrome's Tampermonkey extension details, explicitly enable **Allow user
scripts** (`chrome://extensions/?id=dhdgffkkebhmkfjojejmpbldmpobfkfo`). Merely
installing Tampermonkey or a script does not enable execution. This permission
affects all enabled Tampermonkey scripts; the E2E runner never changes it
automatically. Tampermonkey also needs site access to `venice.ai`.

With the build served by `npm run preview`, run:

```powershell
# Installs this project's build through Tampermonkey's installation UI.
npm run test:e2e -- --install

# Validates an already installed script without changing it.
npm run test:e2e

# Opt-in: adds two synthetic Classic chats through the installed userscript,
# downloads JSON, verifies native Venice rendering after reload and reimport,
# then deletes ONLY the generated fixture records and checks original counts.
npm run test:e2e -- --install --transfer

# Opt-in: native Mind history import/export/reimport and sidebar-without-reload
# checks. Requires an existing local Mind owned by the signed-in account.
# Uses synthetic messages and removes only its own new history records.
npm run test:e2e -- --install --mind-transfer

# Independent Agentic text/reasoning history round trip, native sidebar update
# without reload, rendering after reload and cleanup of synthetic copies.
npm run test:e2e -- --install --agentic-transfer

# Optional user-selected Agentic source: export in memory, import and verify a
# temporary copy, then fingerprint-check the untouched source and delete the copy.
npm run test:e2e -- --agentic-transfer --agentic-conversation=AGENTIC_CHAT_ID

# Complete synthetic Mind package: avatar/cover/reference, sub-agent, completed
# Builder update-tool history, Preview document + image. Checks native editor,
# hashes and no replay, then removes only generated definitions/history/files.
npm run test:e2e -- --install --mind-package

# Native Character JSON/portrait/context import-export-reimport and cleanup.
npm run test:e2e -- --install --characters

# Library PNG/WAV/video originals, ZIP reimport, native viewers/playback,
# original-data fingerprints and targeted test-file cleanup.
npm run test:e2e -- --install --library

# Classic Studio image/edit + ordinary audio session ZIP import/export/reimport,
# native editors/original media, read-only cancel and targeted fixture cleanup.
npm run test:e2e -- --install --studio-sessions

# Optionally verify a selected current-account Character via a temporary copy,
# with its original record and portrait fingerprints unchanged.
npm run test:e2e -- --characters --character=LOCAL_CHARACTER_ID

# Optional: also export the selected account-owned Classic test chat, import
# and verify a temporary copy, then delete the copy and fingerprint-check that
# the original is unchanged. Replace the ID with the last Classic URL segment.
npm run test:e2e -- --transfer --conversation=CLASSIC_CHAT_ID
```

The test opens a dedicated Venice tab, checks the four content categories,
unified conversation list/type icons, full-Mind-without-checkboxes behavior,
available transfer pages and enlarged desktop/390px mobile layout, then
opens Details to check the real manager identity and dummy button. It verifies
Shadow DOM portal placement and rendered styles,
compares displayed storage summaries against the page's actual storage metadata,
checks refresh,
checks that hovering and holding the close button does not displace its hit area
(allowing the standard 1px press feedback), repeats close/reopen three times,
tests Escape, then reloads its own tab to check reinjection.
The default test never injects the bundle with Playwright, exports message contents,
writes storage, or submits prompts. Mind page navigation verifies first-party
account metadata access. The optional `--transfer` test additionally
imports/exports synthetic message contents through the installed userscript and
cleans up only its own generated IDs using targeted IndexedDB transactions.
`--conversation` requires `--transfer`; its downloaded chat JSON is read only in
memory and removed after checking, with no chat text retained in test artifacts.
Transfer checks observe the userscript-triggered same-URL reload and assert that
the native sidebar contains the new chat before any manual reload or navigation.
Neither mode edits existing conversations or sends inference requests. It leaves
its tabs open and disconnects without closing Chrome.
The report and dialog-only overview/mobile/details screenshots are written to
ignored `test-results/`.
Installation interception and Chrome's user-script permissions must be enabled;
otherwise install manually using the instructions above and retry.

## Layout

- `src/main.tsx`: userscript entry.
- `src/runtime.ts`: actual `GM_info` identity or explicit preview identity.
- `src/mount.tsx`: idempotent Shadow DOM mount.
- `src/App.tsx`: non-modal panel and retained smoke-test counter.
- `src/SyncPanel.tsx`: four content pages, transfer overview and lazy Details diagnostics.
- `src/ConversationTransfer.tsx`: conversation list, download and import preview/confirmation.
- `src/MindAvatar.tsx`: local OPFS avatar loading, fallback/error display and URL cleanup.
- `src/components/IconAction.tsx`: consistently named icon-only actions with hover titles.
- `src/mind-conversation-format.ts`: Mind archive validation and nested reference remapping.
- `src/venice-mind-history.ts`: owner-scoped native RxDB history operations and rollback.
- `src/native-rxdb.ts`: guarded running-app collection access and internal account identity.
- `src/native-runtime.ts`: shared public native-module bridge, without replacing module factories.
- `src/CharacterTransfer.tsx`: local role list/portraits and native JSON import preview.
- `src/character-format.ts`: portable native Character JSON and private-copy policy.
- `src/venice-characters.ts`: native Dexie/parser/portrait integration and targeted cleanup.
- `src/StudioTransfer.tsx`: editable Studio session lists and ZIP preview/confirmation.
- `src/studio-session-format.ts`: bounded image/audio session ZIP validation and checksums.
- `src/venice-studio.ts`: native session snapshots, fresh references and add-only transactions.
- `src/MindDefinitionTransfer.tsx`: complete Mind ZIP preview, history options and copy import.
- `src/mind-package-format.ts`: archive limits, manifest/association validation and checksums.
- `src/mind-package-storage.ts`: scoped existing-only reads and generated-directory OPFS writes/cleanup.
- `src/venice-mind-package.ts`: definition/editor-history snapshot, native validation, ID remapping and rollback.
- `src/transfer-files.ts`: shared local JSON file reading and download limits.
- `src/conversation-format.ts`: versioned JSON validation and import ID remapping.
- `src/venice-classic.ts`: observed Classic schema, encryption and atomic add-only imports.
- `src/indexeddb.ts`: existing-database access and request/transaction helpers.
- `src/storage.ts`: readonly localStorage metadata and IndexedDB record counts.
- `src/StorageOverview.tsx`: storage loading, errors, summaries and refresh.
- `src/components/ui/`: shadcn components; `DialogContent` accepts a
  `portalContainer` to prevent portals escaping into Venice's document body.
- `vite.config.ts`: single-file userscript build and local development server.

Agentic tool/media history transfer, edited/branched Classic chats,
Mind tool execution/media histories, media/attachments, cross-device
authentication, conflict merging and cloud synchronization are not implemented.
