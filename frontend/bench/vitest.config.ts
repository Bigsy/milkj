import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// `pnpm run bench:sync` only. `pnpm test` uses Vitest's default include, which never matches
// `*.bench.ts`, so the benchmark stays out of the test suite and CI.
export default defineConfig({
  root: fileURLToPath(new URL("..", import.meta.url)),
  test: {
    include: ["bench/**/*.bench.ts"],
    environment: "jsdom",
    // Per-case cap. Vitest cannot interrupt synchronous code, so the benchmark also checks elapsed
    // time itself, and the watchdog in global-setup.ts ends the whole run after 15 minutes.
    testTimeout: 60_000,
    hookTimeout: 60_000,
    globalSetup: ["bench/global-setup.ts"],
  },
});
