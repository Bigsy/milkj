// @vitest-environment jsdom

import { Schema } from "@milkdown/kit/prose/model";
import { EditorState } from "@milkdown/kit/prose/state";
import { EditorView } from "@milkdown/kit/prose/view";
import { search } from "prosemirror-search";
import { expect, it, vi } from "vitest";
import { installFindBar } from "./findbar";

it("reveals next, previous and wrapped matches while Find keeps focus", () => {
  const schema = new Schema({
    nodes: {
      doc: { content: "paragraph+" },
      paragraph: { content: "text*", toDOM: () => ["p", 0] },
      text: {},
    },
  });
  const root = document.body.appendChild(document.createElement("div"));
  const view = new EditorView(root, {
    state: EditorState.create({
      schema,
      doc: schema.node("doc", null, [
        schema.node("paragraph", null, schema.text("needle first")),
        schema.node("paragraph", null, schema.text("filler ".repeat(1000))),
        schema.node("paragraph", null, schema.text("needle last")),
      ]),
      plugins: [search()],
    }),
  });
  const revealed: Element[] = [];
  const original = Element.prototype.scrollIntoView;
  Element.prototype.scrollIntoView = function () { revealed.push(this); };
  try {
    installFindBar({ getView: () => view, onUserEdit: vi.fn() });
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "f", ctrlKey: true }));
    const input = document.querySelector<HTMLInputElement>(".milkj-findbar-search")!;
    input.value = "needle";
    input.dispatchEvent(new Event("input"));

    const step = (selector: string, expected: string) => {
      const before = revealed.length;
      document.querySelector<HTMLButtonElement>(selector)!.click();
      expect(revealed.length).toBe(before + 1);
      expect(revealed.at(-1)?.parentElement?.textContent).toBe(expected);
      expect(document.activeElement).toBe(input);
    };
    step(".milkj-findbar-next", "needle first");
    step(".milkj-findbar-next", "needle last");
    step(".milkj-findbar-next", "needle first");
    step(".milkj-findbar-prev", "needle last");

    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
    expect(revealed.at(-1)?.parentElement?.textContent).toBe("needle first");
    expect(document.activeElement).toBe(input);
    input.value = "missing";
    input.dispatchEvent(new Event("input"));
    const before = revealed.length;
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
    expect(revealed.length).toBe(before);
  } finally {
    Element.prototype.scrollIntoView = original;
    view.destroy();
    document.body.replaceChildren();
  }
});
