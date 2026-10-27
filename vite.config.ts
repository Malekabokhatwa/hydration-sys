import { defineConfig } from "vitest/config";

export default defineConfig({
  clearScreen: false,
  server: { port: 1420, strictPort: true, host: "127.0.0.1" },
  build: {
    target: ["es2022", "safari16"],
    assetsInlineLimit: 0,
    sourcemap: false,
    modulePreload: { polyfill: false },
  },
  test: { include: ["tests/unit/**/*.test.ts"] },
});
