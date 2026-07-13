/** Tracks whether a Milkdown update came from the IDE or from an actual editor transaction. */
export class EditorBridgeSync {
  private revision = 0;
  private applyingFromIde = false;
  private userEdited = false;

  acceptIdeRevision(revision: number) {
    this.revision = revision;
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

  messageForMarkdown(markdown: string): string | undefined {
    if (!this.userEdited) {
      return undefined;
    }
    return `markdown:${this.revision}\n${markdown}`;
  }
}
