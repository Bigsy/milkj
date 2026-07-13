import { Dialect, LocalLinter } from "harper.js";
import { binary } from "harper.js/binary";
import { describe, expect, it } from "vitest";
import { normalizeHarperLints } from "./normalize";
import { resolveDialect } from "./harper";

describe("Harper 2.4.0 integration", () => {
  it("resolves automatic dialects from locale regions", () => {
    expect(resolveDialect("AUTO", "en-GB")).toBe("BRITISH");
    expect(resolveDialect("AUTO", "en-AU")).toBe("AUSTRALIAN");
    expect(resolveDialect("AUTO", "en-CA")).toBe("CANADIAN");
    expect(resolveDialect("AUTO", "en-IN")).toBe("INDIAN");
    expect(resolveDialect("AUTO", "en-NZ")).toBe("AMERICAN");
    expect(resolveDialect("BRITISH", "en-US")).toBe("BRITISH");
  });

  it("loads the real WASM and returns a deterministic spelling correction", async () => {
    const linter = new LocalLinter({ binary, dialect: Dialect.American });
    const lints = await linter.lint("This is wierd.", { language: "plaintext" });
    try {
      const corrections = normalizeHarperLints("This is wierd.", lints);
      expect(corrections.some((issue) =>
        issue.startIndex === 8 && issue.suggestions.some(({ replacement }) => replacement === "weird"),
      )).toBe(true);
    } finally {
      lints.forEach((lint) => lint.free());
      await linter.dispose();
    }
  }, 15_000);
});
