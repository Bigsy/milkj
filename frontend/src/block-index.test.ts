// @vitest-environment jsdom

import { Editor, parserCtx, remarkCtx, rootCtx, serializerCtx } from "@milkdown/kit/core";
import { commonmark } from "@milkdown/kit/preset/commonmark";
import { gfm } from "@milkdown/kit/preset/gfm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { EditRegions, type MarkdownStructure, SourceBlockIndex } from "./block-index";
import { parseObservingBlocks, splitTopLevelBlocks, type TopLevelBlock } from "./markdown-blocks";
import { mergeSourcePreservingEdit } from "./source-preserving-sync";
import { buildCleanDoc, buildDriftDoc, MARKER_EDITS } from "./test-support/large-markdown";

/**
 * A toy dialect with the shape the guard relies on: blocks are runs of non-blank lines, `__bold__`
 * canonicalizes to `**bold**`, blocks are joined by one blank line, and a `[label]: url` definition
 * vanishes from the canonical text — standing in for syntax Milkdown drops.
 */
const DEFINITION = /^\[[^\]]+\]:/;
const toyCanonicalBlock = (text: string) => text.replaceAll("__", "**");

function toyBlocks(markdown: string): TopLevelBlock[] {
  return [...markdown.matchAll(/[^\n]+(?:\n[^\n]+)*/g)].map((match) => ({
    type: DEFINITION.test(match[0]) ? "definition" : "paragraph",
    start: match.index,
    end: match.index + match[0].length,
    key: toyCanonicalBlock(match[0]),
  }));
}

function toyCanonicalize(markdown: string): string {
  const blocks = toyBlocks(markdown).filter((block) => block.type !== "definition");
  return blocks.length
    ? `${blocks.map((block) => toyCanonicalBlock(markdown.slice(block.start, block.end))).join("\n\n")}\n`
    : "";
}

const toy: MarkdownStructure = {
  splitTopLevel: toyBlocks,
  canonicalizeObserving: (markdown) => ({ canonical: toyCanonicalize(markdown), blocks: toyBlocks(markdown) }),
};

/** Regions for editing `source` into the canonical text `edited`. */
function regionsFor(source: string, edited: string, canonicalBefore = toyCanonicalize(source)) {
  return new SourceBlockIndex(toy).prepare(source, canonicalBefore, edited);
}

function allows(regions: EditRegions | string, candidate: string): boolean {
  if (typeof regions === "string") {
    throw new Error(regions);
  }
  return regions.check(candidate) !== undefined;
}

describe("the byte-exact guard's edit regions", () => {
  it("rejects a candidate that reformats a block the edit did not touch", () => {
    const source = "# Title\n\nKeep __this__.\n\nEdit me.\n";
    const regions = regionsFor(source, "# Title\n\nKeep **this**.\n\nEdited.\n");

    expect(allows(regions, "# Title\n\nKeep __this__.\n\nEdited.\n")).toBe(true);
    // Equivalent to the edited text, so only the guard can tell it apart.
    expect(allows(regions, "# Title\n\nKeep **this**.\n\nEdited.\n")).toBe(false);
  });

  it("keeps the separators of untouched junctions exact", () => {
    const source = "# Title\n\nKeep.\n\nEdit me.\n";
    const regions = regionsFor(source, "# Title\n\nKeep.\n\nEdited.\n");

    expect(allows(regions, "# Title\n\n\nKeep.\n\nEdited.\n")).toBe(false);
    expect(allows(regions, "# Title\n\nKeep.\n\nEdited.")).toBe(false);
  });

  it("lets an inserted block land in the gap it was inserted into, and nowhere else", () => {
    const source = "A __a__.\n\nB.\n";
    const regions = regionsFor(source, "A **a**.\n\nNew.\n\nB.\n");

    expect(allows(regions, "A __a__.\n\nNew.\n\nB.\n")).toBe(true);
    expect(allows(regions, "A **a**.\n\nNew.\n\nB.\n")).toBe(false);
    expect(allows(regions, "New.\n\nA __a__.\n\nB.\n")).toBe(false);
  });

  it("lets a deleted block and its separator go without touching its neighbours", () => {
    const source = "One __x__.\n\nTwo.\n\nThree __y__.\n";
    const regions = regionsFor(source, "One **x**.\n\nThree **y**.\n");

    expect(allows(regions, "One __x__.\n\nThree __y__.\n")).toBe(true);
    expect(allows(regions, "One __x__.\n\nThree **y**.\n")).toBe(false);
    expect(allows(regions, "One **x**.\n\nThree __y__.\n")).toBe(false);
  });

  it("keeps disjoint edits in separate regions", () => {
    const source = "First.\n\nMiddle __m__.\n\nLast.\n";
    const regions = regionsFor(source, "First!\n\nMiddle **m**.\n\nLast!\n");

    expect(typeof regions !== "string" && regions.regions).toHaveLength(2);
    expect(allows(regions, "First!\n\nMiddle __m__.\n\nLast!\n")).toBe(true);
    expect(allows(regions, "First!\n\nMiddle **m**.\n\nLast!\n")).toBe(false);
  });

  it("pins an edit to the one of several identical blocks the editor changed", () => {
    const source = "Same __x__.\n\nSame **x**.\n\nTail.\n";
    const regions = regionsFor(source, "Same **x**.\n\nSame **x**!\n\nTail.\n");

    expect(allows(regions, "Same __x__.\n\nSame **x**!\n\nTail.\n")).toBe(true);
    // Canonically identical to the edited text, but it edits the wrong copy.
    expect(allows(regions, "Same __x__!\n\nSame **x**.\n\nTail.\n")).toBe(false);
  });

  it("refuses to guess among identical blocks when one of them has no counterpart", () => {
    // The canonical text holds two copies where the source holds three: which source copy the
    // edited canonical copy stands for is a guess.
    const source = "Same.\n\nSame.\n\nSame.\n\nEdit.\n";
    const canonicalBefore = "Same.\n\nSame.\n\nEdit.\n";

    expect(regionsFor(source, "Same.\n\nSame!\n\nEdit.\n", canonicalBefore))
      .toBe("MilkJ could not tell which part of the Markdown the rich-text change edited.");
    // A block outside the ambiguous run still maps unambiguously.
    expect(allows(regionsFor(source, "Same.\n\nSame.\n\nEdited.\n", canonicalBefore),
      "Same.\n\nSame.\n\nSame.\n\nEdited.\n")).toBe(true);
  });

  it("refuses an insertion next to source-only blocks it cannot place exactly", () => {
    const source = "Before.\n\n[a]: /a\n\nAfter.\n";
    // The definition sits in the gap the insertion lands in: taking it into the region would let
    // the merge rewrite it.
    expect(regionsFor(source, "Before.\n\nNew.\n\nAfter.\n"))
      .toBe("MilkJ could not tell which part of the Markdown the rich-text change edited.");
    // An edit inside a block next to it is fine, and the definition stays exact.
    const regions = regionsFor(source, "Before!\n\nAfter.\n");
    expect(allows(regions, "Before!\n\n[a]: /a\n\nAfter.\n")).toBe(true);
    expect(allows(regions, "Before!\n\nAfter.\n")).toBe(false);
  });

  it("gives up when source and canonical blocks align only past the edit budget", () => {
    const definitions = Array.from({ length: 501 }, (_, i) => `[d${i}]: /d${i}`).join("\n\n");
    const source = `Edit me.\n\n${definitions}\n\nTail.\n`;

    expect(regionsFor(source, "Edited.\n\nTail.\n"))
      .toBe("MilkJ could not tell which part of the Markdown the rich-text change edited.");
  });

  it("accepts a merge whose candidate keeps the untouched blocks exact", () => {
    const source = "Keep __this__.\n\nEdit me.\n";
    const edited = "Keep **this**.\n\nEdited.\n";

    expect(mergeSourcePreservingEdit(source, edited, toyCanonicalize, undefined, undefined,
      new SourceBlockIndex(toy))).toEqual({ ok: true, markdown: "Keep __this__.\n\nEdited.\n" });
  });
});

