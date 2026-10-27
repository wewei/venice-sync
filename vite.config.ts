import { fileURLToPath, URL } from "node:url"
import tailwindcss from "@tailwindcss/vite"
import react from "@vitejs/plugin-react"
import { defineConfig } from "vite"
import monkey from "vite-plugin-monkey"

export default defineConfig(({ command }) => ({
  plugins: [
    react(),
    tailwindcss(),
    command === "build" && monkey({
      entry: "src/main.tsx",
      userscript: {
        name: "Venice Sync - Dummy",
        namespace: "https://github.com/wewei/venice-sync",
        version: "0.1.0",
        description: "Local Classic conversation JSON import/export and storage metadata. No cloud synchronization.",
        match: ["https://venice.ai/*"],
        grant: ["GM_info", "unsafeWindow"],
        "run-at": "document-idle",
        noframes: true,
      },
      build: {
        fileName: "venice-sync.user.js",
      },
      server: {
        open: false,
      },
    }),
  ],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  server: {
    host: "127.0.0.1",
    port: 5173,
    strictPort: true,
  },
  preview: {
    host: "127.0.0.1",
    port: 4173,
    strictPort: true,
  },
}))
