export function nativePageFixture({ sidebar, mobile = false, preview = false }: { sidebar?: HTMLElement; mobile?: boolean; preview?: boolean } = {}) {
  const frame = document.createElement("div"), main = document.createElement(preview ? "main" : "div")
  const content = document.createElement("div"), input = document.createElement("textarea")
  if (preview) main.dataset.veniceSyncPreviewMain = ""
  input.setAttribute("aria-label", "Native draft"); input.value = "Original Venice draft"
  content.append(input); main.append(content)
  let opener: HTMLButtonElement | undefined
  if (mobile) {
    const header = document.createElement("div")
    opener = document.createElement("button"); opener.setAttribute("aria-label", "Show Sidebar")
    opener.getBoundingClientRect = () => new DOMRect(8, 8, 40, 40)
    header.getBoundingClientRect = () => new DOMRect(0, 0, innerWidth, 56)
    header.append(opener); main.prepend(header)
  }
  const left = sidebar && !mobile ? 320 : 0
  main.getBoundingClientRect = () => new DOMRect(left, 0, innerWidth - left, innerHeight)
  frame.getBoundingClientRect = () => new DOMRect(0, 0, innerWidth, innerHeight)
  if (sidebar) { sidebar.getBoundingClientRect = () => new DOMRect(0, 0, 320, innerHeight); frame.append(sidebar) }
  Object.defineProperties(content, { clientHeight: { value: 200 }, scrollHeight: { value: 1000 } })
  frame.append(main); document.body.append(frame)
  return { frame, main, content, input, opener }
}
