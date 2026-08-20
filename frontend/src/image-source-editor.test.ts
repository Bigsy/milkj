// @vitest-environment jsdom

import { imageBlockComponent } from "@milkdown/kit/component/image-block";
import { Editor, editorViewCtx, parserCtx, rootCtx, serializerCtx } from "@milkdown/kit/core";
import { commonmark } from "@milkdown/kit/preset/commonmark";
import { NodeSelection } from "@milkdown/kit/prose/state";
import { $prose } from "@milkdown/kit/utils";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createImageSourceEditorPlugin,
  parseImageSource,
  serializeImageNode,
} from "./image-source-editor";

describe("image source codec", () => {
  let editor: Editor;

  beforeAll(async () => {
    const root = document.body.appendChild(document.createElement("div"));
    editor = await Editor.make()
      .config((ctx) => ctx.set(rootCtx, root))
      .use(commonmark)
      .use(imageBlockComponent)
      .use($prose((ctx) => createImageSourceEditorPlugin({
        codec: {
          serialize: (node, schema) => serializeImageNode(
            node,
            schema,
            ctx.get(serializerCtx),
          ),
          parse: (source, kind) => parseImageSource(source, kind, ctx.get(parserCtx)),
        },
      })))
      .create();
  });

  afterAll(async () => {
    await editor.destroy();
  });

  it("round-trips an editable block image source", () => {
    const parsed = editor.ctx.get(parserCtx)(
      '![1.00](https://example.test/original.png "Original caption")',
    )!;
    const image = parsed.firstChild!;
    expect(image.type.name).toBe("image-block");

    const source = serializeImageNode(
      image,
      parsed.type.schema,
      editor.ctx.get(serializerCtx),
    );
    expect(source).toContain("https://example.test/original.png");

    expect(parseImageSource(
      '![0.75](../images/edited.png "Edited caption")',
      "image-block",
      editor.ctx.get(parserCtx),
    )).toMatchObject({
      src: "../images/edited.png",
      caption: "Edited caption",
      ratio: 0.75,
    });
  });

  it("keeps inline-image alt and title semantics while parsing the source alone", () => {
    expect(parseImageSource(
      '![Useful alt](./icon.svg "Tooltip")',
      "image",
      editor.ctx.get(parserCtx),
    )).toMatchObject({
      src: "./icon.svg",
      alt: "Useful alt",
      title: "Tooltip",
    });
  });

  it("rejects non-image or multi-block source", () => {
    expect(parseImageSource("plain text", "image-block", editor.ctx.get(parserCtx)))
      .toBeUndefined();
    expect(parseImageSource("![1.00](one.png)\n\nMore", "image-block", editor.ctx.get(parserCtx)))
      .toBeUndefined();
  });

  it("opens for a selected image and commits edited Markdown on Enter", async () => {
    const view = editor.ctx.get(editorViewCtx);
    const parsed = editor.ctx.get(parserCtx)("![1.00](before.png \"Before\")")!;
    const transaction = view.state.tr.replaceWith(0, view.state.doc.content.size, parsed.content);
    view.dispatch(transaction.setSelection(NodeSelection.create(transaction.doc, 0)));
    await Promise.resolve();

    const input = document.querySelector<HTMLInputElement>(".milkj-image-source-editor__input")!;
    expect(input.value).toContain("before.png");
    expect(document.activeElement).toBe(input);

    input.value = '![0.80](after.png "After")';
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));

    expect(view.state.doc.firstChild?.attrs).toMatchObject({
      src: "after.png",
      caption: "After",
      ratio: 0.8,
    });
  });
});
