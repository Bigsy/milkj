import {
  LanguageDescription,
  LanguageSupport,
  StreamLanguage,
  type StreamParser,
} from "@codemirror/language";
import { languages } from "@codemirror/language-data";
import { Crepe, CrepeFeature } from "@milkdown/crepe";
import { editorViewCtx, parserCtx, remarkCtx, serializerCtx } from "@milkdown/kit/core";
import { Plugin, TextSelection } from "@milkdown/kit/prose/state";
import { $prose, replaceAll } from "@milkdown/kit/utils";
import mermaid from "mermaid";
import { search } from "prosemirror-search";
import { EditorBridgeSync } from "./bridge-sync";
import { installFindBar } from "./findbar";
import { createHtmlPreviewPlugin } from "./html-preview";
import {
  createImageSourceEditorPlugin,
  parseImageSource,
  serializeImageNode,
} from "./image-source-editor";
import { resolveImageDomUrl } from "./image-urls";
import { type MarkdownBlock, splitMarkdownBlocks } from "./markdown-blocks";
import { installOutline } from "./outline";
import { createProjectLinksPlugin, installProjectLinks } from "./project-links";
import { ProofingController } from "./proofing/plugin";
import type { ProofingDialect } from "./proofing/types";
import "@milkdown/crepe/theme/common/style.css";

// MilkJ frontend entry point.
//
// Uses Crepe — Milkdown's batteries-included WYSIWYG editor — as a fast starting point. Swap to the
// lower-level @milkdown/kit if/when we need full control over plugins, slash menus, theming, etc.
//
// The Kotlin host (see ../../src/main/kotlin/.../bridge/MilkJBridge.kt) talks to this page over a
// JCEF query bridge. The contract below is a placeholder — finalize it alongside the Kotlin side.

declare global {
  interface Window {
    // Injected by JCEF (JBCefJSQuery.inject) so the page can push Markdown back to the IDE.
    milkjSendToIde?: (message: string) => void;
    // Called by the IDE to push fresh Markdown into the editor (external edits, initial load).
    milkjSetMarkdown?: (markdown: string, revision: number) => void;
    milkjApplyConfig?: (config: MilkJConfig) => void;
    milkjBridgeInstalled?: () => void;
  }
}

type MilkJTheme = "light" | "dark";
type MilkJEditorTheme = "NORD" | "CLASSIC" | "FRAME";
type MilkJMermaidTheme = "AUTO" | "DEFAULT" | "DARK" | "FOREST" | "NEUTRAL" | "BASE";
type MermaidBuiltInTheme = "default" | "dark" | "forest" | "neutral" | "base";

interface MilkJConfig {
  theme: MilkJTheme;
  configuredTheme: "FOLLOW_IDE" | "LIGHT" | "DARK";
  editorTheme: MilkJEditorTheme;
  mermaidTheme: MilkJMermaidTheme;
  defaultEditor: "BUILT_IN" | "MILKJ";
  placeholder: string;
  // True when the file is not writable in the IDE; the editor surface must not accept edits.
  readonly?: boolean;
  proofingEnabled: boolean;
  proofingDialect: ProofingDialect;
  customDictionary: string[];
  weirpacks: string[];
  localImageBaseUrl?: string;
}

const root = document.querySelector<HTMLDivElement>("#app")!;

const mermaidLanguage = LanguageDescription.of({
  name: "Mermaid",
  alias: ["mermaid", "mmd"],
  extensions: ["mmd", "mermaid"],
  support: new LanguageSupport(StreamLanguage.define(createMermaidStreamParser())),
});

const milkjCodeLanguages = [
  mermaidLanguage,
  ...languages.filter((language) => language.name.toLowerCase() !== "mermaid"),
];

let currentMarkdown = "";
let currentTheme: MilkJTheme = "light";
let currentEditorTheme: MilkJEditorTheme = "NORD";
let currentMermaidTheme: MilkJMermaidTheme = "AUTO";
// Empty until the IDE pushes its config (which happens before the content), so the pre-config
// editor never flashes Crepe's built-in "Please enter..." text.
let currentPlaceholder = "";
let currentReadonly = false;
let currentLocalImageBaseUrl: string | undefined;
let crepe: Crepe | undefined;
let editorReady = false;
let creatingEditor = false;
let readySent = false;
let mermaidRenderSeq = 0;

