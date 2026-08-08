import type { Node as ProseMirrorNode } from "@milkdown/kit/prose/model";
import { Plugin, PluginKey } from "@milkdown/kit/prose/state";
import { Decoration, DecorationSet } from "@milkdown/kit/prose/view";

export interface ProjectLinksHost {
  navigate(href: string): void;
}

export interface BareProjectFileLink {
  from: number;
  to: number;
  href: string;
}

const SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:/;
const LINE_ONLY = /^#L[1-9][0-9]*(?:-L[1-9][0-9]*)?$/i;
const BARE_PROJECT_PATH = new RegExp(
  [
    "file:\\/\\/[^\\s<>\\\"'`]+",
    "(?:\\.{1,2}\\/|\\/)?(?:[A-Za-z0-9._~%+@-]+\\/)+" +
      "[A-Za-z0-9._~%+@-]+(?:#L[1-9][0-9]*(?:-L[1-9][0-9]*)?)?",
    "#L[1-9][0-9]*(?:-L[1-9][0-9]*)?",
  ].join("|"),
  "gi",
);
const PROJECT_LINKS_KEY = new PluginKey<DecorationSet>("milkj-project-links");

/** Installs one delegated listener that survives Crepe replacing the editor DOM. */
export function installProjectLinks(
  host: ProjectLinksHost,
  page: Document = document,
): () => void {
  const onClick = (event: MouseEvent) => {
    if (event.button !== 0 || (!event.ctrlKey && !event.metaKey)) {
      return;
    }

    const element = event.target instanceof Element
      ? event.target
      : event.target instanceof Node
        ? event.target.parentElement
        : null;
    const link = element?.closest<HTMLElement>("a[href], [data-milkj-project-href]");
    if (!link) {
      return;
    }

    // No modifier-clicked anchor may reach JCEF's navigation or popup handling.
    event.preventDefault();
    event.stopPropagation();

    const href = link.matches("a[href]")
      ? link.getAttribute("href")
      : link.getAttribute("data-milkj-project-href");
    if (href !== null && isProjectFileCandidate(href)) {
      host.navigate(href);
    }
  };

  page.addEventListener("click", onClick, true);
  return () => page.removeEventListener("click", onClick, true);
}

/** Adds link-like DOM decorations without changing the ProseMirror document or Markdown source. */
export function createProjectLinksPlugin(): Plugin<DecorationSet> {
  return new Plugin<DecorationSet>({
    key: PROJECT_LINKS_KEY,
    state: {
      init: (_config, state) => decorationsForBareProjectPaths(state.doc),
      apply: (transaction, previous) => transaction.docChanged
        ? decorationsForBareProjectPaths(transaction.doc)
        : previous,
    },
    props: {
      decorations: (state) => PROJECT_LINKS_KEY.getState(state) ?? DecorationSet.empty,
    },
  });
}

export function findBareProjectFileLinks(text: string): BareProjectFileLink[] {
  const links: BareProjectFileLink[] = [];
  BARE_PROJECT_PATH.lastIndex = 0;
  for (let match = BARE_PROJECT_PATH.exec(text); match; match = BARE_PROJECT_PATH.exec(text)) {
    const href = trimFileUrlPunctuation(match[0]);
    const from = match.index;
    const previous = from > 0 ? text[from - 1] : "";
    const next = text[from + match[0].length] ?? "";
    if (
      href &&
      previous !== ":" &&
      previous !== "/" &&
      previous !== "\\" &&
      next !== "?" &&
      next !== "#" &&
      next !== "\\" &&
      next !== "/" &&
      isUsefulBarePath(href) &&
      isProjectFileCandidate(href)
    ) {
      links.push({ from, to: from + href.length, href });
    }
  }
  return links;
}

function decorationsForBareProjectPaths(doc: ProseMirrorNode): DecorationSet {
  const decorations: Decoration[] = [];
  doc.descendants((node, position) => {
    if (!node.isText || !node.text || node.marks.some((mark) => mark.type.name === "link")) {
      return;
    }
    for (const link of findBareProjectFileLinks(node.text)) {
      decorations.push(Decoration.inline(position + link.from, position + link.to, {
        class: "milkj-project-link",
        "data-milkj-project-href": link.href,
      }));
    }
  });
  return DecorationSet.create(doc, decorations);
}

function isUsefulBarePath(href: string): boolean {
  if (/^(?:file:\/\/|\.{1,2}\/|\/|#L)/i.test(href)) {
    return true;
  }
  const path = href.split("#", 1)[0];
  const lastSegment = path.substring(path.lastIndexOf("/") + 1);
  return (path.match(/\//g)?.length ?? 0) >= 2 || lastSegment.includes(".") || /#L/i.test(href);
}

function trimFileUrlPunctuation(value: string): string {
  return value.replace(/[.,;!?)\]}]+$/, "");
}

export function isProjectFileCandidate(href: string): boolean {
  if (!href || href.includes("\\") || href.startsWith("//")) {
    return false;
  }
  if (href.startsWith("#")) {
    return LINE_ONLY.test(href);
  }
  const scheme = SCHEME.exec(href)?.[0];
  if (scheme) {
    return scheme.toLowerCase() === "file:" && /^file:\/\//i.test(href);
  }
  return true;
}
