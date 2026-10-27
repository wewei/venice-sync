import { cleanup, render, screen, waitFor } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { MindAvatar } from "./MindAvatar"
import { loadMindAvatar } from "./venice-mind-package"

vi.mock("./venice-mind-package", () => ({ loadMindAvatar: vi.fn() }))
afterEach(() => { cleanup(); vi.resetAllMocks(); vi.unstubAllGlobals() })

describe("local Mind avatars", () => {
  it("uses a neutral fallback for absent avatars without fetching", () => {
    render(<MindAvatar mindId="test" name="Mind" />)
    expect(loadMindAvatar).not.toHaveBeenCalled()
    expect(screen.queryByRole("img")).toBeNull()
  })

  it("shows a local image and releases its object URL on unmount", async () => {
    const revokeObjectURL = vi.fn()
    vi.stubGlobal("URL", { revokeObjectURL })
    vi.mocked(loadMindAvatar).mockResolvedValue("blob:avatar")
    const view = render(<MindAvatar mindId="test" name="My Mind" avatar={{ id: "avatar", mimeType: "image/png" }} />)
    expect(await screen.findByRole("img", { name: "My Mind avatar" })).toHaveAttribute("src", "blob:avatar")
    view.unmount()
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:avatar")
  })

  it("exposes missing-file errors and releases URLs returned after unmount", async () => {
    vi.mocked(loadMindAvatar).mockRejectedValue(new Error("Missing file"))
    const view = render(<MindAvatar mindId="test" name="Mind" avatar={{ id: "missing", mimeType: "image/png" }} />)
    expect(await screen.findByRole("status")).toHaveTextContent("Avatar unavailable: Missing file")
    view.unmount()
    const revokeObjectURL = vi.fn()
    vi.stubGlobal("URL", { revokeObjectURL })
    let resolve: ((url: string) => void) | undefined
    vi.mocked(loadMindAvatar).mockImplementation(() => new Promise((done) => { resolve = done }))
    const next = render(<MindAvatar mindId="next" name="Next" avatar={{ id: "late", mimeType: "image/png" }} />)
    next.unmount()
    resolve?.("blob:late")
    await waitFor(() => expect(revokeObjectURL).toHaveBeenCalledWith("blob:late"))
  })

  it("uses Venice's native public avatar endpoint for remote Minds without loading another Mind's local file", () => {
    const view = render(<MindAvatar remoteMindId="published-mind" name="Published Mind" compact />)
    const image = screen.getByRole("img", { name: "Published Mind avatar" })
    expect(image).toHaveAttribute("src", "https://outerface.venice.ai/api/v2/agents/published-mind/avatar")
    expect(image).toHaveAttribute("referrerpolicy", "no-referrer")
    expect(loadMindAvatar).not.toHaveBeenCalled()
    view.unmount()
  })
})
