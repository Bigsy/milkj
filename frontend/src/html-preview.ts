import DOMPurify from "dompurify";
import type { Node as ProseMirrorNode } from "@milkdown/kit/prose/model";
import { Plugin } from "@milkdown/kit/prose/state";
import type { NodeView } from "@milkdown/kit/prose/view";

export interface HtmlPreviewOptions {
  resolveImageUrl(src: string): string;
}

// GitHub supports a deliberately limited HTML subset in Markdown. Keep this list conservative:
// project documentation is untrusted input, and a preview never needs executable or form content.
const ALLOWED_TAGS = [
  "a",
  "abbr",
  "b",
  "blockquote",
  "br",
  "code",
  "dd",
  "del",
  "details",
  "div",
  "dl",
  "dt",
  "em",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "hr",
  "i",
  "img",
  "kbd",
  "li",
  "ol",
  "p",
  "pre",
  "s",
  "samp",
  "small",
  "span",
  "strong",
  "sub",
  "summary",
  "sup",
  "table",
  "tbody",
  "td",
  "tfoot",
  "th",
  "thead",
  "tr",
  "ul",
  "var",
] as const;

const ALLOWED_ATTRIBUTES = [
  "abbr",
  "align",
  "alt",
  "axis",
  "border",
  "cellpadding",
  "cellspacing",
  "colspan",
  "headers",
  "height",
  "href",
  "name",
  "open",
  "rel",
  "rowspan",
  "scope",
  "src",
  "start",
  "summary",
  "target",
  "title",
  "type",
  "valign",
  "value",
  "width",
] as const;

/** Renders a sanitized, inert view of one Milkdown raw-HTML atom. */
export function renderHtmlPreview(
  value: string,
  options: HtmlPreviewOptions,
): HTMLSpanElement {
  const preview = document.createElement("span");
  preview.className = "milkj-html-preview";
  preview.contentEditable = "false";
  preview.dataset.milkjHtmlPreview = "true";

  const fragment = DOMPurify.sanitize(value, {
    ALLOWED_TAGS: [...ALLOWED_TAGS],
    ALLOWED_ATTR: [...ALLOWED_ATTRIBUTES],
    ALLOW_ARIA_ATTR: true,
    ALLOW_DATA_ATTR: false,
    RETURN_DOM_FRAGMENT: true,
  });

  fragment.querySelectorAll("img[src]").forEach((image) => {
    const src = image.getAttribute("src");
    if (!src) return;
    image.setAttribute("src", options.resolveImageUrl(src));
    image.setAttribute("loading", "lazy");
    image.setAttribute("decoding", "async");
    image.setAttribute("draggable", "false");
  });
  fragment.querySelectorAll("a[href]").forEach((anchor) => {
    anchor.setAttribute("rel", "noopener noreferrer");
  });

  preview.append(fragment);
  return preview;
}

/** Replaces Milkdown's escaped raw-HTML text with a safe visual preview. */
export function createHtmlPreviewPlugin(options: HtmlPreviewOptions): Plugin {
  return new Plugin({
    props: {
      nodeViews: {
        html: (node) => new HtmlPreviewNodeView(node, options),
      },
    },
  });
}

class HtmlPreviewNodeView implements NodeView {
  dom: HTMLSpanElement;

  constructor(
    private node: ProseMirrorNode,
    private readonly options: HtmlPreviewOptions,
  ) {
    this.dom = renderHtmlPreview(String(node.attrs.value ?? ""), options);
  }

  update(node: ProseMirrorNode): boolean {
    if (node.type !== this.node.type) return false;
    if (node.attrs.value !== this.node.attrs.value) {
      const replacement = renderHtmlPreview(String(node.attrs.value ?? ""), this.options);
      this.dom.replaceChildren(...replacement.childNodes);
    }
    this.node = node;
    return true;
  }

  ignoreMutation(): boolean {
    return true;
  }
}
