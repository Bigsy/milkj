import type { Node as ProseMirrorNode } from "@milkdown/kit/prose/model";
import { TextSelection } from "@milkdown/kit/prose/state";
import type { EditorView } from "@milkdown/kit/prose/view";

// In-page document outline. A collapsible rail on the left lists the document's headings;
// clicking an entry moves the caret to that heading and scrolls it into view, and a scroll
// spy highlights the heading currently near the top of the viewport.
//
// Like the find bar, the rail lives on document.body — outside the editor root — so Crepe
// rebuilds (theme/placeholder changes) don't tear it down. IDE shortcuts don't reliably reach
// a focused JCEF view, so the toggle is both an on-page button and an in-page keyboard entry.
//
// Navigation dispatches a selection-only transaction: the doc is untouched, so this is not a
// user edit and never travels back to IntelliJ.

export interface OutlineHost {
  // Current ProseMirror view, or undefined while the editor is (re)building.
  getView(): EditorView | undefined;
}

export interface Outline {
  // Re-reads headings from the current document; cheap when they are unchanged.
  refresh(): void;
}

interface HeadingEntry {
  // Document position before the heading node; the caret target is pos + 1.
  pos: number;
  level: number;
  text: string;
}

// Viewport y below which a heading counts as "the current one" for the scroll spy.
const SPY_LINE_PX = 120;
// Indentation per level in the rail, capped so h6 does not push text out of the panel.
const MAX_INDENT_STEPS = 4;