describe("the block index over the Milkdown parser", () => {
  let editor: Editor;
  let structure: MarkdownStructure;

  beforeAll(async () => {
    const root = document.body.appendChild(document.createElement("div"));
    editor = await Editor.make()
      .config((ctx) => ctx.set(rootCtx, root))
      .use(commonmark)
      .use(gfm)
      .create();
    structure = {
      splitTopLevel: (markdown) => splitTopLevelBlocks(editor.ctx.get(remarkCtx), markdown),
      canonicalizeObserving: (markdown, knownKey) => editor.action((ctx) => {
        const { result, blocks } = parseObservingBlocks(ctx.get(remarkCtx), markdown, ctx.get(parserCtx), knownKey);
        return { canonical: ctx.get(serializerCtx)(result), blocks };
      }),
    };
  });

  afterAll(async () => {
    await editor.destroy();
  });

  const canonicalize = (markdown: string) =>
    editor.action((ctx) => ctx.get(serializerCtx)(ctx.get(parserCtx)(markdown)));

  it("indexes a document from the parse its canonicalization already runs", () => {
    const markdown = "# Title\n\n- tight\n- list\n\n| a | b |\n|-|-|\n| 1 | 2 |\n\nText __bold__.\n";

    const observed = structure.canonicalizeObserving(markdown);

    expect(observed.canonical).toBe(canonicalize(markdown));
    expect(observed.blocks).toEqual(structure.splitTopLevel(markdown));
  });

  it("gives a tight source list and its loose canonical form the same key", () => {
    const [sourceList] = structure.splitTopLevel("- one\n- two\n")!;
    const [canonicalList] = structure.splitTopLevel(canonicalize("- one\n- two\n"))!;

    expect(canonicalList.key).toBe(sourceList.key);
  });

  it("keeps its index equal to a fresh split across a chain of accepted edits", () => {
    const drift = buildDriftDoc(20_000);
    const index = new SourceBlockIndex(structure);
    let source = buildCleanDoc(drift, canonicalize);
    let canonical: string | undefined;
    const edits: Array<(markdown: string) => string> = [
      (markdown) => markdown.replace(MARKER_EDITS.start.from, MARKER_EDITS.start.to),
      (markdown) => markdown.replace(MARKER_EDITS.tableCell.from, MARKER_EDITS.tableCell.to),
      // A new paragraph, a deleted one, and a new last block.
      (markdown) => markdown.replace("## Section 2\n", "## Section 2\n\nA new paragraph.\n"),
      (markdown) => markdown.replace("A new paragraph.\n\n", ""),
      (markdown) => `${markdown}\nAppended at the end.\n`,
    ];

    for (const edit of edits) {
      const before = canonical ?? canonicalize(source);
      const edited = canonicalize(edit(before));
      expect(edited).not.toBe(before);
      const result = mergeSourcePreservingEdit(source, edited, canonicalize, canonical, undefined, index);
      expect(result.ok).toBe(true);
      source = result.ok ? result.markdown : source;
      canonical = edited;

      const { source: sourceIndex, canonical: canonicalIndex } = index.indexed();
      expect(sourceIndex).toEqual({ text: source, blocks: structure.splitTopLevel(source) });
      expect(canonicalIndex).toEqual({ text: edited, blocks: structure.splitTopLevel(edited) });
    }
  });
});
