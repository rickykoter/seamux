import { defineConfig } from "vite";

// The pages live in ui/ and build to dist/, which tauri.conf.json serves.
export default defineConfig({
  root: "ui",
  clearScreen: false,
  server: { port: 5173, strictPort: true },
  build: { outDir: "../dist", emptyOutDir: true, target: "safari16" },
});
