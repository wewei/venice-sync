import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { chromium } from "playwright-core"
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate"
import { syntheticMindPackage } from "./fixtures/mind-package.mjs"
import packageJson from "../package.json" with { type: "json" }

const root = fileURLToPath(new URL("../", import.meta.url))
const extensionOrigin =
  `chrome-extension://${process.env.TM_EXTENSION_ID || "dhdgffkkebhmkfjojejmpbldmpobfkfo"}`
const scriptUrl = process.env.USERSCRIPT_URL || "http://127.0.0.1:4173/venice-sync.user.js"
const hostId = "venice-sync-userscript-host"
const launcherId = "venice-sync-sidebar-launcher"
const install = process.argv.includes("--install")
const transfer = process.argv.includes("--transfer")
const mindTransfer = process.argv.includes("--mind-transfer")
const agenticTransfer = process.argv.includes("--agentic-transfer")
const charactersTransfer = process.argv.includes("--characters")
const libraryTransfer = process.argv.includes("--library")
const studioTransfer = process.argv.includes("--studio-sessions")
const batchControls = process.argv.includes("--batch-controls")
const nativePage = process.argv.includes("--native-page")
const batchOnly = process.argv.includes("--batch-only") || batchControls || nativePage
const batchTransfer = process.argv.includes("--batch") || process.argv.includes("--batch-only")
let preserveFixturePage = false
const mindPackage = process.argv.includes("--mind-package")
const selectedConversation = process.argv.find((argument) => argument.startsWith("--conversation="))?.slice("--conversation=".length)
const selectedAgentic = process.argv.find((argument) => argument.startsWith("--agentic-conversation="))?.slice("--agentic-conversation=".length)
const selectedCharacter = process.argv.find((argument) => argument.startsWith("--character="))?.slice("--character=".length)

async function endpoint() {
  if (process.env.CDP_ENDPOINT) return process.env.CDP_ENDPOINT
  if (!process.env.LOCALAPPDATA) {
    throw new Error("Set CDP_ENDPOINT to your Chrome CDP endpoint.")
  }
  const file = path.join(
    process.env.LOCALAPPDATA,
    "Google",
    "Chrome",
    "User Data",
    "DevToolsActivePort",
  )
  const [port, browserPath] = (await readFile(file, "utf8"))
    .trim()
    .split(/\r?\n/)
  if (!/^\d+$/.test(port) || !browserPath?.startsWith("/devtools/browser/")) {
    throw new Error("Chrome's DevToolsActivePort file is invalid.")
  }
  return `ws://127.0.0.1:${port}${browserPath}`
}

async function installScript(context) {
  const artifact = await readFile(path.join(root, "dist/venice-sync.user.js"))
  const response = await fetch(scriptUrl)
  assert.equal(response.status, 200, "Run npm run preview before installation.")
  const served = Buffer.from(await response.arrayBuffer())
  assert.ok(artifact.equals(served), "Server is not serving the current build.")

  const previousPages = new Set(context.pages())
  const sourcePage = await context.newPage()
  console.log("Opening the built userscript in Tampermonkey.")
  try {
    await sourcePage.goto(`${scriptUrl}?build=${createHash("sha256").update(artifact).digest("hex")}&install=${Date.now()}`, {
      waitUntil: "domcontentloaded",
      timeout: 30_000,
    })
  } catch (error) {
    const extensionClosedSource = sourcePage.isClosed() && context.browser()?.isConnected()
    if (!(error instanceof Error) || (!error.message.includes("net::ERR_ABORTED") && !extensionClosedSource)) {
      throw error
    }
    console.log("Chrome handed userscript navigation to an extension.")
  }

  let installer
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    installer = context.pages().find((page) => {
      if (previousPages.has(page) && !page.url().includes(scriptUrl)) return false
      return (
        page.url().startsWith(`${extensionOrigin}/`) &&
        /\/(?:ask|install)\.html(?:[?#]|$)/.test(page.url())
      )
    })
    if (installer) break
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  if (!installer) {
    throw new Error(
      "Tampermonkey did not open an installer. Install the built script manually, then rerun without --install.",
    )
  }

  await installer.bringToFront()
  const installButton = installer.getByRole("button", {
    name: /^(install|reinstall|update|\u5b89\u88c5|\u91cd\u65b0\u5b89\u88c5|\u66f4\u65b0)$/i,
  })
  await installButton.waitFor({ state: "visible", timeout: 20_000 })
  await installButton.click()
  console.log("Approved installation in Tampermonkey's own installer UI.")
}

async function returnToVenice(page, dialog) {
  assert.equal(await dialog.getByRole("button", { name: "Close", exact: true }).count(), 0)
  assert.equal(await page.locator(`#${hostId}`).getByTestId("sync-backdrop").count(), 0)
  await dialog.getByRole("button", { name: "Back to Venice", exact: true }).click()
  await dialog.waitFor({ state: "hidden" })
}

async function navigatePanel(dialog, name) {
  const button = dialog.getByRole("navigation", { name: "Sync pages" }).getByRole("button", { name, exact: true })
  if (await button.getAttribute("aria-current") !== "page") await button.click()
}

async function openConversations(dialog) {
  await navigatePanel(dialog, "Conversations")
  await dialog.getByTestId("conversation-list").waitFor({ state: "visible", timeout: 45_000 })
}

async function waitForMindHistory(dialog) {
  try {
    await dialog.getByTestId("conversation-list").waitFor({ state: "visible", timeout: 30_000 })
    const errors = await dialog.getByRole("alert").allTextContents()
    assert.equal(errors.length, 0, `Conversation reading reported errors: ${errors.join("; ")}`)
  } catch (error) {
    const alerts = await dialog.getByRole("region", { name: "Conversation transfer" }).locator('[role="alert"]').allTextContents()
    throw new Error(alerts.length ? `Mind history UI reported: ${alerts.join("; ")}` : "Mind history did not finish loading.", { cause: error })
  }
}

async function waitForSignedInVenice(page) {
  await page.waitForFunction(() => window.Clerk?.loaded &&
    typeof window.Clerk?.user?.id === "string" &&
    typeof window.Clerk?.session?.getToken === "function", undefined, { timeout: 45_000 })
}

async function ensureNativeSidebar(page) {
  const show = page.getByRole("button", { name: "Show Sidebar", exact: true })
  if (await show.isVisible()) await show.click()
  else {
    await page.waitForFunction(() => document.querySelector('a[href="/minds"]'), undefined, { timeout: 45_000 })
    const wordmark = page.locator('svg[viewBox="0 0 549 307"]').filter({ visible: true })
    if (!await wordmark.count()) {
      const toggle = page.getByRole("button", { name: /^(?:Toggle sidebar|切换侧边栏)$/i }).filter({ visible: true }).first()
      if (!await toggle.isVisible()) {
        await page.mouse.move(400, 200)
        await page.mouse.move(33, 38)
      }
      await toggle.click()
    }
  }
}

async function sidebarLauncher(page) {
  const launcher = page.locator(`#${launcherId}`).getByRole("button", { name: "Venice Sync", exact: true })
  if (!await launcher.isVisible()) await ensureNativeSidebar(page)
  await launcher.waitFor({ state: "visible", timeout: 45_000 })
  return launcher
}

async function openSync(page) {
  await (await sidebarLauncher(page)).click()
  await page.locator(`#${hostId}`).getByRole("region", { name: "Venice Sync", exact: true }).waitFor({ state: "visible" })
}

async function openUiDiagnostics(dialog) {
  await navigatePanel(dialog, "Details")
  const details = dialog.getByTestId("ui-diagnostics")
  if (await details.getAttribute("open") === null) await details.locator("summary").click()
}

async function checkAgenticGlyphs(page, dialog) {
  const rows = dialog.locator('[data-conversation-kind="agentic"]')
  const count = await rows.count()
  if (!count) return 0
  await page.waitForFunction(() => document.querySelector('a[href="/chat/agent"] svg, a[href^="/chat/agent/"] svg'), undefined, { timeout: 30_000 })
  await rows.first().locator('[data-venice-icon="agentic-native"]').waitFor({ state: "visible", timeout: 10_000 })
  const expected = await page.evaluate(() => {
    const source = document.querySelector('a[href="/chat/agent"] svg, a[href^="/chat/agent/"] svg')
    return { viewBox: source.getAttribute("viewBox"), paths: [...source.querySelectorAll("path")].map((path) => path.getAttribute("d")) }
  })
  assert.ok(expected.paths.length, "Native Agentic glyph had no observable paths.")
  for (const row of await rows.all()) {
    const actual = await row.locator('[data-venice-icon="agentic-native"]').evaluate((svg) => ({
      viewBox: svg.getAttribute("viewBox"), paths: [...svg.querySelectorAll("path")].map((path) => path.getAttribute("d")),
    }))
    assert.deepEqual(actual, expected, "Agentic conversation glyph differs from native Venice.")
  }
  return count
}

async function checkPanelPages(page, dialog) {
  await navigatePanel(dialog, "Overview")
  await page.waitForFunction(() => ["/chat/classic", "/minds"].every((href) =>
    document.querySelector(`a[href="${href}"] svg`)), undefined, { timeout: 90_000 })
  await dialog.locator('[data-venice-icon="mind-native"]').first().waitFor({ state: "visible", timeout: 10_000 })
  const nativeIconMatches = await dialog.getByRole("navigation", { name: "Sync pages" }).evaluate((navigation) => {
    const normalize = (value) => value.replace(/\s+/g, " ").trim().replace(/[zZ]$/, "")
    const shapes = (svg) => svg ? [...svg.querySelectorAll("path,rect,circle,ellipse,line,polyline,polygon")].map((element) => ({
      tag: element.tagName.toLowerCase(),
      attributes: [...element.attributes].filter((attribute) => ["d", "x", "y", "x1", "x2", "y1", "y2", "width", "height", "rx", "ry", "r", "cx", "cy", "points", "transform"].includes(attribute.name))
        .map((attribute) => [attribute.name, normalize(attribute.value)]).sort(([a], [b]) => a.localeCompare(b)),
    })) : null
    return [["Conversations", "/chat/classic"], ["Characters", "/character-chat"], ["Mind", "/minds"]].map(([label, href]) => {
      const source = document.querySelector(`a[href="${href}"] svg`)
      const button = [...navigation.querySelectorAll("button")].find((element) => element.textContent.trim() === label)
      const rendered = button?.querySelector("svg")
      return { label, sourceAvailable: !!source, matches: !!source && JSON.stringify(shapes(source)) === JSON.stringify(shapes(rendered)) }
    })
  })
  assert.ok(nativeIconMatches.every((icon) => icon.matches || (icon.label === "Characters" && !icon.sourceAvailable)), `Native Venice icon mismatch: ${JSON.stringify(nativeIconMatches)}`)
  const overview = dialog.getByRole("region", { name: "Transfer overview" })
  assert.equal(await overview.getByRole("region").count(), 4)
  const borders = await overview.getByRole("region").evaluateAll((elements) => elements.map((element) => {
    const style = getComputedStyle(element)
    return { style: style.borderTopStyle, width: style.borderTopWidth }
  }))
  assert.ok(borders.every((border) => border.style === "solid" && border.width === "1px"), "Content card borders did not render inside the Shadow DOM.")
  assert.equal(await dialog.getByTestId("runtime-handler").count(), 0)
  assert.equal(await dialog.getByTestId("storage-result").count(), 0)
  assert.equal(await dialog.getByTestId("conversation-list").count(), 0)
  const results = path.join(root, "test-results")
  await mkdir(results, { recursive: true })
  await dialog.screenshot({ path: path.join(results, "tampermonkey-overview.png") })
  await navigatePanel(dialog, "Library Assets")
  await dialog.getByTestId("library-asset-list").waitFor({ state: "visible", timeout: 45_000 })
  assert.ok(await dialog.getByRole("button", { name: "Upload Library asset", exact: true }).isVisible())
  await navigatePanel(dialog, "Characters")
  await dialog.getByTestId("character-list").waitFor({ state: "visible", timeout: 45_000 })
  assert.ok(await dialog.getByRole("button", { name: "Upload Character file", exact: true }).isVisible())
  await navigatePanel(dialog, "Mind")
  await dialog.getByTestId("mind-definition-list").waitFor({ state: "visible", timeout: 45_000 })
  assert.ok(await dialog.getByRole("button", { name: "Upload Mind package", exact: true }).isVisible())
  assert.equal(await dialog.getByRole("checkbox").count(), 0, "Mind export must include all contents without checkboxes.")
  await openConversations(dialog)
  assert.equal(await dialog.getByRole("group", { name: "Conversation type" }).count(), 0, "Conversation type tabs should be removed.")
  await waitForMindHistory(dialog)
  const kinds = await dialog.locator("[data-conversation-kind]").evaluateAll((rows) => rows.map((row) => ({
    kind: row.getAttribute("data-conversation-kind"), icon: row.querySelector('[role="img"]')?.getAttribute("aria-label"),
  })))
  assert.ok(kinds.every((row) => row.icon === `${row.kind === "classic" ? "Classic" : row.kind === "mind" ? "Mind" : "Agentic"} conversation`))
  const agenticGlyphs = await checkAgenticGlyphs(page, dialog)
  const avatars = dialog.locator('[data-conversation-kind="mind"] img')
  for (const avatar of await avatars.all()) {
    assert.ok(await avatar.evaluate(async (image) => { await image.decode(); return image.naturalWidth > 0 }), "Mind conversation avatar did not decode.")
  }
  if (await dialog.locator('[data-conversation-kind="mind"]').count()) {
    await dialog.screenshot({ path: path.join(results, "tampermonkey-conversation-avatars.png") })
  }
  await navigatePanel(dialog, "Overview")
  const originalSize = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }))
  await page.setViewportSize({ width: 390, height: 844 })
  await dialog.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))))
  await dialog.evaluate(async (element) => { await Promise.all(element.getAnimations().map((animation) => animation.finished)) })
  const mobile = await dialog.evaluate((element) => {
    const box = element.getBoundingClientRect()
    return { width: box.width, height: box.height, left: box.left, right: box.right, top: box.top, bottom: box.bottom, overflow: element.scrollWidth > element.clientWidth }
  })
  await dialog.screenshot({ path: path.join(results, "tampermonkey-mobile.png") })
  assert.ok(mobile.left >= 0 && mobile.right <= 390 && mobile.top >= 0 && mobile.bottom <= 844, `Mobile dialog is outside the viewport: ${JSON.stringify(mobile)}`)
  assert.equal(mobile.overflow, false, "Mobile dialog overflows horizontally.")
  const mobileNavigationFits = await dialog.getByRole("navigation", { name: "Sync pages" }).evaluate((element) => {
    const nav = element.getBoundingClientRect()
    return Array.from(element.querySelectorAll("button")).every((button) => {
      const box = button.getBoundingClientRect()
      return box.left >= nav.left && box.right <= nav.right && box.top >= nav.top && box.bottom <= nav.bottom
    })
  })
  assert.ok(mobileNavigationFits, "Mobile navigation clips a content page.")
  await dialog.screenshot({ path: path.join(results, "tampermonkey-mobile.png") })
  await page.setViewportSize(originalSize)
  return { fourContentCategories: "passed", nativeCategoryIconShapes: "matched where native entries exist",
    unavailableNativeCategoryIcons: nativeIconMatches.filter(icon => !icon.sourceAvailable).map(icon => icon.label),
    nativeAgenticConversationGlyphsMatched: agenticGlyphs,
    mindConversationAvatarsDecoded: await avatars.count(),
    allContentTransferPagesAvailable: "passed", unifiedConversationListAndTypeIcons: "passed", fullMindWithoutCheckboxes: "passed", diagnosticsSeparated: "passed", mobileLayout: "passed" }
}

async function checkStorageOverview(page, dialog) {
  await navigatePanel(dialog, "Details")
  const details = dialog.getByTestId("storage-diagnostics")
  if (await details.getAttribute("open") === null) await details.locator("summary").click()
  const result = dialog.getByTestId("storage-result")
  await result.waitFor({ state: "visible", timeout: 30_000 })
  assert.equal(await dialog.getByRole("alert").count(), 0, "Storage reading reported errors.")
  const expected = await page.evaluate(async () => {
    let bytes = 0
    for (let index = 0; index < localStorage.length; index += 1) {
      const key = localStorage.key(index)
      if (key === null) throw new Error("localStorage changed during E2E validation.")
      const value = localStorage.getItem(key)
      if (value === null) throw new Error("localStorage changed during E2E validation.")
      bytes += 2 * (key.length + value.length)
    }
    return { keys: localStorage.length, bytes, databases: await indexedDB.databases() }
  })
  assert.equal(
    await result.getByTestId("local-storage-summary").innerText(),
    `${expected.keys} keys; approximately ${expected.bytes} bytes (UTF-16 keys + values).`,
  )
  assert.equal(
    await result.getByTestId("indexeddb-summary").innerText(),
    `${expected.databases.length} databases`,
  )
  for (const database of expected.databases) {
    assert.equal(
      await result.getByRole("heading", { name: `${database.name} (v${database.version})`, exact: true }).count(),
      1,
    )
  }
  const previousRead = await result.getAttribute("data-read-at")
  await dialog.getByRole("button", { name: "Refresh storage" }).click()
  await dialog.locator(`[data-testid="storage-result"]:not([data-read-at="${previousRead}"])`)
    .waitFor({ state: "visible", timeout: 30_000 })
  assert.equal(await dialog.getByRole("alert").count(), 0)
  return { localStorageKeys: expected.keys, indexedDBDatabases: expected.databases.length }
}

