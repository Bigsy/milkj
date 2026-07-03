import type { Command } from "@milkdown/kit/prose/state";
import type { EditorView } from "@milkdown/kit/prose/view";
import {
  findNext,
  findPrev,
  replaceAll as replaceAllMatches,
  replaceNext,
  SearchQuery,
  setSearchState,
} from "prosemirror-search";

// In-page find/replace bar for the Milkdown editor. prosemirror-search supplies the match
// decorations and commands; this module owns the UI, the keyboard entry points, and match
// counting. The bar lives on document.body — outside the editor root — so Crepe rebuilds
// (theme/placeholder changes) don't tear it down.

export interface FindBarHost {
  // Current ProseMirror view, or undefined while the editor is (re)building.
  getView(): EditorView | undefined;
  // Called before a replace mutates the doc, so the host treats it as a user edit
  // (e.g. lifts markdown-echo suppression) rather than an IDE-driven change.
  onUserEdit(): void;
}

export interface FindBar {
  // Recompute the match count after the document changed.
  refresh(): void;
  // Hide/disable replace when the file is not writable.
  setReadonly(readonly: boolean): void;
  // Re-apply the active query after the editor is rebuilt (fresh plugin state).
  syncToView(): void;
}

// The doc is scanned per keystroke to produce the count; cap the scan so a degenerate
// query on a huge doc can't hang the page.
const MAX_COUNTED_MATCHES = 9999;

