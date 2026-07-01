import {
  LanguageDescription,
  LanguageSupport,
  StreamLanguage,
  type StreamParser,
} from "@codemirror/language";
import { languages } from "@codemirror/language-data";
import { Crepe, CrepeFeature } from "@milkdown/crepe";
import { replaceAll } from "@milkdown/kit/utils";
import mermaid from "mermaid";
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
    milkjSetMarkdown?: (markdown: string) => void;
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
let currentReadonly = false;
let crepe: Crepe | undefined;
let editorReady = false;
let readySent = false;
let mermaidRenderEpoch = 0;
let mermaidObserver: MutationObserver | undefined;
let renderingMermaid = false;

// Milkdown's listener plugin fires markdownUpdated ~200ms (debounced) after ANY doc-changing
// transaction — including Crepe's own init/normalization transactions and content the IDE just
// pushed in. Those echoes must never reach the IDE: the Crepe-normalized markdown usually differs
// from the text on disk (bullet style, escaping, spacing), so writing it into the Document would
// dirty it without any user edit and trigger spurious "File Cache Conflict" dialogs.
//
// A boolean flag can't model this: the echo arrives after the apply returns (debounce), and an
// apply that leaves the doc unchanged fires no echo at all, which would strand the flag. Instead,
// echoes are suppressed for a time window after every IDE-driven apply; any direct user
// interaction lifts the suppression immediately so real edits are never swallowed.
const ECHO_SUPPRESS_MS = 500;
let suppressEchoUntil = 0;

function suppressMarkdownEchoes() {
  suppressEchoUntil = performance.now() + ECHO_SUPPRESS_MS;
}

for (const type of ["keydown", "pointerdown", "paste", "cut", "drop"]) {
  root.addEventListener(type, () => {
    suppressEchoUntil = 0;
  }, { capture: true });
}

applyChrome();

async function createEditor(markdown: string) {
  mermaidObserver?.disconnect();
  root.replaceChildren();
  crepe = new Crepe({
    root,
    defaultValue: markdown,
    featureConfigs: {
      [CrepeFeature.CodeMirror]: {
        languages: milkjCodeLanguages,
      },
    },
  });
  await crepe.create();
  crepe.setReadonly(currentReadonly);
  crepe.on((listener) => {
    listener.markdownUpdated((_ctx, markdown) => {
      currentMarkdown = markdown;
      if (performance.now() >= suppressEchoUntil) {
        window.milkjSendToIde?.(`markdown:${markdown}`);
      }
      scheduleMermaidRender();
    });
  });
  suppressMarkdownEchoes();
  installMermaidObserver();
  scheduleMermaidRender();
}