// Milkdown reports markdownUpdated asynchronously for both user transactions and content the IDE
// applied. Track the origin at the ProseMirror transaction itself instead of guessing with a time
// window: only a document change that did not happen during an IDE apply may travel back. The IDE
// also attaches a monotonically increasing revision, so even an unusually delayed callback cannot
// overwrite a newer document.
const bridgeSync = new EditorBridgeSync(canonicalizeMarkdown, splitMarkdownBlocksForSync);

function markUserEdit() {
  bridgeSync.recordUserEdit();
}

applyChrome();

// Cmd/Ctrl+F find bar. Created once; each (re)built editor registers the prosemirror-search
// plugin, and syncToView re-applies any active query to the fresh plugin state.
const findBar = installFindBar({
  getView: () => {
    if (!crepe || creatingEditor) {
      return undefined;
    }
    try {
      return crepe.editor.ctx.get(editorViewCtx);
    } catch {
      return undefined;
    }
  },
  // A replace is a real user edit even though it is dispatched programmatically.
  onUserEdit: markUserEdit,
});

const disposeProjectLinks = installProjectLinks({
  navigate: (href) => {
    window.milkjSendToIde?.(`navigate:file:${encodeURIComponent(href)}`);
  },
  openExternal: (href) => {
    window.milkjSendToIde?.(`navigate:url:${encodeURIComponent(href)}`);
  },
});

const outline = installOutline({
  getView: () => {
    if (!crepe || creatingEditor) {
      return undefined;
    }
    try {
      return crepe.editor.ctx.get(editorViewCtx);
    } catch {
      return undefined;
    }
  },
});

const proofingController = new ProofingController({
  onUserEdit: markUserEdit,
  onAddDictionaryWord: (word) => {
    window.milkjSendToIde?.(`dictionary:add:${encodeURIComponent(word)}`);
  },
});
window.addEventListener("pagehide", () => {
  disposeProjectLinks();
  void proofingController.dispose();
}, { once: true });

async function createEditor() {
  const markdown = currentMarkdown;
  creatingEditor = true;
  try {
    await crepe?.destroy().catch(() => undefined);
    root.replaceChildren();
    crepe = new Crepe({
      root,
      defaultValue: markdown,
      featureConfigs: {
        [CrepeFeature.Placeholder]: {
          text: currentPlaceholder,
          mode: "block",
        },
        [CrepeFeature.CodeMirror]: {
          languages: milkjCodeLanguages,
          // Renders Mermaid fences through the code-block component's preview panel: the component
          // re-invokes this whenever the block's content or language changes, and sanitizes the
          // result (Mermaid's SVG/foreignObject included) before inserting it.
          renderPreview: (language, content, applyPreview) => {
            if (!/^(mermaid|mmd)$/i.test(language) || !content.trim()) {
              return null;
            }
            void renderMermaidPreview(content, applyPreview);
            // Returning undefined marks the preview as async; the component shows its loading
            // placeholder until applyPreview delivers the diagram.
          },
        },
        [CrepeFeature.ImageBlock]: {
          // Browser security prevents an http-backed JCEF page from loading file:// paths. Local
          // Markdown paths are mapped to a project-scoped endpoint supplied by the IDE; remote,
          // data, and blob URLs pass through unchanged.
          proxyDomURL: (src) => resolveImageDomUrl(src, currentLocalImageBaseUrl),
        },
      },
    });
    crepe.editor.use($prose(() => search()));
    crepe.editor.use($prose(() => new Plugin({
      view: () => ({
        update(view, previousState) {
          if (!view.state.doc.eq(previousState.doc)) {
            bridgeSync.recordDocumentChange(creatingEditor);
          }
        },
      }),
    })));
    crepe.editor.use($prose(() => proofingController.createPlugin()));
    crepe.editor.use($prose(() => createProjectLinksPlugin()));
    crepe.editor.use($prose(() => createHtmlPreviewPlugin({
      resolveImageUrl: (src) => resolveImageDomUrl(src, currentLocalImageBaseUrl),
    })));
    crepe.editor.use($prose(() => createImageSourceEditorPlugin({
      codec: {
        serialize: (node, schema) => serializeImageNode(
          node,
          schema,
          (document) => crepe!.editor.ctx.get(serializerCtx)(document),
        ),
        parse: (source, kind) => parseImageSource(
          source,
          kind,
          (markdown) => crepe!.editor.ctx.get(parserCtx)(markdown),
        ),
      },
    })));
    await crepe.create();
    crepe.setReadonly(currentReadonly);
    crepe.on((listener) => {
      listener.markdownUpdated((_ctx, markdown) => {
        currentMarkdown = markdown;
        const result = bridgeSync.messageForMarkdown(markdown);
        if (result?.ok) {
          window.milkjSendToIde?.(result.message);
        } else if (result) {
          window.milkjSendToIde?.(`roundtrip:error:${encodeURIComponent(result.reason)}`);
          // Do not leave a rejected edit visible: it was never written to IntelliJ and a later
          // edit must not accidentally include it. Defer the dispatch until this listener returns.
          window.setTimeout(() => restoreSourceAfterUnsafeEdit(result.sourceMarkdown), 0);
        }
        findBar.refresh();
        outline.refresh();
      });
    });
    // Content the IDE pushed while the editor was being (re)built.
    if (currentMarkdown !== markdown) {
      const activeCrepe = crepe;
      bridgeSync.applyFromIde(() => {
        replaceAllKeepingSelection(activeCrepe, currentMarkdown);
      });
    }
  } finally {
    creatingEditor = false;
  }
  findBar.syncToView();
  outline.refresh();
}

