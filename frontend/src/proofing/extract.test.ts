import { Schema } from "@milkdown/kit/prose/model";
import { describe, expect, it } from "vitest";
import { extractLintBatches, mapCorrection } from "./extract";

const schema = new Schema({
  nodes: {
    doc: { content: "block+" },
    paragraph: { content: "inline*", group: "block" },
    code_block: { content: "text*", group: "block", code: true },
    text: { group: "inline" },
    hard_break: { inline: true, group: "inline" },
  },
  marks: { inlineCode: { code: true } },
});

describe("semantic prose extraction", () => {
  it("includes prose, joins mark boundaries, and excludes inline and block code", () => {
    const inlineCode = schema.marks.inlineCode.create();
    const doc = schema.node("doc", null, [
      schema.node("paragraph", null, [
        schema.text("A wierd "),
        schema.text("sentence"),
        schema.text(" code", [inlineCode]),
        schema.text(" after"),
      ]),
      schema.node("code_block", null, schema.text("misspeled source")),
      schema.node("paragraph", null, schema.text("Final prose")),
    ]);
    const batches = extractLintBatches(doc);
    expect(batches).toHaveLength(1);
    expect(batches[0]?.text).toBe("A wierd sentence after\n\nFinal prose");
    expect(mapCorrection(batches[0]!, {
      startIndex: 2, endIndex: 7, correction: "weird",
      suggestions: [{ replacement: "weird" }], types: ["spelling"], explanation: "",
    }, "one")).toMatchObject({ from: 3, to: 8 });
    expect(mapCorrection(batches[0]!, {
      startIndex: 15, endIndex: 20, correction: "bridge",
      suggestions: [], types: [], explanation: "",
    }, "bad")).toBeNull();
  });

  it("keeps lowercase prose after inline code in the same sentence context", () => {
    const inlineCode = schema.marks.inlineCode.create();
    const doc = schema.node("doc", null, schema.node("paragraph", null, [
      schema.text("Read "),
      schema.text("AGENTS.md", [inlineCode]),
      schema.text(" before starting."),
    ]));
    const [batch] = extractLintBatches(doc);
    expect(batch?.text).toBe("Read  before starting.");
    expect(batch?.runs).toHaveLength(2);
  });

  it("preserves hard breaks as newlines without allowing cross-break mappings", () => {
    const doc = schema.node("doc", null, schema.node("paragraph", null, [
      schema.text("first line"),
      schema.node("hard_break"),
      schema.text("second line"),
    ]));
    const [batch] = extractLintBatches(doc);
    expect(batch?.text).toBe("first line\nsecond line");
    expect(batch?.runs).toHaveLength(2);
    expect(mapCorrection(batch!, {
      startIndex: 6, endIndex: 16, correction: "crossed",
      suggestions: [], types: ["grammar"], explanation: "",
    }, "cross-break")).toBeNull();
  });

  it("windows long runs without splitting surrogate pairs", () => {
    const text = `${"a".repeat(3999)}😀${"b".repeat(4200)}`;
    const doc = schema.node("doc", null, schema.node("paragraph", null, schema.text(text)));
    const batches = extractLintBatches(doc);
    expect(batches.length).toBeGreaterThan(1);
    expect(batches.every((batch) => batch.text.length <= 4000)).toBe(true);
    expect(batches.every((batch) => !/^\udc00/.test(batch.text) && !/\ud83d$/.test(batch.text))).toBe(true);
  });

  it("assigns a seam-crossing correction to the window containing its start", () => {
    const first = {
      text: "a".repeat(200),
      runs: [{ textFrom: 0, textTo: 200, docFrom: 1, docTo: 201 }],
      trustedFrom: 0,
      trustedTo: 100,
    };
    const second = {
      text: "a".repeat(200),
      runs: [{ textFrom: 0, textTo: 200, docFrom: 51, docTo: 251 }],
      trustedFrom: 50,
      trustedTo: 200,
    };
    const correction = {
      startIndex: 98, endIndex: 102, correction: "word",
      suggestions: [{ replacement: "word" }], types: ["spelling"], explanation: "",
    };
    expect(mapCorrection(first, correction, "first")).toMatchObject({ from: 99, to: 103 });
    expect(mapCorrection(second, { ...correction, startIndex: 48, endIndex: 52 }, "second")).toBeNull();
  });
});
