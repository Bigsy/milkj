// @vitest-environment jsdom

import { Editor, remarkCtx, rootCtx } from "@milkdown/kit/core";
import { commonmark } from "@milkdown/kit/preset/commonmark";
import { gfm } from "@milkdown/kit/preset/gfm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type MarkdownBlock, splitMarkdownBlocks } from "./markdown-blocks";

const WIDE_TABLE = `# Runbook

| Thing | Value |
| --- | --- |
| note | a value long enough that the canonical form pads every other cell in this column |
| keep | value 1 |

After the table.
`;

const TASK_LIST = `- [ ] first task
- [x] second task with
      a continuation line
- [ ] third task
`;

const FENCED_CODE = `Intro.

\`\`\`ts
const table = "| not | a | table |";
\`\`\`

Outro.
`;

const FRONTMATTER = `---
title: Runbook
tags:
  - infra
---

# Plan

Body text.
`;

const RAW_HTML = `<details data-owner="MilkJ">
<summary>Advanced</summary>

Raw HTML payload.
</details>

A paragraph.
`;

const CRLF = "# Heading\r\n\r\nFirst paragraph.\r\n\r\n- a\r\n- b\r\n";

const CORPUS = [
  { name: "a wide GFM table", markdown: WIDE_TABLE },
  { name: "a task list", markdown: TASK_LIST },
  { name: "fenced code", markdown: FENCED_CODE },
  { name: "YAML frontmatter", markdown: FRONTMATTER },
  { name: "a raw HTML block", markdown: RAW_HTML },
  { name: "a CRLF document", markdown: CRLF },
  { name: "a blockquote", markdown: "> para one\n>\n> para two\n> more of two\n\nAfter.\n" },
  { name: "a nested list", markdown: "- outer one\n  - inner a\n  - inner b\n- outer two\n" },
  { name: "an empty document", markdown: "" },
  { name: "a document of blank lines", markdown: "\n\n\n" },
  { name: "no trailing newline", markdown: "# Title\n\nLast line" },
];

/** Block bytes plus the gaps between them: must reproduce the split text exactly, at every level. */
function reassemble(markdown: string, block: MarkdownBlock): string {
  const children = block.children;
  const first = children[0];
  const last = children[children.length - 1];
  if (!first || !last) {
    return markdown.slice(block.start, block.end);
  }
  let text = markdown.slice(block.start, first.start);
  children.forEach((child, index) => {
    const previous = children[index - 1];
    if (previous) {
      text += markdown.slice(previous.end, child.start);
    }
    text += reassemble(markdown, child);
  });
  return text + markdown.slice(last.end, block.end);
}

function blockAt(root: MarkdownBlock, ...path: number[]): MarkdownBlock {
  return path.reduce((block, index) => block.children[index]!, root);
}

