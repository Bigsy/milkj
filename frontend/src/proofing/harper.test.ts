import { Dialect, LocalLinter } from "harper.js";
import { binary } from "harper.js/binary";
import { describe, expect, it, vi } from "vitest";
import { normalizeHarperLints } from "./normalize";
import { HarperEngine, resolveDialect, type HarperLinter } from "./harper";

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

      const context = "Read  before starting.";
      const contextLints = await linter.lint(context, { language: "plaintext" });
      try {
        const contextCorrections = normalizeHarperLints(context, contextLints);
        expect(contextCorrections.some((issue) =>
          issue.startIndex === 6 &&
          issue.endIndex === 12 &&
          issue.suggestions.some(({ replacement }) => replacement === "Before"),
        )).toBe(false);
      } finally {
        contextLints.forEach((lint) => lint.free());
      }
    } finally {
      lints.forEach((lint) => lint.free());
      await linter.dispose();
    }
  }, 15_000);

  it("adds and removes a real custom dictionary word", async () => {
    const linter = new LocalLinter({ binary, dialect: Dialect.American });
    const hasProoflyLint = async () => {
      const lints = await linter.lint("Proofly improves text.", { language: "plaintext" });
      try {
        return normalizeHarperLints("Proofly improves text.", lints)
          .some((correction) => correction.startIndex === 0);
      } finally {
        lints.forEach((lint) => lint.free());
      }
    };
    try {
      expect(await hasProoflyLint()).toBe(true);
      await linter.clearWords();
      await linter.importWords(["Proofly"]);
      expect(await hasProoflyLint()).toBe(false);
      await linter.clearWords();
      expect(await hasProoflyLint()).toBe(true);
    } finally {
      await linter.dispose();
    }
  }, 15_000);
});

describe("HarperEngine dictionary lifecycle", () => {
  function mockLinter(calls: string[]): HarperLinter {
    return {
      setup: vi.fn(async () => { calls.push("setup"); }),
      clearWords: vi.fn(async () => { calls.push("clearWords"); }),
      importWords: vi.fn(async (words: string[]) => { calls.push(`importWords:${words.join(",")}`); }),
      setDialect: vi.fn(async () => { calls.push("setDialect"); }),
      lint: vi.fn(async (text: string) => { calls.push(`lint:${text}`); return []; }),
      dispose: vi.fn(async () => { calls.push("dispose"); }),
    };
  }

  it("stays lazy and applies complete dictionary snapshots in order", async () => {
    const calls: string[] = [];
    const factory = vi.fn(() => mockLinter(calls));
    const engine = new HarperEngine(factory);
    expect(factory).not.toHaveBeenCalled();

    await engine.lint("one", "AMERICAN", ["MilkJ", "Proofly"]);
    expect(calls).toEqual([
      "setup", "clearWords", "importWords:MilkJ,Proofly", "lint:one",
    ]);
    calls.length = 0;
    await engine.lint("two", "AMERICAN", ["MilkJ", "Proofly"]);
    expect(calls).toEqual(["lint:two"]);
    await engine.lint("three", "AMERICAN", ["MilkJ"]);
    expect(calls.slice(1)).toEqual(["clearWords", "importWords:MilkJ", "lint:three"]);
    await engine.lint("four", "AMERICAN", []);
    expect(calls.slice(-2)).toEqual(["clearWords", "lint:four"]);
    await engine.dispose();
  });

  it("reimports the dictionary after a dialect change", async () => {
    const calls: string[] = [];
    const engine = new HarperEngine(() => mockLinter(calls));
    await engine.lint("one", "AMERICAN", ["MilkJ"]);
    calls.length = 0;
    await engine.lint("two", "BRITISH", ["MilkJ"]);
    expect(calls).toEqual(["setDialect", "clearWords", "importWords:MilkJ", "lint:two"]);
    await engine.dispose();
  });

  it("disposes a failed worker and recreates it on a later retry", async () => {
    const calls: string[] = [];
    let first = true;
    const factory = vi.fn(() => {
      const linter = mockLinter(calls);
      if (first) {
        first = false;
        linter.clearWords = vi.fn(async () => { throw new Error("dictionary failed"); });
      }
      return linter;
    });
    const engine = new HarperEngine(factory);
    expect((await engine.lint("one", "AMERICAN", ["MilkJ"])).error).toBe("dictionary failed");
    expect((await engine.lint("two", "AMERICAN", ["MilkJ"])).error).toBeUndefined();
    expect(factory).toHaveBeenCalledTimes(2);
    await engine.dispose();
  });
});
