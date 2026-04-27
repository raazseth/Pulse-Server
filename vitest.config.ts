import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  resolve: {
    alias: { "@": path.resolve(__dirname, "./") },
  },
  test: {
    environment: "node",
    globals: true,
    testTimeout: 15000,
    hookTimeout: 15000,
    coverage: {
      provider: "v8",
      include: ["internal/**/*.ts"],
      exclude: ["internal/**/*.d.ts", "internal/**/model/**", "internal/pkg/**"],
      reporter: ["text", "json-summary"],
    },
  },
});
