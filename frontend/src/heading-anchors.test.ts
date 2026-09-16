// @vitest-environment jsdom

import { Editor, editorViewCtx, parserCtx, rootCtx } from "@milkdown/kit/core";
import { commonmark } from "@milkdown/kit/preset/commonmark";
import type { Node } from "@milkdown/kit/prose/model";
import type { EditorView } from "@milkdown/kit/prose/view";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  anchorFragment,
  headingAnchors,
  navigateToHeadingAnchor,
  resolveHeadingAnchor,
  slugifyHeading,
} from "./heading-anchors";

describe("heading slugs", () => {
  it.each([
    ["Getting Started", "getting-started"],
    ["C++ API & More!", "c-api--more"],
    ["snake_case and re-use", "snake_case-and-re-use"],
    ["  Ünïcode Wörds  ", "ünïcode-wörds"],
    ["Step 1.2: `code`", "step-12-code"],
  ])("slugifies %j like GitHub", (text, slug) => {
    expect(slugifyHeading(text)).toBe(slug);
  });

  it.each([
    ["#usage", "usage"],
    ["#Getting%20Started", "Getting Started"],
    ["#bad%", "bad%"],
  ])("decodes the fragment of %s", (href, fragment) => {
    expect(anchorFragment(href)).toBe(fragment);
  });

  it.each(["#", "usage", "https://example.com/#x"])("has no fragment for %s", (href) => {
    expect(anchorFragment(href)).toBeUndefined();
  });
});

describe("heading anchors in a document", () => {
  let editor: Editor;
  let view: EditorView;

  function setMarkdown(markdown: string) {
    const parsed: Node | null = editor.ctx.get(parserCtx)(markdown);
    expect(parsed).not.toBeNull();
    view.dispatch(view.state.tr.replaceWith(0, view.state.doc.content.size, parsed!.content));
  }

  /** Position of the first heading with this text. */
  function headingPos(text: string): number {
    let result = -1;
    view.state.doc.descendants((node, pos) => {
      if (result === -1 && node.type.name === "heading" && node.textContent === text) {
        result = pos;
      }
    });
    return result;
  }

  beforeAll(async () => {
    const root = document.body.appendChild(document.createElement("div"));
    editor = await Editor.make()
      .config((ctx) => ctx.set(rootCtx, root))
      .use(commonmark)
      .create();
    view = editor.ctx.get(editorViewCtx);
    setMarkdown(
      "# Getting Started\n\nintro\n\n## Notes\n\nfirst\n\n## Notes\n\nsecond\n\n## Re-use & snake_case\n",
    );
  });

  afterAll(async () => {
    await editor.destroy();
  });

  it("dedupes repeated headings the way GitHub does", () => {
    expect(headingAnchors(view.state.doc).map((anchor) => anchor.slug)).toEqual([
      "getting-started",
      "notes",
      "notes-1",
      "re-use--snake_case",
    ]);
  });

  it.each([
    ["#getting-started", "Getting Started"],
    ["#Getting%20Started", "Getting Started"],
    ["#GETTING-STARTED", "Getting Started"],
    ["#user-content-notes", "Notes"],
    ["#re-use--snake_case", "Re-use & snake_case"],
    // Milkdown's own id rule keeps punctuation; the `&` arrives percent-encoded in a link.
    ["#re-use-%26-snake_case", "Re-use & snake_case"],
  ])("resolves %s", (href, text) => {
    expect(resolveHeadingAnchor(view.state.doc, href)?.pos).toBe(headingPos(text));
  });

  it("resolves the deduplicated slug to the later duplicate", () => {
    const [first, second] = headingAnchors(view.state.doc).filter((anchor) => anchor.text === "Notes");
    expect(resolveHeadingAnchor(view.state.doc, "#notes")?.pos).toBe(first!.pos);
    expect(resolveHeadingAnchor(view.state.doc, "#notes-1")?.pos).toBe(second!.pos);
    // Milkdown's own duplicate suffix.
    expect(resolveHeadingAnchor(view.state.doc, "#notes-#2")?.pos).toBe(second!.pos);
  });

  it.each(["#missing", "#", "#L12"])("resolves nothing for %s", (href) => {
    expect(resolveHeadingAnchor(view.state.doc, href)).toBeUndefined();
  });

  it("moves the caret to the heading and focuses the editor", () => {
    expect(navigateToHeadingAnchor(view, "#notes-1")).toBe(true);

    expect(view.hasFocus()).toBe(true);
    const second = headingAnchors(view.state.doc).filter((anchor) => anchor.text === "Notes")[1]!;
    expect(view.state.selection.from).toBe(second.pos + 1);
    expect(view.state.selection.empty).toBe(true);
  });

  it("leaves the selection alone for an unknown fragment", () => {
    const before = view.state.selection;
    expect(navigateToHeadingAnchor(view, "#nowhere")).toBe(false);
    expect(view.state.selection.eq(before)).toBe(true);
  });
});
