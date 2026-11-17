import { defineConfig } from "vitest/config";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root: here,
  resolve: {
    alias: {
      "@lib": path.resolve(here, "../lib"),
      "@sim": path.resolve(here, "../sim"),
      "@artifacts": path.resolve(here, "../artifacts"),
    },
  },
  test: { environment: "node", include: ["src/**/*.test.{ts,tsx}"], testTimeout: 180_000 },
});