async function smokeTest(context) {
  const page = await context.newPage()
  await page.goto("https://venice.ai/chat/agent", {
    waitUntil: "domcontentloaded",
    timeout: 60_000,
  })
  await waitForSignedInVenice(page)
  await page.bringToFront()

  const host = page.locator(`#${hostId}`)
  await sidebarLauncher(page)
  assert.equal(await host.count(), 1)
  await openSync(page)

  const dialog = host.getByRole("region", { name: "Venice Sync", exact: true })
  await dialog.waitFor({ state: "visible" })
  const webui = await checkPanelPages(page, dialog)
  await navigatePanel(dialog, "Details")
  assert.equal(await dialog.getByTestId("runtime-handler").innerText(), "Tampermonkey")
  assert.equal(await dialog.getByTestId("runtime-mode").innerText(), "userscript")
  assert.equal(await dialog.getByText(packageJson.version, { exact: true }).count(), 1)

  const storage = await checkStorageOverview(page, dialog)
  const hostInput = page.locator("textarea").first()
  if (await hostInput.count()) {
    await hostInput.focus()
    assert.ok(await dialog.isVisible(), "Host autofocus dismissed the non-modal dialog.")
  }
  const status = dialog.getByRole("status").filter({ hasText: "Test clicks:" })
  await openUiDiagnostics(dialog)
  assert.equal(await status.innerText(), "Test clicks: 0")
  await dialog.getByRole("button", { name: "Test interaction" }).click()
  await status.filter({ hasText: "Test clicks: 1" }).waitFor()
  const styles = await dialog.evaluate((element) => {
    const computed = getComputedStyle(element), box = element.getBoundingClientRect(), parent = element.getRootNode().host.parentElement, parentBox = parent.getBoundingClientRect()
    return {
      background: computed.backgroundColor,
      width: element.getBoundingClientRect().width,
      insideShadow: element.getRootNode() instanceof ShadowRoot,
      portalEscaped: !!document.querySelector('[data-slot="dialog-content"]'),
      fillsContentArea: Math.abs(box.left - parentBox.left - parent.clientLeft) < 1 && Math.abs(box.top - parentBox.top - parent.clientTop) < 1 && Math.abs(box.width - parent.clientWidth) < 1 && Math.abs(box.height - parent.clientHeight) < 1,
    }
  })
  assert.ok(styles.insideShadow)
  assert.equal(styles.portalEscaped, false)
  assert.ok(styles.width > 250, "Dialog layout styles did not apply.")
  assert.equal(styles.fillsContentArea, true, "Sync must fill the native content region.")
  assert.notEqual(styles.background, "rgba(0, 0, 0, 0)")

  const results = path.join(root, "test-results")
  await mkdir(results, { recursive: true })
  await dialog.screenshot({ path: path.join(results, "tampermonkey-details.png") })
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await returnToVenice(page, dialog)
    await openSync(page)
    await openUiDiagnostics(dialog)
    await status.filter({ hasText: "Test clicks: 1" }).waitFor()
  }
  await page.keyboard.press("Escape")
  await dialog.waitFor({ state: "hidden" })

  await page.reload({ waitUntil: "domcontentloaded" })
  await sidebarLauncher(page)
  assert.equal(await host.count(), 1)
  await openSync(page)
  await openUiDiagnostics(dialog)
  await status.filter({ hasText: "Test clicks: 0" }).waitFor()
  await checkStorageOverview(page, dialog)

  return {
    runtime: "Tampermonkey",
    mode: "userscript",
    version: packageJson.version,
    webui,
    counterInteraction: "passed",
    storageOverview: "passed",
    storageRefresh: "passed",
    storage,
    nativeContentPageAndReturn: "passed",
    focusOutsideDismissalPrevented: true,
    closeAndReopen: "passed",
    escapeKey: "passed",
    reloadReinjection: "passed",
    singleHostAfterReload: "passed",
    counterResetAfterReload: "passed",
    styles,
    scriptEvaluatedByPlaywright: false,
    veniceStorageMetadataReadByTest: true,
    veniceRecordContentsReadByTest: false,
    veniceStorageWrittenByTest: false,
    screenshot: "test-results/tampermonkey-overview.png",
  }
}

async function classicCounts(page) {
  return page.evaluate(async () => {
    const database = await new Promise((resolve, reject) => {
      const request = indexedDB.open("venice-db-encrypted")
      request.onupgradeneeded = () => { request.transaction.abort(); reject(new Error("Classic database is missing.")) }
      request.onerror = () => reject(request.error)
      request.onsuccess = () => resolve(request.result)
    })
    try {
      const names = ["conversations", "messages", "messageIds"]
      const transaction = database.transaction(names, "readonly")
      return await Promise.all(names.map((name) => new Promise((resolve, reject) => {
        const request = transaction.objectStore(name).count()
        request.onsuccess = () => resolve(request.result)
        request.onerror = () => reject(request.error)
      })))
    } finally { database.close() }
  })
}

async function cleanupSyntheticChats(page, ids) {
  if (ids.length === 0) return
  await page.evaluate(async (generatedIds) => {
    const database = await new Promise((resolve, reject) => {
      const request = indexedDB.open("venice-db-encrypted")
      request.onupgradeneeded = () => { request.transaction.abort(); reject(new Error("Classic database is missing during cleanup.")) }
      request.onerror = () => reject(request.error)
      request.onsuccess = () => resolve(request.result)
    })
    try {
      await new Promise((resolve, reject) => {
        const transaction = database.transaction(["conversations", "messages", "messageIds"], "readwrite")
        transaction.oncomplete = () => resolve()
        transaction.onabort = () => reject(transaction.error ?? new Error("Synthetic fixture cleanup aborted."))
        for (const id of generatedIds) {
          transaction.objectStore("conversations").delete(id)
          for (const name of ["messages", "messageIds"]) {
            const store = transaction.objectStore(name)
            const keys = store.index("conversationId").getAllKeys(id)
            keys.onsuccess = () => { for (const key of keys.result) store.delete(key) }
          }
        }
      })
    } finally { database.close() }
  }, ids)
}

async function importWithNativeRefresh(page, dialog, json, ids) {
  const file = JSON.parse(json)
  const previousIds = new Set(await dialog.locator("[data-conversation-id]").evaluateAll(
    (elements) => elements.map((element) => element.getAttribute("data-conversation-id")),
  ))
  const previousUrl = page.url()
  await dialog.getByLabel("Import conversation JSON").setInputFiles({
    name: "venice-sync-test.json", mimeType: "application/json", buffer: Buffer.from(json),
  })
  await dialog.getByTestId("import-preview").waitFor({ state: "visible" })
  const [navigation] = await Promise.all([
    page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 60_000 }),
    dialog.getByRole("button", { name: "Confirm import as new chat", exact: true }).click({ timeout: 60_000 }),
  ])
  assert.ok(navigation, "Import did not reload the native document.")
  assert.equal(page.url(), previousUrl, "Import unexpectedly switched the current conversation.")
  assert.equal(
    await page.evaluate(() => performance.getEntriesByType("navigation")[0]?.type),
    "reload",
    "Import did not automatically reload the page.",
  )

  await openSync(page)
  await openConversations(dialog)
  await dialog.getByTestId("conversation-list").waitFor({ state: "visible", timeout: 30_000 })
  const matchingIds = await dialog.locator("[data-conversation-id]").evaluateAll(
    (elements, name) => elements
      .filter((element) => element.querySelector("h3")?.textContent === name)
      .map((element) => element.getAttribute("data-conversation-id")),
    file.conversation.name,
  )
  const addedIds = matchingIds.filter((id) => !previousIds.has(id))
  assert.equal(addedIds.length, 1, "Could not uniquely identify the new test conversation.")
  const id = addedIds[0]
  assert.match(id ?? "", /^[0-9a-f-]{36}$/i)
  assert.ok(!ids.includes(id))
  ids.push(id)

  const nativeLink = page.locator(`a[href="/chat/classic/${id}"], a[href="/chat/${id}"]`).first()
  await nativeLink.waitFor({ state: "visible", timeout: 30_000 })
  assert.ok((await nativeLink.innerText()).includes(file.conversation.name), "Venice's native sidebar did not refresh.")
  return { id, href: await nativeLink.getAttribute("href") }
}

async function conversationTransferTest(context) {
  const page = await context.newPage()
  await page.goto("https://venice.ai/chat/classic", { waitUntil: "domcontentloaded", timeout: 60_000 })
  await waitForSignedInVenice(page)
  await page.bringToFront()
  const host = page.locator(`#${hostId}`)
  const dialog = host.getByRole("region", { name: "Venice Sync", exact: true })
  await openSync(page)
  await openConversations(dialog)
  await dialog.getByTestId("conversation-list").waitFor({ state: "visible", timeout: 30_000 })
  const baseline = await classicCounts(page)
  const fixture = JSON.parse(await readFile(path.join(root, "scripts/fixtures/classic-conversation.json"), "utf8"))
  fixture.conversation.name = `Venice Sync E2E ${Date.now()}`
  const ids = []
  try {
    const importFile = (json) => importWithNativeRefresh(page, dialog, json, ids)
    const first = await importFile(JSON.stringify(fixture))
    assert.deepEqual(await classicCounts(page), baseline.map((count, index) => count + (index === 0 ? 1 : 2)))
    const downloadReady = page.waitForEvent("download")
    await dialog.locator(`[data-conversation-id="${first.id}"]`).getByRole("button", { name: "Export JSON" }).click()
    const download = await downloadReady
    const saved = path.join(root, "test-results/round-trip-conversation.json")
    await download.saveAs(saved)
    const exportedJson = await readFile(saved, "utf8")
    await download.delete()
    const exported = JSON.parse(exportedJson)
    assert.equal(exported.format, "venice-sync-classic")
    assert.equal(exported.version, 1)
    assert.equal(exported.conversation.name, fixture.conversation.name)
    assert.equal(exported.conversation.ownerId, undefined)
    assert.deepEqual(
      exported.messages.map(({ role, content, createdAtUnixTimestamp, updatedAtUnixTimestamp }) => ({ role, content, createdAtUnixTimestamp, updatedAtUnixTimestamp })),
      fixture.messages.map(({ role, content, createdAtUnixTimestamp, updatedAtUnixTimestamp }) => ({ role, content, createdAtUnixTimestamp, updatedAtUnixTimestamp })),
    )
    assert.ok(exported.messages.every((message) => message.conversationId === first.id))
    assert.ok(exported.messages.every((message) => !fixture.messages.some((source) => source.id === message.id)))
    await dialog.screenshot({ path: path.join(root, "test-results/tampermonkey-conversation-transfer.png") })
    await page.goto(`https://venice.ai${first.href}`, { waitUntil: "domcontentloaded" })
    for (const message of fixture.messages) {
      await page.getByText(message.content, { exact: true }).waitFor({ state: "visible", timeout: 45_000 })
    }
    await page.reload({ waitUntil: "domcontentloaded" })
    for (const message of fixture.messages) {
      await page.getByText(message.content, { exact: true }).waitFor({ state: "visible", timeout: 45_000 })
    }
    await openSync(page)
    await openConversations(dialog)
    await dialog.getByTestId("conversation-list").waitFor({ state: "visible" })
    await importFile(exportedJson)
    assert.deepEqual(await classicCounts(page), baseline.map((count, index) => count + (index === 0 ? 2 : 4)))
  } finally {
    await cleanupSyntheticChats(page, ids)
    assert.deepEqual(await classicCounts(page), baseline, "Synthetic fixture cleanup did not restore original counts.")
    await page.goto("https://venice.ai/chat/classic", { waitUntil: "domcontentloaded" })
  }
  return {
    importPreview: "passed", atomicNativeImport: "passed", jsonDownload: "passed",
    nativeSidebarAutoRefresh: "passed", importReloadPreservesCurrentUrl: "passed",
    plaintextContentAndRolesRoundTrip: "passed", nativeVeniceRenderingAfterReload: "passed",
    reimportCreatesNewChat: "passed", syntheticFixtureCleanup: "passed",
    existingChatsModified: false, inferenceRequestsSent: false,
    scriptEvaluatedByPlaywright: false,
  }
}

async function selectedConversationTest(context, id) {
  assert.match(id, /^[a-zA-Z0-9_-]+$/, "Invalid test conversation ID.")
  const page = await context.newPage()
  await page.goto(`https://venice.ai/chat/classic/${id}`, { waitUntil: "domcontentloaded" })
  await waitForSignedInVenice(page)
  await page.bringToFront()
  const host = page.locator(`#${hostId}`)
  const dialog = host.getByRole("region", { name: "Venice Sync", exact: true })
  await openSync(page)
  await openConversations(dialog)
  await dialog.getByTestId("conversation-list").waitFor({ state: "visible", timeout: 30_000 })
  const fingerprint = () => page.evaluate(async (conversationId) => {
    const database = await new Promise((resolve, reject) => {
      const request = indexedDB.open("venice-db-encrypted")
      request.onupgradeneeded = () => { request.transaction.abort(); reject(new Error("Missing Classic database.")) }
      request.onerror = () => reject(request.error)
      request.onsuccess = () => resolve(request.result)
    })
    try {
      const transaction = database.transaction(["conversations", "messages", "messageIds"], "readonly")
      const requests = [
        transaction.objectStore("conversations").get(conversationId),
        transaction.objectStore("messages").index("conversationId").getAll(conversationId),
        transaction.objectStore("messageIds").index("conversationId").getAll(conversationId),
      ]
      const values = await Promise.all(requests.map((request) => new Promise((resolve, reject) => {
        request.onsuccess = () => resolve(request.result)
        request.onerror = () => reject(request.error)
      })))
      if (!values[0]) throw new Error("Selected conversation is missing.")
      const serialized = JSON.stringify(values)
      const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(serialized))
      return {
        sha256: Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join(""),
        messages: values[1].length,
      }
    } finally { database.close() }
  }, id)
  const downloadConversation = async (conversationId) => {
    const [download] = await Promise.all([
      page.waitForEvent("download"),
      dialog.locator(`[data-conversation-id="${conversationId}"]`).getByRole("button", { name: "Export JSON" }).click(),
    ]).catch(async (error) => {
      const alerts = await dialog.locator('[role="alert"]').allTextContents()
      throw new Error(
        alerts.length ? `Userscript export failed: ${alerts.join("; ")}` : "Chrome did not start the conversation JSON download.",
        { cause: error },
      )
    })
    try {
      const stream = await download.createReadStream()
      assert.ok(stream, "Conversation download has no readable stream.")
      const chunks = []
      for await (const chunk of stream) chunks.push(chunk)
      return JSON.parse(Buffer.concat(chunks).toString("utf8"))
    } finally { await download.delete() }
  }
  const messageDigest = (messages) => {
    const canonical = (value) => Array.isArray(value) ? value.map(canonical) :
      value && typeof value === "object" ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, entry]) => [key, canonical(entry)])) : value
    const normalized = messages.map((message) => {
      const result = { ...message }
      delete result.id
      delete result.conversationId
      delete result.ownerId
      return result
    })
    return createHash("sha256").update(JSON.stringify(canonical(normalized))).digest("hex")
  }
  const baseline = await classicCounts(page)
  const originalFingerprint = await fingerprint()
  const original = await downloadConversation(id)
  assert.equal(original.messages.length, originalFingerprint.messages)
  const expectedMessages = messageDigest(original.messages)
  const ids = []
  try {
    const file = { ...original, conversation: { ...original.conversation, name: `${original.conversation.name} [Venice Sync test copy]` } }
    const { id: copyId, href } = await importWithNativeRefresh(page, dialog, JSON.stringify(file), ids)
    assert.notEqual(copyId, id)
    const copy = await downloadConversation(copyId)
    assert.equal(messageDigest(copy.messages), expectedMessages, "Copied message data differs from the original export.")
    assert.equal(copy.conversation.name, file.conversation.name)
    assert.equal(copy.conversation.modelId, original.conversation.modelId)
    const userMessage = original.messages.find((message) => message.role === "user")
    assert.ok(userMessage, "Selected test chat has no user message to check in native Venice.")
    await page.goto(`https://venice.ai${href}`, { waitUntil: "domcontentloaded" })
    await page.getByText(userMessage.content, { exact: true }).first().waitFor({ state: "visible", timeout: 45_000 })
  } finally {
    await cleanupSyntheticChats(page, ids)
    assert.deepEqual(await classicCounts(page), baseline)
    assert.deepEqual(await fingerprint(), originalFingerprint, "Original conversation changed during testing.")
    await page.goto("https://venice.ai/chat/classic", { waitUntil: "domcontentloaded" })
  }
  return {
    exportedMessages: originalFingerprint.messages,
    exportAndCopyImport: "passed", copiedMessageDataDigest: "matched",
    nativeSidebarAutoRefresh: "passed", importReloadPreservesCurrentUrl: "passed",
    nativeImportedPromptVisible: "passed", originalRecordFingerprint: "unchanged",
    testCopyCleanup: "passed", originalChatModified: false,
    chatContentsLoggedOrRetainedByTest: false,
  }
}