function applyChrome() {
  document.documentElement.dataset.theme = currentTheme;
  document.documentElement.dataset.editorTheme = currentEditorTheme.toLowerCase();
  mermaid.initialize({
    startOnLoad: false,
    theme: effectiveMermaidTheme(),
  });
  scheduleMermaidRender();
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

function scheduleMermaidRender() {
  const epoch = ++mermaidRenderEpoch;
  window.setTimeout(() => {
    if (epoch === mermaidRenderEpoch) {
      void renderMermaidPreviews();
    }
  }, 50);
}

async function renderMermaidPreviews() {
  mermaidObserver?.disconnect();
  renderingMermaid = true;

  const sources = extractMermaidSources(currentMarkdown);
  try {
    if (sources.length === 0) {
      root.querySelectorAll(".milkj-mermaid-render").forEach((node) => node.remove());
      return;
    }

    const usedSourceIndexes = new Set<number>();
    const codeBlocks = Array.from(root.querySelectorAll(".milkdown-code-block, pre"))
      .filter((codeBlock) => !codeBlock.closest(".milkj-mermaid-render"));

    for (const codeBlock of codeBlocks) {
      const [existingPreview, ...duplicatePreviews] = getMermaidPreviews(codeBlock);
      duplicatePreviews.forEach((preview) => preview.remove());

      const sourceIndex = findMermaidSourceIndex(getCodeBlockText(codeBlock), sources, usedSourceIndexes);
      if (sourceIndex === -1) {
        existingPreview?.remove();
        continue;
      }

      usedSourceIndexes.add(sourceIndex);
      const source = sources[sourceIndex];
      const renderKey = `${currentTheme}:${currentMermaidTheme}:${normalizeMermaidSource(source)}`;
      const container = existingPreview ?? createMermaidPreview();
      attachMermaidPreview(codeBlock, container);

      if (container.dataset.renderKey === renderKey && container.childElementCount > 0) {
        continue;
      }

      container.dataset.renderKey = renderKey;
      container.classList.remove("milkj-mermaid-render-error");
      container.textContent = "Rendering diagram...";

      try {
        const id = `milkj-mermaid-${Date.now()}-${sourceIndex}-${Math.random()
          .toString(36)
          .slice(2)}`;
        const { svg } = await mermaid.render(id, source);
        container.innerHTML = svg;
      } catch (error) {
        container.classList.add("milkj-mermaid-render-error");
        container.textContent = error instanceof Error ? error.message : "Unable to render Mermaid diagram.";
      }
    }
  } finally {
    renderingMermaid = false;
    installMermaidObserver();
  }
}

function installMermaidObserver() {
  mermaidObserver?.disconnect();
  mermaidObserver = new MutationObserver((mutations) => {
    if (renderingMermaid || mutations.every(isMermaidPreviewMutation)) {
      return;
    }

    scheduleMermaidRender();
  });
  mermaidObserver.observe(root, {
    childList: true,
    characterData: true,
    subtree: true,
  });
}

function extractMermaidSources(markdown: string): string[] {
  const sources: string[] = [];
  const mermaidFence = /```mermaid[^\n]*\n([\s\S]*?)```/gi;
  let match: RegExpExecArray | null;

  while ((match = mermaidFence.exec(markdown)) !== null) {
    sources.push(match[1].trim());
  }

  return sources;
}

function findMermaidSourceIndex(
  codeBlockText: string,
  sources: string[],
  usedSourceIndexes: Set<number>,
): number {
  const normalizedCodeBlock = normalizeMermaidSource(codeBlockText);
  const exactMatch = sources.findIndex(
    (source, index) =>
      !usedSourceIndexes.has(index) &&
      normalizeMermaidSource(source) === normalizedCodeBlock,
  );
  if (exactMatch !== -1) {
    return exactMatch;
  }

  if (!looksLikeMermaidSource(normalizedCodeBlock)) {
    return -1;
  }

  return sources.findIndex((_source, index) => !usedSourceIndexes.has(index));
}

function getCodeBlockText(codeBlock: Element): string {
  const codeMirrorLines = Array.from(codeBlock.querySelectorAll(".cm-line"));
  if (codeMirrorLines.length > 0) {
    return codeMirrorLines.map((line) => line.textContent ?? "").join("\n");
  }

  const codeMirrorContent = codeBlock.querySelector(".cm-content");
  if (codeMirrorContent) {
    return codeMirrorContent.textContent ?? "";
  }

  return codeBlock.textContent ?? "";
}

function normalizeMermaidSource(source: string): string {
  return source.replace(/\r\n/g, "\n").trim();
}

function looksLikeMermaidSource(source: string): boolean {
  return /^(flowchart|graph|sequenceDiagram|classDiagram|stateDiagram|stateDiagram-v2|erDiagram|gantt|pie|journey|gitGraph|mindmap|timeline|quadrantChart|xychart-beta|block-beta|C4Context)\b/.test(
    source,
  );
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

function createMermaidPreview(): HTMLDivElement {
  const container = document.createElement("div");
  container.className = "milkj-mermaid-render";
  container.contentEditable = "false";
  container.dataset.milkjTransient = "true";
  return container;
}

function getMermaidPreviews(codeBlock: Element): HTMLDivElement[] {
  return Array.from(codeBlock.querySelectorAll<HTMLDivElement>(".milkj-mermaid-render"));
}

function attachMermaidPreview(codeBlock: Element, container: HTMLDivElement) {
  if (container.parentElement === codeBlock) {
    return;
  }

  codeBlock.append(container);
}

function isMermaidPreviewMutation(mutation: MutationRecord): boolean {
  const changedNodes = [...mutation.addedNodes, ...mutation.removedNodes];
  return changedNodes.length > 0 && changedNodes.every(isMermaidPreviewNode);
}

function isMermaidPreviewNode(node: Node): boolean {
  return node instanceof Element && (
    node.classList.contains("milkj-mermaid-render") ||
    node.closest(".milkj-mermaid-render") !== null
  );
}

window.milkjSetMarkdown = (markdown: string) => {
  if (markdown === currentMarkdown) {
    return;
  }
  currentMarkdown = markdown;
  if (crepe && editorReady) {
    // Replace content in place: rebuilding Crepe on every external edit would tear down
    // ProseMirror, the CodeMirror blocks and the Mermaid observer, losing cursor and scroll.
    crepe.editor.action(replaceAll(markdown));
    suppressMarkdownEchoes();
    scheduleMermaidRender();
  } else {
    void createEditor(markdown);
  }
};

window.milkjApplyConfig = (config: MilkJConfig) => {
  currentTheme = config.theme;
  currentEditorTheme = config.editorTheme;
  currentMermaidTheme = config.mermaidTheme;
  currentReadonly = config.readonly === true;
  crepe?.setReadonly(currentReadonly);
  applyChrome();
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

void createEditor(currentMarkdown).then(() => {
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

  .milkj-mermaid-render {
    margin: 10px 0 18px;
    padding: 14px;
    overflow-x: auto;
    border: 1px solid var(--milkj-border);
    border-radius: 6px;
    background: var(--crepe-color-surface);
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
`;
document.head.append(style);
