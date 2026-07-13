import type { Mark, Node as ProseMirrorNode } from "@milkdown/kit/prose/model";
import { Plugin, PluginKey, type EditorState, type Transaction } from "@milkdown/kit/prose/state";
import { Decoration, DecorationSet, type EditorView } from "@milkdown/kit/prose/view";
import { extractLintBatches, mapCorrection } from "./extract";
import { HarperEngine, resolveDialect, type ResolvedDialect } from "./harper";
import type { LintBatch, MappedIssue, ProofingDialect, ProofingStatus } from "./types";

export interface ProofingEngine {
  lint(text: string, dialect: ResolvedDialect): ReturnType<HarperEngine["lint"]>;
  dispose(): Promise<void>;
}

interface PluginState {
  decorations: DecorationSet;
  status: ProofingStatus;
}

interface ProofingMeta {
  clear?: boolean;
  issues?: MappedIssue[];
  status?: ProofingStatus;
}

interface ControllerOptions {
  onUserEdit: () => void;
  engine?: ProofingEngine;
}

const DEBOUNCE_MS = 600;

export class ProofingController {
  private readonly key = new PluginKey<PluginState>("milkj-proofing");
  private readonly engine: ProofingEngine;
  private view: EditorView | undefined;
  private enabled = true;
  private dialect: ProofingDialect = "AUTO";
  private readonly = false;
  private active = false;
  private generation = 0;
  private timer: number | undefined;
  private attachment = 0;
  private popup: HTMLElement | undefined;
  private issueSequence = 0;
  private cache = new Map<string, Awaited<ReturnType<ProofingEngine["lint"]>>>();
  private nativeSpellcheck: string | null = null;

  constructor(private readonly options: ControllerOptions) {
    this.engine = options.engine ?? new HarperEngine();
  }

  configure(enabled: boolean, dialect: ProofingDialect, readonly: boolean): void {
    const proofingChanged = enabled !== this.enabled || dialect !== this.dialect;
    this.enabled = enabled;
    this.dialect = dialect;
    this.readonly = readonly;
    this.syncNativeSpellcheck();
    if (!proofingChanged) return;
    this.invalidate();
    this.closePopup();
    if (!enabled) {
      this.dispatchMeta({ clear: true, status: "disabled" });
    } else {
      this.dispatchMeta({ clear: true, status: "idle" });
      this.schedule();
    }
  }

  dispose(): Promise<void> {
    this.invalidate();
    this.closePopup();
    this.view = undefined;
    return this.engine.dispose();
  }

  createPlugin(): Plugin<PluginState> {
    const controller = this;
    return new Plugin<PluginState>({
      key: this.key,
      state: {
        init: () => ({
          decorations: DecorationSet.empty,
          status: controller.enabled ? "idle" : "disabled",
        }),
        apply(tr, previous) {
          let decorations = previous.decorations;
          if (tr.docChanged) {
            decorations = pruneTouchedDecorations(decorations.map(tr.mapping, tr.doc), tr);
          }
          const meta = tr.getMeta(controller.key) as ProofingMeta | undefined;
          if (meta?.clear) decorations = DecorationSet.empty;
          if (meta?.issues) decorations = decorationsFor(tr.doc, meta.issues);
          return { decorations, status: meta?.status ?? previous.status };
        },
      },
      props: {
        decorations(state) {
          return controller.key.getState(state)?.decorations ?? DecorationSet.empty;
        },
      },
      view(view) {
        return controller.attach(view);
      },
    });
  }

  private attach(view: EditorView) {
    const attachment = ++this.attachment;
    this.view = view;
    this.nativeSpellcheck = view.dom.getAttribute("spellcheck");
    const activate = () => this.activate();
    const click = (event: MouseEvent) => this.handleClick(event);
    for (const type of ["focusin", "pointerdown", "keydown"] as const) {
      view.dom.addEventListener(type, activate, { capture: true });
    }
    view.dom.addEventListener("click", click);
    this.syncNativeSpellcheck();
    if (view.hasFocus()) this.activate();
    else if (this.active) this.schedule(0);

    return {
      update: (nextView: EditorView, previousState: EditorState) => {
        this.view = nextView;
        if (nextView.state.doc !== previousState.doc) {
          this.invalidate();
          this.closePopup();
          this.schedule();
        }
      },
      destroy: () => {
        for (const type of ["focusin", "pointerdown", "keydown"] as const) {
          view.dom.removeEventListener(type, activate, { capture: true });
        }
        view.dom.removeEventListener("click", click);
        this.restoreNativeSpellcheck(view);
        if (this.attachment === attachment) {
          this.view = undefined;
          this.invalidate();
          this.closePopup();
        }
      },
    };
  }