async function mindStorageSnapshot(page, cleanup = [], expectedPrefix = "", selectedId = "") {
  return page.evaluate(async ({ cleanup, expectedPrefix, selectedId }) => {
    const registry = await new Promise((resolve, reject) => {
      const id = `venice-sync-test-registry-${crypto.randomUUID()}`, chunk = `venice-sync/${id}.js`
      const timer = setTimeout(() => reject(new Error("Native RxDB test registry timed out.")), 5000)
      try {
        globalThis.TURBOPACK.push([chunk, id, (runtime) => {
          try { clearTimeout(timer); resolve(runtime.r(947217).OPEN_COLLECTIONS) } catch (error) { reject(error) }
        }])
        Promise.resolve(globalThis.TURBOPACK.push([chunk, { otherChunks: [], runtimeModuleIds: [id] }])).catch(reject)
      } catch (error) { clearTimeout(timer); reject(error) }
    })
    const get = (name, version) => {
      const values = [...registry].filter((collection) => !collection.closed && collection.database.name === "venice-rx-db-encrypted" && collection.name === name &&
        (collection.schema.version === version || (name === "mindConversations" && collection.schema.version === 5)))
      if (values.length !== 1) throw new Error("Ambiguous native Mind test collection.")
      return values[0]
    }
    const definitions = get("minds", 25), conversations = get("mindConversations", 4), messages = get("mindMessages", 25)
    for (const id of cleanup) {
      const conversation = await conversations.findOne(id).exec()
      if (!conversation || !expectedPrefix || !conversation.name.startsWith(expectedPrefix)) throw new Error("Refusing to clean an unverified Mind test record.")
      const records = await messages.find({ selector: { mind_conversation_id: id } }).exec()
      if (records.some((record) => record.owner_id !== conversation.ownerId)) throw new Error("Unexpected ownership during Mind test cleanup.")
      const removed = await messages.bulkRemove(records.map((record) => record.id))
      if (removed.error.length) throw new Error("Could not clean generated Mind test messages.")
      const removedConversation = await conversations.bulkRemove([id])
      if (removedConversation.error.length) throw new Error("Could not clean the generated Mind test conversation.")
    }
    const minds = await definitions.find({ selector: {} }).exec()
    const bytes = new TextEncoder().encode(JSON.stringify(minds.map((mind) => mind.toJSON()).sort((a, b) => a.id.localeCompare(b.id))))
    const digest = await crypto.subtle.digest("SHA-256", bytes)
    let selected
    if (selectedId) {
      const conversation = await conversations.findOne(selectedId).exec()
      if (!conversation || conversation.type !== "chat" || conversation.mindId || conversation.remoteMindId || conversation.studioProjectId) {
        throw new Error("The selected Agentic test conversation is missing or bound to another content type.")
      }
      const records = (await messages.find({ selector: { mind_conversation_id: selectedId } }).exec()).map((record) => record.toJSON()).sort((a, b) => a.id.localeCompare(b.id))
      const bytes = new TextEncoder().encode(JSON.stringify({ conversation: conversation.toJSON(), messages: records }))
      const digest = await crypto.subtle.digest("SHA-256", bytes)
      selected = { messageCount: records.length, fingerprint: Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("") }
    }
    return {
      definitionFingerprint: Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join(""),
      conversations: (await conversations.find({ selector: {} }).exec()).length,
      messages: (await messages.find({ selector: {} }).exec()).length,
      ...(selected ? { selected } : {}),
    }
  }, { cleanup, expectedPrefix, selectedId })
}

async function mindHistoryTransferTest(context, agentic = false) {
  const page = await context.newPage()
  await page.goto("https://venice.ai/chat/agent", { waitUntil: "domcontentloaded" })
  await waitForSignedInVenice(page)
  await page.bringToFront()
  const host = page.locator(`#${hostId}`)
  const dialog = host.getByRole("region", { name: "Venice Sync", exact: true })
  const openMind = async () => {
    await openConversations(dialog)
    await waitForMindHistory(dialog)
  }
  await openSync(page)
  await openMind()
  const baseline = await mindStorageSnapshot(page)
  const fixture = JSON.parse(await readFile(path.join(root, "scripts/fixtures/mind-conversation.json"), "utf8"))
  if (agentic) {
    fixture.format = "venice-sync-agentic-conversation"
    delete fixture.conversation.mindId
  }
  fixture.conversation.name = `Venice Sync ${agentic ? "Agentic" : "Mind"} E2E ${Date.now()}`
  const prefix = fixture.conversation.name
  const ids = []
  const documentOrigin = await page.evaluate(() => performance.timeOrigin)
  const initialUrl = page.url()
  const importFile = async (json) => {
    await dialog.getByLabel("Import conversation JSON", { exact: true }).setInputFiles({
      name: "mind-history-test.json", mimeType: "application/json", buffer: Buffer.from(json),
    })
    await dialog.getByTestId(agentic ? "agentic-import-preview" : "mind-import-preview").waitFor()
    if (!agentic) {
      const select = dialog.getByRole("combobox", { name: "Destination Mind" })
      const option = select.locator('option[value^="local:"]').first()
      const value = await option.getAttribute("value")
      assert.ok(value, "A local Mind is required for the opt-in Mind history test.")
      await select.selectOption(value)
    } else assert.equal(await dialog.getByRole("combobox", { name: "Destination Mind" }).count(), 0)
    await dialog.getByRole("button", { name: agentic ? "Confirm Agentic history import" : "Confirm Mind history import", exact: true }).click()
    const link = dialog.getByTestId(agentic ? "imported-agentic-chat-link" : "imported-mind-chat-link")
    await link.waitFor({ state: "visible" })
    const href = await link.getAttribute("href")
    const id = href?.split("/").at(-1)
    assert.match(id ?? "", /^[0-9a-f-]{36}$/i)
    assert.ok(!ids.includes(id))
    ids.push(id)
    await dialog.locator(`[data-conversation-id="${id}"][data-conversation-kind="${agentic ? "agentic" : "mind"}"]`).waitFor()
    await page.waitForFunction((href) => [...document.querySelectorAll("a[href]")].some((anchor) =>
      anchor.getAttribute("href") === href && anchor.getClientRects().length > 0), href, { timeout: 30_000 })
    return { id, href }
  }
  const messageShape = (messages) => messages.map((message) => ({
    role: message.role, status: message.status,
    created: message.created_at_unix_timestamp, updated: message.updated_at_unix_timestamp,
    items: message.output_items.map((item) => ({
      type: item.type, content: item.content.map((part) => ({ type: part.type, text: part.text, refusal: part.refusal })),
    })),
  }))
  try {
    const first = await importFile(JSON.stringify(fixture))
    if (agentic) await checkAgenticGlyphs(page, dialog)
    assert.equal(page.url(), initialUrl)
    assert.equal(await page.evaluate(() => performance.timeOrigin), documentOrigin, "Mind import unexpectedly reloaded the page.")
    const ready = page.waitForEvent("download")
    await dialog.locator(`[data-conversation-id="${first.id}"][data-conversation-kind="${agentic ? "agentic" : "mind"}"]`).getByRole("button", { name: agentic ? "Export Agentic JSON" : "Export Mind JSON" }).click()
    const download = await ready
    const file = path.join(root, `test-results/${agentic ? "agentic" : "mind"}-history-round-trip.json`)
    await download.saveAs(file)
    const exportedJson = await readFile(file, "utf8")
    await download.delete()
    const exported = JSON.parse(exportedJson)
    assert.equal(exported.format, agentic ? "venice-sync-agentic-conversation" : "venice-sync-mind-conversation")
    if (agentic) {
      assert.equal(exported.conversation.mindId, undefined)
      assert.equal(exported.conversation.remoteMindId, undefined)
    }
    assert.deepEqual(messageShape(exported.messages), messageShape(fixture.messages))
    assert.equal(exported.conversation.ownerId, undefined)
    assert.ok(exported.messages.every((message) => message.owner_id === undefined && message.mind_conversation_id === first.id))
    await importFile(exportedJson)
    assert.equal(await page.evaluate(() => performance.timeOrigin), documentOrigin)
    await dialog.screenshot({ path: path.join(root, `test-results/tampermonkey-${agentic ? "agentic" : "mind"}-history.png`) })
    await page.goto(`https://venice.ai${first.href}`, { waitUntil: "domcontentloaded" })
    for (const text of [fixture.messages[0].output_items[0].content[0].text, fixture.messages[1].output_items[1].content[0].text]) {
      await page.getByText(text, { exact: true }).first().waitFor({ state: "visible", timeout: 45_000 })
    }
    await page.reload({ waitUntil: "domcontentloaded" })
    await page.getByText(fixture.messages[1].output_items[1].content[0].text, { exact: true }).first().waitFor({ state: "visible", timeout: 45_000 })
  } finally {
    const restored = await mindStorageSnapshot(page, ids, prefix)
    assert.deepEqual(restored, baseline, "Mind test cleanup changed existing data or definitions.")
    await page.goto("https://venice.ai/chat/agent", { waitUntil: "domcontentloaded" })
  }
  return {
    ...(agentic ? { previewWithoutMindDestination: "passed" } : { previewAndDestinationSelection: "passed" }), nativeRxDBImport: "passed",
    structuredTextAndReasoningRoundTrip: "passed", nativeSidebarUpdatedWithoutReload: "passed",
    nativeMessagesRenderedAfterReload: "passed", reimportCreatesNewCopy: "passed",
    mindDefinitionFingerprint: "unchanged", existingHistoryCounts: "unchanged", fixtureCleanup: "passed",
    scriptEvaluatedByPlaywright: false, inferenceRequestsSubmittedByTest: false,
  }
}

async function selectedAgenticConversationTest(context, id) {
  assert.match(id, /^[\w-]{1,100}$/)
  const page = await context.newPage()
  await page.goto(`https://venice.ai/chat/agent/${id}`, { waitUntil: "domcontentloaded" })
  await waitForSignedInVenice(page)
  await page.bringToFront()
  const host = page.locator(`#${hostId}`)
  const dialog = host.getByRole("region", { name: "Venice Sync", exact: true })
  await openSync(page)
  await openConversations(dialog)
  const baseline = await mindStorageSnapshot(page, [], "", id)
  const downloadArchive = async (conversationId) => {
    const [download] = await Promise.all([
      page.waitForEvent("download"),
      dialog.locator(`[data-conversation-id="${conversationId}"][data-conversation-kind="agentic"]`)
        .getByRole("button", { name: "Export Agentic JSON", exact: true }).click(),
    ]).catch(async (error) => {
      const alerts = await dialog.getByRole("alert").allTextContents()
      throw new Error(alerts.length ? `Agentic export failed: ${alerts.join("; ")}` : "Agentic download did not start.", { cause: error })
    })
    try {
      const stream = await download.createReadStream()
      assert.ok(stream)
      const chunks = []
      for await (const chunk of stream) chunks.push(chunk)
      return JSON.parse(Buffer.concat(chunks).toString("utf8"))
    } finally { await download.delete() }
  }
  const digest = (messages) => {
    const idFields = new Set(["id", "mind_conversation_id", "owner_id", "turn_id", "item_id", "response_id"])
    const normalize = (value) => Array.isArray(value) ? value.map(normalize) : value && typeof value === "object" ?
      Object.fromEntries(Object.entries(value).filter(([key]) => !idFields.has(key)).sort(([a], [b]) => a.localeCompare(b)).map(([key, entry]) => [key, normalize(entry)])) : value
    return createHash("sha256").update(JSON.stringify(normalize(messages))).digest("hex")
  }
  const original = await downloadArchive(id)
  assert.equal(original.format, "venice-sync-agentic-conversation")
  assert.equal(original.messages.length, baseline.selected.messageCount)
  assert.equal(original.conversation.mindId, undefined)
  assert.equal(original.conversation.remoteMindId, undefined)
  const prefix = `${original.conversation.name} [Venice Sync Agentic test copy]`
  const copy = { ...original, conversation: { ...original.conversation, name: prefix } }
  const ids = [], requests = []
  page.on("request", (request) => {
    if (request.method() !== "GET" && /(?:\/(?:inference|publish|responses|completions)(?:\/|$)|mind.*(?:chat|stream|infer|publish))/i.test(new URL(request.url()).pathname)) {
      requests.push(new URL(request.url()).pathname)
    }
  })
  try {
    const timeOrigin = await page.evaluate(() => performance.timeOrigin)
    await dialog.getByLabel("Import conversation JSON", { exact: true }).setInputFiles({
      name: "user-agentic-copy.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(copy)),
    })
    await dialog.getByTestId("agentic-import-preview").waitFor({ state: "visible" })
    assert.equal(await dialog.getByRole("combobox").count(), 0)
    await dialog.getByRole("button", { name: "Confirm Agentic history import", exact: true }).click()
    const link = dialog.getByTestId("imported-agentic-chat-link")
    await link.waitFor({ state: "visible", timeout: 30_000 })
    const href = await link.getAttribute("href")
    const copyId = href?.split("/").at(-1)
    assert.match(copyId ?? "", /^[a-f0-9-]{36}$/)
    assert.notEqual(copyId, id)
    ids.push(copyId)
    await dialog.locator(`[data-conversation-id="${copyId}"]`).waitFor()
    await page.waitForFunction((href) => [...document.querySelectorAll("a[href]")].some((anchor) =>
      anchor.getAttribute("href") === href && anchor.getClientRects().length > 0), href, { timeout: 30_000 })
    assert.equal(await page.evaluate(() => performance.timeOrigin), timeOrigin)
    const restored = await downloadArchive(copyId)
    assert.equal(digest(restored.messages), digest(original.messages), "Agentic copy changed the stored message data.")
    assert.equal(restored.conversation.name, prefix)
    await page.goto(`https://venice.ai${href}`, { waitUntil: "domcontentloaded" })
    const text = original.messages.find((message) => message.role === "user")?.output_items
      .find((item) => item.type === "message")?.content.find((part) => part.type === "output_text")?.text
    assert.equal(typeof text, "string", "The selected source has no user text for native-render verification.")
    await page.waitForFunction((text) => [...document.querySelectorAll("p,div,span")].some((element) =>
      element.textContent === text && element.getClientRects().length > 0), text, { timeout: 45_000 })
    await page.reload({ waitUntil: "domcontentloaded" })
    await page.waitForFunction((text) => [...document.querySelectorAll("p,div,span")].some((element) =>
      element.textContent === text && element.getClientRects().length > 0), text, { timeout: 45_000 })
    assert.equal(requests.length, 0)
  } finally {
    assert.deepEqual(await mindStorageSnapshot(page, ids, prefix, id), baseline, "Agentic test did not preserve original records.")
    await page.goto("https://venice.ai/chat/agent", { waitUntil: "domcontentloaded" })
  }
  return {
    exportedMessages: baseline.selected.messageCount, exportImportReexportMessageData: "matched",
    newIndependentChatWithoutMindBinding: "passed", nativeSidebarUpdatedWithoutReload: "passed",
    nativeContentVisibleAfterReload: "passed", originalFingerprint: "unchanged",
    testCopyCleanup: "passed", inferenceOrPublishRequests: 0, privateChatContentsRetainedByTest: false,
  }
}

