import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

// `@/` resolves to ./src, matching tsconfig paths. Telemetry self-silences under vitest (VITEST env).
export default defineConfig({
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  test: {
    include: ["tests/**/*.test.ts"],
  },
});
