import { describe, expect, it } from "vitest";
import { normalizeHarperLints } from "./normalize";

function wrapper<T extends object>(value: T, freed: string[], name: string) {
  return { ...value, free: () => freed.push(name) };
}

describe("normalizeHarperLints", () => {
  it("normalizes alternatives and frees temporary wrappers", () => {
    const freed: string[] = [];
    const lint = {
      span: () => wrapper({ start: 2, end: 7 }, freed, "span"),
      lint_kind: () => "Spelling",
      message: () => "Did you mean weird?",
      suggestions: () => [
        wrapper({ kind: () => 0, get_replacement_text: () => "weird" }, freed, "first"),
        wrapper({ kind: () => "replace", get_replacement_text: () => "wired" }, freed, "second"),
        wrapper({ kind: () => "replace", get_replacement_text: () => "weird" }, freed, "duplicate"),
      ],
    };
    expect(normalizeHarperLints("A wierd word", [lint])).toEqual([{
      startIndex: 2,
      endIndex: 7,
      correction: "weird",
      suggestions: [{ replacement: "weird" }, { replacement: "wired" }],
      types: ["spelling"],
      explanation: "Did you mean weird?",
    }]);
    expect(freed).toEqual(["span", "first", "second", "duplicate"]);
  });

  it("splits insertion suggestions and rejects mid-surrogate spans", () => {
    const insertion = {
      span: () => ({ start: 0, end: 4, free() {} }),
      lint_kind: () => "Punctuation",
      message: () => "Add punctuation",
      suggestions: () => [{ kind: () => "insert-after", get_replacement_text: () => ".", free() {} }],
    };
    expect(normalizeHarperLints("word", [insertion])[0]).toMatchObject({
      startIndex: 4, endIndex: 4, correction: ".",
    });
    const malformed = {
      span: () => ({ start: 1, end: 2, free() {} }),
      suggestions: () => [],
    };
    expect(normalizeHarperLints("😀", [malformed])).toEqual([]);
  });
});
