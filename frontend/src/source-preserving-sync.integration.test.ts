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
