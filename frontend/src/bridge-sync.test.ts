import { describe, expect, it } from "vitest";
import { EditorBridgeSync } from "./bridge-sync";

describe("EditorBridgeSync", () => {
  it("never sends a delayed echo of IDE-applied content", () => {
    const sync = new EditorBridgeSync();
    sync.acceptIdeRevision(7, "IDE content\n");
    sync.applyFromIde(() => sync.recordDocumentChange(false));

    expect(sync.messageForMarkdown("normalized IDE content\n")).toBeUndefined();
  });

  it("sends user edits with the document revision they were based on", () => {
    const sync = new EditorBridgeSync();
    sync.acceptIdeRevision(12, "original\n");
    sync.recordDocumentChange(false);

    expect(sync.messageForMarkdown("user edit\n")).toEqual({
      ok: true,
      message: "markdown:12\nuser edit\n",
    });
  });

  it("resets user edit state when the IDE pushes a newer revision", () => {
    const sync = new EditorBridgeSync();
    sync.acceptIdeRevision(2, "revision 2\n");
    sync.recordUserEdit();
    sync.acceptIdeRevision(3, "revision 3\n");

    expect(sync.messageForMarkdown("late revision 2 callback\n")).toBeUndefined();
  });

  it("clears the IDE-apply guard even when replacement throws", () => {
    const sync = new EditorBridgeSync();
    expect(() => sync.applyFromIde(() => {
      throw new Error("replace failed");
    })).toThrow("replace failed");

    sync.recordDocumentChange(false);
    expect(sync.messageForMarkdown("later user edit")).toEqual({
      ok: true,
      message: "markdown:0\nlater user edit",
    });
  });

  it("recognizes a push of the page's own last write as an echo", () => {
    const sync = new EditorBridgeSync();
    expect(sync.acceptIdeRevision(1, "one\n")).toBe(false);

    sync.recordUserEdit();
    expect(sync.messageForMarkdown("one two\n")).toEqual({
      ok: true,
      message: "markdown:1\none two\n",
    });

    // The IDE autosaves the write and relays it back as if it were an external change.
    expect(sync.acceptIdeRevision(2, "one two\n")).toBe(true);
    // A genuinely different external change is not an echo.
    expect(sync.acceptIdeRevision(3, "external\n")).toBe(false);
  });

  it("keeps an in-flight user edit across an echo of the page's own write", () => {
    const sync = new EditorBridgeSync();
    sync.acceptIdeRevision(1, "one\n");
    sync.recordUserEdit();
    sync.messageForMarkdown("one two\n");

    // The user keeps typing while the IDE echoes the previous write back.
    sync.recordUserEdit();
    expect(sync.acceptIdeRevision(2, "one two\n")).toBe(true);

    expect(sync.messageForMarkdown("one two three\n")).toEqual({
      ok: true,
      message: "markdown:2\none two three\n",
    });
  });

  it("advances its exact-source baseline after each accepted user edit", () => {
    const sync = new EditorBridgeSync();
    sync.acceptIdeRevision(4, "one\n");

    sync.recordUserEdit();
    expect(sync.messageForMarkdown("one two\n")).toEqual({
      ok: true,
      message: "markdown:4\none two\n",
    });

    sync.recordUserEdit();
    expect(sync.messageForMarkdown("one two three\n")).toEqual({
      ok: true,
      message: "markdown:4\none two three\n",
    });
  });
});
