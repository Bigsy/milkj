import DiffMatchPatch from "diff-match-patch";
import { describe, expect, it } from "vitest";
import { alignSource, type Diff, normalizeLine } from "./source-alignment";

/** The two texts a diff runs between. */
function sides(diffs: Diff[]): [string, string] {
  return [
    diffs.filter(([operation]) => operation <= 0).map(([, text]) => text).join(""),
    diffs.filter(([operation]) => operation >= 0).map(([, text]) => text).join(""),
  ];
}

describe("normalizeLine", () => {
  it.each([
    ["* item", "+ item"],
    ["* item", "  - item"],
    ["1. first", "3) first"],
    ["Keep **bold** here", "Keep __bold__ here  "],
    ["## Heading", "Heading"],
    ["## Heading", "## Heading ##"],
    ["***", "---"],
    ["***", "_ _ _"],
    ["```ts", "~~~ts"],
    ["| a    | long cell |", "|a|long cell|"],
    ["| ---- | :-------: |", "|-|:-:|"],
    ["> quoted", ">quoted"],
    ["a \\* star", "a * star"],
    ["hard break\\", "hard break  "],
  ])("equates %j with %j", (canonical, source) => {
    expect(normalizeLine(canonical)).toBe(normalizeLine(source));
  });

  it("keeps lines that differ in content apart", () => {
    expect(normalizeLine("* one")).not.toBe(normalizeLine("* two"));
    expect(normalizeLine("> quoted")).not.toBe(normalizeLine("quoted"));
    expect(normalizeLine("| a | b |")).not.toBe(normalizeLine("| a | c |"));
  });
});

describe("alignSource", () => {
  const dmp = new DiffMatchPatch();

  it("pairs every line of a drifted document with its canonical counterpart", () => {
    const canonical = "## Title\n\n* one\n\n* two\n\n| a    | b |\n| ---- | - |\n| long | 1 |\n\nKeep **x**.\n";
    const source = "Title\n=====\n\n+ one\n+ two\n\n|a|b|\n|-|-|\n|long|1|\n\nKeep __x__.\n";

    const alignment = alignSource(dmp, canonical, source)!;

    expect(sides(alignment.lines)).toEqual([canonical, source]);
    expect(sides(alignment.characters)).toEqual([canonical, source]);
    // Each reformatted line is its own one-line replacement, not part of a document-sized chunk.
    expect(alignment.lines).toContainEqual([-1, "| long | 1 |\n"]);
    expect(alignment.lines).toContainEqual([1, "|long|1|\n"]);
    expect(alignment.lines).toContainEqual([1, "+ two\n"]);
    expect(dmp.diff_xIndex(alignment.characters, canonical.indexOf("Keep"))).toBe(source.indexOf("Keep"));
  });

  it("returns undefined for texts that differ by more than formatting", () => {
    const unrelated = (prefix: string) =>
      Array.from({ length: 2_100 }, (_, i) => `${prefix} line ${i}`).join("\n");

    expect(alignSource(dmp, unrelated("canonical"), unrelated("source"))).toBeUndefined();
  });
});
