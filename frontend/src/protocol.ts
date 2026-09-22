/**
 * The wire protocol between this page and the Kotlin host
 * (../../src/main/kotlin/com/hedworth/milkj/bridge/BridgeProtocol.kt). Every message in either
 * direction is one JSON object discriminated by its `type`:
 *  - page -> IDE: `sendToIde` serializes a PageMessage through `window.milkjSendToIde`;
 *  - IDE -> page: the IDE calls `window.milkjReceive` with an IdeMessage object.
 *
 * Both sides ship in the same plugin build, so the protocol is not versioned. protocol/fixtures.json
 * holds one example of every message; protocol.test.ts and the Kotlin protocol test both check their
 * own definitions against it, which is what keeps the two sides from drifting apart.
 */
import type { ProofingDialect } from "./proofing/types";

export type PageMessage =
  // The editor exists and can receive content.
  | { type: "ready" }
  // A user edit, based on the content the IDE pushed as `revision`.
  | { type: "markdown"; revision: number; markdown: string }
  // An edit that could not be merged onto the source safely was reverted.
  | { type: "roundtripError"; reason: string }
  | { type: "dictionaryAdd"; word: string }
  // Cmd/Ctrl-click on a project file link, `href` exactly as written in the Markdown.
  | { type: "navigateFile"; href: string }
  // Cmd/Ctrl-click on an http(s)/mailto link.
  | { type: "navigateUrl"; href: string }
  // A pasted/dropped image to store next to the Markdown file; `base64` has no `data:` prefix.
  | { type: "imageUpload"; requestId: string; fileName: string; mimeType: string; base64: string }
  // Caret anchor and scroll offset, both non-negative integers, for the editor tab's state.
  | { type: "viewState"; anchor: number; scrollTop: number }
  // Ctrl/Cmd +, - or 0; the IDE owns the zoom level.
  | { type: "zoom"; command: "in" | "out" | "reset" };

export type IdeMessage =
  // Fresh content (initial load or an external edit), stamped with the IDE's revision.
  | { type: "setMarkdown"; markdown: string; revision: number }
  | { type: "applyConfig"; config: MilkJConfig }
  // Caret and scroll position to restore once a reopened file's content has been pushed.
  | { type: "setViewState"; anchor: number; scrollTop: number }
  // The reply to an imageUpload: the Markdown-relative path, or null when the IDE refused it.
  | { type: "imageUploaded"; requestId: string; path: string | null };

export type PageMessageOf<T extends PageMessage["type"]> = Extract<PageMessage, { type: T }>;
export type IdeMessageOf<T extends IdeMessage["type"]> = Extract<IdeMessage, { type: T }>;

export type MilkJTheme = "light" | "dark";
export type MilkJEditorTheme = "NORD" | "CLASSIC" | "FRAME";
export type MilkJMermaidTheme = "AUTO" | "DEFAULT" | "DARK" | "FOREST" | "NEUTRAL" | "BASE";

export interface MilkJConfig {
  // The resolved colour scheme; configuredTheme is the setting it came from.
  theme: MilkJTheme;
  configuredTheme: "FOLLOW_IDE" | "LIGHT" | "DARK";
  editorTheme: MilkJEditorTheme;
  mermaidTheme: MilkJMermaidTheme;
  defaultEditor: "BUILT_IN" | "MILKJ";
  placeholder: string;
  // Font family overrides from settings; blank keeps the editor theme's own fonts.
  textFontFamily: string;
  headingFontFamily: string;
  codeFontFamily: string;
  proofingEnabled: boolean;
  proofingDialect: ProofingDialect;
  customDictionary: string[];
  // Base64 Weirpack archives, enabled ones only.
  weirpacks: string[];
  // True when the editor surface must not accept edits: the file is read-only or sync is paused.
  readonly: boolean;
  // Present when the Markdown file is on the local file system.
  localImageBaseUrl?: string;
}

declare global {
  interface Window {
    // Injected by JCEF (JBCefJSQuery.inject); carries one serialized PageMessage per call.
    milkjSendToIde?: (message: string) => void;
    milkjReceive?: (message: IdeMessage) => void;
    // Called by the IDE once milkjSendToIde has been injected after a page load.
    milkjBridgeInstalled?: () => void;
  }
}

/** True once the IDE has injected the bridge; messages sent before that are lost. */
export function bridgeInstalled(): boolean {
  return window.milkjSendToIde !== undefined;
}

export function sendToIde(message: PageMessage): void {
  window.milkjSendToIde?.(JSON.stringify(message));
}
