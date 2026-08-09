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

  constructor(private readonly canonicalize: MarkdownCanonicalizer = (markdown) => markdown) {}

  acceptIdeRevision(revision: number, sourceMarkdown: string) {
    this.revision = revision;
    this.sourceMarkdown = sourceMarkdown;
    this.canonicalSource = undefined;
    this.userEdited = false;
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