async function packageDatabaseState(page, cleanup = [], expectedPrefix = "") {
  return page.evaluate(async ({ cleanup, expectedPrefix }) => {
    const registry = await new Promise((resolve, reject) => {
      const id = `venice-sync-package-test-${crypto.randomUUID()}`, chunk = `venice-sync/${id}.js`
      const timer = setTimeout(() => reject(new Error("Native package test registry timed out.")), 5000)
      try {
        globalThis.TURBOPACK.push([chunk, id, (runtime) => {
          try { clearTimeout(timer); resolve(runtime.r(947217).OPEN_COLLECTIONS) } catch (error) { reject(error) }
        }])
        Promise.resolve(globalThis.TURBOPACK.push([chunk, { otherChunks: [], runtimeModuleIds: [id] }])).catch(reject)
      } catch (error) { clearTimeout(timer); reject(error) }
    })
    const names = ["minds", "mindConversations", "mindMessages", "mindAttachments", "mindMedia"]
    const ports = Object.fromEntries(names.map((name) => {
      const matches = [...registry].filter((collection) => !collection.closed && collection.database.name === "venice-rx-db-encrypted" && collection.name === name)
      if (matches.length !== 1) throw new Error("Ambiguous native package test collection.")
      return [name, matches[0]]
    }))
    const root = await navigator.storage.getDirectory()
    for (const id of cleanup) {
      if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error("Unsafe generated fixture ID.")
      const mind = await ports.minds.findOne(id).exec()
      if (!mind || !expectedPrefix || !mind.name.startsWith(expectedPrefix)) throw new Error("Refusing to delete an unverified test Mind.")
      for (const conversationId of [`mind-maker-conv:${id}`, `mind-preview-conv:${id}`]) {
        for (const name of ["mindMessages", "mindAttachments", "mindMedia"]) {
          const field = name === "mindMessages" ? "mind_conversation_id" : "mindConversationId"
          const docs = await ports[name].find({ selector: { [field]: conversationId } }).exec()
          if (docs.some((document) => (name === "mindMessages" ? document.owner_id : document.ownerId) !== mind.ownerId)) throw new Error("Unexpected test-record ownership.")
          if (docs.length && (await ports[name].bulkRemove(docs.map((document) => document.id))).error.length) throw new Error("Could not clean test history.")
        }
        const history = await ports.mindConversations.findOne(conversationId).exec()
        if (history && (await ports.mindConversations.bulkRemove([conversationId])).error.length) throw new Error("Could not clean test conversation.")
      }
      if ((await ports.minds.bulkRemove([id])).error.length) throw new Error("Could not clean test definition.")
      for (const [parentName, child] of [["minds", id], ["media", `mind-maker-conv:${id}`], ["media", `mind-preview-conv:${id}`]]) {
        try {
          const parent = await root.getDirectoryHandle(parentName)
          await parent.removeEntry(child, { recursive: true })
        } catch (error) { if (error.name !== "NotFoundError") throw error }
      }
    }
    const state = {}
    for (const name of names) {
      const docs = (await ports[name].find({ selector: {} }).exec()).map((document) => document.toJSON()).sort((a, b) => a.id.localeCompare(b.id))
      const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(docs)))
      state[name] = { count: docs.length, fingerprint: Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("") }
    }
    return state
  }, { cleanup, expectedPrefix })
}

async function completeMindPackageTest(context) {
  const page = await context.newPage()
  await page.goto("https://venice.ai/chat/agent", { waitUntil: "domcontentloaded" })
  await waitForSignedInVenice(page)
  await page.bringToFront()
  const host = page.locator(`#${hostId}`)
  const dialog = host.getByRole("region", { name: "Venice Sync", exact: true })
  const openPackages = async () => {
    await openSync(page)
    await navigatePanel(dialog, "Mind")
    await dialog.getByTestId("mind-definition-list").waitFor({ state: "visible", timeout: 45_000 })
  }
  await openPackages()
  const baseline = await packageDatabaseState(page)
  const fixture = syntheticMindPackage(`Venice Sync package E2E ${Date.now()}`)
  const prefix = fixture.manifest.definition.name
  const ids = [], requests = []
  page.on("request", (request) => {
    if (request.method() !== "GET" && /(?:\/(?:inference|publish|responses|completions)(?:\/|$)|mind.*(?:chat|stream|infer|publish))/i.test(new URL(request.url()).pathname)) {
      requests.push(new URL(request.url()).pathname)
    }
  })
  const importZip = async (bytes) => {
    await dialog.getByLabel("Import Mind package", { exact: true }).setInputFiles({
      name: "mind-complete-test.zip", mimeType: "application/zip", buffer: Buffer.from(bytes),
    })
    await dialog.getByTestId("mind-package-preview").waitFor({ state: "visible" })
    assert.ok((await dialog.getByTestId("mind-package-preview").innerText()).includes("5 files"))
    await dialog.getByRole("button", { name: "Confirm import as new Mind", exact: true }).click()
    const result = await Promise.race([
      dialog.getByTestId("imported-mind-definition-link").waitFor({ state: "visible", timeout: 45_000 }).then(() => "success"),
      dialog.getByRole("region", { name: "Mind definition transfer", exact: true }).getByRole("alert").waitFor({ state: "visible", timeout: 45_000 }).then(() => "error"),
    ])
    if (result === "error") throw new Error(`Mind package UI: ${await dialog.getByRole("region", { name: "Mind definition transfer", exact: true }).getByRole("alert").innerText()}`)
    const href = await dialog.getByTestId("imported-mind-definition-link").getAttribute("href")
    const id = href?.split("/")[3]
    assert.match(id ?? "", /^[a-f0-9-]{36}$/)
    ids.push(id)
    await dialog.locator(`[data-mind-definition-id="${id}"]`).waitFor()
    const avatar = dialog.locator(`[data-mind-definition-id="${id}"]`).getByRole("img", { name: `${prefix} avatar`, exact: true })
    await avatar.waitFor({ state: "visible", timeout: 15_000 })
    assert.ok(await avatar.evaluate(async (image) => { await image.decode(); return image.complete && image.naturalWidth > 0 }), "Local Mind avatar did not decode.")
    return { id, href }
  }
  const downloadZip = async (id) => {
    const ready = page.waitForEvent("download")
    await dialog.locator(`[data-mind-definition-id="${id}"]`).getByRole("button", { name: "Export Mind package", exact: true }).click()
    const download = await ready
    try {
      const stream = await download.createReadStream()
      assert.ok(stream)
      const chunks = []
      for await (const chunk of stream) chunks.push(chunk)
      return Buffer.concat(chunks)
    } finally { await download.delete() }
  }
  const verify = (zip, id) => {
    const entries = unzipSync(zip)
    const manifest = JSON.parse(strFromU8(entries["manifest.json"]))
    assert.equal(manifest.definition.id, id)
    assert.equal(manifest.definition.name, prefix)
    assert.deepEqual(manifest.definition.systemPrompt, fixture.manifest.definition.systemPrompt)
    assert.deepEqual(manifest.definition.tools, fixture.manifest.definition.tools)
    assert.equal(manifest.definition.ownerId, undefined)
    assert.equal(manifest.definition.remoteId, undefined)
    assert.equal(manifest.files.length, 5, `Unexpected synthetic package files: ${manifest.files.map((file) => `${file.scope}/${file.path}`).join(", ")}`)
    assert.equal(manifest.assistant.conversation.id, `mind-maker-conv:${id}`)
    assert.equal(manifest.preview.conversation.id, `mind-preview-conv:${id}`)
    const calls = manifest.assistant.messages[0].output_items
    assert.ok(calls.some((item) => item.type === "functionCall" && item.name === "update_mind" && item.status === "completed"))
    const call = calls.find((item) => item.type === "functionCall")
    const output = calls.find((item) => item.type === "functionCallOutput")
    assert.equal(call.call_id, output.call_id)
    assert.notEqual(call.call_id, "builder-call-id")
    assert.equal(manifest.preview.attachments.length, 1)
    assert.equal(manifest.preview.media.length, 1)
    const content = manifest.preview.messages[0].output_items[0].content
    assert.equal(content.find((part) => part.type === "input_file").media_id, manifest.preview.attachments[0].id)
    assert.equal(content.find((part) => part.type === "input_image").media_id, manifest.preview.media[0].id)
    assert.equal(manifest.preview.attachments[0].mindMessageId, manifest.preview.messages[0].id)
    const expectedHashes = fixture.manifest.files.map((file) => file.sha256).sort()
    const actualHashes = manifest.files.map((file) => {
      const bytes = entries[`files/${file.scope}/${file.path}`]
      assert.ok(bytes)
      const hash = createHash("sha256").update(bytes).digest("hex")
      assert.equal(hash, file.sha256)
      return hash
    }).sort()
    assert.deepEqual(actualHashes, expectedHashes)
    return manifest
  }
  try {
    const first = await importZip(fixture.zip)
    const exported = await downloadZip(first.id)
    verify(exported, first.id)
    await importZip(exported)
    await dialog.screenshot({ path: path.join(root, "test-results/tampermonkey-mind-package.png") })
    await page.goto(`https://venice.ai${first.href}`, { waitUntil: "domcontentloaded" })
    await waitForSignedInVenice(page)
    await page.getByText("Synthetic Builder history restored without replaying edits.", { exact: true }).first().waitFor({ state: "visible", timeout: 45_000 })
    const previewTab = page.getByRole("tab", { name: /^(Mind preview|Mind 预览|Preview|预览)$/ })
    if (await previewTab.count()) {
      await previewTab.click()
      await page.getByText("Synthetic Preview history restored with its reference attachment.", { exact: true }).first().waitFor({ state: "visible", timeout: 30_000 })
    } else throw new Error("Native Mind editor Preview tab is unavailable.")
    await page.reload({ waitUntil: "domcontentloaded" })
    await waitForSignedInVenice(page)
    await openPackages()
    const afterEditor = await downloadZip(first.id)
    verify(afterEditor, first.id)
    assert.equal(requests.length, 0, "Restoring/opening history triggered an inference or publishing request.")
  } finally {
    assert.deepEqual(await packageDatabaseState(page, ids, prefix), baseline, "Mind package cleanup changed existing data.")
    await page.goto("https://venice.ai/chat/agent", { waitUntil: "domcontentloaded" })
  }
  return {
    definitionAndSubAgents: "passed", avatarCoverAndReferenceFiles: "passed",
    builderToolsPreservedWithoutReplay: "passed", previewAttachmentAndImage: "passed",
    nestedReferencesRemapped: "passed", exportImportReexportHashes: "matched",
    nativeEditorAssistantAndPreview: "passed", unpublishedFreshCopy: "passed",
    localMindAvatarRendered: "passed", exportIncludesAllWithoutCheckboxes: "passed",
    existingRecordsFingerprints: "unchanged", generatedRecordsAndFilesCleanup: "passed",
    inferenceOrPublishRequests: 0, scriptEvaluatedByPlaywright: false,
  }
}

async function characterStorageState(page, cleanup = [], expectedPrefix = "", sourceId = "") {
  return page.evaluate(async ({ cleanup, expectedPrefix, sourceId }) => {
    const api = await new Promise((resolve, reject) => {
      const id = `venice-sync-character-test-${crypto.randomUUID()}`, chunk = `venice-sync/${id}.js`
      const timer = setTimeout(() => reject(new Error("Native Character test bridge timed out.")), 5000)
      try {
        globalThis.TURBOPACK.push([chunk, id, (runtime) => {
          try { clearTimeout(timer); resolve({ db: runtime.r(342219).db, media: runtime.r(951225) }) } catch (error) { reject(error) }
        }])
        Promise.resolve(globalThis.TURBOPACK.push([chunk, { otherChunks: [], runtimeModuleIds: [id] }])).catch(reject)
      } catch (error) { clearTimeout(timer); reject(error) }
    })
    const { db, media } = api
    if (db.name !== "venice-db-encrypted" || db.verno !== 31) throw new Error("Unsupported Character test schema.")
    for (const id of cleanup) {
      if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error("Unsafe generated Character ID.")
      const character = await db.characters.get(id)
      if (!character || !expectedPrefix || !character.name.startsWith(expectedPrefix)) throw new Error("Refusing to delete an unverified Character fixture.")
      const chats = (await db.conversations.where("ownerId").equals(character.ownerId).toArray()).filter((chat) => chat.characterId === id)
      for (const chat of chats) {
        await db.transaction("rw", [db.conversations, db.messages, db.messageIds, db.messageImages], async () => {
          const messageIds = await db.messages.where("conversationId").equals(chat.id).primaryKeys()
          await db.messageImages.where("conversationId").equals(chat.id).delete()
          await db.messages.bulkDelete(messageIds)
          await db.messageIds.where("conversationId").equals(chat.id).delete()
          await db.conversations.delete(chat.id)
        })
      }
      await db.characters.delete(id)
      await media.n(character)
      const root = await navigator.storage.getDirectory()
      try {
        const directory = await (await root.getDirectoryHandle("media")).getDirectoryHandle(`character-photos-${character.ownerId}`)
        for await (const [name, entry] of directory.entries()) {
          if (entry.kind === "file" && name.startsWith(`${id}__`)) await directory.removeEntry(name)
        }
      } catch (error) { if (error.name !== "NotFoundError") throw error }
    }
    const rows = (await db.characters.toArray()).sort((a, b) => a.id.localeCompare(b.id))
    const digest = async (value) => {
      const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(value)))
      return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("")
    }
    let selected
    if (sourceId) {
      const source = await db.characters.get(sourceId)
      if (!source || source.ownerId !== window.Clerk?.user?.id) throw new Error("Selected Character is missing or not owned by the account.")
      const hydrated = await media.C(source)
      selected = { fingerprint: await digest(source), portraitFingerprint: await digest(hydrated.photo ?? null) }
    }
    return {
      characters: rows.length, fingerprint: await digest(rows),
      conversations: await db.conversations.count(), messages: await db.messages.count(),
      messageIds: await db.messageIds.count(), ...(selected ? { selected } : {}),
    }
  }, { cleanup, expectedPrefix, sourceId })
}

