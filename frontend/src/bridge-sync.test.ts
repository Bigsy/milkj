import { describe, expect, it } from "vitest";
import { EditorBridgeSync } from "./bridge-sync";

describe("EditorBridgeSync", () => {
  it("never sends a delayed echo of IDE-applied content", () => {
    const sync = new EditorBridgeSync();
    sync.acceptIdeRevision(7);
    sync.applyFromIde(() => sync.recordDocumentChange(false));

    expect(sync.messageForMarkdown("normalized IDE content\n")).toBeUndefined();
  });

  it("sends user edits with the document revision they were based on", () => {
    const sync = new EditorBridgeSync();
    sync.acceptIdeRevision(12);
    sync.recordDocumentChange(false);

    expect(sync.messageForMarkdown("user edit\n")).toBe("markdown:12\nuser edit\n");
  });

  it("resets user edit state when the IDE pushes a newer revision", () => {
    const sync = new EditorBridgeSync();
    sync.acceptIdeRevision(2);
    sync.recordUserEdit();
    sync.acceptIdeRevision(3);

    expect(sync.messageForMarkdown("late revision 2 callback\n")).toBeUndefined();
  });

  it("clears the IDE-apply guard even when replacement throws", () => {
    const sync = new EditorBridgeSync();
    expect(() => sync.applyFromIde(() => {
      throw new Error("replace failed");
    })).toThrow("replace failed");

    sync.recordDocumentChange(false);
    expect(sync.messageForMarkdown("later user edit")).toBe("markdown:0\nlater user edit");
  });
});
