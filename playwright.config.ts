import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "tests/e2e",
  workers: 1,
  reporter: "list",
  use: { baseURL: "http://127.0.0.1:1421", headless: true, viewport: { width: 440, height: 700 } },
  webServer: { command: "npx vite --mode mock --port 1421 --strictPort", url: "http://127.0.0.1:1421", reuseExistingServer: true, timeout: 30_000 },
});
