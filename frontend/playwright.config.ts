import { defineConfig, devices } from "@playwright/test"

const port = Number(process.env.PLAYWRIGHT_PORT ?? "4188")
const browserChannel =
  process.env.PLAYWRIGHT_CHANNEL === "chrome" ? "chrome" : undefined

export default defineConfig({
  testDir: "./test",
  outputDir: "./output/playwright/results",
  timeout: 30_000,
  expect: {
    timeout: 5_000,
  },
  fullyParallel: false,
  workers: 1,
  reporter: [
    ["line"],
    [
      "html",
      {
        outputFolder: "./output/playwright/report",
        open: "never",
      },
    ],
  ],
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
    video: "off",
  },
  webServer: {
    command: `npm run dev -- --host 127.0.0.1 --port ${port} --strictPort`,
    url: `http://127.0.0.1:${port}`,
    reuseExistingServer: false,
    timeout: 120_000,
  },
  projects: [
    {
      name: "desktop-chromium",
      use: {
        ...devices["Desktop Chrome"],
        channel: browserChannel,
        viewport: { width: 1440, height: 1000 },
      },
    },
    {
      name: "mobile-chromium",
      use: {
        ...devices["Pixel 7"],
        channel: browserChannel,
        viewport: { width: 390, height: 844 },
      },
    },
  ],
})