export function installOutline(host: OutlineHost): Outline {
  let open = false;
  let entries: HeadingEntry[] = [];
  let activeIndex = -1;
  // Rendering skips when only positions changed (an edit elsewhere in the doc); the entries
  // still carry fresh positions for navigation and scroll spying.
  let fingerprint = "";
  let spyScheduled = false;

  const button = document.createElement("button");
  button.type = "button";
  button.className = "milkj-outline-toggle";
  button.title = "Outline (Ctrl/Cmd+Shift+O)";
  button.setAttribute("aria-label", "Toggle outline");
  button.setAttribute("aria-expanded", "false");
  button.innerHTML =
    '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">' +
    '<path d="M5.5 3.5h9M5.5 8h9M5.5 12.5h9" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>' +
    '<circle cx="2" cy="3.5" r="1.2" fill="currentColor"/>' +
    '<circle cx="2" cy="8" r="1.2" fill="currentColor"/>' +
    '<circle cx="2" cy="12.5" r="1.2" fill="currentColor"/></svg>';

  const rail = document.createElement("nav");
  rail.className = "milkj-outline";
  rail.hidden = true;
  rail.setAttribute("aria-label", "Document outline");
  rail.innerHTML = `
    <div class="milkj-outline-header">Outline</div>
    <div class="milkj-outline-items"></div>
    <div class="milkj-outline-empty" hidden>No headings</div>
  `;

  const itemsEl = rail.querySelector<HTMLDivElement>(".milkj-outline-items")!;
  const emptyEl = rail.querySelector<HTMLDivElement>(".milkj-outline-empty")!;

  function collectHeadings(doc: ProseMirrorNode): HeadingEntry[] {
    const found: HeadingEntry[] = [];
    doc.descendants((node, pos) => {
      if (node.type.name === "heading") {
        found.push({
          pos,
          level: Number(node.attrs.level ?? 1),
          text: node.textContent.trim(),
        });
      }
    });
    return found;
  }

  function domFor(entry: HeadingEntry): HTMLElement | undefined {
    const view = host.getView();
    if (!view) {
      return undefined;
    }
    const dom = view.nodeDOM(entry.pos);
    return dom instanceof HTMLElement ? dom : undefined;
  }

  function setActive(index: number) {
    if (index === activeIndex) {
      return;
    }
    activeIndex = index;
    for (let i = 0; i < itemsEl.children.length; i++) {
      const item = itemsEl.children[i];
      const active = i === index;
      item.classList.toggle("milkj-outline-active", active);
      if (active) {
        item.setAttribute("aria-current", "true");
        // Keep the highlighted entry visible inside the rail without scrolling the page.
        item.scrollIntoView?.({ block: "nearest" });
      } else {
        item.removeAttribute("aria-current");
      }
    }
  }

  /** Picks the last heading above the spy line, or the first heading before any has passed it. */
  function updateActiveFromViewport() {
    spyScheduled = false;
    let next = -1;
    if (open && entries.length > 0) {
      next = 0;
      for (let i = 0; i < entries.length; i++) {
        const dom = domFor(entries[i]);
        if (!dom) {
          break;
        }
        if (dom.getBoundingClientRect().top <= SPY_LINE_PX) {
          next = i;
        } else {
          break;
        }
      }
    }
    setActive(next);
  }

  function scheduleSpy() {
    if (!open || spyScheduled) {
      return;
    }
    spyScheduled = true;
    requestAnimationFrame(updateActiveFromViewport);
  }

  function renderItems() {
    activeIndex = -1;
    const fragment = document.createDocumentFragment();
    entries.forEach((entry) => {
      const item = document.createElement("button");
      item.type = "button";
      item.className = "milkj-outline-item";
      item.textContent = entry.text || "(untitled)";
      item.title = entry.text;
      // Inline style rather than per-level classes: levels are unbounded in the schema.
      item.style.paddingLeft = `${8 + Math.min(entry.level - 1, MAX_INDENT_STEPS) * 12}px`;
      item.addEventListener("click", () => navigate(entry));
      fragment.append(item);
    });
    itemsEl.replaceChildren(fragment);
    emptyEl.hidden = entries.length > 0;
  }

  function navigate(entry: HeadingEntry) {
    const view = host.getView();
    if (!view) {
      return;
    }
    const position = Math.min(entry.pos + 1, view.state.doc.content.size);
    view.dispatch(
      view.state.tr.setSelection(TextSelection.near(view.state.doc.resolve(position), 1)),
    );
    // Scroll the heading itself rather than using tr.scrollIntoView(): block-start alignment
    // lands the heading below the toggle button and above the spy line.
    domFor(entry)?.scrollIntoView?.({ block: "start" });
    view.focus();
    updateActiveFromViewport();
  }

  function setOpen(value: boolean) {
    open = value;
    rail.hidden = !value;
    button.setAttribute("aria-expanded", String(value));
    document.body.classList.toggle("milkj-outline-open", value);
    if (!value) {
      host.getView()?.focus();
    } else {
      updateActiveFromViewport();
    }
  }

  button.addEventListener("click", () => setOpen(!open));

  window.addEventListener(
    "keydown",
    (event) => {
      const mod = event.metaKey || event.ctrlKey;
      if (mod && event.shiftKey && !event.altKey && event.key.toLowerCase() === "o") {
        event.preventDefault();
        setOpen(!open);
        return;
      }
      if (event.key === "Escape" && open && rail.contains(document.activeElement)) {
        event.preventDefault();
        setOpen(false);
      }
    },
    { capture: true },
  );

  // Scroll events do not bubble, but capture on window sees every scroller, including nested
  // CodeMirror blocks whose scrolling can move headings underneath the spy line.
  window.addEventListener("scroll", scheduleSpy, { capture: true, passive: true });

  document.body.append(button, rail);

  const style = document.createElement("style");
  style.textContent = `
    .milkj-outline-toggle {
      position: fixed;
      top: 12px;
      left: 12px;
      z-index: 120;
      display: flex;
      align-items: center;
      justify-content: center;
      width: 28px;
      height: 28px;
      padding: 0;
      border: 1px solid var(--milkj-border);
      border-radius: 6px;
      background: var(--milkj-bg);
      color: var(--milkj-fg);
      cursor: pointer;
      box-shadow: 0 1px 4px rgba(0, 0, 0, 0.15);
    }

    .milkj-outline-toggle:hover {
      border-color: var(--crepe-color-primary, #3574f0);
    }

    .milkj-outline {
      position: fixed;
      top: 0;
      bottom: 0;
      left: 0;
      z-index: 100;
      width: 232px;
      box-sizing: border-box;
      overflow-y: auto;
      padding: 50px 10px 16px;
      border-right: 1px solid var(--milkj-border);
      background: var(--milkj-bg);
      color: var(--milkj-fg);
      font-family: system-ui, sans-serif;
      font-size: 13px;
    }

    /* Push the content instead of covering it, so writing continues beside the rail. */
    body.milkj-outline-open #app {
      padding-left: 256px;
    }

    #app {
      transition: padding-left 0.18s ease;
    }

    .milkj-outline-header {
      margin-bottom: 6px;
      color: var(--crepe-color-on-surface-variant, var(--milkj-fg));
      font-size: 11px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.04em;
    }

    .milkj-outline-item {
      display: block;
      width: 100%;
      box-sizing: border-box;
      padding: 4px 8px;
      border: none;
      border-radius: 5px;
      background: transparent;
      color: inherit;
      font: inherit;
      text-align: left;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      cursor: pointer;
    }

    .milkj-outline-item:hover {
      background: color-mix(in srgb, var(--crepe-color-primary, #3574f0) 10%, transparent);
    }

    .milkj-outline-item.milkj-outline-active {
      background: color-mix(in srgb, var(--crepe-color-primary, #3574f0) 16%, transparent);
      color: var(--crepe-color-on-surface, var(--milkj-fg));
      font-weight: 600;
    }

    .milkj-outline-empty {
      padding: 4px 8px;
      opacity: 0.6;
    }
  `;
  document.head.append(style);

  return {
    refresh() {
      const view = host.getView();
      entries = view ? collectHeadings(view.state.doc) : [];
      const mark = entries.map((entry) => `${entry.level}:${entry.text}`).join("\n");
      if (mark !== fingerprint) {
        fingerprint = mark;
        renderItems();
      }
      scheduleSpy();
    },
  };
}