  private activate(): void {
    if (this.active) return;
    this.active = true;
    this.schedule(0);
  }

  private schedule(delay = DEBOUNCE_MS): void {
    if (!this.enabled || !this.active || !this.view) return;
    if (this.timer !== undefined) window.clearTimeout(this.timer);
    this.timer = window.setTimeout(() => {
      this.timer = undefined;
      void this.check();
    }, delay);
  }

  private async check(): Promise<void> {
    const view = this.view;
    if (!view || !this.enabled || !this.active) return;
    const doc = view.state.doc;
    const generation = ++this.generation;
    const attachment = this.attachment;
    const resolvedDialect = resolveDialect(this.dialect);
    const batches = extractLintBatches(doc);
    if (!batches.length) {
      this.dispatchMeta({ issues: [], status: "ready" });
      return;
    }
    this.dispatchMeta({ status: "checking" });
    const issues: MappedIssue[] = [];
    let failed = false;
    for (const batch of batches) {
      const result = await this.lintBatch(batch, resolvedDialect);
      if (!this.isCurrentCheck(view, doc, generation, attachment, resolvedDialect)) return;
      if (result.error) {
        failed = true;
        break;
      }
      for (const correction of result.corrections) {
        const issue = mapCorrection(batch, correction, `milkj-proofing-${++this.issueSequence}`);
        if (issue) issues.push(issue);
      }
    }
    if (!this.isCurrentCheck(view, doc, generation, attachment, resolvedDialect)) return;
    if (failed) {
      this.dispatchMeta({ status: "error" });
      return;
    }
    const deduplicated = [...new Map(issues.map((issue) => [
      JSON.stringify([issue.from, issue.to, issue.correction, issue.types]),
      issue,
    ])).values()];
    this.dispatchMeta({ issues: deduplicated, status: "ready" });
  }

  private lintBatch(batch: LintBatch, dialect: ResolvedDialect) {
    const key = `${dialect}\u0000${batch.text}`;
    const cached = this.cache.get(key);
    if (cached) {
      this.cache.delete(key);
      this.cache.set(key, cached);
      return Promise.resolve(cached);
    }
    return this.engine.lint(batch.text, dialect).then((result) => {
      if (!result.error) {
        this.cache.set(key, result);
        while (this.cache.size > 150) this.cache.delete(this.cache.keys().next().value!);
      }
      return result;
    });
  }

  private handleClick(event: MouseEvent): void {
    const view = this.view;
    const target = event.target as HTMLElement | null;
    if (!view || !target) return;
    let issue: MappedIssue | undefined;
    const widgetId = target.closest<HTMLElement>(".milkj-proofing-widget[data-milkj-proofing-id]")
      ?.dataset.milkjProofingId;
    const state = this.key.getState(view.state);
    if (!state) return;
    if (widgetId) {
      issue = findIssueById(state.decorations, widgetId)?.issue;
    } else if (target.closest(".milkj-proofing-issue")) {
      const position = view.posAtCoords({ left: event.clientX, top: event.clientY })?.pos;
      if (position !== undefined) {
        const candidates = state.decorations.find(position, position)
          .map((decoration) => ({ decoration, issue: decoration.spec.issue as MappedIssue }))
          .filter(({ issue }) => issue);
        candidates.sort((a, b) => (a.decoration.to - a.decoration.from) - (b.decoration.to - b.decoration.from));
        issue = candidates[0]?.issue;
      }
    }
    if (issue) {
      event.preventDefault();
      this.openPopup(issue);
    }
  }

