// @vitest-environment jsdom

import { Editor, parserCtx, remarkCtx, rootCtx, serializerCtx } from "@milkdown/kit/core";
import { commonmark } from "@milkdown/kit/preset/commonmark";
import { gfm } from "@milkdown/kit/preset/gfm";
import DiffMatchPatch from "diff-match-patch";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mergeEditByBlocks } from "./block-merge";
import { type MarkdownBlock, splitMarkdownBlocks } from "./markdown-blocks";

const TASK_LIST = `# Checklist

- [ ] first task
- [x] second task with
      a continuation
- [ ] delete this bullet
- [ ] last task

Tail paragraph.
`;

const WIDE_TABLE = `# Runbook

Keep __this__ formatting.

| Thing | Value |
| --- | --- |
| note | a value long enough that the canonical form pads every other cell in this column out |
| keep one | value 1 |
| delete me | value 2 |
| keep two | value 3 |

## Steps

Edit this sentence far below the table.
`;

describe("merging a rich-text edit by aligned blocks", () => {
  let editor: Editor;
  let split: (markdown: string) => MarkdownBlock | undefined;

  beforeAll(async () => {
    const root = document.body.appendChild(document.createElement("div"));
    editor = await Editor.make()
      .config((ctx) => ctx.set(rootCtx, root))
      .use(commonmark)
      .use(gfm)
      .create();
    split = (markdown) => splitMarkdownBlocks(editor.ctx.get(remarkCtx), markdown);
  });

  afterAll(async () => {
    await editor.destroy();
  });

  /** Exactly what the editor does to Markdown: parse into its document model, serialize it back. */
  function canonicalize(markdown: string): string {
    return editor.action((ctx) => ctx.get(serializerCtx)(ctx.get(parserCtx)(markdown)!));
  }

  function merge(source: string, editedCanonical: string): string | undefined {
    return mergeEditByBlocks(new DiffMatchPatch(), source, editedCanonical, split, canonicalize);
  }

  /** Every merge result must still parse to the document the editor holds. */
  function expectEquivalent(merged: string | undefined, editedCanonical: string) {
    expect(merged).toBeDefined();
    expect(canonicalize(merged!)).toBe(canonicalize(editedCanonical));
  }

  it("returns the source unchanged when the editor's document matches it", () => {
    expect(merge(WIDE_TABLE, canonicalize(WIDE_TABLE))).toBe(WIDE_TABLE);
  });

  it("rewrites only the edited paragraph, however far the canonical table shifts it", () => {
    const edited = canonicalize(WIDE_TABLE).replace("far below", "way below");

    const merged = merge(WIDE_TABLE, edited);

    expect(merged).toBe(WIDE_TABLE.replace("far below", "way below"));
    expectEquivalent(merged, edited);
  });

  it("takes the editor's formatting for an edited table and nothing else", () => {
    const canonical = canonicalize(WIDE_TABLE);
    const edited = canonicalize(canonical.replace(/^\| delete me.*\n/m, ""));

    const merged = merge(WIDE_TABLE, edited);

    // The table is one block: editing it normalizes its padding. Everything around it — including
    // the `__this__` emphasis Crepe would rewrite as `**this**` — keeps its source bytes.
    expect(merged).toBe(edited.replace("Keep **this** formatting.", "Keep __this__ formatting."));
    expectEquivalent(merged, edited);
  });

  it("keeps the source bytes of the bullets a deletion did not touch", () => {
    const edited = canonicalize(
      canonicalize(TASK_LIST).replace("* [ ] delete this bullet\n", ""),
    );

    const merged = merge(TASK_LIST, edited);

    // The junction the deletion left behind takes the source's own separator, not the editor's: a
    // blank line there would turn this tight list loose, and Milkdown writes every bullet list
    // loose, so canonical equivalence cannot see the difference.
    expect(merged).toBe(`# Checklist

- [ ] first task
- [x] second task with
      a continuation
- [ ] last task

Tail paragraph.
`);
    expectEquivalent(merged, edited);
  });

  it("keeps a tight list tight around an inserted item", () => {
    const source = "Intro.\n\n* first\n* last\n\nTail.\n";
    const edited = canonicalize("* first\n* inserted\n* last\n");

    const merged = merge(source, `Intro.\n\n${edited}\nTail.\n`);

    expect(merged).toBe("Intro.\n\n* first\n* inserted\n* last\n\nTail.\n");
    expectEquivalent(merged, `Intro.\n\n${edited}\nTail.\n`);
  });

  it("keeps a loose list loose when an item is deleted", () => {
    const source = "- a\n\n- delete me\n\n- c\n";
    const edited = canonicalize("- a\n\n- c\n");

    const merged = merge(source, edited);

    expect(merged).toBe("- a\n\n- c\n");
    expectEquivalent(merged, edited);
  });

  it("keeps a nested list's spacing when one of its items is deleted", () => {
    const source = "- outer one\n  - inner a\n  - delete me\n  - inner c\n- outer two\n";
    const edited = canonicalize("- outer one\n  - inner a\n  - inner c\n- outer two\n");

    const merged = merge(source, edited);

    expect(merged).toBe("- outer one\n  - inner a\n  - inner c\n- outer two\n");
    expectEquivalent(merged, edited);
  });

  it("keeps every untouched bullet byte-exact when one bullet's text changes", () => {
    // The payoff of recursing into containers: without it the whole list would be rewritten in the
    // editor's formatting (`*` bullets, blank lines between items) because one item changed.
    const edited = canonicalize(TASK_LIST).replace("second task with", "second task, edited,");

    const merged = merge(TASK_LIST, edited);

    expect(merged).toBe(`# Checklist

- [ ] first task
- [x] second task, edited,
  a continuation
- [ ] delete this bullet
- [ ] last task

Tail paragraph.
`);
    expectEquivalent(merged, edited);
  });

  it("preserves source markers at every level of a nested list", () => {
    const source = "- outer one\n  - inner a\n  - inner b\n- outer two\n";
    const edited = canonicalize(source).replace("inner b", "inner beta");

    const merged = merge(source, edited);

    expect(merged).toBe("- outer one\n  - inner a\n  - inner beta\n- outer two\n");
    expectEquivalent(merged, edited);
  });

  it("preserves an ordered list's own delimiters around the edited item", () => {
    const source = "1) first\n2) second\n3) third\n";
    const edited = canonicalize(source).replace("second", "segundo");

    const merged = merge(source, edited);

    expect(merged).toBe("1) first\n2) segundo\n3) third\n");
    expectEquivalent(merged, edited);
  });

  it("edits one paragraph of a blockquote without touching its siblings", () => {
    const source = "> para one\n>\n> para __two__\n\nAfter.\n";
    const edited = canonicalize(source).replace("para one", "para uno");

    const merged = merge(source, edited);

    expect(merged).toBe("> para uno\n>\n> para __two__\n\nAfter.\n");
    expectEquivalent(merged, edited);
  });

  it("falls back to the editor's whole container when splicing its bytes would not parse alike", () => {
    // An inserted item arrives with the editor's `*` bullet; keeping the source's `-` bullets around
    // it would start a new list at each marker change, so the container takes the editor's bytes.
    const source = "Intro.\n\n- a\n- b\n";
    const edited = canonicalize("- a\n- new\n- b\n");

    const merged = merge(source, `Intro.\n\n${edited}`);

    expect(merged).toBe(`Intro.\n\n${edited}`);
    expectEquivalent(merged, `Intro.\n\n${edited}`);
  });

  it("keeps opaque frontmatter and inserts a new block with the editor's spacing", () => {
    const source = "---\ntitle: Runbook\ntags:\n  - infra\n---\n\n# Plan\n\nFirst step.\n";
    const edited = `${canonicalize(source)}\nSecond step.\n`;

    const merged = merge(source, edited);

    expect(merged).toBe(`${source}\nSecond step.\n`);
    expectEquivalent(merged, edited);
  });

  it("absorbs a mid-typing state that no Markdown string parses back to", () => {
    // The editor holds "Hello there " with the space just typed; parsing strips it, so the block's
    // identity is unchanged and the source keeps its bytes.
    expect(merge("Hello\n\nWorld\n", "Hello there \n\nWorld\n")).toBe("Hello there \n\nWorld\n");
    expect(merge("Hello __world__\n", "Hello __world__ \n")).toBe("Hello __world__\n");
  });

  it("keeps source line endings out of the merge's hands", () => {
    // Nothing here converts endings: untouched blocks emit source bytes, and the caller normalizes
    // the endings of whatever the editor contributed.
    const source = "# Heading\r\n\r\nFirst __paragraph__.\r\n\r\n- a\r\n- b\r\n";
    const edited = canonicalize(source).replace("First", "Second");

    expect(merge(source, edited)).toBe(
      "# Heading\r\n\r\nSecond __paragraph__.\r\n\r\n- a\r\n- b\r\n",
    );
  });

  it("empties a document whose every block was deleted, keeping its trailing newline", () => {
    const merged = merge("# Title\n\nBody.\n", "");

    expect(merged).toBe("\n");
    expectEquivalent(merged, "");
  });

  it("fills a document that held nothing but blank lines", () => {
    const merged = merge("\n\n", canonicalize("First words.\n"));

    expectEquivalent(merged, "First words.\n");
  });

  it("replaces every block when the edit replaced the whole document", () => {
    const edited = canonicalize("# Fresh\n\nAll new text.\n");

    const merged = merge("# Old\n\nOld __text__.\n\n- a\n- b\n", edited);

    expect(merged).toBe(edited);
  });

  it("gives up instead of guessing when a document cannot be split", () => {
    expect(mergeEditByBlocks(new DiffMatchPatch(), "a\n", "b\n", () => undefined, canonicalize))
      .toBeUndefined();
  });

  it("gives up when the document holds more distinct blocks than there are key codes", () => {
    const blocks = (count: number): MarkdownBlock => ({
      type: "root",
      start: 0,
      end: count,
      key: `root ${count}`,
      children: Array.from({ length: count }, (_, index) => ({
        type: "paragraph",
        start: index,
        end: index + 1,
        key: `paragraph ${index}`,
        children: [],
      })),
    });

    const merged = mergeEditByBlocks(
      new DiffMatchPatch(),
      "x".repeat(6500),
      "y".repeat(6500),
      (markdown) => blocks(markdown.length),
      canonicalize,
    );

    expect(merged).toBeUndefined();
  });
});
