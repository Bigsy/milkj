import type { MarkdownBlockSplitter } from "./markdown-blocks";
import {
  mergeSourcePreservingEdit,
  type MarkdownCanonicalizer,
} from "./source-preserving-sync";

export type MarkdownSyncResult =
  | { ok: true; message: string }
  | { ok: false; reason: string; sourceMarkdown: string };

/** Tracks edit origin and keeps the exact IntelliJ source separate from Crepe's serialization. */
export class EditorBridgeSync {
  private revision = 0;
  private applyingFromIde = false;
  private userEdited = false;
  private sourceMarkdown = "";
  private canonicalSource: string | undefined;

  constructor(
    private readonly canonicalize: MarkdownCanonicalizer = (markdown) => markdown,
    private readonly splitBlocks?: MarkdownBlockSplitter,
  ) {}

  /**
   * Accepts a push from the IDE. Returns true when the pushed text is exactly the source this page
   * last handed to the IDE — an echo of its own write (the IDE relays saves of that write back as
   * if they were external changes). An echo only refreshes the revision: the canonical mapping and
   * any user edit made while the echo was in flight must survive, and the caller must not replace
   * the editor content (which would reset the cursor).
   */
  acceptIdeRevision(revision: number, sourceMarkdown: string): boolean {
    this.revision = revision;
    if (sourceMarkdown === this.sourceMarkdown) {
      return true;
    }
    this.sourceMarkdown = sourceMarkdown;
    this.canonicalSource = undefined;
    this.userEdited = false;
    return false;
  }

  applyFromIde(action: () => void) {
    this.applyingFromIde = true;
    try {
      action();
    } finally {
      this.applyingFromIde = false;
    }
  }

  recordDocumentChange(editorIsBeingCreated: boolean) {
    if (!editorIsBeingCreated && !this.applyingFromIde) {
      this.userEdited = true;
    }
  }

  recordUserEdit() {
    this.userEdited = true;
  }

  messageForMarkdown(markdown: string): MarkdownSyncResult | undefined {
    if (!this.userEdited) {
      return undefined;
    }
    this.userEdited = false;

    const merged = mergeSourcePreservingEdit(
      this.sourceMarkdown,
      markdown,
      this.canonicalize,
      this.canonicalSource,
      this.splitBlocks,
    );
    if (!merged.ok) {
      return {
        ok: false,
        reason: merged.reason,
        sourceMarkdown: this.sourceMarkdown,
      };
    }

    this.sourceMarkdown = merged.markdown;
    this.canonicalSource = markdown;
    return {
      ok: true,
      message: `markdown:${this.revision}\n${merged.markdown}`,
    };
  }
}