async function characterTransferTest(context, sourceId) {
  if (sourceId) assert.match(sourceId, /^[\w-]{1,100}$/)
  const page = await context.newPage()
  await page.goto("https://venice.ai/character-chat", { waitUntil: "domcontentloaded" })
  await waitForSignedInVenice(page)
  await page.bringToFront()
  const host = page.locator(`#${hostId}`)
  const dialog = host.getByRole("region", { name: "Venice Sync", exact: true })
  const openCharacters = async () => {
    await openSync(page)
    await navigatePanel(dialog, "Characters")
    await dialog.getByTestId("character-list").waitFor({ state: "visible", timeout: 45_000 })
  }
  await openCharacters()
  const baseline = await characterStorageState(page, [], "", sourceId ?? "")
  const readDownload = async (id) => {
    const [download] = await Promise.all([
      page.waitForEvent("download"),
      dialog.locator(`[data-character-id="${id}"]`).getByRole("button", { name: "Export Character JSON", exact: true }).click(),
    ]).catch(async (error) => {
      const alerts = await dialog.getByRole("alert").allTextContents()
      throw new Error(alerts.length ? `Character export failed: ${alerts.join("; ")}` : "Character download did not start.", { cause: error })
    })
    try {
      const stream = await download.createReadStream()
      assert.ok(stream)
      const chunks = []
      for await (const chunk of stream) chunks.push(chunk)
      return JSON.parse(Buffer.concat(chunks).toString("utf8"))
    } finally { await download.delete() }
  }
  const importFile = async (file, ids) => {
    const before = new Set(await dialog.locator("[data-character-id]").evaluateAll((rows) => rows.map((row) => row.getAttribute("data-character-id"))))
    const previousUrl = page.url()
    await dialog.getByLabel("Import Character JSON", { exact: true }).setInputFiles({
      name: "character-verification.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(file)),
    })
    await dialog.getByTestId("character-import-preview").waitFor({ state: "visible" })
    await Promise.all([
      page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 60_000 }),
      dialog.getByRole("button", { name: "Confirm import as new Character", exact: true }).click(),
    ])
    assert.equal(page.url(), previousUrl)
    await openCharacters()
    const values = await dialog.locator("[data-character-id]").evaluateAll((rows, name) => rows
      .filter((row) => row.querySelector("h3")?.textContent === name).map((row) => row.getAttribute("data-character-id")), file.character.name)
    const added = values.filter((id) => !before.has(id))
    assert.equal(added.length, 1)
    ids.push(added[0])
    assert.match(added[0], /^[a-f0-9-]{36}$/)
    if (file.character.photo) {
      const image = dialog.locator(`[data-character-id="${added[0]}"]`).getByRole("img", { name: `${file.character.name} portrait`, exact: true })
      await image.waitFor({ state: "visible" })
      assert.ok(await image.evaluate(async (element) => { await element.decode(); return element.naturalWidth > 0 }))
    }
    return added[0]
  }
  const normalize = (value) => {
    const skip = new Set(["id", "ownerId", "publicId", "sourceId", "remoteId", "photoMedia", "createdAtUnixTimestamp", "updatedAtUnixTimestamp", "lastUsed", "isImported", "isPublic", "isApiVisible"])
    const canonical = (entry) => Array.isArray(entry) ? entry.map(canonical) : entry && typeof entry === "object" ?
      Object.fromEntries(Object.entries(entry).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)])) : entry
    return canonical(Object.fromEntries(Object.entries(value).filter(([key]) => !skip.has(key))))
  }
  const fixture = JSON.parse(await readFile(path.join(root, "scripts/fixtures/character.json"), "utf8"))
  fixture.character.name = `Venice Sync Character E2E ${Date.now()}`
  const ids = [], requests = []
  page.on("request", (request) => {
    if (request.method() !== "GET" && /(?:\/(?:inference|publish|responses|completions)(?:\/|$)|mind.*(?:chat|stream|infer|publish))/i.test(new URL(request.url()).pathname)) requests.push(new URL(request.url()).pathname)
  })
  try {
    const first = await importFile(fixture, ids)
    const exported = await readDownload(first)
    assert.equal(exported.schemaVersion, "1")
    assert.deepEqual(normalize(exported.character), normalize(fixture.character))
    assert.equal(exported.character.ownerId, undefined)
    assert.equal(exported.character.photoMedia, undefined)
    await importFile(exported, ids)
    await dialog.screenshot({ path: path.join(root, "test-results/tampermonkey-characters.png") })
    await page.goto(`https://venice.ai/character-chat/${first}`, { waitUntil: "domcontentloaded" })
    await page.waitForFunction((name) => [...document.querySelectorAll("h1,h2,h3,p,div,span")].some((element) =>
      element.textContent === name && element.getClientRects().length > 0), fixture.character.name, { timeout: 45_000 })
    await page.reload({ waitUntil: "domcontentloaded" })
    await page.waitForFunction((name) => [...document.querySelectorAll("h1,h2,h3,p,div,span")].some((element) =>
      element.textContent === name && element.getClientRects().length > 0), fixture.character.name, { timeout: 45_000 })
  } finally {
    assert.deepEqual(await characterStorageState(page, ids, fixture.character.name, sourceId ?? ""), baseline, "Character fixture cleanup did not preserve existing data.")
    await page.goto("https://venice.ai/character-chat", { waitUntil: "domcontentloaded" })
  }
  let sourceResult
  if (sourceId) {
    await openCharacters()
    const original = await readDownload(sourceId)
    const prefix = `Venice Sync Character source-copy E2E ${Date.now()}`
    const copy = { ...original, character: { ...original.character, name: prefix } }
    const copies = []
    try {
      const id = await importFile(copy, copies)
      const restored = await readDownload(id)
      assert.deepEqual(normalize(restored.character), normalize(copy.character), "Character source copy changed portable data.")
      sourceResult = { definitionAndPortraitRoundTrip: "matched", originalRecordAndPortraitFingerprints: "unchanged", privateContentsRetainedByTest: false }
    } finally {
      assert.deepEqual(await characterStorageState(page, copies, prefix, sourceId), baseline, "User Character source or portrait was changed.")
    }
  }
  assert.equal(requests.length, 0)
  return {
    nativeJSONPreviewAndCopyImport: "passed", embeddedPortraitDecoded: "passed", contextAndSettingsRoundTrip: "matched",
    newPrivateLocalCopies: "passed", nativeCharacterVisibleAfterReload: "passed",
    generatedCharacterAndPhotoCleanup: "passed", existingCharacterFingerprints: "unchanged",
    inferenceOrPublishRequests: 0, ...(sourceResult ? { selectedSource: sourceResult } : {}),
    scriptEvaluatedByPlaywright: false,
  }
}

async function libraryTestState(page, assetIds = [], expectedPrefix = "") {
  return page.evaluate(async ({ assetIds, expectedPrefix }) => {
    const db = await new Promise((resolve, reject) => {
      const id = `venice-sync-library-test-${crypto.randomUUID()}`, chunk = `venice-sync/${id}.js`
      const timer = setTimeout(() => reject(new Error("Native Library test bridge timed out.")), 5000)
      try {
        globalThis.TURBOPACK.push([chunk, id, (runtime) => { try { clearTimeout(timer); resolve(runtime.r(342219).db) } catch (error) { reject(error) } }])
        Promise.resolve(globalThis.TURBOPACK.push([chunk, { otherChunks: [], runtimeModuleIds: [id] }])).catch(reject)
      } catch (error) { clearTimeout(timer); reject(error) }
    })
    if (db.name !== "venice-db-encrypted" || db.verno !== 31) throw new Error("Unsupported native Library test database.")
    const root = await navigator.storage.getDirectory()
    for (const id of assetIds) {
      if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error("Unsafe generated Library asset ID.")
      const message = await db.messages.get(id)
      if (!message || !expectedPrefix || !message.content.startsWith(expectedPrefix) || !message.veniceSyncLibrary) throw new Error("Refusing to delete an unverified Library test asset.")
      const conversationId = message.conversationId
      const conversation = await db.conversations.get(conversationId)
      if (!conversation || conversation.ownerId !== message.ownerId || !/^[a-f0-9-]{36}$/.test(conversationId)) throw new Error("Unexpected Library test ownership.")
      const children = await db.messages.where("conversationId").equals(conversationId).toArray()
      if (children.length !== 1 || children[0].id !== id) throw new Error("The generated Library container has unexpected additional messages.")
      await db.transaction("rw", [db.conversations, db.messages, db.messageIds], async () => {
        await db.messages.delete(id); await db.messageIds.delete(id); await db.conversations.delete(conversationId)
      })
      try { await (await root.getDirectoryHandle("media")).removeEntry(conversationId, { recursive: true }) } catch (error) { if (error.name !== "NotFoundError") throw error }
      try {
        const thumbnails = await root.getDirectoryHandle("thumbnails")
        for await (const [name, entry] of thumbnails.entries()) if (entry.kind === "file" && name.startsWith(`${conversationId}_`)) await thumbnails.removeEntry(name)
      } catch (error) { if (error.name !== "NotFoundError") throw error }
    }
    const state = {}
    for (const name of ["conversations", "messages", "messageIds", "messageImages", "studioImageTurnMedia", "studioAudioTurnMedia", "characters"]) {
      const records = (await db[name].toArray()).sort((a, b) => String(a.id).localeCompare(String(b.id)))
      const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(records)))
      state[name] = { count: records.length, fingerprint: [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("") }
    }
    return state
  }, { assetIds, expectedPrefix })
}

async function syntheticLibraryFiles(page, prefix) {
  const generated = await page.evaluate(async () => {
    const canvas = document.createElement("canvas")
    canvas.width = 32; canvas.height = 32
    const context = canvas.getContext("2d")
    if (!context) throw new Error("Canvas is unavailable.")
    context.fillStyle = "#3975d8"; context.fillRect(0, 0, 32, 32)
    const png = await new Promise((resolve, reject) => canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error("PNG creation failed.")), "image/png"))
    const mimeType = ["video/mp4", "video/webm"].find((type) => MediaRecorder.isTypeSupported(type))
    if (!mimeType) throw new Error("Chrome has no usable synthetic video recorder.")
    const stream = canvas.captureStream(10), chunks = []
    let recorder
    try {
      recorder = new MediaRecorder(stream, { mimeType })
      const result = new Promise((resolve, reject) => {
        recorder.ondataavailable = (event) => { if (event.data.size) chunks.push(event.data) }
        recorder.onerror = () => reject(new Error("Synthetic video recording failed."))
        recorder.onstop = async () => resolve([...new Uint8Array(await new Blob(chunks, { type: mimeType }).arrayBuffer())])
      })
      recorder.start()
      for (let frame = 0; frame < 8; frame++) {
        context.fillStyle = frame % 2 ? "#3975d8" : "#71a6fa"; context.fillRect(0, 0, 32, 32)
        await new Promise((resolve) => setTimeout(resolve, 100))
      }
      recorder.stop()
      return { png: [...new Uint8Array(await png.arrayBuffer())], video: await result, mimeType }
    } finally { if (recorder?.state === "recording") recorder.stop(); stream.getTracks().forEach((track) => track.stop()) }
  })
  const samples = 32000, wav = Buffer.alloc(44 + samples * 2)
  wav.write("RIFF", 0); wav.writeUInt32LE(wav.length - 8, 4); wav.write("WAVEfmt ", 8)
  wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22)
  wav.writeUInt32LE(8000, 24); wav.writeUInt32LE(16000, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34)
  wav.write("data", 36); wav.writeUInt32LE(samples * 2, 40)
  return [
    { name: `${prefix}-image.png`, mimeType: "image/png", buffer: Buffer.from(generated.png), kind: "image" },
    { name: `${prefix}-audio.wav`, mimeType: "audio/wav", buffer: wav, kind: "audio" },
    { name: `${prefix}-video.${generated.mimeType === "video/mp4" ? "mp4" : "webm"}`, mimeType: generated.mimeType, buffer: Buffer.from(generated.video), kind: "video" },
  ]
}

async function libraryTransferTest(context) {
  const page = await context.newPage()
  await page.goto("https://venice.ai/chat/agent", { waitUntil: "domcontentloaded" })
  await waitForSignedInVenice(page); await page.bringToFront()
  const host = page.locator(`#${hostId}`)
  const dialog = host.getByRole("region", { name: "Venice Sync", exact: true })
  const openLibrary = async () => {
    await openSync(page); await navigatePanel(dialog, "Library Assets")
    await dialog.getByTestId("library-asset-list").waitFor({ state: "visible", timeout: 45_000 })
    const errors = await dialog.getByRole("region", { name: "Library asset transfer" }).getByRole("alert").allTextContents()
    assert.equal(errors.length, 0, `Library UI errors: ${errors.join("; ")}`)
  }
  await openLibrary()
  const baseline = await libraryTestState(page), prefix = `Venice-Sync-Library-E2E-${Date.now()}`
  const fixtures = await syntheticLibraryFiles(page, prefix), ids = [], requests = []
  page.on("request", (request) => {
    if (request.method() !== "GET" && /(?:\/(?:inference|publish|responses|completions)(?:\/|$)|mind.*(?:chat|stream|infer|publish))/i.test(new URL(request.url()).pathname)) requests.push(new URL(request.url()).pathname)
  })
  const importFile = async (fixture) => {
    const previous = new Set(await dialog.locator("[data-library-asset-key]").evaluateAll((cards) => cards.map((card) => card.getAttribute("data-library-asset-key"))))
    const url = page.url()
    await dialog.getByLabel("Import Library asset", { exact: true }).setInputFiles(fixture)
    await dialog.getByTestId("library-import-preview").waitFor({ state: "visible", timeout: 30_000 })
    await Promise.all([
      page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 60_000 }),
      dialog.getByRole("button", { name: "Confirm import as new Library asset", exact: true }).click(),
    ])
    assert.equal(page.url(), url)
    await openLibrary()
    const added = (await dialog.locator("[data-library-asset-key]").evaluateAll((cards) => cards.map((card) => card.getAttribute("data-library-asset-key"))))
      .filter((key) => !previous.has(key) && key.startsWith("chat:"))
    assert.equal(added.length, 1)
    const id = added[0].slice("chat:".length); ids.push(id)
    return { id, key: added[0] }
  }
  try {
    for (const fixture of fixtures) {
      const imported = await importFile({ name: fixture.name, mimeType: fixture.mimeType, buffer: fixture.buffer })
      const [download] = await Promise.all([
        page.waitForEvent("download"),
        dialog.locator(`[data-library-asset-key="${imported.key}"]`).getByRole("button", { name: "Export Library asset ZIP", exact: true }).click(),
      ])
      let zip
      try {
        const stream = await download.createReadStream(), chunks = []
        assert.ok(stream)
        for await (const chunk of stream) chunks.push(chunk)
        zip = Buffer.concat(chunks)
      } finally { await download.delete() }
      const entries = unzipSync(zip), manifest = JSON.parse(strFromU8(entries["manifest.json"]))
      assert.equal(manifest.asset.filename, fixture.name); assert.equal(manifest.asset.kind, fixture.kind)
      assert.deepEqual(Buffer.from(entries["asset.bin"]), fixture.buffer)
      assert.equal(createHash("sha256").update(entries["asset.bin"]).digest("hex"), manifest.asset.sha256)
      await importFile({ name: `${prefix}-archive.zip`, mimeType: "application/zip", buffer: zip })
    }
    const mask = dialog.locator(`[data-library-asset-key]${ids.map((id) => `:not([data-library-asset-key="chat:${id}"])`).join("")}`)
    await dialog.screenshot({ path: path.join(root, "test-results/tampermonkey-library.png"), mask: [mask] })
    await page.goto("https://venice.ai/studio/library", { waitUntil: "domcontentloaded" })
    await waitForSignedInVenice(page)
    const image = page.getByRole("img", { name: fixtures[0].name, exact: true }).first()
    await image.waitFor({ state: "visible", timeout: 45_000 })
    await image.click()
    const nativeDialog = page.getByRole("dialog")
    const fullImage = nativeDialog.getByRole("img", { name: fixtures[0].name, exact: true })
    await fullImage.waitFor({ state: "visible" })
    await fullImage.evaluate((element) => element.decode())
    const imageBytes = await fullImage.evaluate(async (element) => [...new Uint8Array(await (await fetch(element.src)).arrayBuffer())])
    assert.deepEqual(Buffer.from(imageBytes), fixtures[0].buffer)
    await page.keyboard.press("Escape")
    await nativeDialog.waitFor({ state: "hidden" })
    await page.getByRole("img", { name: "Video thumbnail", exact: true }).first().locator("xpath=ancestor::*[@role='group'][1]").click()
    const video = nativeDialog.locator("video")
    await video.waitFor({ state: "visible" })
    await page.waitForFunction(() => [...document.querySelectorAll("video")].some((element) => element.readyState >= 2 && element.videoWidth > 0 && element.duration > 0))
    const videoBytes = await video.evaluate(async (element) => [...new Uint8Array(await (await fetch(element.currentSrc)).arrayBuffer())])
    assert.deepEqual(Buffer.from(videoBytes), fixtures[2].buffer)
    await page.keyboard.press("Escape")
    await nativeDialog.waitFor({ state: "hidden" })
    const [audioRequest] = await Promise.all([
      page.waitForEvent("request", { predicate: (request) => request.url().startsWith("blob:") && request.resourceType() === "media", timeout: 30_000 }),
      page.getByRole("img", { name: /Audio album cover|音频.*封面/i }).first().locator("xpath=ancestor::*[@role='group'][1]").click(),
    ])
    await nativeDialog.getByRole("button", { name: /Pause|暂停/i }).waitFor({ state: "visible" })
    await nativeDialog.getByText(fixtures[1].name, { exact: true }).waitFor({ state: "visible" })
    const audioBytes = await page.evaluate(async (url) => [...new Uint8Array(await (await fetch(url)).arrayBuffer())], audioRequest.url())
    assert.deepEqual(Buffer.from(audioBytes), fixtures[1].buffer)
    await page.keyboard.press("Escape")
    assert.equal(requests.length, 0)
  } finally {
    assert.deepEqual(await libraryTestState(page, ids, prefix), baseline, "Library test cleanup changed existing data.")
    await page.goto("https://venice.ai/chat/agent", { waitUntil: "domcontentloaded" })
  }
  return {
    imageAudioVideoImport: "passed", originalBytesAndHashesRoundTrip: "matched", archiveReimportCreatesNewCopies: "passed",
    nativeLibraryMediaVisible: "passed", sourceChatsAndProjectsNotRecreated: "passed",
    existingRecordsFingerprints: "unchanged", generatedContainersFilesAndCachesCleanup: "passed",
    inferenceOrPublishRequests: 0, scriptEvaluatedByPlaywright: false,
  }
}

