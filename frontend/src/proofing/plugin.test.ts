import { Schema } from "@milkdown/kit/prose/model";
import { EditorState } from "@milkdown/kit/prose/state";
import { Decoration, DecorationSet } from "@milkdown/kit/prose/view";
import { describe, expect, it } from "vitest";
import { pruneTouchedDecorations } from "./plugin";

const schema = new Schema({
  nodes: {
    doc: { content: "paragraph+" },
    paragraph: { content: "text*" },
    text: {},
  },
});

function setup() {
  const doc = schema.node("doc", null, schema.node("paragraph", null, schema.text("one wierd ending")));
  const state = EditorState.create({ doc });
  const decorations = DecorationSet.create(doc, [Decoration.inline(5, 10, {}, { id: "issue" })]);
  return { state, decorations };
}

describe("proofing decoration edit mapping", () => {
  it("keeps and shifts an untouched issue", () => {
    const { state, decorations } = setup();
    const tr = state.tr.insertText("X", 2);
    const mapped = pruneTouchedDecorations(decorations.map(tr.mapping, tr.doc), tr).find();
    expect(mapped).toHaveLength(1);
    expect(mapped[0]).toMatchObject({ from: 6, to: 11 });
  });

  it("drops an issue touched by an edit", () => {
    const { state, decorations } = setup();
    const tr = state.tr.insertText("X", 7);
    expect(pruneTouchedDecorations(decorations.map(tr.mapping, tr.doc), tr).find()).toEqual([]);
  });

  it("maps each changed range through later steps", () => {
    const { state, decorations } = setup();
    const tr = state.tr.insertText("X", 7).insertText("Y", 2);
    expect(pruneTouchedDecorations(decorations.map(tr.mapping, tr.doc), tr).find()).toEqual([]);
  });
});
