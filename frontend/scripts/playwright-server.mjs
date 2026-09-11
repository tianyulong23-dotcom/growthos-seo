import { build, preview } from "vite"

const port = Number(process.argv[2])

// Browser acceptance runs against a fresh build, without dev-module loading.
await build()
await preview({
  preview: {
    host: "127.0.0.1",
    port,
    strictPort: true,
  },
})
