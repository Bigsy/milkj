import { describe, expect, it } from "vitest";
import {
  dictionaryCandidate,
  isDictionaryEligible,
  isValidDictionaryWord,
  normalizeDictionary,
} from "./dictionary";
import type { MappedIssue } from "./types";

function issue(overrides: Partial<MappedIssue> = {}): MappedIssue {
  return {
    id: "issue",
    from: 2,
    to: 8,
    startIndex: 100,
    endIndex: 101,
    correction: null,
    suggestions: [],
    types: ["Spelling"],
    explanation: "",
    ...overrides,
  };
}

describe("custom dictionary", () => {
  it("trims, exact-case deduplicates, and sorts by UTF-16 code units", () => {
    expect(normalizeDictionary([" zebra ", "Apple", "apple", "Apple", 4]))
      .toEqual(["Apple", "apple", "zebra"]);
  });

  it("accepts supported words and interior punctuation", () => {
    for (const word of ["Ångström", "𐐀", "don't", "web-scale", "C++", "C#", "MilkJ2"]) {
      expect(isValidDictionaryWord(word), word).toBe(true);
    }
  });

  it("rejects empty, whitespace, punctuation-only, and overlong values", () => {
    for (const word of ["", "two words", "two\u00a0words", "two\ufeffwords", "---", "a".repeat(65)]) {
      expect(isValidDictionaryWord(word), JSON.stringify(word)).toBe(false);
    }
  });

  it("uses the current mapped text and strips only sentence punctuation", () => {
    expect(dictionaryCandidate("“MilkJ”,", issue({ from: 2, to: 10 }))).toBe("MilkJ");
    expect(dictionaryCandidate("C++", issue({ from: 2, to: 5 }))).toBe("C++");
    expect(dictionaryCandidate("C#", issue({ from: 2, to: 4 }))).toBe("C#");
  });

  it("rejects insertions, invalid ranges, non-spelling issues, and phrases", () => {
    expect(isDictionaryEligible("", issue({ from: 2, to: 2 }))).toBe(false);
    expect(isDictionaryEligible("word", issue({ from: 2, to: 9 }))).toBe(false);
    expect(isDictionaryEligible("two words", issue({ from: 2, to: 11 }))).toBe(false);
    for (const type of ["grammar", "punctuation", "capitalization", "style"]) {
      expect(isDictionaryEligible("MilkJ", issue({ from: 2, to: 7, types: [type] }))).toBe(false);
    }
  });
});
