import { describe, expect, it } from "vitest";
import { mergeSourcePreservingEdit } from "./source-preserving-sync";

const YAML_SOURCE = `---
title: MilkJ Smoke Test
tags:
  - milkj
  - markdown
---

# Heading

Keep __this emphasis__ exactly.

- First item
- Second item
`;

const NORMALIZED_FRONTMATTER = `***

title: MilkJ Smoke Test
tags:

* milkj

* markdown

***

`;

function canonicalizeFixture(markdown: string): string {
  const heading = markdown.indexOf("# Heading");
  if (heading < 0) throw new Error("missing body");
  return NORMALIZED_FRONTMATTER + markdown
    .slice(heading)
    .replaceAll("__", "**")
    .replace(/^- /gm, "* ");
}

describe("source-preserving Markdown merge", () => {
  it("changes only edited prose while preserving frontmatter and source formatting", () => {
    const edited = canonicalizeFixture(YAML_SOURCE)
      .replace("Keep **this emphasis** exactly.", "Keep **this emphasis** completely unchanged.");

    const result = mergeSourcePreservingEdit(YAML_SOURCE, edited, canonicalizeFixture);

    expect(result).toEqual({
      ok: true,
      markdown: YAML_SOURCE.replace(
        "Keep __this emphasis__ exactly.",
        "Keep __this emphasis__ completely unchanged.",
      ),
    });
  });

  it("preserves opaque HTML and custom directives outside the edited range", () => {
    const source = `:::note{kind="warning"}
<details data-owner="MilkJ">
<summary>Raw HTML</summary>

Do **not** normalize this.
</details>
:::

Editable paragraph.
`;
    const edited = source.replace("Editable paragraph.", "Edited paragraph.");

    const result = mergeSourcePreservingEdit(source, edited, (markdown) => markdown);

    expect(result).toEqual({
      ok: true,
      markdown: source.replace("Editable paragraph.", "Edited paragraph."),
    });
  });

  it("rejects an edit that would change opaque frontmatter", () => {
    const edited = canonicalizeFixture(YAML_SOURCE)
      .replace("title: MilkJ Smoke Test", "title: Changed in rich text");

    const result = mergeSourcePreservingEdit(YAML_SOURCE, edited, canonicalizeFixture);

    expect(result).toEqual({
      ok: false,
      reason: "The rich-text change would modify the document frontmatter.",
    });
  });

  it("rejects a candidate that does not parse back to the edited document", () => {
    const source = "# Heading\n\nOriginal paragraph.\n";
    const edited = "# Heading\n\nEdited paragraph.\n";
    const canonicalize = (markdown: string) => markdown.includes("Edited")
      ? markdown.replace("Edited", "Different")
      : markdown;

    const result = mergeSourcePreservingEdit(source, edited, canonicalize);

    expect(result).toEqual({
      ok: false,
      reason: "The merged Markdown was not equivalent to the rich-text document.",
    });
  });

  it("returns the exact source for a no-op normalized update", () => {
    const result = mergeSourcePreservingEdit(
      YAML_SOURCE,
      canonicalizeFixture(YAML_SOURCE),
      canonicalizeFixture,
    );

    expect(result).toEqual({ ok: true, markdown: YAML_SOURCE });
  });

  it("does not treat ordinary thematic breaks as frontmatter", () => {
    const source = "---\n\n# Section\n\nEditable text.\n\n---\n";
    const edited = source.replace("Editable text.", "Edited text.");

    const result = mergeSourcePreservingEdit(source, edited, (markdown) => markdown);

    expect(result).toEqual({ ok: true, markdown: edited });
  });

  it("uses the source document's CRLF endings for inserted lines", () => {
    const source = "# Heading\r\n\r\nFirst paragraph.\r\n";
    const canonicalize = (markdown: string) => markdown.replaceAll("\r\n", "\n");
    const edited = "# Heading\n\nFirst paragraph.\n\nSecond paragraph.\n";

    const result = mergeSourcePreservingEdit(source, edited, canonicalize);

    expect(result).toEqual({
      ok: true,
      markdown: "# Heading\r\n\r\nFirst paragraph.\r\n\r\nSecond paragraph.\r\n",
    });
  });
});
