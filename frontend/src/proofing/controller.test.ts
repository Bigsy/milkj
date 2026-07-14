// @vitest-environment jsdom

import { Schema, type Node as ProseMirrorNode } from "@milkdown/kit/prose/model";
import { EditorState } from "@milkdown/kit/prose/state";
import { EditorView } from "@milkdown/kit/prose/view";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HarperEngineResult } from "./types";
import { ProofingController, type ProofingEngine } from "./plugin";

const schema = new Schema({
  nodes: {
    doc: { content: "paragraph+" },
    paragraph: { content: "text*", toDOM: () => ["p", 0] },
    text: {},
  },
  marks: { strong: { toDOM: () => ["strong", 0] } },
});

function doc(text: string) {
  return schema.node("doc", null, schema.node("paragraph", null, schema.text(text)));
}

function correction(): HarperEngineResult {
  return {
    corrections: [{
      startIndex: 4,
      endIndex: 9,
      correction: "weird",
      suggestions: [{ replacement: "weird" }],
      types: ["spelling"],
      explanation: "Did you mean weird?",
    }],
  };
}

function createHarness(
  engine: ProofingEngine,
  content: string | ProseMirrorNode = "one wierd ending",
  onUserEdit: () => void = vi.fn(),
  onAddDictionaryWord: (word: string) => void = vi.fn(),
) {
  const controller = new ProofingController({ onUserEdit, onAddDictionaryWord, engine });
  const state = EditorState.create({
    doc: typeof content === "string" ? doc(content) : content,
    plugins: [controller.createPlugin()],
  });
  const host = document.body.appendChild(document.createElement("div"));
  const view = new EditorView(host, { state });
  return { controller, host, view };
}

function activate(view: EditorView) {
  view.dom.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
}

