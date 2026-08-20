// @vitest-environment jsdom

import { Editor, defaultValueCtx, editorViewCtx, rootCtx, serializerCtx } from "@milkdown/kit/core";
import { commonmark } from "@milkdown/kit/preset/commonmark";
import { gfm } from "@milkdown/kit/preset/gfm";
import { $prose } from "@milkdown/kit/utils";
import { afterEach, describe, expect, it } from "vitest";
import { createHtmlPreviewPlugin, renderHtmlPreview } from "./html-preview";

describe("raw HTML preview", () => {
  afterEach(() => {
    document.body.replaceChildren();
  });

  it("renders the centered header and image-table markup used by GitHub READMEs", () => {
    const preview = renderHtmlPreview(`
<p align="center"><strong>Project</strong></p>
<table>
  <tr><td><img width="467" height="360" alt="Screen" src="docs/screen.png"></td></tr>
</table>`, {
      resolveImageUrl: (src) => `http://milkj.localhost/local/${encodeURIComponent(src)}`,
    });

    expect(preview.querySelector("p")?.getAttribute("align")).toBe("center");
    expect(preview.querySelector("strong")?.textContent).toBe("Project");
    expect(preview.querySelector("table td img")?.getAttribute("src"))
      .toBe("http://milkj.localhost/local/docs%2Fscreen.png");
    expect(preview.querySelector("img")?.getAttribute("width")).toBe("467");
    expect(preview.querySelector("img")?.getAttribute("loading")).toBe("lazy");
    expect(preview.contentEditable).toBe("false");
  });

  it("removes executable content, event handlers, inline styles, and unsafe URLs", () => {
    const preview = renderHtmlPreview(`
<script>window.pwned = true</script>
<iframe src="https://example.test"></iframe>
<table style="position:fixed" onclick="window.pwned=true">
  <tr><td><a class="unsafe" href="javascript:alert(1)" target="_blank">unsafe</a></td></tr>
</table>
<a href="https://example.test" target="_blank">safe</a>
<img src="safe.png" srcset="https://tracker.test/2x 2x" onerror="window.pwned=true">`, {
      resolveImageUrl: (src) => `/local/${src}`,
    });

    expect(preview.querySelector("script, iframe")).toBeNull();
    expect(preview.querySelector("table")?.hasAttribute("style")).toBe(false);
    expect(preview.querySelector("table")?.hasAttribute("onclick")).toBe(false);
    const anchors = preview.querySelectorAll("a");
    expect(anchors[0]?.hasAttribute("href")).toBe(false);
    expect(anchors[1]?.getAttribute("rel")).toBe("noopener noreferrer");
    expect(preview.querySelector("img")?.hasAttribute("srcset")).toBe(false);
    expect(preview.querySelector("img")?.hasAttribute("onerror")).toBe(false);
  });

  it("uses a node view without changing the raw HTML stored in the Markdown document", async () => {
    const root = document.createElement("div");
    document.body.append(root);
    const source = `<table data-owner="docs">
  <tr><td><img src="screen.png" alt="Screen"></td></tr>
</table>`;

    const editor = await Editor.make()
      .config((ctx) => {
        ctx.set(rootCtx, root);
        ctx.set(defaultValueCtx, source);
      })
      .use(commonmark)
      .use(gfm)
      .use($prose(() => createHtmlPreviewPlugin({
        resolveImageUrl: (src) => `/local/${src}`,
      })))
      .create();

    try {
      expect(root.querySelector(".milkj-html-preview table img")?.getAttribute("src"))
        .toBe("/local/screen.png");
      const documentNode = editor.ctx.get(editorViewCtx).state.doc;
      expect(editor.ctx.get(serializerCtx)(documentNode).trim()).toBe(source);
    } finally {
      await editor.destroy();
    }
  });
});