/**
 * replaceAll rebuilds the entire ProseMirror document, which maps the selection to the document
 * end. For content applied over the user's head (external IDE edits, roundtrip restores) put the
 * caret back as close as possible to where it was.
 */
function replaceAllKeepingSelection(activeCrepe: Crepe, markdown: string) {
  let previousAnchor: number | undefined;
  try {
    previousAnchor = activeCrepe.editor.ctx.get(editorViewCtx).state.selection.anchor;
  } catch {
    previousAnchor = undefined;
  }
  activeCrepe.editor.action(replaceAll(markdown));
  if (previousAnchor === undefined) {
    return;
  }
  try {
    const view = activeCrepe.editor.ctx.get(editorViewCtx);
    const { doc, tr } = view.state;
    const position = Math.min(previousAnchor, doc.content.size);
    // Bias backward: when the replacement made the text near the caret slightly shorter (e.g. the
    // IDE stripped a trailing space on save), the caret must stay at the end of its line rather
    // than slide forward onto the next one.
    view.dispatch(tr.setSelection(TextSelection.near(doc.resolve(position), -1)).scrollIntoView());
  } catch {
    // Restoring the caret is best-effort; the content replacement already succeeded.
  }
}

function canonicalizeMarkdown(markdown: string): string {
  if (!crepe || creatingEditor) {
    throw new Error("The Milkdown parser is not ready");
  }
  return crepe.editor.action((ctx) => {
    const document = ctx.get(parserCtx)(markdown);
    return ctx.get(serializerCtx)(document);
  });
}

/** Splits with the editor's own remark processor, so blocks carry the syntax Crepe itself parses. */
function splitMarkdownBlocksForSync(markdown: string): MarkdownBlock | undefined {
  if (!crepe || creatingEditor) {
    return undefined;
  }
  try {
    return crepe.editor.action((ctx) => splitMarkdownBlocks(ctx.get(remarkCtx), markdown));
  } catch {
    return undefined;
  }
}

/** True when parsing the pushed Markdown yields the document the editor already holds. */
function parsesToCurrentDocument(activeCrepe: Crepe, markdown: string): boolean {
  try {
    return activeCrepe.editor.action((ctx) => {
      const pushed = ctx.get(parserCtx)(markdown);
      return pushed !== null && pushed.eq(ctx.get(editorViewCtx).state.doc);
    });
  } catch {
    return false;
  }
}

function restoreSourceAfterUnsafeEdit(sourceMarkdown: string) {
  if (!crepe || creatingEditor) return;
  currentMarkdown = sourceMarkdown;
  const activeCrepe = crepe;
  bridgeSync.applyFromIde(() => {
    replaceAllKeepingSelection(activeCrepe, sourceMarkdown);
  });
}

async function renderMermaidPreview(
  source: string,
  applyPreview: (value: null | string | HTMLElement) => void,
) {
  const id = `milkj-mermaid-${++mermaidRenderSeq}`;
  const container = document.createElement("div");
  container.className = "milkj-mermaid-render";
  try {
    const { svg } = await mermaid.render(id, source.trim());
    container.innerHTML = svg;
  } catch (error) {
    // Failed renders can leave mermaid's temporary element behind.
    document.getElementById(`d${id}`)?.remove();
    container.classList.add("milkj-mermaid-render-error");
    container.textContent =
      error instanceof Error ? error.message : "Unable to render Mermaid diagram.";
  }
  applyPreview(container);
}

