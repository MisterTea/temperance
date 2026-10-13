import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

// Tauri serves dist/ in the app and expects the dev server on a fixed port.
export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: { port: 5173, strictPort: true },
  build: { target: "es2022", outDir: "dist" },
  test: {
    environment: "jsdom",
    include: ["tests/**/*.test.{ts,tsx}"],
    setupFiles: ["tests/setup.ts"],
    coverage: {
      provider: "v8",
      include: ["src/**/*.{ts,tsx}"],
      exclude: ["src/main.tsx"],
      reporter: ["text-summary", "text", "lcov"],
      thresholds: { lines: 80, statements: 80, functions: 80, branches: 70 },
    },
  },
});