async function studioTestState(page, prefix, cleanup = false, kind = "image") {
  return page.evaluate(async ({ prefix, cleanup, kind }) => {
    const db = await new Promise((resolve, reject) => {
      const id = `venice-sync-studio-test-${crypto.randomUUID()}`, chunk = `${id}.js`
      const timer = setTimeout(() => reject(new Error("Native Studio test bridge timed out.")), 5000)
      globalThis.TURBOPACK.push([chunk, id, runtime => {
        try { clearTimeout(timer); resolve(runtime.r(342219).db) } catch (error) { reject(error) }
      }])
      Promise.resolve(globalThis.TURBOPACK.push([chunk, { otherChunks: [], runtimeModuleIds: [id] }])).catch(reject)
    })
    if (db.name !== "venice-db-encrypted" || db.verno !== 31) throw new Error("Unsupported Studio test repository.")
    const tablePrefix = kind === "image" ? "studioImage" : "studioAudio"
    const names = [`${tablePrefix}Sessions`, `${tablePrefix}Turns`, `${tablePrefix}TurnMedia`]
    const [sessionTable, turnTable, mediaTable] = names.map(name => db[name])
    const owner = globalThis.Clerk?.user?.id
    const sessions = (await sessionTable.where("ownerId").equals(owner).toArray()).filter(row => row.name === prefix)
    if (cleanup) {
      if (!prefix.startsWith("Venice-Sync-Studio-E2E-")) throw new Error("Unsafe fixture cleanup prefix.")
      const root = await navigator.storage.getDirectory()
      for (const session of sessions) {
        if (!/^[a-f0-9-]{36}$/.test(session.id)) throw new Error("Unsafe fixture session ID.")
        const turns = await turnTable.where("sessionId").equals(session.id).toArray()
        const media = await mediaTable.where("sessionId").equals(session.id).toArray()
        if (turns.length !== 1 || media.length !== (kind === "image" ? 2 : 1) || [...turns, ...media].some(row => row.ownerId !== owner) ||
            turns[0].prompt !== prefix || media.some(row => !row.fileName.startsWith(`media/${session.id}/${row.id}.`))) {
          throw new Error("Fixture relationships changed; refusing cleanup.")
        }
        await db.transaction("rw", names.map(name => db[name]), async () => {
          for (const row of media) await mediaTable.delete(row.id)
          for (const row of turns) await turnTable.delete(row.id)
          await sessionTable.delete(session.id)
        })
        try { await (await root.getDirectoryHandle("media")).removeEntry(session.id, { recursive: true }) }
        catch (error) { if (error.name !== "NotFoundError") throw error }
        try {
          const thumbnails = await root.getDirectoryHandle("thumbnails")
          for await (const name of thumbnails.keys()) if (name.startsWith(`${session.id}_`)) await thumbnails.removeEntry(name)
        } catch (error) { if (error.name !== "NotFoundError") throw error }
      }
    }
    const fingerprint = {}
    for (const name of ["studioImageSessions", "studioImageTurns", "studioImageTurnMedia", "studioAudioSessions", "studioAudioTurns", "studioAudioTurnMedia"]) {
      const rows = (await db[name].toArray()).sort((a, b) => String(a.id).localeCompare(String(b.id)))
      const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(rows)))
      fingerprint[name] = { count: rows.length, sha256: [...new Uint8Array(digest)].map(n => n.toString(16).padStart(2, "0")).join("") }
    }
    return { fingerprint, ids: cleanup ? [] : sessions.map(row => row.id) }
  }, { prefix, cleanup, kind })
}

async function studioSessionTransferTest(context, kind = "image") {
  const page = await context.newPage()
  await page.goto("https://venice.ai/chat/agent", { waitUntil: "domcontentloaded" })
  await waitForSignedInVenice(page); await page.bringToFront()
  const prefix = `Venice-Sync-Studio-E2E-${kind}-${Date.now()}`, stateOf = (cleanup = false) => studioTestState(page, prefix, cleanup, kind)
  const before = await stateOf()
  const fixture = (await syntheticLibraryFiles(page, prefix))[kind === "image" ? 0 : 1]
  const sessionId = crypto.randomUUID(), turnId = crypto.randomUUID(), mediaIds = [crypto.randomUUID(), crypto.randomUUID()]
  const media = kind === "image" ? mediaIds.map((id, index) => ({
    id, sessionId, turnId, createdAtUnixTimestamp: 2, mimeType: "image/png", fileName: `media/${sessionId}/${id}.png`,
    mediaRole: index ? "output" : "input", ...(index ? { modelId: "venice-sync-test", modelName: "Synthetic test", prompt: prefix,
      source: "edit", imageSettings: { width: 32, height: 32, format: "png" } } : { inputIndex: 0 }),
  })) : [{
    id: mediaIds[1], sessionId, turnId, createdAtUnixTimestamp: 2, mimeType: "audio/wav", fileName: `media/${sessionId}/${mediaIds[1]}.wav`,
    modelId: "venice-sync-test", modelName: "Synthetic silent audio", prompt: prefix, effectivePrompt: prefix,
    lyricsPrompt: "", audioSettings: { musicSubcategory: "music", forceInstrumental: true, durationSeconds: 4 },
    coverAssetPath: "/images/VeniceKeys_circle_blue.svg", durationSeconds: 4,
  }]
  const manifest = {
    format: "venice-sync-studio-session", version: 1, kind, exportedAt: new Date().toISOString(),
    session: { id: sessionId, type: kind === "image" ? "edit" : "audio-generate", name: prefix,
      [kind === "image" ? "selectedImageId" : "selectedAudioId"]: mediaIds[1], createdAtUnixTimestamp: 1, updatedAtUnixTimestamp: 3 },
    turns: [{ id: turnId, sessionId, createdAtUnixTimestamp: 2, prompt: prefix, ...(kind === "image" ? { mode: "edit",
      input: { id: mediaIds[0], mimeType: "image/png", fileName: media[0].fileName } } :
      { effectivePrompt: prefix, lyricsPrompt: "", settings: { musicSubcategory: "music", forceInstrumental: true, durationSeconds: 4 } }) }],
    media, files: media.map(row => ({ id: row.id, path: row.fileName, mimeType: row.mimeType, size: fixture.buffer.length,
      sha256: createHash("sha256").update(fixture.buffer).digest("hex") })),
  }
  let zip = zipSync({ "manifest.json": strToU8(JSON.stringify(manifest)), ...Object.fromEntries(media.map(row => [row.fileName, fixture.buffer])) })
  const host = page.locator(`#${hostId}`)
  const dialog = host.getByRole("region", { name: "Venice Sync", exact: true }), requests = [], mediaRequests = [], pageErrors = []
  page.on("pageerror", error => pageErrors.push(error.message))
  page.on("request", request => {
    if (request.url().startsWith("blob:") && request.resourceType() === "media") mediaRequests.push(request.url())
    if (request.method() !== "GET" && /(?:\/(?:inference|publish|responses|completions)(?:\/|$)|mind.*(?:chat|stream|infer|publish))/i.test(new URL(request.url()).pathname)) requests.push(new URL(request.url()).pathname)
  })
  const open = async () => {
    await openSync(page); await navigatePanel(dialog, "Library Assets")
    await dialog.getByRole("button", { name: "Studio Sessions", exact: true }).click()
    await dialog.getByTestId("studio-session-list").waitFor({ state: "visible", timeout: 45_000 })
    assert.deepEqual(await dialog.getByRole("region", { name: "Studio session transfer" }).getByRole("alert").allTextContents(), [])
  }
  let activeSelection
  try {
    await open()
    await dialog.getByLabel("Import Studio session", { exact: true }).setInputFiles({ name: "session.zip", mimeType: "application/zip", buffer: Buffer.from(zip) })
    await dialog.getByTestId("studio-import-preview").waitFor()
    await dialog.getByRole("button", { name: "Cancel Studio import", exact: true }).click()
    assert.deepEqual((await stateOf()).fingerprint, before.fingerprint, "Preview/cancel modified storage.")
    for (let copy = 0; copy < 2; copy++) {
      await dialog.getByLabel("Import Studio session", { exact: true }).setInputFiles({ name: "session.zip", mimeType: "application/zip", buffer: Buffer.from(zip) })
      await dialog.getByTestId("studio-import-preview").waitFor()
      await Promise.all([
        page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 60_000 }),
        dialog.getByRole("button", { name: "Confirm import as new Studio session", exact: true }).click(),
      ])
      await waitForSignedInVenice(page); await open()
      const state = await stateOf()
      assert.equal(state.ids.length, copy + 1)
      const cards = dialog.locator("[data-studio-session-id]").filter({ hasText: prefix })
      const [download] = await Promise.all([page.waitForEvent("download"), cards.first().getByRole("button", { name: "Export Studio session ZIP", exact: true }).click()])
      try {
        const chunks = [], stream = await download.createReadStream()
        assert.ok(stream)
        for await (const chunk of stream) chunks.push(chunk)
        zip = Buffer.concat(chunks)
      } finally { await download.delete() }
      const entries = unzipSync(zip), output = JSON.parse(strFromU8(entries["manifest.json"]))
      assert.equal(output.turns[0].prompt, prefix)
      assert.equal(output.kind, kind)
      if (kind === "image") {
        assert.equal(output.session.selectedImageId, output.media.find(row => row.mediaRole === "output").id)
        assert.equal(output.turns[0].input.id, output.media.find(row => row.mediaRole === "input").id)
      } else {
        assert.equal(output.session.selectedAudioId, output.media[0].id)
        assert.deepEqual(output.turns[0].settings, manifest.turns[0].settings)
        assert.deepEqual(output.media[0].audioSettings, manifest.media[0].audioSettings)
      }
      assert.ok(!JSON.stringify(output).includes("ownerId"))
      assert.notEqual(output.session.id, sessionId)
      for (const file of output.files) {
        assert.deepEqual(Buffer.from(entries[file.path]), fixture.buffer)
        assert.equal(createHash("sha256").update(entries[file.path]).digest("hex"), file.sha256)
      }
    }
    const fixtureIds = (await stateOf()).ids
    activeSelection = await page.evaluate(({ id, type }) => {
      const owner = globalThis.Clerk?.user?.id
      if (!owner) throw new Error("Missing test account.")
      const key = `studio_active_session_${type}_${owner}`, previous = localStorage.getItem(key)
      localStorage.setItem(key, id)
      return { key, previous, id }
    }, { id: fixtureIds[0], type: kind === "image" ? "edit" : "audio-generate" })
    mediaRequests.length = 0
    await page.goto(`https://venice.ai/studio/${kind === "image" ? "edit" : "audio"}`, { waitUntil: "domcontentloaded" })
    await waitForSignedInVenice(page)
    if (kind === "image") {
      await page.waitForFunction(async expectedHash => {
        const images = [...document.querySelectorAll('img[src^="blob:"]')].filter(image => image.complete && image.naturalWidth === 32 && image.checkVisibility())
        for (const image of images) {
          const bytes = await (await fetch(image.src)).arrayBuffer()
          const digest = await crypto.subtle.digest("SHA-256", bytes)
          const hash = [...new Uint8Array(digest)].map(n => n.toString(16).padStart(2, "0")).join("")
          if (hash === expectedHash) return true
        }
        return false
      }, createHash("sha256").update(fixture.buffer).digest("hex"), { timeout: 30_000 })
    } else {
      await page.waitForFunction(() => [...document.querySelectorAll("audio")].some(audio => audio.currentSrc.startsWith("blob:")), undefined, { timeout: 15_000 }).catch(async error => {
        if (mediaRequests.length) return
        const play = page.getByRole("button", { name: /Play|播放/i }).first()
        if (!await play.count()) throw error
        await Promise.all([
          page.waitForEvent("request", { predicate: request => request.url().startsWith("blob:") && request.resourceType() === "media", timeout: 15_000 }),
          play.click(),
        ])
      })
      const url = mediaRequests.at(-1) ?? await page.locator("audio").first().evaluate(audio => audio.currentSrc)
      assert.ok(url?.startsWith("blob:"), "Native Studio has no playable original audio.")
      const audioBytes = await page.evaluate(async url => [...new Uint8Array(await (await fetch(url)).arrayBuffer())], url)
      assert.deepEqual(Buffer.from(audioBytes), fixture.buffer)
    }
    assert.equal(requests.length, 0)
  } catch (error) {
    await page.screenshot({ path: path.join(root, `test-results/studio-${kind}-failure.png`) })
    console.error("Native Studio test diagnostics:", JSON.stringify({
      kind, route: new URL(page.url()).pathname, pageErrors, mediaRequests: mediaRequests.length,
      selectionMatches: activeSelection ? await page.evaluate(({ key, id }) => localStorage.getItem(key) === id, activeSelection) : null,
    }))
    throw error
  } finally {
    if (activeSelection) await page.evaluate(({ key, previous, id }) => {
      if (localStorage.getItem(key) === id) {
        if (previous === null) localStorage.removeItem(key)
        else localStorage.setItem(key, previous)
      }
    }, activeSelection)
    await page.goto("https://venice.ai/chat/agent", { waitUntil: "domcontentloaded" })
    await waitForSignedInVenice(page)
    assert.deepEqual((await stateOf(true)).fingerprint, before.fingerprint, "Studio cleanup changed existing data.")
  }
  return { kind, sessionArchiveRoundTrip: "passed", originalBytesAndHashes: "matched", newSessionCopies: "passed",
    previewAndCancelReadOnly: "passed", nativeRecordsAndFilesCleanup: "passed", existingRecordsFingerprints: "unchanged",
    nativeEditorOriginalVisible: "passed", inferenceOrPublishRequests: 0, scriptEvaluatedByPlaywright: false }
}

