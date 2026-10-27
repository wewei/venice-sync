import { cleanup, render, waitFor } from "@testing-library/react"
import { afterEach, describe, expect, it } from "vitest"
import { VeniceAgenticIcon, VeniceCharactersIcon, VeniceClassicIcon, VeniceLibraryIcon, VeniceMindIcon } from "./VeniceIcons"

afterEach(() => {
  cleanup()
  document.querySelectorAll("[data-native-icon-fixture]").forEach((element) => element.remove())
})

describe("Venice category icons", () => {
  it("uses the supplied Library folder and matching open-source Classic/Characters paths", () => {
    const view = render(<><VeniceLibraryIcon /><VeniceClassicIcon /><VeniceCharactersIcon /></>)
    const icons = view.container.querySelectorAll("svg")
    expect(icons[0].querySelector("path")).toHaveAttribute("d", "M5 4h4l3 3h7a2 2 0 0 1 2 2v8a2 2 0 0 1 -2 2h-14a2 2 0 0 1 -2 -2v-11a2 2 0 0 1 2 -2")
    expect(icons[1].querySelectorAll("path")).toHaveLength(3)
    expect(icons[1].querySelector("path")).toHaveAttribute("d", "M8 9h8")
    expect(icons[2].querySelectorAll("path")).toHaveLength(8)
  })

  it("uses safe primitives from the actual native Mind SVG without vendoring artwork or handlers", () => {
    const link = document.createElement("a")
    link.href = "/minds"
    link.dataset.nativeIconFixture = ""
    link.innerHTML = '<svg viewBox="0 0 24 24" onclick="untrusted()"><rect x="2" y="2" width="20" height="20" rx="5" /><path d="M2 2L5 5" onmouseover="untrusted()" /><script>untrusted()</script><image href="https://invalid.example/image.png" /></svg>'
    document.body.append(link)
    const view = render(<VeniceMindIcon data-testid="mind" />)
    const icon = view.getByTestId("mind")
    expect(icon).toHaveAttribute("data-venice-icon", "mind-native")
    expect(icon.querySelector("rect")).toHaveAttribute("rx", "5")
    expect(icon.querySelector("path")).toHaveAttribute("d", "M2 2L5 5")
    expect(icon.querySelectorAll("script,image,[onclick],[onmouseover]")).toHaveLength(0)
    expect(icon).not.toHaveAttribute("onclick")
  })

  it("waits for native navigation to appear and otherwise shows a declared fallback", async () => {
    const view = render(<VeniceMindIcon data-testid="mind" />)
    expect(view.getByTestId("mind")).toHaveAttribute("data-venice-icon", "mind-fallback")
    const link = document.createElement("a")
    link.setAttribute("href", "/minds")
    link.dataset.nativeIconFixture = ""
    link.innerHTML = '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="8" /></svg>'
    document.body.append(link)
    await waitFor(() => expect(view.getByTestId("mind")).toHaveAttribute("data-venice-icon", "mind-native"))
    expect(view.getByTestId("mind").querySelector("circle")).toHaveAttribute("r", "8")
  })

  it("uses the actual Agentic conversation glyph rather than a generic robot or the Mind icon", async () => {
    const view = render(<VeniceAgenticIcon data-testid="agentic" />)
    expect(view.getByTestId("agentic")).toHaveAttribute("data-venice-icon", "agentic-fallback")
    const link = document.createElement("a")
    link.setAttribute("href", "/chat/agent/fixture")
    link.dataset.nativeIconFixture = ""
    link.innerHTML = '<svg viewBox="0 0 24 24" onclick="untrusted()"><path d="M4 4L12 12" /><script>untrusted()</script></svg>'
    document.body.append(link)
    await waitFor(() => expect(view.getByTestId("agentic")).toHaveAttribute("data-venice-icon", "agentic-native"))
    expect(view.getByTestId("agentic").querySelector("path")).toHaveAttribute("d", "M4 4L12 12")
    expect(view.getByTestId("agentic").querySelector("script")).toBeNull()
    expect(view.getByTestId("agentic")).not.toHaveAttribute("onclick")
  })
})