function mockEngine(results: Array<HarperEngineResult | Promise<HarperEngineResult>>): ProofingEngine & {
  lint: ReturnType<typeof vi.fn>;
} {
  return {
    lint: vi.fn(async () => await results.shift()!),
    dispose: vi.fn(async () => undefined),
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

afterEach(() => {
  vi.useRealTimers();
  document.body.replaceChildren();
});

describe("proofing controller lifecycle", () => {
  it("does not lint until the editor receives user activation", async () => {
    vi.useFakeTimers();
    const engine = mockEngine([{ corrections: [] }]);
    const { controller, view } = createHarness(engine);
    await vi.advanceTimersByTimeAsync(1000);
    expect(engine.lint).not.toHaveBeenCalled();

    activate(view);
    await vi.advanceTimersByTimeAsync(0);
    expect(engine.lint).toHaveBeenCalledTimes(1);
    view.destroy();
    await controller.dispose();
  });

  it("stores dictionary configuration lazily and passes it to the first lint", async () => {
    vi.useFakeTimers();
    const engine = mockEngine([{ corrections: [] }]);
    const { controller, view } = createHarness(engine);
    controller.configure(true, "AUTO", false, [" Proofly ", "MilkJ"]);
    await vi.advanceTimersByTimeAsync(1000);
    expect(engine.lint).not.toHaveBeenCalled();
    activate(view);
    await vi.advanceTimersByTimeAsync(0);
    expect(engine.lint).toHaveBeenCalledWith(expect.any(String), expect.any(String), ["MilkJ", "Proofly"]);
    view.destroy();
    await controller.dispose();
  });

  it("invalidates in-flight results and re-lints when the dictionary changes", async () => {
    vi.useFakeTimers();
    const pending = deferred<HarperEngineResult>();
    const engine = mockEngine([pending.promise, { corrections: [] }]);
    const { controller, view } = createHarness(engine);
    activate(view);
    await vi.advanceTimersByTimeAsync(0);
    controller.configure(true, "AUTO", false, ["wierd"]);
    await vi.advanceTimersByTimeAsync(600);
    pending.resolve(correction());
    await Promise.resolve();
    expect(engine.lint).toHaveBeenCalledTimes(2);
    expect(engine.lint.mock.calls[1]?.[2]).toEqual(["wierd"]);
    expect(view.dom.querySelectorAll(".milkj-proofing-issue")).toHaveLength(0);
    view.destroy();
    await controller.dispose();
  });

  it("re-lints a doc-changing transaction whose parsed document is content-equal", async () => {
    vi.useFakeTimers();
    const engine = mockEngine([correction()]);
    const { controller, view } = createHarness(engine);
    activate(view);
    await vi.advanceTimersByTimeAsync(0);
    expect(engine.lint).toHaveBeenCalledTimes(1);
    expect(view.dom.querySelectorAll(".milkj-proofing-issue")).toHaveLength(1);

    const before = view.state.doc;
    const equalReplacement = doc("one wierd ending");
    view.dispatch(view.state.tr.replaceWith(0, before.content.size, equalReplacement.content));
    expect(view.state.doc).not.toBe(before);
    expect(view.state.doc.eq(before)).toBe(true);
    expect(view.dom.querySelectorAll(".milkj-proofing-issue")).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(600);
    expect(view.dom.querySelectorAll(".milkj-proofing-issue")).toHaveLength(1);
    view.destroy();
    await controller.dispose();
  });

  it("keeps mapped decorations when a later lint generation fails", async () => {
    vi.useFakeTimers();
    const engine = mockEngine([correction(), { corrections: [], error: "worker failed" }]);
    const { controller, view } = createHarness(engine);
    activate(view);
    await vi.advanceTimersByTimeAsync(0);
    expect(view.dom.querySelectorAll(".milkj-proofing-issue")).toHaveLength(1);

    view.dispatch(view.state.tr.insertText("!", view.state.doc.content.size - 1));
    expect(view.dom.querySelectorAll(".milkj-proofing-issue")).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(600);
    expect(engine.lint).toHaveBeenCalledTimes(2);
    expect(view.dom.querySelectorAll(".milkj-proofing-issue")).toHaveLength(1);
    view.destroy();
    await controller.dispose();
  });

  it("stops an invalidated multi-batch generation before linting another batch", async () => {
    vi.useFakeTimers();
    const pending = deferred<HarperEngineResult>();
    const engine = mockEngine([pending.promise, { corrections: [] }]);
    const { controller, view } = createHarness(engine, "a".repeat(8000));
    activate(view);
    await vi.advanceTimersByTimeAsync(0);
    expect(engine.lint).toHaveBeenCalledTimes(1);

    view.dispatch(view.state.tr.insertText("b", 2));
    pending.resolve({ corrections: [] });
    await Promise.resolve();
    await Promise.resolve();
    expect(engine.lint).toHaveBeenCalledTimes(1);
    view.destroy();
    await controller.dispose();
  });

  it("resolves inline clicks and calls onUserEdit before dispatching a suggestion", async () => {
    vi.useFakeTimers();
    const order: string[] = [];
    const engine = mockEngine([correction()]);
    const { controller, view } = createHarness(engine, "one wierd ending", () => order.push("edit"));
    activate(view);
    await vi.advanceTimersByTimeAsync(0);
    vi.spyOn(view, "posAtCoords").mockReturnValue({ pos: 6, inside: -1 });
    vi.spyOn(view, "coordsAtPos").mockReturnValue({ left: 0, right: 10, top: 0, bottom: 10 });
    const originalDispatch = view.dispatch.bind(view);
    vi.spyOn(view, "dispatch").mockImplementation((tr) => {
      order.push("dispatch");
      originalDispatch(tr);
    });

    view.dom.querySelector<HTMLElement>(".milkj-proofing-issue")!
      .dispatchEvent(new MouseEvent("click", { bubbles: true, clientX: 1, clientY: 1 }));
    expect(document.querySelector(".milkj-proofing-popup__explanation")).toBeNull();
    expect(document.querySelector(".milkj-proofing-popup")?.textContent)
      .not.toContain("Did you mean");
    document.querySelector<HTMLButtonElement>(".milkj-proofing-popup__actions button")!.click();
    expect(order.slice(0, 2)).toEqual(["edit", "dispatch"]);
    expect(view.state.doc.textContent).toBe("one weird ending");
    view.destroy();
    await controller.dispose();
  });

  it("hides replacements but permits dictionary actions in readonly mode", async () => {
    vi.useFakeTimers();
    const engine = mockEngine([correction()]);
    const { controller, view } = createHarness(engine);
    controller.configure(true, "AUTO", true);
    activate(view);
    await vi.advanceTimersByTimeAsync(0);
    vi.spyOn(view, "posAtCoords").mockReturnValue({ pos: 6, inside: -1 });
    vi.spyOn(view, "coordsAtPos").mockReturnValue({ left: 0, right: 10, top: 0, bottom: 10 });
    view.dom.querySelector<HTMLElement>(".milkj-proofing-issue")!
      .dispatchEvent(new MouseEvent("click", { bubbles: true, clientX: 1, clientY: 1 }));
    expect(document.querySelector(".milkj-proofing-popup")).not.toBeNull();
    expect(document.querySelectorAll(".milkj-proofing-popup__actions button")).toHaveLength(1);
    expect(document.querySelector(".milkj-proofing-popup__dictionary")?.textContent)
      .toBe("Add “wierd” to dictionary");
    view.destroy();
    await controller.dispose();
  });

  it("adds the exact current mapped word without editing the document", async () => {
    vi.useFakeTimers();
    const add = vi.fn();
    const userEdit = vi.fn();
    const engine = mockEngine([correction()]);
    const { controller, view } = createHarness(engine, "one wierd ending", userEdit, add);
    activate(view);
    await vi.advanceTimersByTimeAsync(0);
    view.dispatch(view.state.tr.insertText("X", 1));
    vi.spyOn(view, "posAtCoords").mockReturnValue({ pos: 7, inside: -1 });
    vi.spyOn(view, "coordsAtPos").mockReturnValue({ left: 0, right: 10, top: 0, bottom: 10 });
    view.dom.querySelector<HTMLElement>(".milkj-proofing-issue")!
      .dispatchEvent(new MouseEvent("click", { bubbles: true, clientX: 1, clientY: 1 }));
    const dispatch = vi.spyOn(view, "dispatch");
    document.querySelector<HTMLButtonElement>(".milkj-proofing-popup__dictionary")!.click();
    expect(add).toHaveBeenCalledWith("wierd");
    expect(userEdit).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();
    expect(view.state.doc.textContent).toBe("Xone wierd ending");
    view.destroy();
    await controller.dispose();
  });

  it("preserves uniform marks when applying a replacement", async () => {
    vi.useFakeTimers();
    const strong = schema.marks.strong.create();
    const markedDoc = schema.node("doc", null, schema.node("paragraph", null, [
      schema.text("one "),
      schema.text("wierd", [strong]),
      schema.text(" ending"),
    ]));
    const engine = mockEngine([correction()]);
    const { controller, view } = createHarness(engine, markedDoc);
    activate(view);
    await vi.advanceTimersByTimeAsync(0);
    vi.spyOn(view, "posAtCoords").mockReturnValue({ pos: 6, inside: -1 });
    vi.spyOn(view, "coordsAtPos").mockReturnValue({ left: 0, right: 10, top: 0, bottom: 10 });
    view.dom.querySelector<HTMLElement>(".milkj-proofing-issue")!
      .dispatchEvent(new MouseEvent("click", { bubbles: true, clientX: 1, clientY: 1 }));
    document.querySelector<HTMLButtonElement>(".milkj-proofing-popup__actions button")!.click();
    const replaced = view.state.doc.nodeAt(5);
    expect(replaced?.text).toBe("weird");
    expect(replaced?.marks.map((mark) => mark.type.name)).toEqual(["strong"]);
    view.destroy();
    await controller.dispose();
  });
});
