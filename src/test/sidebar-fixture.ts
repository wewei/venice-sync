export function sidebarFixture(parent: HTMLElement = document.body) {
  const document = parent.ownerDocument
  const aside = document.createElement("aside"), header = document.createElement("div"), logo = document.createElement("div")
  const link = document.createElement("a"), brand = document.createElementNS("http://www.w3.org/2000/svg", "svg")
  const toggle = document.createElement("button"), nav = document.createElement("a")
  brand.setAttribute("viewBox", "0 0 549 307")
  link.append(brand); logo.append(link)
  toggle.setAttribute("aria-label", "Toggle sidebar")
  nav.href = "/minds"
  header.append(logo, toggle); aside.append(header, nav); parent.append(aside)
  let toggleLeft = 288
  header.getBoundingClientRect = () => new DOMRect(0, 0, 320, 77)
  logo.getBoundingClientRect = () => new DOMRect(16, 16, 80, 45)
  toggle.getBoundingClientRect = () => new DOMRect(toggleLeft, 22.5, 32, 32)
  return { aside, header, logo, brand, toggle, setToggleLeft: (value: number) => { toggleLeft = value } }
}