async function batchExportTest(context) {
  const page = await context.newPage()
  await page.goto("https://venice.ai/chat/classic", { waitUntil: "domcontentloaded" })
  await waitForSignedInVenice(page); await page.bringToFront()
  const prefix = `Venice-Sync-Studio-E2E-Batch-${Date.now()}`, ids = []
  const baseline = await libraryTestState(page)
  const studioName = `${prefix}-studio`, studioBaseline = (await studioTestState(page, studioName)).fingerprint
  const host = page.locator(`#${hostId}`), dialog = host.getByRole("region", { name: "Venice Sync", exact: true })
  const fixture = JSON.parse(await readFile(path.join(root, "scripts/fixtures/classic-conversation.json"), "utf8"))
  fixture.conversation.name = `${prefix}-chat`
  const media = (await syntheticLibraryFiles(page, prefix))[0]
  const sessionId = crypto.randomUUID(), turnId = crypto.randomUUID(), inputId = crypto.randomUUID(), outputId = crypto.randomUUID()
  const studioMedia = [inputId, outputId].map((id, index) => ({
    id, sessionId, turnId, createdAtUnixTimestamp: 2, mimeType: "image/png", fileName: `media/${sessionId}/${id}.png`,
    mediaRole: index ? "output" : "input", ...(index ? { modelId: "venice-sync-test", prompt: studioName, source: "edit", imageSettings: { width: 32, height: 32 } } : {}),
  }))
  const studioManifest = {
    format: "venice-sync-studio-session", version: 1, kind: "image", exportedAt: new Date().toISOString(),
    session: { id: sessionId, type: "edit", name: studioName, selectedImageId: outputId, createdAtUnixTimestamp: 1, updatedAtUnixTimestamp: 3 },
    turns: [{ id: turnId, sessionId, createdAtUnixTimestamp: 2, prompt: studioName, mode: "edit", input: { id: inputId, mimeType: "image/png", fileName: studioMedia[0].fileName } }],
    media: studioMedia, files: studioMedia.map(row => ({ id: row.id, path: row.fileName, mimeType: row.mimeType, size: media.buffer.length, sha256: createHash("sha256").update(media.buffer).digest("hex") })),
  }
  const studioZip = Buffer.from(zipSync({ "manifest.json": strToU8(JSON.stringify(studioManifest)), ...Object.fromEntries(studioMedia.map(row => [row.fileName, media.buffer])) }))
  const download = async (action) => {
    const [file] = await Promise.all([page.waitForEvent("download"), action()])
    try {
      const chunks = [], stream = await file.createReadStream()
      assert.ok(stream)
      for await (const chunk of stream) chunks.push(chunk)
      return Buffer.concat(chunks)
    } finally { await file.delete() }
  }
  const requests = []
  page.on("request", request => {
    if (request.method() !== "GET" && /(?:\/(?:inference|publish|responses|completions)(?:\/|$)|mind.*(?:chat|stream|infer|publish))/i.test(new URL(request.url()).pathname)) requests.push(new URL(request.url()).pathname)
  })
  try {
    await openSync(page); await navigatePanel(dialog, "Details")
    assert.equal(await dialog.getByTestId("runtime-handler").innerText(), "Tampermonkey")
    assert.equal(await dialog.getByTestId("runtime-mode").innerText(), "userscript")
    assert.equal(await dialog.getByText(packageJson.version, { exact: true }).count(), 1)
    await openConversations(dialog)
    const first = await importWithNativeRefresh(page, dialog, JSON.stringify(fixture), ids)
    await navigatePanel(dialog, "Library Assets")
    await dialog.getByRole("button", { name: "Studio Sessions", exact: true }).click()
    await dialog.getByTestId("studio-session-list").waitFor()
    await dialog.getByLabel("Import Studio session", { exact: true }).setInputFiles({ name: "studio.zip", mimeType: "application/zip", buffer: studioZip })
    await dialog.getByTestId("studio-import-preview").waitFor()
    await Promise.all([
      page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 60000 }),
      dialog.getByRole("button", { name: "Confirm import as new Studio session", exact: true }).click(),
    ])
    await openSync(page); await navigatePanel(dialog, "Library Assets")
    await dialog.getByRole("button", { name: "Studio Sessions", exact: true }).click()
    await dialog.getByTestId("studio-session-list").waitFor()
    const card = dialog.locator("[data-studio-session-id]").filter({ hasText: studioName }).first()
    const before = await libraryTestState(page)
    const studioBefore = (await studioTestState(page, studioName)).fingerprint
    await card.getByRole("button", { name: `Add to export basket: ${studioName}`, exact: true }).click()
    await openConversations(dialog)
    await dialog.locator(`[data-conversation-id="${first.id}"]`).getByRole("button", { name: `Add to export basket: ${fixture.conversation.name}`, exact: true }).click()
    await dialog.evaluate(async element => { await Promise.all(element.getAnimations().map(animation => animation.finished)) })
    const contentBounds = await dialog.boundingBox()
    await dialog.getByRole("button", { name: "Export basket (2)", exact: true }).click()
    assert.deepEqual(await dialog.boundingBox(), contentBounds, "Opening the basket resized the native page.")
    const basket = dialog.getByRole("region", { name: "Content basket", exact: true })
    assert.equal(await dialog.getByRole("button", { name: "Back to content", exact: true }).evaluate(button => button.getRootNode().activeElement === button), true)
    await page.keyboard.press("Tab")
    assert.equal(await basket.evaluate(element => element.contains(element.getRootNode().activeElement)), true)
    await page.keyboard.press("Escape")
    assert.equal(await dialog.isVisible(), true)
    assert.equal(await dialog.getByRole("button", { name: "Export basket (2)", exact: true }).evaluate(button => button.getRootNode().activeElement === button), true)
    await dialog.getByRole("button", { name: "Export basket (2)", exact: true }).click()
    const zip = await download(() => dialog.getByRole("button", { name: "Download export basket", exact: true }).click())
    const entries = unzipSync(zip), manifest = JSON.parse(strFromU8(entries["manifest.json"]))
    assert.equal(manifest.format, "venice-sync-batch"); assert.equal(manifest.version, 1)
    assert.equal(manifest.items.length, 2)
    assert.ok(Object.keys(entries).every(name => name === "manifest.json" || /^objects\/[a-f0-9]{64}$/.test(name)))
    for (const item of manifest.items) for (const file of item.files) {
      assert.equal(entries[`objects/${file.object}`].length, file.bytes)
      assert.equal(createHash("sha256").update(entries[`objects/${file.object}`]).digest("hex"), file.object)
    }
    const mediaRefs = manifest.items.find(item => item.kind === "studio-image").files.filter(file => file.path.startsWith("media/"))
    assert.equal(mediaRefs.length, 2)
    assert.equal(mediaRefs[0].object, mediaRefs[1].object, "Identical originals were not deduplicated.")
    await dialog.getByRole("button", { name: "Import from backup", exact: true }).click()
    await dialog.getByLabel("Open batch ZIP", { exact: true }).setInputFiles({ name: "batch.zip", mimeType: "application/zip", buffer: zip })
    await dialog.getByRole("region", { name: "Opened batch contents", exact: true }).waitFor()
    await dialog.getByText("Take out original files", { exact: true }).click()
    const restoredJson = await download(() => dialog.getByRole("button", { name: `Take out item: ${fixture.conversation.name}`, exact: true }).click())
    const restored = JSON.parse(restoredJson.toString("utf8"))
    assert.equal(restored.conversation.id, first.id)
    assert.deepEqual(restored.messages.map(message => message.content), fixture.messages.map(message => message.content))
    const restoredZip = await download(() => dialog.getByRole("button", { name: `Take out item: ${studioName}`, exact: true }).click())
    const studio = unzipSync(restoredZip), restoredStudio = JSON.parse(strFromU8(studio["manifest.json"]))
    assert.equal(restoredStudio.format, "venice-sync-studio-session")
    for (const file of restoredStudio.files) assert.deepEqual(Buffer.from(studio[file.path]), media.buffer)
    assert.deepEqual(await libraryTestState(page), before, "Batch preparation/open/extraction changed native storage.")
    assert.deepEqual((await studioTestState(page, studioName)).fingerprint, studioBefore)
    await dialog.getByRole("button", { name: "Back to content", exact: true }).click()
    await dialog.getByLabel("Import conversation JSON", { exact: true }).setInputFiles({ name: "restored.json", mimeType: "application/json", buffer: restoredJson })
    await dialog.getByTestId("import-preview").waitFor()
    await dialog.getByRole("button", { name: "Cancel import", exact: true }).click()
    await navigatePanel(dialog, "Library Assets")
    await dialog.getByLabel("Import Studio session", { exact: true }).setInputFiles({ name: "restored.zip", mimeType: "application/zip", buffer: restoredZip })
    await dialog.getByTestId("studio-import-preview").waitFor()
    await dialog.getByRole("button", { name: "Cancel Studio import", exact: true }).click()
    assert.deepEqual(await libraryTestState(page), before, "Standalone extracted-file previews changed storage.")
    await dialog.getByRole("button", { name: "Export basket (2)", exact: true }).click()
    const imports = dialog.getByRole("region", { name: "Selected batch import", exact: true })
    await imports.getByRole("button", { name: "Select all unattempted items", exact: true }).click()
    await imports.getByRole("button", { name: "Review 2 selected imports", exact: true }).click()
    await imports.getByTestId("batch-import-preview").waitFor()
    assert.deepEqual(await libraryTestState(page), before, "Batch import review changed storage.")
    const originBeforeImport = await page.evaluate(() => performance.timeOrigin)
    await imports.getByRole("button", { name: "Confirm selected batch import", exact: true }).click()
    await dialog.getByRole("button", { name: "Back to content", exact: true }).click()
    await page.waitForFunction(hostId => {
      const panel = document.getElementById(hostId)?.shadowRoot?.querySelector('[aria-label="Selected batch import"]')
      return panel?.querySelectorAll('[data-batch-result-status="success"]').length === 2 &&
        ![...panel.querySelectorAll("button")].some(button => button.textContent === "Stop after current item")
    }, hostId, { timeout: 60000 })
    await dialog.getByRole("button", { name: "Export basket (2)", exact: true }).click()
    const results = await imports.locator("[data-batch-result-key]").evaluateAll(nodes => nodes.map(node => ({
      kind: JSON.parse(node.getAttribute("data-batch-result-key"))[0], id: node.getAttribute("data-batch-new-id"),
    })))
    assert.equal(await page.evaluate(() => performance.timeOrigin), originBeforeImport, "Batch reloaded before results could be reviewed.")
    assert.equal(results.length, 2)
    const newClassic = results.find(result => result.kind === "classic")
    assert.ok(newClassic?.id && !ids.includes(newClassic.id)); ids.push(newClassic.id)
    assert.equal((await studioTestState(page, studioName)).ids.length, 2)
    assert.ok(await imports.getByRole("button", { name: "Refresh Venice after reviewing results", exact: true }).isEnabled())
    const original = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }))
    for (const width of [320, 390]) {
      await page.setViewportSize({ width, height: 844 })
      await dialog.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
      await dialog.evaluate(async element => { await Promise.all(element.getAnimations().map(animation => animation.finished)) })
      const basket = dialog.getByRole("region", { name: "Content basket", exact: true })
      await basket.screenshot({ path: path.join(root, `test-results/batch-basket-mobile-${width}.png`) })
      const layout = await basket.evaluate(element => ({
        overflow: element.scrollWidth > element.clientWidth || element.lastElementChild.scrollWidth > element.lastElementChild.clientWidth,
        overflowing: [...element.querySelectorAll("*")].filter(node => node.clientWidth && node.scrollWidth > node.clientWidth)
          .slice(0, 6).map(node => ({ tag: node.tagName, class: node.className, width: node.clientWidth, scroll: node.scrollWidth })),
      }))
      assert.equal(layout.overflow, false, `Basket overflows at ${width}px: ${JSON.stringify(layout.overflowing)}`)
    }
    await page.setViewportSize(original)
    assert.equal(requests.length, 0)
    return { mixedConversationAndStudioBasket: "passed", independentObjectsAndHashes: "matched", identicalOriginalsDeduplicated: "passed",
      reconstructedJsonAndStudioZip: "passed", existingImportPreviews: "passed", exportAndExtractionReadOnly: "passed",
      selectedBatchImportCreatesNewCopies: "passed", noIntermediateReload: "passed",
      contentNotResized: "passed", basketKeyboardFocusAndEscape: "passed",
      collapsedImportRetainsResults: "passed", mobile320px: "passed", mobile390px: "passed", inferenceOrPublishRequests: 0, scriptEvaluatedByPlaywright: false }
  } catch (error) {
    console.error("Batch E2E failed before cleanup:", error)
    throw error
  } finally {
    assert.deepEqual((await studioTestState(page, studioName, true)).fingerprint, studioBaseline)
    await cleanupSyntheticChats(page, ids)
    assert.deepEqual(await libraryTestState(page), baseline, "Batch fixture cleanup changed existing data.")
    await page.close()
  }
}

async function batchImportControlsTest(context) {
  const page = await context.newPage()
  await page.goto("https://venice.ai/chat/classic", { waitUntil: "domcontentloaded" })
  await waitForSignedInVenice(page); await page.bringToFront()
  const prefix = `Venice-Sync-Controls-${crypto.randomUUID()}`
  const probeName = `veniceSyncProbe${crypto.randomUUID().replaceAll("-", "")}`
  const baseline = await libraryTestState(page)
  const fixture = JSON.parse(await readFile(path.join(root, "scripts/fixtures/classic-conversation.json"), "utf8"))
  const total = 40, expected = {}, objects = {}, items = []
  for (let index = 0; index < total; index++) {
    const file = structuredClone(fixture), name = `${prefix}-${index}`
    file.conversation.name = name
    for (const [position, message] of file.messages.entries()) message.content = `${name} / message ${position}`
    expected[name] = file.messages.map(message => `${message.role}:${message.content}`).sort()
    const bytes = strToU8(JSON.stringify(file)), hash = createHash("sha256").update(bytes).digest("hex")
    objects[`objects/${hash}`] = bytes
    items.push({ kind: "classic", id: crypto.randomUUID(), title: name, filename: `fixture-${index}.json`, packaging: "json",
      files: [{ path: "export.json", object: hash, bytes: bytes.length }] })
  }
  const archive = Buffer.from(zipSync({ "manifest.json": strToU8(JSON.stringify({
    format: "venice-sync-batch", version: 1, exportedAt: new Date().toISOString(), items,
  })), ...objects }))
  const resultsDirectory = path.join(root, "test-results")
  await mkdir(resultsDirectory, { recursive: true })
  const journal = path.join(resultsDirectory, `${prefix}-committed-ids.jsonl`), committed = new Map()
  await writeFile(journal, "")
  const dialog = page.locator(`#${hostId}`).getByRole("region", { name: "Venice Sync", exact: true })
  const imports = dialog.getByRole("region", { name: "Selected batch import", exact: true })
  let observing = false, observationError, observer, writeRequested = false, captureTask = Promise.resolve()
  const capture = () => captureTask = captureTask.then(async () => {
    const rows = await page.evaluate(name => globalThis[name].scan(), probeName)
    for (const row of rows) if (!committed.has(row.id)) {
      await appendFile(journal, `${JSON.stringify({ ...row, observedAt: new Date().toISOString() })}\n`)
      committed.set(row.id, row)
    }
    return rows
  })
  try {
    await page.evaluate(async ({ prefix, expected, probeName }) => {
      const db = await new Promise((resolve, reject) => {
        const id = `venice-sync-controls-${crypto.randomUUID()}`, chunk = `venice-sync/${id}.js`
        const timer = setTimeout(() => reject(new Error("Native Classic control probe timed out.")), 5000)
        try {
          globalThis.TURBOPACK.push([chunk, id, runtime => { try { clearTimeout(timer); resolve(runtime.r(342219).db) } catch (error) { reject(error) } }])
          Promise.resolve(globalThis.TURBOPACK.push([chunk, { otherChunks: [], runtimeModuleIds: [id] }])).catch(reject)
        } catch (error) { clearTimeout(timer); reject(error) }
      })
      if (db.name !== "venice-db-encrypted" || db.verno !== 31) throw new Error("Unsupported native Classic control database.")
      const initial = await db.conversations.toArray(), originalIds = new Set(initial.map(row => row.id))
      if (initial.some(row => row.name?.startsWith(prefix))) throw new Error("Fixture namespace already exists.")
      const owner = globalThis.Clerk.user.id
      globalThis[probeName] = { scan: async () => {
        const rows = (await db.conversations.toArray()).filter(row => row.name?.startsWith(prefix))
        for (const row of rows) {
          if (originalIds.has(row.id) || !/^[a-f0-9-]{36}$/.test(row.id) || row.ownerId !== owner || !expected[row.name]) throw new Error("Unverified control fixture identity.")
          const messages = await db.messages.where("conversationId").equals(row.id).toArray()
          const contents = messages.map(message => `${message.role}:${message.content}`).sort()
          if (JSON.stringify(contents) !== JSON.stringify(expected[row.name]) ||
            await db.messageIds.where("conversationId").equals(row.id).count() !== messages.length) throw new Error("Unverified control fixture contents.")
        }
        return rows.map(row => ({ id: row.id, name: row.name }))
      } }
    }, { prefix, expected, probeName })
    await capture()
    observing = true
    observer = (async () => {
      while (observing) { await capture(); await new Promise(resolve => setTimeout(resolve, 25)) }
    })().catch(error => { observationError = error; observing = false; console.error("Committed-ID observation failed:", error) })
    await openSync(page); await navigatePanel(dialog, "Details")
    assert.equal(await dialog.getByTestId("runtime-handler").innerText(), "Tampermonkey")
    assert.equal(await dialog.getByTestId("runtime-mode").innerText(), "userscript")
    assert.equal(await dialog.getByText(packageJson.version, { exact: true }).count(), 1)
    await dialog.getByRole("button", { name: "Export basket (0)", exact: true }).click()
    await dialog.getByRole("button", { name: "Import from backup", exact: true }).click()
    await dialog.getByLabel("Open batch ZIP", { exact: true }).setInputFiles({ name: "controls.zip", mimeType: "application/zip", buffer: archive })
    await imports.getByRole("button", { name: "Select all unattempted items", exact: true }).click()
    await imports.getByRole("button", { name: `Review ${total} selected imports`, exact: true }).click()
    await imports.getByTestId("batch-import-preview").waitFor()
    assert.deepEqual(await libraryTestState(page), baseline, "Control selection/review wrote native data.")
    if (observationError) throw observationError
    const originBefore = await page.evaluate(() => performance.timeOrigin)
    preserveFixturePage = true; writeRequested = true
    await imports.getByRole("button", { name: "Confirm selected batch import", exact: true }).click()
    await imports.getByRole("button", { name: "Stop after current item", exact: true }).waitFor({ state: "visible", timeout: 5000 })
    assert.equal(await dialog.getAttribute("aria-busy"), "true")
    await page.keyboard.press("Escape")
    assert.equal(await dialog.getByRole("region", { name: "Content basket", exact: true }).count(), 0)
    await page.keyboard.press("Escape"); await page.mouse.click(1, 1)
    assert.equal(await dialog.isVisible(), true, "A running import was dismissed.")
    assert.equal(await dialog.getAttribute("aria-busy"), "true")
    await dialog.getByRole("button", { name: "Export basket (0)", exact: true }).click()
    await imports.getByRole("button", { name: "Stop after current item", exact: true }).click()
    await page.waitForFunction(id => ![...document.getElementById(id).shadowRoot.querySelectorAll("button")]
      .some(button => button.textContent === "Stop after current item"), hostId, { timeout: 60000 })
    await capture()
    const results = await imports.locator("[data-batch-result-key]").evaluateAll(nodes => nodes.map(node => ({
      id: node.getAttribute("data-batch-new-id"), status: node.getAttribute("data-batch-result-status"),
    })))
    assert.ok(results.length > 0 && results.length < total, `Cancellation must leave later items unattempted; got ${results.length}/${total}.`)
    assert.ok(results.every(result => result.status === "success" && committed.has(result.id)), "A completed native copy was not independently recorded.")
    assert.equal(committed.size, results.length)
    assert.equal(await imports.locator('input[type="checkbox"]:disabled').count(), results.length)
    assert.equal(await page.evaluate(() => performance.timeOrigin), originBefore)
    assert.equal(await dialog.getAttribute("aria-busy"), "false")
    await dialog.getByRole("button", { name: "Back to content", exact: true }).click()
    await dialog.getByRole("button", { name: "Export basket (0)", exact: true }).click()
    assert.equal(await imports.locator("[data-batch-result-key]").count(), results.length)
    return { runtime: "Tampermonkey", attempted: results.length, unattempted: total - results.length,
      escapeAndOutsideCloseLockedDuringWrites: "passed", stopOnlyPreventsLaterItems: "passed",
      committedIdsRecordedIndependently: "passed", attemptedRowsDisabled: "passed",
      resultsSurviveCollapse: "passed", noIntermediateReload: "passed", journal: path.relative(root, journal),
      scriptEvaluatedByPlaywright: false }
  } finally {
    if (writeRequested) {
      const stop = imports.locator("button").filter({ hasText: /^Stop after current item$/ })
      if (await stop.count()) {
        const trigger = dialog.getByRole("button", { name: "Export basket (0)", exact: true })
        if (await trigger.getAttribute("aria-expanded") !== "true") await trigger.click()
        await stop.click()
        await page.waitForFunction(id => ![...document.getElementById(id).shadowRoot.querySelectorAll("button")]
          .some(button => button.textContent === "Stop after current item"), hostId, { timeout: 60000 })
      }
    }
    observing = false
    await observer
    if (await page.evaluate(name => !!globalThis[name], probeName)) {
      const verified = await capture()
      assert.deepEqual(verified.map(row => row.id).sort(), [...committed.keys()].sort())
      await cleanupSyntheticChats(page, verified.map(row => row.id))
    }
    assert.deepEqual(await libraryTestState(page), baseline, "Control fixture cleanup changed pre-existing data.")
    preserveFixturePage = false
    await page.close()
  }
}

