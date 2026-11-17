import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { viteSingleFile } from "vite-plugin-singlefile";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));

// One self-contained dist/index.html: JS, CSS and wasm are inlined.
export default defineConfig({
  root: here,
  base: "./",
  plugins: [react(), viteSingleFile()],
  resolve: {
    alias: {
      "@lib": path.resolve(here, "../lib"),
      "@sim": path.resolve(here, "../sim"),
      "@artifacts": path.resolve(here, "../artifacts"),
    },
  },
  define: { "process.env": {}, global: "globalThis" },
  server: { fs: { allow: [path.resolve(here, "..")] }, host: true },
  build: {
    outDir: path.resolve(here, "dist"),
    emptyOutDir: true,
    target: "es2022",
    assetsInlineLimit: 100_000_000,
    chunkSizeWarningLimit: 100_000,
    cssCodeSplit: false,
  },
});
