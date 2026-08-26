// @vitest-environment jsdom

import { Editor, editorViewCtx, parserCtx, rootCtx } from "@milkdown/kit/core";
import { commonmark } from "@milkdown/kit/preset/commonmark";
import type { Node } from "@milkdown/kit/prose/model";
import type { EditorView } from "@milkdown/kit/prose/view";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { installOutline } from "./outline";

describe("outline rail", () => {
  let editor: Editor;
  let view: EditorView;
  let refresh: () => void;

  /** Replaces the whole document with the parsed Markdown, like an IDE content push would. */
  function setMarkdown(markdown: string) {
    const parsed: Node | null = editor.ctx.get(parserCtx)(markdown);
    expect(parsed).not.toBeNull();
    view.dispatch(
      view.state.tr.replaceWith(0, view.state.doc.content.size, parsed!.content),
    );
  }

  function headingPos(text: string): number {
    let result = -1;
    view.state.doc.descendants((node, pos) => {
      if (node.type.name === "heading" && node.textContent === text) {
        result = pos;
      }
    });
    return result;
  }

  function items(): HTMLElement[] {
    return [...document.querySelectorAll<HTMLElement>(".milkj-outline-item")];
  }

  beforeAll(async () => {
    const root = document.body.appendChild(document.createElement("div"));
    editor = await Editor.make()
      .config((ctx) => ctx.set(rootCtx, root))
      .use(commonmark)
      .create();
    view = editor.ctx.get(editorViewCtx);
    const outline = installOutline({ getView: () => view });
    refresh = () => outline.refresh();
    // main.ts calls refresh() from its markdownUpdated listener; tests do it directly.
    setMarkdown("# Alpha\n\nbody\n\n## Beta\n\n### Gamma");
    refresh();
  });

  afterAll(async () => {
    await editor.destroy();
  });

  it("lists headings with indent per level", () => {
    expect(items().map((item) => item.textContent)).toEqual(["Alpha", "Beta", "Gamma"]);
    expect(items().map((item) => item.style.paddingLeft)).toEqual(["8px", "20px", "32px"]);
  });

  it("moves the caret to a heading when its entry is clicked", () => {
    items()[1]!.click();

    expect(view.hasFocus()).toBe(true);
    expect(view.state.selection.from).toBe(headingPos("Beta") + 1);
    expect(view.state.selection.to).toBe(headingPos("Beta") + 1);
  });

  it("picks up headings added later without duplicating entries", () => {
    setMarkdown("# Alpha\n\nbody\n\n## Beta\n\n### Gamma\n\n## Delta");
    refresh();

    expect(items().map((item) => item.textContent)).toEqual([
      "Alpha",
      "Beta",
      "Gamma",
      "Delta",
    ]);
  });

  it("keeps entries when an edit elsewhere only moves positions", () => {
    setMarkdown("# Alpha\n\nmore body than before\n\n## Beta\n\n### Gamma");
    refresh();

    expect(items()).toHaveLength(3);
    expect(headingPos("Beta")).toBeGreaterThan(-1);
    items()[2]!.click();
    expect(view.state.selection.from).toBe(headingPos("Gamma") + 1);
  });
});