async function nativePageTest(context) {
  const page = await context.newPage(), cdp = await context.newCDPSession(page), scripts = []
  const artifact = await readFile(path.join(root, "dist/venice-sync.user.js")), body = artifact.toString("utf8").split("// ==/UserScript==")[1].trim()
  cdp.on("Debugger.scriptParsed", event => { if (event.length >= body.length || /userscript/i.test(event.url)) scripts.push(event) })
  await cdp.send("Debugger.enable")
  try {
    await page.goto("https://venice.ai/studio/library", { waitUntil: "domcontentloaded" })
    await waitForSignedInVenice(page); await page.bringToFront()
    await page.locator(`#${hostId}`).waitFor({ state: "attached", timeout: 45000 })
    let matched = false
    for (const script of scripts) {
      const { scriptSource } = await cdp.send("Debugger.getScriptSource", { scriptId: script.scriptId })
      if (scriptSource.includes(body)) { matched = true; break }
    }
    assert.equal(matched, true, "The executed Tampermonkey body must match this build.")
    await cdp.detach()
    const workspace = page.locator(`#${hostId}`).getByRole("region", { name: "Venice Sync", exact: true })
    const matrix = []
    for (const width of [1280, 390, 320]) {
      await page.setViewportSize({ width, height: 844 })
      await sidebarLauncher(page)
      const url = page.url(), history = await page.evaluate(() => window.history.length)
      await openSync(page)
      await page.waitForFunction(id => {
        const host = document.getElementById(id), region = host?.shadowRoot?.querySelector('[data-testid="sync-workspace"]')
        if (!host || !region || host.parentElement === document.body) return false
        const box = region.getBoundingClientRect(), parent = host.parentElement, parentBox = parent.getBoundingClientRect()
        return Math.abs(box.left - parentBox.left - parent.clientLeft) < 1 && Math.abs(box.width - parent.clientWidth) < 1
      }, hostId)
      const originalChildren = await workspace.evaluateHandle(element => [...element.getRootNode().host.parentElement.children].filter(child => child.id !== "venice-sync-userscript-host"))
      const geometry = await workspace.evaluate(element => {
        const box = element.getBoundingClientRect(), frame = element.getRootNode().host.parentElement, frameBox = frame.getBoundingClientRect()
        return { x: box.x, y: box.y, width: box.width, height: box.height,
          fillsFrame: Math.abs(box.x - frameBox.x - frame.clientLeft) < 1 && Math.abs(box.y - frameBox.y - frame.clientTop) < 1 && Math.abs(box.width - frame.clientWidth) < 1 && Math.abs(box.height - frame.clientHeight) < 1,
          overflow: element.scrollWidth > element.clientWidth }
      })
      assert.equal(geometry.fillsFrame, true); assert.equal(geometry.overflow, false)
      assert.equal(page.url(), url); assert.equal(await page.evaluate(() => window.history.length), history)
      assert.equal(await page.locator(`#${hostId}`).getByTestId("sync-backdrop").count(), 0)
      assert.equal(await workspace.getByRole("dialog").count(), 0)
      await navigatePanel(workspace, "Overview")
      await workspace.screenshot({ path: path.join(root, `test-results/native-page-${width}.png`) })
      if (width === 1280) {
        assert.ok(geometry.x > 0, "Desktop Venice navigation must remain outside Sync.")
        await navigatePanel(workspace, "Details")
        assert.equal(await workspace.getByTestId("runtime-handler").innerText(), "Tampermonkey")
        assert.equal(await workspace.getByText(packageJson.version, { exact: true }).count(), 1)
        await openConversations(workspace)
        const fixture = await readFile(path.join(root, "scripts/fixtures/classic-conversation.json"))
        await workspace.getByLabel("Import conversation JSON", { exact: true }).setInputFiles({ name: "readonly-preview.json", mimeType: "application/json", buffer: fixture })
        await workspace.getByTestId("import-preview").waitFor({ state: "visible" })
        await returnToVenice(page, workspace)
        await openSync(page)
        assert.equal(await workspace.getByTestId("import-preview").isVisible(), true, "Returning must retain the read-only preview.")
      } else {
        assert.ok(geometry.x >= 0 && geometry.x + geometry.width <= width + 1)
        await workspace.getByRole("button", { name: "Open Venice navigation", exact: true }).click()
        const drawer = page.locator('[role="dialog"][aria-modal="true"]').filter({ visible: true })
        await drawer.waitFor({ state: "visible" })
        await page.locator(`#${launcherId}`).getByRole("button", { name: "Venice Sync", exact: true }).waitFor({ state: "visible", timeout: 15000 })
        await page.getByRole("button", { name: /^(?:Toggle sidebar|切换侧边栏)$/i }).filter({ visible: true }).first().click()
        await drawer.waitFor({ state: "hidden" }); await workspace.waitFor({ state: "visible" })
      }
      await workspace.getByRole("button", { name: "Export basket (0)", exact: true }).click()
      const basket = workspace.getByRole("region", { name: "Content basket", exact: true })
      await basket.waitFor({ state: "visible" })
      assert.equal(await workspace.getByRole("dialog").count(), 0)
      assert.equal(await workspace.getByTestId("batch-basket-overlay").count(), 0)
      if (width !== 1280) {
        assert.equal(await basket.getByRole("button", { name: "Open Venice navigation", exact: true }).isEnabled(), true)
      }
      await page.keyboard.press("Escape")
      await workspace.getByRole("button", { name: "Back to Venice", exact: true }).waitFor({ state: "visible" })
      await returnToVenice(page, workspace)
      assert.equal(await originalChildren.evaluate(children => children.length > 0 && children.every(child => child.isConnected)), true, "Native content was unmounted.")
      await originalChildren.dispose()
      assert.equal(page.url(), url); assert.equal(await page.evaluate(() => window.history.length), history)
      matrix.push({ viewport: width, ...geometry, mobileNavigation: width === 1280 ? "desktop sidebar preserved" : "native Drawer opened and closed", originalDOMRetained: true })
    }
    await page.setViewportSize({ width: 1280, height: 844 })
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
    await openSync(page)
    await page.locator('a[href="/minds"]').filter({ visible: true }).first().click()
    await page.waitForURL(url => url.pathname === "/minds")
    await workspace.waitFor({ state: "hidden" })
    return { executedTampermonkeyBodyMatched: true, noSyntheticRouteOrHistory: "passed", noDialogOrBackdrop: "passed",
      nativeNavigationReturnsToVenice: "passed", previewSurvivesReturn: "passed", matrix,
      businessDataImports: 0, businessDataCleanup: 0, scriptEvaluatedByPlaywright: false }
  } finally { await page.close() }
}

async function sidebarLauncherTest(context) {
  const page = await context.newPage()
  await page.goto("https://venice.ai/chat/agent", { waitUntil: "domcontentloaded" })
  await waitForSignedInVenice(page)
  await page.bringToFront()
  const originalSize = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }))
  const body = page.locator(`#${hostId}`), dialog = body.getByRole("region", { name: "Venice Sync", exact: true })
  const launcher = page.locator(`#${launcherId}`).getByRole("button", { name: "Venice Sync", exact: true })
  const nativeToggle = () => page.getByRole("button", { name: /^(?:Toggle sidebar|切换侧边栏)$/i }).filter({ visible: true }).first()
  const fits = async () => {
    await page.waitForFunction(id => {
      const host = document.getElementById(id)
      if (!host) return false
      const toggle = host.nextElementSibling, logo = host.previousElementSibling
      if (!toggle || !logo) return false
      const h = host.getBoundingClientRect(), l = logo.getBoundingClientRect(), t = toggle.getBoundingClientRect()
      return h.width === 44 && h.height === 44 && h.left >= l.right + 7 && h.right <= t.left && h.top >= 0
    }, launcherId)
    assert.equal(await page.locator(`#${launcherId}`).count(), 1)
    assert.equal(await body.getByRole("button", { name: "Venice Sync", exact: true }).count(), 0, "A floating body launcher remains.")
  }
  try {
    await sidebarLauncher(page); await fits()
    await page.locator(`#${launcherId}`).screenshot({ path: path.join(root, "test-results/sidebar-launcher-desktop.png") })
    await launcher.click(); await dialog.waitFor({ state: "visible" })
    assert.equal(await launcher.getAttribute("aria-expanded"), "true")
    await launcher.click(); await dialog.waitFor({ state: "hidden" })
    assert.equal(await launcher.getAttribute("aria-expanded"), "false")
    await launcher.focus(); await page.keyboard.press("Enter")
    await dialog.waitFor({ state: "visible" })
    await page.keyboard.press("Escape"); await dialog.waitFor({ state: "hidden" })
    assert.equal(await launcher.evaluate(button => button.getRootNode().activeElement === button), true)
    await nativeToggle().click()
    await page.waitForFunction(id => !document.getElementById(id), launcherId)
    await sidebarLauncher(page); await fits()
    await page.locator('a[href="/minds"]').filter({ visible: true }).first().click()
    await page.waitForURL(url => url.pathname === "/minds")
    await sidebarLauncher(page); await fits()
    await openSync(page)
    await page.keyboard.press("Escape"); await dialog.waitFor({ state: "hidden" })
    await page.goto("https://venice.ai/chat/agent", { waitUntil: "domcontentloaded" })
    await waitForSignedInVenice(page)
    for (const width of [390, 320]) {
      await page.setViewportSize({ width, height: 844 })
      const show = page.getByRole("button", { name: "Show Sidebar", exact: true })
      await show.waitFor({ state: "visible" })
      await page.waitForFunction(id => !document.getElementById(id), launcherId)
      for (let attempt = 0; attempt < 2; attempt++) {
        await show.click(); await launcher.waitFor({ state: "visible" }); await fits()
        const sidebar = page.locator('[role="dialog"][aria-modal="true"]').filter({ has: page.locator(`#${launcherId}`) })
        assert.equal(await sidebar.count(), 1)
        const header = page.locator(`#${launcherId}`).locator("..")
        await header.screenshot({ path: path.join(root, `test-results/sidebar-launcher-${width}.png`) })
        await launcher.click()
        await dialog.waitFor({ state: "visible" })
        assert.equal(await page.locator('[role="dialog"][aria-modal="true"]').filter({ visible: true }).count(), 0, "Native Drawer remains open beneath Sync.")
        assert.notEqual(await body.getAttribute("aria-hidden"), "true")
        const bounds = await dialog.boundingBox()
        assert.ok(bounds && bounds.x >= 0 && bounds.y >= 0 && bounds.x + bounds.width <= width + 1 && bounds.y + bounds.height <= 845)
        await dialog.getByRole("button", { name: "Details", exact: true }).click()
        assert.equal(await dialog.getByTestId("runtime-handler").innerText(), "Tampermonkey")
        if (attempt === 0) await returnToVenice(page, dialog)
        else await page.keyboard.press("Escape")
        await dialog.waitFor({ state: "hidden" })
        await page.waitForFunction(() => document.activeElement?.getAttribute("aria-label") === "Show Sidebar")
        assert.equal(await launcher.count(), 0, "A launcher remains over the mobile composer after closing.")
      }
    }
    return { logoAdjacent44pxTarget: "passed", noFloatingLauncher: "passed", desktopCollapseAndFocus: "passed",
      nativeSpaNavigation: "passed", mobile320And390px: "passed", nativeDrawerClosesBeforeSync: "passed",
      mobileFocusReturnsToSidebarOpener: "passed", repeatedOpenCloseNoDuplicate: "passed", scriptEvaluatedByPlaywright: false }
  } finally {
    await page.keyboard.press("Escape")
    await page.setViewportSize(originalSize)
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
    try { await ensureNativeSidebar(page) }
    finally { await page.close() }
  }
}

async function main() {
  if (nativePage && (transfer || mindTransfer || agenticTransfer || charactersTransfer || libraryTransfer || studioTransfer || mindPackage || batchTransfer || batchControls)) {
    throw new Error("--native-page is UI-only; do not combine it with transfer/import flags.")
  }
  if (selectedConversation && !transfer) throw new Error("--conversation requires the explicit --transfer opt-in.")
  if (selectedAgentic && !agenticTransfer) throw new Error("--agentic-conversation requires --agentic-transfer.")
  if (selectedCharacter && !charactersTransfer) throw new Error("--character requires --characters.")
  console.log("Connecting to real Chrome. Approve its debugging prompt if shown.")
  const browser = await chromium.connectOverCDP(await endpoint(), {
    timeout: 120_000,
  })
  const context = browser.contexts()[0]
  const previousPages = new Set(context?.pages() ?? [])
  try {
    assert.ok(context, "Chrome has no accessible context.")
    const worker = context.serviceWorkers().find((candidate) =>
      candidate.url().startsWith(`${extensionOrigin}/`),
    )
    if (worker) {
      const canRunUserScripts = await worker.evaluate(
        () => typeof globalThis.chrome.userScripts?.getScripts === "function",
      )
      if (!canRunUserScripts) {
        throw new Error(
          "Chrome blocks Tampermonkey execution. Enable 'Allow user scripts' in chrome://extensions/?id=dhdgffkkebhmkfjojejmpbldmpobfkfo, then retry. This test never changes that permission automatically.",
        )
      }
    }
    if (install) await installScript(context)
    const result = batchOnly ? {} : await smokeTest(context)
    if (!batchOnly) result.sidebarLauncher = await sidebarLauncherTest(context)
    if (transfer) result.conversationTransfer = await conversationTransferTest(context)
    if (selectedConversation) result.selectedConversation = await selectedConversationTest(context, selectedConversation)
    if (mindTransfer) result.mindHistory = await mindHistoryTransferTest(context)
    if (agenticTransfer) result.agenticHistory = await mindHistoryTransferTest(context, true)
    if (selectedAgentic) result.selectedAgentic = await selectedAgenticConversationTest(context, selectedAgentic)
    if (mindPackage) result.mindPackage = await completeMindPackageTest(context)
    if (charactersTransfer) result.characters = await characterTransferTest(context, selectedCharacter)
    if (libraryTransfer) result.library = await libraryTransferTest(context)
    if (studioTransfer) result.studioSessions = {
      image: await studioSessionTransferTest(context), audio: await studioSessionTransferTest(context, "audio"),
    }
    if (batchTransfer) result.batchExport = await batchExportTest(context)
    if (batchControls) result.batchImportControls = await batchImportControlsTest(context)
    if (nativePage) result.nativePage = await nativePageTest(context)
    const artifact = await readFile(path.join(root, "dist/venice-sync.user.js"))
    const report = {
      timestamp: new Date().toISOString(),
      chrome: browser.version(),
      artifactSha256: createHash("sha256").update(artifact).digest("hex"),
      installedViaTampermonkeyUiThisRun: install,
      ...result,
      veniceRecordContentsReadByTest: transfer || mindTransfer || mindPackage || agenticTransfer || charactersTransfer || libraryTransfer || studioTransfer || batchTransfer || batchControls,
      veniceStorageWrittenByTest: transfer || mindTransfer || mindPackage || agenticTransfer || charactersTransfer || libraryTransfer || studioTransfer || batchTransfer || batchControls,
    }
    await mkdir(path.join(root, "test-results"), { recursive: true })
    await writeFile(
      path.join(root, "test-results/e2e-result.json"),
      `${JSON.stringify(report, null, 2)}\n`,
    )
    console.log(JSON.stringify(report, null, 2))
  } finally {
    try {
      if (preserveFixturePage) console.error("Preserving the fixture tab: writes or cleanup could not be verified. Inspect the committed-ID journal before retrying.")
      else for (const page of context?.pages() ?? []) if (!previousPages.has(page)) await page.close()
    } finally { await browser.close() }
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
