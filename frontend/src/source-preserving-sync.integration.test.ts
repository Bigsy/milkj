// @vitest-environment jsdom

import { Editor, editorViewCtx, parserCtx, rootCtx, serializerCtx } from "@milkdown/kit/core";
import { commonmark } from "@milkdown/kit/preset/commonmark";
import { gfm } from "@milkdown/kit/preset/gfm";
import { TextSelection } from "@milkdown/kit/prose/state";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mergeSourcePreservingEdit } from "./source-preserving-sync";

describe("source-preserving merge with the Milkdown parser", () => {
  let editor: Editor;

  beforeAll(async () => {
    const root = document.body.appendChild(document.createElement("div"));
    editor = await Editor.make()
      .config((ctx) => ctx.set(rootCtx, root))
      .use(commonmark)
      .use(gfm)
      .create();
  });

  afterAll(async () => {
    await editor.destroy();
  });

  function canonicalize(markdown: string): string {
    return editor.action((ctx) => {
      const document = ctx.get(parserCtx)(markdown);
      return ctx.get(serializerCtx)(document);
    });
  }

  it("preserves real YAML frontmatter while editing body prose", () => {
    const source = `---
title: MilkJ
tags:
  - markdown
  - wysiwyg
---

# Plan

Keep __this emphasis__ exactly.

- First item
- Second item

Edit this sentence[^note].

[^note]: Preserve this unsupported extension exactly.
`;
    const editedCanonical = canonicalize(source)
      .replace(" exactly.", " completely unchanged.");

    const result = mergeSourcePreservingEdit(source, editedCanonical, canonicalize);

    expect(result).toEqual({
      ok: true,
      markdown: source.replace(
        "Keep __this emphasis__ exactly.",
        "Keep __this emphasis__ completely unchanged.",
      ),
    });
  });

  it("leaves raw HTML byte-for-byte intact when another paragraph changes", () => {
    const source = `<details data-owner="MilkJ">
<summary>Advanced</summary>

Raw HTML payload.
</details>

Edit this paragraph.
`;
    const editedCanonical = canonicalize(source)
      .replace("Edit this paragraph.", "This paragraph was edited.");

    const result = mergeSourcePreservingEdit(source, editedCanonical, canonicalize);

    expect(result).toEqual({
      ok: true,
      markdown: source.replace("Edit this paragraph.", "This paragraph was edited."),
    });
  });

  it("merges an edit far below a table whose canonical padding shifts every position", () => {
    // Regression: serializing a GFM table pads every cell to the widest column, so a table with
    // one long cell shifts everything below it by more than patch_apply's fuzzy-match radius
    // (a few hundred characters). Edits below such a table failed with "could not map".
    const longCell = "a very long confirmation note that widens this column considerably " +
      "and keeps going for a couple of hundred characters so each of the other rows in this " +
      "column gets padded all the way out to this width by the canonical serializer";
    const rows = Array.from({ length: 12 }, (_, i) => `| key ${i} | value ${i} |`).join("\n");
    const source = `# Runbook

| Thing | Value |
| --- | --- |
| note | ${longCell} |
${rows}

## Steps

Edit this sentence far below the table.
`;
    const canonical = canonicalize(source);
    // The premise of the regression: canonical padding must shift later content by more than
    // patch_apply's effective search radius (~500 chars).
    expect(canonical.indexOf("## Steps") - source.indexOf("## Steps")).toBeGreaterThan(1000);

    const edited = canonical.replace("far below the table", "way below the table");
    const result = mergeSourcePreservingEdit(source, edited, canonicalize);

    expect(result).toEqual({
      ok: true,
      markdown: source.replace("far below the table", "way below the table"),
    });
  });

  it("merges a row deletion inside a table whose canonical form is heavily padded", () => {
    // Regression: the deleted hunk's text is the CANONICAL row — padded to the widest column —
    // which never exists in the unpadded source, so fuzzy patching can't apply it anywhere. The
    // line-granular fallback replaces the edited table with the editor's version of it while
    // everything outside the table keeps its source bytes (the __bold__ paragraph proves that).
    const longCell = "an intentionally long value that makes the canonical serializer pad every " +
      "other row in this column out to a couple of hundred characters of alignment spaces";
    const source = `# Runbook

Keep __this__ formatting.

| Thing | Value |
| --- | --- |
| note | ${longCell} |
| keep one | value 1 |
| delete me | value 2 |
| keep two | value 3 |

Trailing paragraph.
`;
    const canonical = canonicalize(source);
    const deletedRow = canonical.match(/^\| delete me[^\n]*\n/m)![0];
    expect(deletedRow.length).toBeGreaterThan(100);
    // Re-canonicalize so the remaining rows re-pad, exactly as the editor serializes a deletion.
    const edited = canonicalize(canonical.replace(deletedRow, ""));

    const result = mergeSourcePreservingEdit(source, edited, canonicalize);

    // The edited table takes the editor's (padded) form; untouched blocks keep source formatting.
    expect(result).toEqual({
      ok: true,
      markdown: edited.replace("Keep **this** formatting.", "Keep __this__ formatting."),
    });
  });

  it("merges the mid-typing state where the line ends in a just-typed space", () => {
    // Regression: pausing after typing a space serialized "Hello there \n…", whose trailing space
    // does not survive a parse round-trip; the merge rejected it and the editor content was
    // reverted under the user's caret.
    const source = "Hello\n\nWorld\n";
    const serialized = editor.action((ctx) => {
      const view = ctx.get(editorViewCtx);
      const doc = ctx.get(parserCtx)(source);
      view.dispatch(view.state.tr.replaceWith(0, view.state.doc.content.size, doc.content));
      // Caret at the end of "Hello", then type " there " exactly as a user pausing mid-word would.
      view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 6)));
      view.dispatch(view.state.tr.insertText(" there "));
      return ctx.get(serializerCtx)(view.state.doc);
    });
    expect(serialized).toBe("Hello there \n\nWorld\n");

    const result = mergeSourcePreservingEdit(source, serialized, canonicalize);

    expect(result).toEqual({ ok: true, markdown: "Hello there \n\nWorld\n" });
  });
});