export function installFindBar(host: FindBarHost): FindBar {
  let open = false;
  let readonly = false;
  let caseSensitive = false;

  const bar = document.createElement("div");
  bar.className = "milkj-findbar";
  bar.hidden = true;
  bar.innerHTML = `
    <div class="milkj-findbar-row">
      <input class="milkj-findbar-search" type="text" placeholder="Find" spellcheck="false">
      <button type="button" class="milkj-findbar-case" title="Match case" aria-pressed="false">Aa</button>
      <span class="milkj-findbar-count"></span>
      <button type="button" class="milkj-findbar-prev" title="Previous match (Shift+Enter)">&#8593;</button>
      <button type="button" class="milkj-findbar-next" title="Next match (Enter)">&#8595;</button>
      <button type="button" class="milkj-findbar-close" title="Close (Escape)">&#10005;</button>
    </div>
    <div class="milkj-findbar-row milkj-findbar-replace-row">
      <input class="milkj-findbar-replace" type="text" placeholder="Replace" spellcheck="false">
      <button type="button" class="milkj-findbar-replace-one">Replace</button>
      <button type="button" class="milkj-findbar-replace-all">All</button>
    </div>
  `;

  const searchInput = bar.querySelector<HTMLInputElement>(".milkj-findbar-search")!;
  const replaceInput = bar.querySelector<HTMLInputElement>(".milkj-findbar-replace")!;
  const caseButton = bar.querySelector<HTMLButtonElement>(".milkj-findbar-case")!;
  const countLabel = bar.querySelector<HTMLSpanElement>(".milkj-findbar-count")!;
  const replaceRow = bar.querySelector<HTMLDivElement>(".milkj-findbar-replace-row")!;

  function buildQuery(): SearchQuery {
    return new SearchQuery({
      search: searchInput.value,
      caseSensitive,
      replace: replaceInput.value,
    });
  }

  function applyQuery() {
    const view = host.getView();
    if (view) {
      view.dispatch(setSearchState(view.state.tr, buildQuery()));
    }
    updateCount();
  }

  function clearQuery() {
    const view = host.getView();
    view?.dispatch(setSearchState(view.state.tr, new SearchQuery({ search: "" })));
  }

  function updateCount() {
    const view = host.getView();
    const query = buildQuery();
    if (!view || !query.valid) {
      countLabel.textContent = "";
      countLabel.classList.remove("milkj-findbar-no-results");
      return;
    }
    const { state } = view;
    const { from: selFrom, to: selTo } = state.selection;
    let total = 0;
    let active = 0;
    let pos = 0;
    while (total < MAX_COUNTED_MATCHES) {
      // findNext with an explicit range does not wrap, so this walk terminates.
      const result = query.findNext(state, pos);
      if (!result) {
        break;
      }
      total += 1;
      if (result.from === selFrom && result.to === selTo) {
        active = total;
      }
      pos = result.to > result.from ? result.to : result.from + 1;
    }
    countLabel.textContent =
      total === 0 ? "No results" : active > 0 ? `${active}/${total}` : `${total}`;
    countLabel.classList.toggle("milkj-findbar-no-results", total === 0);
  }

  function run(command: Command) {
    const view = host.getView();
    if (view) {
      command(view.state, view.dispatch);
    }
    updateCount();
  }

  function openBar() {
    const view = host.getView();
    if (view) {
      // Prefill from a short single-line selection, like every editor's find does.
      const { from, to } = view.state.selection;
      if (to > from && to - from < 200) {
        const text = view.state.doc.textBetween(from, to, "\n");
        if (text && !text.includes("\n")) {
          searchInput.value = text;
        }
      }
    }
    open = true;
    bar.hidden = false;
    applyQuery();
    searchInput.focus();
    searchInput.select();
  }

  function closeBar() {
    open = false;
    bar.hidden = true;
    clearQuery();
    host.getView()?.focus();
  }

  function doReplace(all: boolean) {
    if (readonly) {
      return;
    }
    host.onUserEdit();
    // Sync first so the replace text in the plugin state matches the input.
    applyQuery();
    run(all ? replaceAllMatches : replaceNext);
  }

  searchInput.addEventListener("input", applyQuery);
  searchInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      run(event.shiftKey ? findPrev : findNext);
    }
  });
  replaceInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      doReplace(false);
    }
  });

  caseButton.addEventListener("click", () => {
    caseSensitive = !caseSensitive;
    caseButton.setAttribute("aria-pressed", String(caseSensitive));
    applyQuery();
    searchInput.focus();
  });
  bar.querySelector(".milkj-findbar-prev")!.addEventListener("click", () => run(findPrev));
  bar.querySelector(".milkj-findbar-next")!.addEventListener("click", () => run(findNext));
  bar.querySelector(".milkj-findbar-close")!.addEventListener("click", closeBar);
  bar.querySelector(".milkj-findbar-replace-one")!.addEventListener("click", () => doReplace(false));
  bar.querySelector(".milkj-findbar-replace-all")!.addEventListener("click", () => doReplace(true));

  // Keep focus in the inputs when clicking bar buttons, so Enter keeps cycling matches.
  for (const button of bar.querySelectorAll("button")) {
    button.addEventListener("mousedown", (event) => event.preventDefault());
  }

  window.addEventListener(
    "keydown",
    (event) => {
      const mod = event.metaKey || event.ctrlKey;
      if (mod && !event.shiftKey && !event.altKey && event.key.toLowerCase() === "f") {
        event.preventDefault();
        openBar();
        return;
      }
      if (!open) {
        return;
      }
      if ((mod && event.key.toLowerCase() === "g") || event.key === "F3") {
        event.preventDefault();
        run(event.shiftKey ? findPrev : findNext);
        return;
      }
      if (event.key === "Escape" && bar.contains(document.activeElement)) {
        event.preventDefault();
        closeBar();
      }
    },
    { capture: true },
  );

  document.body.append(bar);

  const style = document.createElement("style");
  style.textContent = `
    .milkj-findbar {
      position: fixed;
      top: 12px;
      right: 20px;
      z-index: 100;
      display: flex;
      flex-direction: column;
      gap: 6px;
      padding: 8px;
      border: 1px solid var(--milkj-border);
      border-radius: 8px;
      background: var(--milkj-bg);
      color: var(--milkj-fg);
      box-shadow: 0 2px 8px rgba(0, 0, 0, 0.25);
      font-family: system-ui, sans-serif;
      font-size: 13px;
    }

    .milkj-findbar-row {
      display: flex;
      align-items: center;
      gap: 4px;
    }

    /* display:flex above would otherwise override the hidden attribute's display:none. */
    .milkj-findbar[hidden],
    .milkj-findbar-row[hidden] {
      display: none;
    }

    .milkj-findbar input {
      flex: 1;
      min-width: 200px;
      padding: 4px 8px;
      border: 1px solid var(--milkj-border);
      border-radius: 4px;
      background: var(--milkj-bg);
      color: var(--milkj-fg);
      font: inherit;
      outline: none;
    }

    .milkj-findbar input:focus {
      border-color: #3574f0;
    }

    .milkj-findbar button {
      padding: 4px 6px;
      border: none;
      border-radius: 4px;
      background: transparent;
      color: inherit;
      font: inherit;
      cursor: pointer;
    }

    .milkj-findbar button:hover {
      background: var(--milkj-border);
    }

    .milkj-findbar-case[aria-pressed="true"] {
      background: var(--milkj-border);
    }

    .milkj-findbar-count {
      min-width: 60px;
      text-align: center;
      opacity: 0.8;
      font-variant-numeric: tabular-nums;
      white-space: nowrap;
    }

    .milkj-findbar-count.milkj-findbar-no-results {
      color: var(--crepe-color-error, #ba1a1a);
      opacity: 1;
    }

    .milkj-findbar-replace-row button {
      border: 1px solid var(--milkj-border);
      padding: 4px 8px;
    }

    /* Match decorations render inside .milkdown, where the crepe variables are defined. */
    .ProseMirror-search-match {
      background: color-mix(in srgb, var(--crepe-color-primary) 22%, transparent);
      border-radius: 2px;
    }

    .ProseMirror-active-search-match {
      background: color-mix(in srgb, var(--crepe-color-primary) 42%, transparent);
      box-shadow: 0 0 0 1px var(--crepe-color-primary);
      border-radius: 2px;
    }
  `;
  document.head.append(style);

  return {
    refresh() {
      if (open) {
        updateCount();
      }
    },
    setReadonly(value: boolean) {
      readonly = value;
      replaceRow.hidden = value;
    },
    syncToView() {
      if (open) {
        applyQuery();
      }
    },
  };
}
