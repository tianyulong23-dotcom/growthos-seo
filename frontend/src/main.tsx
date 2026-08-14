import { StrictMode } from "react"
import { createRoot } from "react-dom/client"

import "./index.css"
import App from "./App.tsx"
import { ThemeProvider } from "@/components/theme-provider.tsx"
import { getCanonicalLocalProductUrl } from "@/local-product-origin.ts"

const canonicalLocalProductUrl = getCanonicalLocalProductUrl(
  new URL(window.location.href)
)

if (canonicalLocalProductUrl) {
  window.location.replace(canonicalLocalProductUrl)
} else {
  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <ThemeProvider>
        <App />
      </ThemeProvider>
    </StrictMode>
  )
}