  private openPopup(issue: MappedIssue): void {
    const view = this.view;
    if (!view) return;
    this.closePopup();
    const found = findIssueById(this.key.getState(view.state)?.decorations, issue.id);
    if (!found) return;
    const popup = document.createElement("div");
    popup.className = "milkj-proofing-popup";
    popup.setAttribute("role", "dialog");
    popup.setAttribute("aria-label", "Proofreading suggestion");
    const category = document.createElement("div");
    category.className = "milkj-proofing-popup__category";
    category.textContent = friendlyType(issue.types[0]);
    popup.append(category);
    // Harper's spelling explanation ("Did you mean to spell X this way?") only repeats the
    // replacement button immediately below it. Keep explanations for grammar/style issues, where
    // they add useful context, but make spelling suggestions compact.
    if (!typeClass(issue.types[0]).endsWith("spelling")) {
      const explanation = document.createElement("div");
      explanation.className = "milkj-proofing-popup__explanation";
      explanation.textContent = issue.explanation || "Harper found a possible issue.";
      popup.append(explanation);
    }
    const applicableSuggestions = issue.suggestions.filter(({ replacement }) =>
      canApplyReplacement(view.state.doc, found.from, found.to, replacement),
    );
    if (!issue.suggestions.length) {
      const info = document.createElement("div");
      info.className = "milkj-proofing-popup__empty";
      info.textContent = "No automatic suggestion is available.";
      popup.append(info);
    } else if (!this.readonly && !applicableSuggestions.length) {
      const info = document.createElement("div");
      info.className = "milkj-proofing-popup__empty";
      info.textContent = "This suggestion crosses formatting boundaries and cannot be applied safely.";
      popup.append(info);
    } else if (!this.readonly) {
      const actions = document.createElement("div");
      actions.className = "milkj-proofing-popup__actions";
      for (const { replacement } of applicableSuggestions) {
        const button = document.createElement("button");
        button.type = "button";
        button.textContent = replacement || "Remove";
        button.addEventListener("click", () => this.applySuggestion(issue.id, replacement));
        actions.append(button);
      }
      popup.append(actions);
    }
    document.body.append(popup);
    const coords = view.coordsAtPos(found.from);
    popup.style.left = `${Math.max(8, Math.min(coords.left, window.innerWidth - popup.offsetWidth - 8))}px`;
    popup.style.top = `${Math.min(coords.bottom + 6, window.innerHeight - popup.offsetHeight - 8)}px`;
    this.popup = popup;
    window.addEventListener("pointerdown", this.onOutsidePointer, { capture: true });
    window.addEventListener("keydown", this.onEscape, { capture: true });
    window.addEventListener("scroll", this.onViewportChange, { capture: true });
    window.addEventListener("resize", this.onViewportChange);
  }

  private applySuggestion(id: string, replacement: string): void {
    const view = this.view;
    const found = findIssueById(view && this.key.getState(view.state)?.decorations, id);
    if (
      !view ||
      !found ||
      this.readonly ||
      !canApplyReplacement(view.state.doc, found.from, found.to, replacement)
    ) return this.closePopup();
    this.options.onUserEdit();
    let tr = view.state.tr;
    if (!replacement) {
      tr = tr.delete(found.from, found.to);
    } else if (found.from === found.to) {
      tr = tr.insertText(replacement, found.from);
    } else {
      const marks = uniformMarks(view.state.doc, found.from, found.to);
      if (!marks) return this.closePopup();
      tr = tr.replaceWith(
        found.from,
        found.to,
        view.state.schema.text(replacement, [...marks]),
      );
    }
    view.dispatch(tr.scrollIntoView());
    view.focus();
    this.closePopup();
  }

  private onOutsidePointer = (event: Event) => {
    if (!this.popup?.contains(event.target as Node)) this.closePopup();
  };
  private onEscape = (event: KeyboardEvent) => {
    if (event.key === "Escape") this.closePopup();
  };
  private onViewportChange = () => this.closePopup();

  private closePopup(): void {
    this.popup?.remove();
    this.popup = undefined;
    window.removeEventListener("pointerdown", this.onOutsidePointer, { capture: true });
    window.removeEventListener("keydown", this.onEscape, { capture: true });
    window.removeEventListener("scroll", this.onViewportChange, { capture: true });
    window.removeEventListener("resize", this.onViewportChange);
  }

  private invalidate(): void {
    this.generation++;
    if (this.timer !== undefined) window.clearTimeout(this.timer);
    this.timer = undefined;
  }