function hasMermaidBlocks(markdown: string): boolean {
  return /```(?:mermaid|mmd)\b/i.test(markdown);
}

function applyChrome() {
  document.documentElement.dataset.theme = currentTheme;
  document.documentElement.dataset.editorTheme = currentEditorTheme.toLowerCase();
  mermaid.initialize({
    startOnLoad: false,
    theme: effectiveMermaidTheme(),
  });
}

function effectiveMermaidTheme(): MermaidBuiltInTheme {
  if (currentMermaidTheme === "AUTO") {
    return currentTheme === "dark" ? "dark" : "default";
  }

  switch (currentMermaidTheme) {
    case "DARK":
      return "dark";
    case "FOREST":
      return "forest";
    case "NEUTRAL":
      return "neutral";
    case "BASE":
      return "base";
    case "DEFAULT":
    default:
      return "default";
  }
}

function createMermaidStreamParser(): StreamParser<null> {
  return {
    name: "mermaid",
    startState: () => null,
    token(stream) {
      if (stream.match(/%%.*/)) {
        return "comment";
      }

      if (
        stream.match(
          /(?:flowchart|graph|sequenceDiagram|classDiagram|stateDiagram|stateDiagram-v2|erDiagram|gantt|pie|journey|gitGraph|mindmap|timeline|quadrantChart|xychart-beta|block-beta|C4Context)\b/,
        )
      ) {
        return "keyword";
      }

      if (stream.match(/-->|---|==>|-.->|--x|--o/)) {
        return "operator";
      }

      stream.next();
      return null;
    },
    languageData: {
      commentTokens: { line: "%%" },
    },
  };
}

window.milkjSetMarkdown = (markdown: string, revision: number) => {
  // The IDE relays autosaves of this page's own writes back as pushes. The editor's serialization
  // (currentMarkdown) intentionally differs from the source-preserving markdown the IDE holds, so
  // an echo must be recognized against the source we last sent — replacing the content for it
  // would throw the caret to the end of the document after every rich-text edit.
  const isOwnWriteEcho = bridgeSync.acceptIdeRevision(revision, markdown);
  if (isOwnWriteEcho || markdown === currentMarkdown) {
    return;
  }
  currentMarkdown = markdown;
  if (creatingEditor) {
    // A rebuild is in flight; acting on the half-created editor would throw. createEditor
    // applies the latest currentMarkdown once the new editor exists.
    return;
  }
  if (crepe && editorReady) {
    const activeCrepe = crepe;
    if (parsesToCurrentDocument(activeCrepe, markdown)) {
      // Nothing to show: the push differs from this page's serialization but not from its document.
      // IntelliJ's save normalization (stripping the trailing space of a line being typed, say)
      // rewrites the file and the IDE relays that back as an external change; replacing the content
      // for it would only disturb the caret.
      return;
    }
    // Replace content in place: rebuilding Crepe on every external edit would tear down
    // ProseMirror and the CodeMirror blocks, losing cursor and scroll.
    bridgeSync.applyFromIde(() => {
      replaceAllKeepingSelection(activeCrepe, markdown);
    });
  } else {
    void createEditor();
  }
};

window.milkjApplyConfig = (config: MilkJConfig) => {
  const mermaidThemeBefore = effectiveMermaidTheme();
  const placeholderBefore = currentPlaceholder;
  currentTheme = config.theme;
  currentEditorTheme = config.editorTheme;
  currentMermaidTheme = config.mermaidTheme;
  currentPlaceholder = config.placeholder;
  currentReadonly = config.readonly === true;
  currentLocalImageBaseUrl = config.localImageBaseUrl;
  crepe?.setReadonly(currentReadonly);
  findBar.setReadonly(currentReadonly);
  proofingController.configure(
    config.proofingEnabled,
    config.proofingDialect,
    currentReadonly,
    config.customDictionary,
    config.weirpacks,
  );
  applyChrome();
  // The placeholder is baked into the editor at creation, and Mermaid bakes its theme into each
  // rendered SVG (previews only re-render when their code block's content changes) — either
  // change needs an editor rebuild to take effect. The IDE pushes config before content, so the
  // initial placeholder rebuild happens while the editor is still empty.
  const needsRebuild =
    currentPlaceholder !== placeholderBefore ||
    (effectiveMermaidTheme() !== mermaidThemeBefore && hasMermaidBlocks(currentMarkdown));
  if (needsRebuild && crepe && editorReady && !creatingEditor) {
    void createEditor();
  }
};

function announceReady() {
  if (!editorReady || readySent) {
    return;
  }

  if (window.milkjSendToIde) {
    window.milkjSendToIde("ready");
    readySent = true;
  } else {
    window.setTimeout(announceReady, 100);
  }
}

window.milkjBridgeInstalled = announceReady;

void createEditor().then(() => {
  editorReady = true;
  announceReady();
});

const style = document.createElement("style");
style.textContent = `
  :root {
    color-scheme: light;
    --milkj-bg: #ffffff;
    --milkj-fg: #1f2328;
    --milkj-border: #d0d7de;
  }

  :root[data-theme="dark"] {
    color-scheme: dark;
    --milkj-bg: #1e1f22;
    --milkj-fg: #dfe1e5;
    --milkj-border: #3c3f44;
  }

  html,
  body,
  #app {
    min-height: 100%;
    margin: 0;
    background: var(--milkj-bg);
    color: var(--milkj-fg);
  }

  body {
    font-family: system-ui, sans-serif;
  }

  #app {
    padding: 20px 24px;
    box-sizing: border-box;
  }

  .milkdown {
    min-height: 100vh;
    box-sizing: border-box;
    background: var(--crepe-color-background);
    color: var(--crepe-color-on-background);
  }

  .milkdown a[href],
  .milkdown .milkj-project-link {
    cursor: pointer;
  }

  /* Milkdown stores raw HTML as an inline atom so it can round-trip it exactly. The custom node
     view renders a sanitized copy while leaving that atom (and therefore the Markdown) untouched. */
  .milkdown .milkj-html-preview {
    display: block;
    box-sizing: border-box;
    max-width: 100%;
    overflow-x: auto;
    white-space: normal;
  }

  .milkdown p:has(> .milkj-html-preview:only-child) {
    margin: 0;
  }

  .milkdown .milkj-html-preview table {
    display: table;
    width: 100%;
    max-width: 100%;
    margin: 16px 0;
    border-spacing: 0;
    border-collapse: collapse;
    overflow: auto;
  }

  .milkdown .milkj-html-preview th,
  .milkdown .milkj-html-preview td {
    padding: 6px 13px;
    border: 1px solid var(--crepe-color-outline, var(--milkj-border));
    vertical-align: middle;
  }

  .milkdown .milkj-html-preview tr:nth-child(2n) {
    background: var(--crepe-color-surface, transparent);
  }

  .milkdown .milkj-html-preview img {
    display: inline-block;
    max-width: 100%;
    height: auto;
  }

  .milkdown .milkj-html-preview td > img:only-child {
    display: block;
    margin: 0 auto;
  }

  .milkdown .milkj-html-preview.ProseMirror-selectednode {
    outline: 2px solid var(--crepe-color-primary);
    outline-offset: 2px;
  }

  /* Crepe hides the native caret unconditionally and only colors its virtual caret while the
     ProseMirror-focused class is present. JCEF's focus reporting is unreliable — the editor can be
     receiving keystrokes while that class is absent — which leaves no visible caret at all. Color
     the virtual caret like the text, independent of focus state. */
  .milkdown .ProseMirror {
    --prosemirror-virtual-cursor-color: var(--crepe-color-on-background);
  }

  .milkdown .milkj-project-link {
    color: var(--crepe-color-primary);
    text-decoration: underline;
    text-decoration-style: dotted;
    text-underline-offset: 2px;
  }

  :root[data-editor-theme="nord"] .milkdown {
    --crepe-color-background: #fdfcff;
    --crepe-color-on-background: #1b1c1d;
    --crepe-color-surface: #f8f9ff;
    --crepe-color-surface-low: #f2f3fa;
    --crepe-color-on-surface: #191c20;
    --crepe-color-on-surface-variant: #43474e;
    --crepe-color-outline: #73777f;
    --crepe-color-primary: #37618e;
    --crepe-color-secondary: #d7e3f8;
    --crepe-color-on-secondary: #101c2b;
    --crepe-color-inverse: #2e3135;
    --crepe-color-on-inverse: #eff0f7;
    --crepe-color-inline-code: #ba1a1a;
    --crepe-color-error: #ba1a1a;
    --crepe-color-hover: #eceef4;
    --crepe-color-selected: #e1e2e8;
    --crepe-color-inline-area: #d8dae0;
    --crepe-font-title: Rubik, Cambria, 'Times New Roman', Times, serif;
    --crepe-font-default: Inter, Arial, Helvetica, sans-serif;
    --crepe-font-code: 'JetBrains Mono', Menlo, Monaco, 'Courier New', Courier, monospace;
    --crepe-shadow-1: 0px 1px 3px 1px rgba(0, 0, 0, 0.15), 0px 1px 2px 0px rgba(0, 0, 0, 0.3);
    --crepe-shadow-2: 0px 2px 6px 2px rgba(0, 0, 0, 0.15), 0px 1px 2px 0px rgba(0, 0, 0, 0.3);
  }

  :root[data-theme="dark"][data-editor-theme="nord"] .milkdown {
    --crepe-color-background: #1b1c1d;
    --crepe-color-on-background: #f8f9ff;
    --crepe-color-surface: #111418;
    --crepe-color-surface-low: #191c20;
    --crepe-color-on-surface: #e1e2e8;
    --crepe-color-on-surface-variant: #c3c6cf;
    --crepe-color-outline: #8d9199;
    --crepe-color-primary: #a1c9fd;
    --crepe-color-secondary: #3c4858;
    --crepe-color-on-secondary: #d7e3f8;
    --crepe-color-inverse: #e1e2e8;
    --crepe-color-on-inverse: #2e3135;
    --crepe-color-inline-code: #ffb4ab;
    --crepe-color-error: #ffb4ab;
    --crepe-color-hover: #1d2024;
    --crepe-color-selected: #32353a;
    --crepe-color-inline-area: #111418;
    --crepe-font-title: Rubik, Cambria, 'Times New Roman', Times, serif;
    --crepe-font-default: Inter, Arial, Helvetica, sans-serif;
    --crepe-font-code: 'JetBrains Mono', Menlo, Monaco, 'Courier New', Courier, monospace;
    --crepe-shadow-1: 0px 1px 2px 0px rgba(255, 255, 255, 0.3), 0px 1px 3px 1px rgba(255, 255, 255, 0.15);
    --crepe-shadow-2: 0px 1px 2px 0px rgba(255, 255, 255, 0.3), 0px 2px 6px 2px rgba(255, 255, 255, 0.15);
  }

  :root[data-editor-theme="classic"] .milkdown {
    --crepe-color-background: #fffdfb;
    --crepe-color-on-background: #1f1b16;
    --crepe-color-surface: #fff8f4;
    --crepe-color-surface-low: #fff1e5;
    --crepe-color-on-surface: #201b13;
    --crepe-color-on-surface-variant: #4f4539;
    --crepe-color-outline: #817567;
    --crepe-color-primary: #805610;
    --crepe-color-secondary: #fbdebc;
    --crepe-color-on-secondary: #271904;
    --crepe-color-inverse: #362f27;
    --crepe-color-on-inverse: #fcefe2;
    --crepe-color-inline-code: #ba1a1a;
    --crepe-color-error: #ba1a1a;
    --crepe-color-hover: #f9ecdf;
    --crepe-color-selected: #ede0d4;
    --crepe-color-inline-area: #e4d8cc;
    --crepe-font-title: Georgia, Cambria, 'Times New Roman', Times, serif;
    --crepe-font-default: 'Open Sans', Arial, Helvetica, sans-serif;
    --crepe-font-code: Fira Code, Menlo, Monaco, 'Courier New', Courier, monospace;
    --crepe-shadow-1: 0px 1px 3px 1px rgba(0, 0, 0, 0.15), 0px 1px 2px 0px rgba(0, 0, 0, 0.3);
    --crepe-shadow-2: 0px 2px 6px 2px rgba(0, 0, 0, 0.15), 0px 1px 2px 0px rgba(0, 0, 0, 0.3);
  }

  :root[data-theme="dark"][data-editor-theme="classic"] .milkdown {
    --crepe-color-background: #1f1b16;
    --crepe-color-on-background: #eae1d9;
    --crepe-color-surface: #18120b;
    --crepe-color-surface-low: #201b13;
    --crepe-color-on-surface: #ede0d4;
    --crepe-color-on-surface-variant: #d3c4b4;
    --crepe-color-outline: #9c8f80;
    --crepe-color-primary: #f4bd6f;
    --crepe-color-secondary: #56442a;
    --crepe-color-on-secondary: #fbdebc;
    --crepe-color-inverse: #ede0d4;
    --crepe-color-on-inverse: #362f27;
    --crepe-color-inline-code: #ffb4ab;
    --crepe-color-error: #ffb4ab;
    --crepe-color-hover: #251f17;
    --crepe-color-selected: #3b342b;
    --crepe-color-inline-area: #3f3830;
    --crepe-font-title: Georgia, Cambria, 'Times New Roman', Times, serif;
    --crepe-font-default: 'Open Sans', Arial, Helvetica, sans-serif;
    --crepe-font-code: Fira Code, Menlo, Monaco, 'Courier New', Courier, monospace;
    --crepe-shadow-1: 0px 1px 2px 0px rgba(255, 255, 255, 0.3), 0px 1px 3px 1px rgba(255, 255, 255, 0.15);
    --crepe-shadow-2: 0px 1px 2px 0px rgba(255, 255, 255, 0.3), 0px 2px 6px 2px rgba(255, 255, 255, 0.15);
  }

  :root[data-editor-theme="frame"] .milkdown {
    --crepe-color-background: #ffffff;
    --crepe-color-on-background: #000000;
    --crepe-color-surface: #f7f7f7;
    --crepe-color-surface-low: #ededed;
    --crepe-color-on-surface: #1c1c1c;
    --crepe-color-on-surface-variant: #4d4d4d;
    --crepe-color-outline: #a8a8a8;
    --crepe-color-primary: #333333;
    --crepe-color-secondary: #cfcfcf;
    --crepe-color-on-secondary: #000000;
    --crepe-color-inverse: #f0f0f0;
    --crepe-color-on-inverse: #1a1a1a;
    --crepe-color-inline-code: #ba1a1a;
    --crepe-color-error: #ba1a1a;
    --crepe-color-hover: #e0e0e0;
    --crepe-color-selected: #d5d5d5;
    --crepe-color-inline-area: #cacaca;
    --crepe-font-title: 'Noto Serif', Cambria, 'Times New Roman', Times, serif;
    --crepe-font-default: 'Noto Sans', Arial, Helvetica, sans-serif;
    --crepe-font-code: 'Space Mono', Fira Code, Menlo, Monaco, 'Courier New', Courier, monospace;
    --crepe-shadow-1: 0px 1px 3px 1px rgba(0, 0, 0, 0.15), 0px 1px 2px 0px rgba(0, 0, 0, 0.3);
    --crepe-shadow-2: 0px 2px 6px 2px rgba(0, 0, 0, 0.15), 0px 1px 2px 0px rgba(0, 0, 0, 0.3);
  }

  :root[data-theme="dark"][data-editor-theme="frame"] .milkdown {
    --crepe-color-background: #1a1a1a;
    --crepe-color-on-background: #e6e6e6;
    --crepe-color-surface: #121212;
    --crepe-color-surface-low: #1c1c1c;
    --crepe-color-on-surface: #d1d1d1;
    --crepe-color-on-surface-variant: #a9a9a9;
    --crepe-color-outline: #757575;
    --crepe-color-primary: #b5b5b5;
    --crepe-color-secondary: #4d4d4d;
    --crepe-color-on-secondary: #d6d6d6;
    --crepe-color-inverse: #e5e5e5;
    --crepe-color-on-inverse: #2a2a2a;
    --crepe-color-inline-code: #ff6666;
    --crepe-color-error: #ff6666;
    --crepe-color-hover: #232323;
    --crepe-color-selected: #2f2f2f;
    --crepe-color-inline-area: #2b2b2b;
    --crepe-font-title: 'Noto Serif', Cambria, 'Times New Roman', Times, serif;
    --crepe-font-default: 'Noto Sans', Arial, Helvetica, sans-serif;
    --crepe-font-code: 'Space Mono', Fira Code, Menlo, Monaco, 'Courier New', Courier, monospace;
    --crepe-shadow-1: 0px 1px 2px 0px rgba(255, 255, 255, 0.3), 0px 1px 3px 1px rgba(255, 255, 255, 0.15);
    --crepe-shadow-2: 0px 1px 2px 0px rgba(255, 255, 255, 0.3), 0px 2px 6px 2px rgba(255, 255, 255, 0.15);
  }

  .milkdown .editor {
    min-height: calc(100vh - 40px);
  }

  /* Mermaid diagrams render inside the code-block component's preview panel. */
  .milkj-mermaid-render {
    padding: 8px 0;
    overflow-x: auto;
  }

  .milkj-mermaid-render svg {
    display: block;
    max-width: 100%;
    height: auto;
    margin: 0 auto;
  }

  .milkj-mermaid-render-error {
    color: var(--crepe-color-error);
    font-family: var(--crepe-font-code);
    white-space: pre-wrap;
  }

  .milkj-image-source-editor {
    position: fixed;
    z-index: 1100;
    box-sizing: border-box;
    padding: 8px 10px;
    border: 1px solid var(--crepe-color-outline, var(--milkj-border));
    border-radius: 8px;
    background: var(--crepe-color-surface, var(--milkj-bg));
    color: var(--crepe-color-on-surface, var(--milkj-fg));
    box-shadow: var(--crepe-shadow-2, 0 4px 16px rgba(0, 0, 0, .2));
  }

  .milkj-image-source-editor[hidden] {
    display: none;
  }

  .milkj-image-source-editor__label {
    display: flex;
    align-items: center;
    gap: 8px;
    color: var(--crepe-color-on-surface-variant, currentColor);
    font: 600 11px/1.3 system-ui, sans-serif;
    text-transform: uppercase;
  }

  .milkj-image-source-editor__input {
    min-width: 0;
    flex: 1;
    box-sizing: border-box;
    padding: 6px 8px;
    border: 1px solid var(--crepe-color-outline, var(--milkj-border));
    border-radius: 5px;
    outline: none;
    background: var(--crepe-color-inline-area, var(--milkj-bg));
    color: var(--crepe-color-on-surface, var(--milkj-fg));
    font: 12px/1.4 var(--crepe-font-code, monospace);
    text-transform: none;
  }

  .milkj-image-source-editor__input:focus {
    border-color: var(--crepe-color-primary, Highlight);
    box-shadow: 0 0 0 1px var(--crepe-color-primary, Highlight);
  }

  .milkj-image-source-editor__input[aria-invalid="true"] {
    border-color: var(--crepe-color-error, #d1242f);
  }

  .milkj-image-source-editor__error {
    margin-top: 5px;
    color: var(--crepe-color-error, #d1242f);
    font: 11px/1.3 system-ui, sans-serif;
  }

  :root {
    --milkj-proofing-spelling: #d1242f;
    --milkj-proofing-grammar: #8250df;
    --milkj-proofing-punctuation: #0969da;
    --milkj-proofing-style: #6e7781;
  }

  :root[data-theme="dark"] {
    --milkj-proofing-spelling: #ff7b72;
    --milkj-proofing-grammar: #d2a8ff;
    --milkj-proofing-punctuation: #79c0ff;
    --milkj-proofing-style: #b1bac4;
  }

  .milkj-proofing-issue {
    text-decoration-line: underline;
    text-decoration-style: wavy;
    text-decoration-thickness: 1.2px;
    text-underline-offset: 3px;
    cursor: pointer;
  }

  .milkj-proofing-issue--spelling { text-decoration-color: var(--milkj-proofing-spelling); color: inherit; }
  .milkj-proofing-issue--grammar { text-decoration-color: var(--milkj-proofing-grammar); color: inherit; }
  .milkj-proofing-issue--punctuation { text-decoration-color: var(--milkj-proofing-punctuation); color: inherit; }
  .milkj-proofing-issue--style { text-decoration-color: var(--milkj-proofing-style); color: inherit; }

  .milkj-proofing-widget {
    display: inline-block;
    width: 4px;
    height: 1em;
    overflow: visible;
    color: var(--milkj-proofing-punctuation);
    cursor: pointer;
    user-select: none;
    vertical-align: baseline;
  }

  .milkj-proofing-popup {
    position: fixed;
    z-index: 1000;
    box-sizing: border-box;
    max-width: min(360px, calc(100vw - 16px));
    padding: 12px;
    border: 1px solid var(--crepe-color-outline, var(--milkj-border));
    border-radius: 8px;
    background: var(--crepe-color-surface, var(--milkj-bg));
    color: var(--crepe-color-on-surface, var(--milkj-fg));
    box-shadow: var(--crepe-shadow-2, 0 4px 16px rgba(0, 0, 0, .2));
    font: 13px/1.4 system-ui, sans-serif;
  }

  .milkj-proofing-popup__category {
    margin-bottom: 4px;
    color: var(--crepe-color-on-surface-variant, currentColor);
    font-size: 11px;
    font-weight: 700;
    text-transform: uppercase;
  }

  .milkj-proofing-popup__actions {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    margin-top: 10px;
  }

  .milkj-proofing-popup__actions button {
    padding: 5px 9px;
    border: 1px solid var(--crepe-color-outline, var(--milkj-border));
    border-radius: 5px;
    background: var(--crepe-color-secondary, transparent);
    color: var(--crepe-color-on-secondary, inherit);
    cursor: pointer;
  }

  .milkj-proofing-popup__actions button:focus-visible {
    outline: 2px solid var(--crepe-color-primary, Highlight);
    outline-offset: 2px;
  }

  .milkj-proofing-popup__empty {
    margin-top: 8px;
    color: var(--crepe-color-on-surface-variant, currentColor);
  }
`;
document.head.append(style);
