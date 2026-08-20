import type { Node as ProseMirrorNode, Schema } from "@milkdown/kit/prose/model";
import { NodeSelection, Plugin, type EditorState } from "@milkdown/kit/prose/state";
import type { EditorView } from "@milkdown/kit/prose/view";

export type ImageNodeKind = "image" | "image-block";

export interface ImageSourceCodec {
  serialize(node: ProseMirrorNode, schema: Schema): string;
  parse(source: string, kind: ImageNodeKind): Record<string, unknown> | undefined;
}

interface ImageSourceEditorOptions {
  codec: ImageSourceCodec;
}

interface SelectedImage {
  pos: number;
  node: ProseMirrorNode;
  kind: ImageNodeKind;
}

/**
 * Shows the Markdown for a selected image in a small source field beside the rendered node.
 *
 * The field deliberately lives outside ProseMirror's contenteditable DOM. That lets users edit
 * the atom node's source without replacing the node or making ProseMirror interpret the source as
 * document content while it is only half typed.
 */
export function createImageSourceEditorPlugin(options: ImageSourceEditorOptions): Plugin {
  return new Plugin({
    view: (view) => new ImageSourceEditorView(view, options.codec),
  });
}

export function selectedImage(state: EditorState): SelectedImage | undefined {
  const selection = state.selection;
  if (!(selection instanceof NodeSelection)) return undefined;

  const kind = selection.node.type.name;
  if (kind !== "image" && kind !== "image-block") return undefined;
  return { pos: selection.from, node: selection.node, kind };
}

export function serializeImageNode(
  node: ProseMirrorNode,
  schema: Schema,
  serializeDocument: (document: ProseMirrorNode) => string,
): string {
  const content = node.isInline
    ? schema.nodes.paragraph?.create(undefined, node)
    : node;
  if (!content) return "";
  return serializeDocument(schema.topNodeType.create(undefined, content)).trim();
}

export function parseImageSource(
  source: string,
  kind: ImageNodeKind,
  parseDocument: (markdown: string) => ProseMirrorNode | null,
): Record<string, unknown> | undefined {
  // A standalone Markdown image is promoted by Crepe to image-block. Surround inline images with
  // text while parsing so their ordinary alt/title attributes retain their inline meaning.
  const document = parseDocument(kind === "image" ? `x${source}x` : source);
  if (!document) return undefined;

  if (kind === "image-block") {
    if (document.childCount !== 1) return undefined;
    const image = document.firstChild;
    return image?.type.name === "image-block" ? { ...image.attrs } : undefined;
  }

  if (document.childCount !== 1 || document.firstChild?.type.name !== "paragraph") {
    return undefined;
  }
  const paragraph = document.firstChild;
  if (paragraph.childCount !== 3) return undefined;
  const [prefix, image, suffix] = [paragraph.child(0), paragraph.child(1), paragraph.child(2)];
  if (prefix.text !== "x" || image.type.name !== "image" || suffix.text !== "x") {
    return undefined;
  }
  return { ...image.attrs };
}

class ImageSourceEditorView {
  private view: EditorView;
  private readonly codec: ImageSourceCodec;
  private readonly popup: HTMLDivElement;
  private readonly input: HTMLInputElement;
  private readonly error: HTMLDivElement;
  private target: SelectedImage | undefined;
  private dismissedPos: number | undefined;
  private lastSelectionFrom = -1;
  private lastSelectionTo = -1;

  constructor(view: EditorView, codec: ImageSourceCodec) {
    this.view = view;
    this.codec = codec;

    this.popup = document.createElement("div");
    this.popup.className = "milkj-image-source-editor";
    this.popup.hidden = true;
    this.popup.setAttribute("role", "dialog");
    this.popup.setAttribute("aria-label", "Edit image Markdown source");

    const label = document.createElement("label");
    label.className = "milkj-image-source-editor__label";
    label.textContent = "Image source";
    this.input = document.createElement("input");
    this.input.className = "milkj-image-source-editor__input";
    this.input.type = "text";
    this.input.spellcheck = false;
    this.input.autocomplete = "off";
    this.input.setAttribute("aria-label", "Image Markdown source");
    label.append(this.input);

    this.error = document.createElement("div");
    this.error.className = "milkj-image-source-editor__error";
    this.error.textContent = "Enter one valid Markdown image.";
    this.error.hidden = true;
    this.popup.append(label, this.error);
    document.body.append(this.popup);

    this.input.addEventListener("input", this.onInput);
    this.input.addEventListener("keydown", this.onKeyDown);
    this.input.addEventListener("blur", this.onBlur);
    window.addEventListener("resize", this.positionPopup);
    window.addEventListener("scroll", this.positionPopup, true);
    view.dom.addEventListener("pointerdown", this.onEditorPointerDown);

    this.update(view);
  }

