import type { Node as ProseMirrorNode } from "@milkdown/kit/prose/model";
import { TextSelection } from "@milkdown/kit/prose/state";
import type { EditorView } from "@milkdown/kit/prose/view";

// In-document heading links, `[Usage](#usage)`, as GitHub renders them in a README. GitHub derives
// the fragment from the heading text (lowercase, punctuation dropped, spaces to hyphens, later
// duplicates suffixed -1, -2, …). Milkdown's own heading ids follow a similar but not identical
// rule (punctuation kept, duplicates suffixed -#2, -#3, …), so both are accepted, plus a
// case-insensitive match on the heading text for hand-written fragments such as `#Usage`.

export interface HeadingAnchor {
  // Document position before the heading node; the caret target is pos + 1.
  pos: number;
  text: string;
  // GitHub-style slug, made unique within the document.
  slug: string;
  // The same slug before deduplication: what a table of contents that ignores duplicates emits.
  baseSlug: string;
  // Milkdown's own id attribute, when the schema provides one.
  id: string;
}

/** GitHub's heading slug: lowercase; keep letters, numbers, marks, `-` and `_`; spaces to hyphens. */
export function slugifyHeading(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\p{M}\s_-]/gu, "")
    .replace(/\s/g, "-");
}

export function headingAnchors(doc: ProseMirrorNode): HeadingAnchor[] {
  const anchors: HeadingAnchor[] = [];
  const seen = new Map<string, number>();
  doc.descendants((node, pos) => {
    if (node.type.name !== "heading") {
      return;
    }
    const text = node.textContent.trim();
    const baseSlug = slugifyHeading(text);
    const duplicates = seen.get(baseSlug) ?? 0;
    seen.set(baseSlug, duplicates + 1);
    anchors.push({
      pos,
      text,
      baseSlug,
      slug: duplicates === 0 ? baseSlug : `${baseSlug}-${duplicates}`,
      id: typeof node.attrs.id === "string" ? node.attrs.id : "",
    });
  });
  return anchors;
}

/** The decoded text after `#`, or undefined when the href is not a fragment link. */
export function anchorFragment(href: string): string | undefined {
  if (!href.startsWith("#") || href.length < 2) {
    return undefined;
  }
  const raw = href.slice(1);
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

export function resolveHeadingAnchor(
  doc: ProseMirrorNode,
  href: string,
): HeadingAnchor | undefined {
  const fragment = anchorFragment(href);
  if (fragment === undefined) {
    return undefined;
  }
  const wanted = fragment.toLowerCase();
  // GitHub prefixes the ids it renders with `user-content-`; some tools copy that into links.
  const candidates = new Set([wanted, wanted.replace(/^user-content-/, "")]);
  const anchors = headingAnchors(doc);
  const keys: Array<(anchor: HeadingAnchor) => string> = [
    (anchor) => anchor.slug,
    (anchor) => anchor.id.toLowerCase(),
    (anchor) => anchor.baseSlug,
    (anchor) => anchor.text.toLowerCase(),
  ];
  for (const key of keys) {
    const found = anchors.find((anchor) => candidates.has(key(anchor)));
    if (found) {
      return found;
    }
  }
  return undefined;
}

/**
 * Moves the caret to the heading a `#fragment` link points at and scrolls it into view. A
 * selection-only transaction: the document is untouched, so nothing travels back to the IDE.
 */
export function navigateToHeadingAnchor(view: EditorView, href: string): boolean {
  const anchor = resolveHeadingAnchor(view.state.doc, href);
  if (!anchor) {
    return false;
  }
  const { doc, tr } = view.state;
  const position = Math.min(anchor.pos + 1, doc.content.size);
  view.dispatch(tr.setSelection(TextSelection.near(doc.resolve(position), 1)));
  // Like the outline: block-start alignment puts the heading at the top of the viewport rather
  // than wherever tr.scrollIntoView() would leave the caret.
  const dom = view.nodeDOM(anchor.pos);
  if (dom instanceof HTMLElement) {
    dom.scrollIntoView?.({ block: "start" });
  }
  view.focus();
  return true;
}
