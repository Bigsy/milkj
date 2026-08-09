// @vitest-environment jsdom

import { Editor, parserCtx, rootCtx, serializerCtx } from "@milkdown/kit/core";
import { commonmark } from "@milkdown/kit/preset/commonmark";
import { gfm } from "@milkdown/kit/preset/gfm";
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
});