  update(view: EditorView, previousState?: EditorState) {
    this.view = view;
    const selectionChanged =
      view.state.selection.from !== this.lastSelectionFrom ||
      view.state.selection.to !== this.lastSelectionTo;
    this.lastSelectionFrom = view.state.selection.from;
    this.lastSelectionTo = view.state.selection.to;
    if (selectionChanged) this.dismissedPos = undefined;

    const target = selectedImage(view.state);
    if (!target || !view.editable || target.pos === this.dismissedPos) {
      this.target = target;
      this.hide();
      return;
    }

    const targetChanged =
      target.pos !== this.target?.pos || target.kind !== this.target?.kind;
    const documentChanged = previousState ? !view.state.doc.eq(previousState.doc) : true;
    this.target = target;
    if (targetChanged || (documentChanged && document.activeElement !== this.input)) {
      this.input.value = this.codec.serialize(target.node, view.state.schema);
      this.setValid(true);
    }
    this.popup.hidden = false;
    this.positionPopup();

    if (targetChanged) {
      queueMicrotask(() => {
        if (this.target?.pos !== target.pos || this.popup.hidden) return;
        this.input.focus();
        selectImageDestination(this.input, String(target.node.attrs.src ?? ""));
      });
    }
  }

  destroy() {
    this.view.dom.removeEventListener("pointerdown", this.onEditorPointerDown);
    window.removeEventListener("resize", this.positionPopup);
    window.removeEventListener("scroll", this.positionPopup, true);
    this.input.removeEventListener("input", this.onInput);
    this.input.removeEventListener("keydown", this.onKeyDown);
    this.input.removeEventListener("blur", this.onBlur);
    this.popup.remove();
  }

  private readonly onInput = () => {
    const target = this.target;
    this.setValid(Boolean(target && this.codec.parse(this.input.value, target.kind)));
  };

  private readonly onKeyDown = (event: KeyboardEvent) => {
    if (event.key === "Enter") {
      event.preventDefault();
      if (this.commit()) this.dismissAndRefocus();
    } else if (event.key === "Escape") {
      event.preventDefault();
      this.dismissAndRefocus();
    }
  };

  private readonly onBlur = () => {
    // Commit before ProseMirror processes a click elsewhere and replaces this.target. Invalid
    // half-typed source is simply cancelled on blur; Enter keeps the field open with its error.
    this.commit();
    this.dismiss();
  };

  private readonly onEditorPointerDown = (event: PointerEvent) => {
    const target = event.target;
    if (!(target instanceof Element) || !target.closest("img")) return;
    this.dismissedPos = undefined;
    window.setTimeout(() => this.update(this.view), 0);
  };

  private commit(): boolean {
    const target = this.target;
    if (!target) return true;
    const attrs = this.codec.parse(this.input.value, target.kind);
    if (!attrs) {
      this.setValid(false);
      return false;
    }

    const current = this.view.state.doc.nodeAt(target.pos);
    if (!current || current.type.name !== target.kind) return true;
    if (!shallowEqual(current.attrs, attrs)) {
      this.view.dispatch(this.view.state.tr.setNodeMarkup(target.pos, undefined, attrs));
    }
    return true;
  }

  private dismissAndRefocus() {
    this.dismiss();
    this.view.focus();
  }

  private dismiss() {
    this.dismissedPos = this.target?.pos;
    this.hide();
  }

  private hide() {
    this.popup.hidden = true;
  }

  private setValid(valid: boolean) {
    this.input.setAttribute("aria-invalid", String(!valid));
    this.error.hidden = valid;
  }

  private readonly positionPopup = () => {
    const target = this.target;
    if (!target || this.popup.hidden) return;
    const nodeDom = this.view.nodeDOM(target.pos);
    const element = nodeDom instanceof Element
      ? nodeDom
      : nodeDom?.parentElement;
    if (!element) {
      this.hide();
      return;
    }

    const bounds = element.getBoundingClientRect();
    const margin = 8;
    const width = Math.min(Math.max(bounds.width, 320), window.innerWidth - margin * 2);
    this.popup.style.width = `${Math.max(width, 0)}px`;
    this.popup.style.left = `${Math.min(Math.max(bounds.left, margin), window.innerWidth - width - margin)}px`;
    const top = Math.min(bounds.bottom + 6, window.innerHeight - this.popup.offsetHeight - margin);
    this.popup.style.top = `${Math.max(top, margin)}px`;
  };
}

function selectImageDestination(input: HTMLInputElement, src: string) {
  const start = input.value.indexOf(src);
  if (src && start >= 0) {
    input.setSelectionRange(start, start + src.length);
  } else {
    input.select();
  }
}

function shallowEqual(left: Record<string, unknown>, right: Record<string, unknown>): boolean {
  const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
  return [...keys].every((key) => left[key] === right[key]);
}