  private isCurrentCheck(
    view: EditorView,
    doc: ProseMirrorNode,
    generation: number,
    attachment: number,
    dialect: ResolvedDialect,
  ): boolean {
    return generation === this.generation &&
      attachment === this.attachment &&
      view === this.view &&
      this.enabled &&
      view.state.doc === doc &&
      resolveDialect(this.dialect) === dialect;
  }

  private dispatchMeta(meta: ProofingMeta): void {
    const view = this.view;
    if (view) view.dispatch(view.state.tr.setMeta(this.key, meta));
  }

  private syncNativeSpellcheck(): void {
    if (!this.view) return;
    if (this.enabled) this.view.dom.setAttribute("spellcheck", "false");
    else this.restoreNativeSpellcheck(this.view);
  }

  private restoreNativeSpellcheck(view: EditorView): void {
    if (this.nativeSpellcheck === null) view.dom.removeAttribute("spellcheck");
    else view.dom.setAttribute("spellcheck", this.nativeSpellcheck);
  }
}

export function canApplyReplacement(
  doc: ProseMirrorNode,
  from: number,
  to: number,
  replacement: string,
): boolean {
  if (!replacement || from === to) return true;
  return uniformMarks(doc, from, to) !== null;
}

function uniformMarks(doc: ProseMirrorNode, from: number, to: number): readonly Mark[] | null {
  let reference: readonly Mark[] | undefined;
  let uniform = true;
  doc.nodesBetween(from, to, (node) => {
    if (!uniform || !node.isText) return;
    if (!reference) {
      reference = node.marks;
      return;
    }
    if (reference.length !== node.marks.length || reference.some((mark, index) => !mark.eq(node.marks[index]!))) {
      uniform = false;
    }
  });
  return uniform ? (reference ?? []) : null;
}

function decorationsFor(doc: ProseMirrorNode, issues: MappedIssue[]): DecorationSet {
  return DecorationSet.create(doc, issues.map((issue) => {
    const spec = { id: issue.id, issue };
    if (issue.from === issue.to) {
      return Decoration.widget(issue.from, () => {
        const marker = document.createElement("span");
        marker.className = `milkj-proofing-widget ${typeClass(issue.types[0])}`;
        marker.dataset.milkjProofingId = issue.id;
        marker.setAttribute("role", "button");
        marker.setAttribute("aria-label", issue.explanation || "Proofreading suggestion");
        marker.textContent = "·";
        return marker;
      }, { ...spec, side: 1 });
    }
    return Decoration.inline(issue.from, issue.to, {
      class: `milkj-proofing-issue ${typeClass(issue.types[0])}`,
      "data-milkj-proofing-id": issue.id,
    }, spec);
  }));
}

export function pruneTouchedDecorations(decorations: DecorationSet, tr: Transaction): DecorationSet {
  const ranges: Array<{ from: number; to: number }> = [];
  tr.mapping.maps.forEach((stepMap, index) => {
    const suffix = tr.mapping.slice(index + 1);
    stepMap.forEach((_oldStart, _oldEnd, newStart, newEnd) => {
      const from = suffix.map(newStart, -1);
      const to = suffix.map(newEnd, 1);
      ranges.push({ from: Math.min(from, to), to: Math.max(from, to) });
    });
  });
  const remove = new Set<Decoration>();
  for (const range of ranges) {
    for (const decoration of decorations.find(range.from, range.to)) remove.add(decoration);
  }
  return decorations.remove([...remove]);
}

function findIssueById(decorations: DecorationSet | undefined, id: string) {
  const decoration = decorations?.find(undefined, undefined, (spec) => spec.id === id)[0];
  if (!decoration) return undefined;
  return { from: decoration.from, to: decoration.to, issue: decoration.spec.issue as MappedIssue };
}

function typeClass(type = ""): string {
  const normalized = type.toLowerCase();
  if (normalized.includes("spell")) return "milkj-proofing-issue--spelling";
  if (normalized.includes("grammar")) return "milkj-proofing-issue--grammar";
  if (normalized.includes("punct")) return "milkj-proofing-issue--punctuation";
  return "milkj-proofing-issue--style";
}

function friendlyType(type = ""): string {
  const className = typeClass(type);
  if (className.endsWith("spelling")) return "Spelling";
  if (className.endsWith("grammar")) return "Grammar";
  if (className.endsWith("punctuation")) return "Punctuation";
  return "Writing suggestion";
}