describe("splitting Markdown into blocks with the Milkdown processor", () => {
  let editor: Editor;
  let split: (markdown: string) => MarkdownBlock | undefined;

  beforeAll(async () => {
    const root = document.body.appendChild(document.createElement("div"));
    editor = await Editor.make()
      .config((ctx) => ctx.set(rootCtx, root))
      .use(commonmark)
      .use(gfm)
      .create();
    split = (markdown) => splitMarkdownBlocks(editor.ctx.get(remarkCtx), markdown);
  });

  afterAll(async () => {
    await editor.destroy();
  });

  it.each(CORPUS)("reports ranges that reassemble $name byte-for-byte", ({ markdown }) => {
    const root = split(markdown);

    expect(root).toBeDefined();
    expect(reassemble(markdown, root!)).toBe(markdown);
  });

  it("gives each top-level block the exact source text of that block", () => {
    const root = split(WIDE_TABLE)!;

    expect(root.children.map((block) => [block.type, WIDE_TABLE.slice(block.start, block.end)]))
      .toEqual([
        ["heading", "# Runbook"],
        ["table", [
          "| Thing | Value |",
          "| --- | --- |",
          "| note | a value long enough that the canonical form pads every other cell in this column |",
          "| keep | value 1 |",
        ].join("\n")],
        ["paragraph", "After the table."],
      ]);
  });

  it("keeps a fenced code block's fences and content inside one range", () => {
    const root = split(FENCED_CODE)!;

    expect(root.children.map((block) => block.type)).toEqual(["paragraph", "code", "paragraph"]);
    expect(FENCED_CODE.slice(blockAt(root, 1).start, blockAt(root, 1).end)).toBe(
      '```ts\nconst table = "| not | a | table |";\n```',
    );
  });

  it("covers frontmatter with blocks that stop before the body", () => {
    // Crepe does not model frontmatter, so it parses as ordinary blocks. What matters is that their
    // ranges are exact: the merge preserves them by emitting source bytes, not by understanding them.
    const root = split(FRONTMATTER)!;
    const body = FRONTMATTER.indexOf("# Plan");

    expect(root.children[0]).toMatchObject({ type: "thematicBreak", start: 0, end: 3 });
    expect(root.children.filter((block) => block.start < body).map((block) => block.type))
      .toEqual(["thematicBreak", "paragraph", "list", "thematicBreak"]);
    expect(blockAt(root, 4)).toMatchObject({ type: "heading", start: body });
  });

  it("keeps CRLF line endings outside every block's range", () => {
    const root = split(CRLF)!;
    const slices = root.children.map((block) => CRLF.slice(block.start, block.end));

    expect(slices).toEqual(["# Heading", "First paragraph.", "- a\r\n- b"]);
    // The gaps carry the line endings, so reassembly cannot silently convert them.
    expect(CRLF.slice(blockAt(root, 0).end, blockAt(root, 1).start)).toBe("\r\n\r\n");
    expect(CRLF.slice(blockAt(root, 2, 0).end, blockAt(root, 2, 1).start)).toBe("\r\n");
  });

  it("splits containers into children and leaves other blocks whole", () => {
    const root = split(TASK_LIST)!;
    const list = blockAt(root, 0);

    expect(list.type).toBe("list");
    expect(list.children.map((item) => TASK_LIST.slice(item.start, item.end))).toEqual([
      "- [ ] first task",
      "- [x] second task with\n      a continuation line",
      "- [ ] third task",
    ]);
    // Recursion continues into the item, so an edit to one item's text can keep its source marker.
    expect(TASK_LIST.slice(blockAt(root, 0, 1, 0).start, blockAt(root, 0, 1, 0).end))
      .toBe("second task with\n      a continuation line");
    expect(blockAt(split(WIDE_TABLE)!, 1).children).toEqual([]);
    expect(blockAt(split(RAW_HTML)!, 0).children).toEqual([]);
  });

  it("gives equal keys to blocks that differ only in source formatting", () => {
    const keyOf = (markdown: string) => blockAt(split(markdown)!, 0).key;

    expect(keyOf("Keep __this__ text.\n")).toBe(keyOf("Keep **this** text.\n"));
    expect(keyOf("Title\n=====\n")).toBe(keyOf("# Title\n"));
    expect(keyOf("- a\n- b\n")).toBe(keyOf("* a\n* b\n"));
    expect(keyOf("| a | b |\n| --- | --- |\n| 1 | 2 |\n"))
      .toBe(keyOf("| a  | b  |\n| -- | -- |\n| 1  | 2  |\n"));
    expect(keyOf("Text.\n")).not.toBe(keyOf("Other text.\n"));
    // Two blocks holding the same characters in different roles must not match.
    expect(keyOf("<br />\n")).not.toBe(keyOf("\\<br />\n"));
  });

  it("returns undefined when the processor cannot parse the Markdown", () => {
    const failing = {
      parse: () => {
        throw new Error("no parser");
      },
      stringify: () => "",
    };

    expect(splitMarkdownBlocks(failing, "# Title\n")).toBeUndefined();
  });
});
