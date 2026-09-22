/**
 * Generated Markdown documents large enough to expose how the source-preserving merge scales, shared
 * by the regression tests and `bench/sync.bench.ts`.
 *
 * A "drift" document is written in formatting Crepe does not produce itself — setext headings,
 * `__bold__`, `*` and `+` bullets, unpadded tables, YAML frontmatter — so its canonical form differs
 * from the source on almost every line. A "clean" document is the canonical form of the drift body
 * behind the same frontmatter, which only drifts where Crepe cannot model the syntax at all.
 */

export const FRONTMATTER = "---\ntitle: Large benchmark document\ntags:\n  - bench\n  - milkj\n---\n\n";

/** Unique words planted in the drift document, and the edit a test or benchmark makes to each. */
export const MARKER_EDITS = {
  /** In the first section's first paragraph. */
  start: { from: "MARKERSTART", to: "MARKERSTARTx" },
  /** In the middle section's first paragraph, a few blocks before the wide table. */
  middle: { from: "MARKERMID", to: "MARKERMIDx" },
  /** In the last paragraph of the document. */
  end: { from: "MARKEREND", to: "MARKERENDx" },
  /** In one cell of the wide table. */
  tableCell: { from: "CELLMARK", to: "CELLMARKx" },
} as const;

export type MarkerEdit = (typeof MARKER_EDITS)[keyof typeof MARKER_EDITS];

const WORDS = [
  "alpha", "bravo", "charlie", "delta", "echo", "foxtrot", "golf", "hotel",
  "india", "juliet", "kilo", "lima", "mike", "november", "oscar", "papa",
];

function lorem(count: number, seed: number): string {
  return Array.from({ length: count }, (_, i) => WORDS[(seed * 7 + i * 3) % WORDS.length]).join(" ");
}

/** One drift section: setext heading, two paragraphs, a bullet list, an ordered list, a code fence and a table. */
function section(index: number, marker?: string): string {
  const bullet = index % 2 ? "*" : "+";
  const paragraph = (k: number) =>
    `${lorem(40, index + k)} with __bold ${k}__, \`code_${index}\`, ` +
    `and a [link](https://example.com/${index}/${k}).`;
  return [
    `Section ${index}\n----------`, "",
    paragraph(1) + (marker ? ` ${marker}` : ""), "",
    paragraph(2), "",
    `${bullet} item one ${index}\n${bullet} item two ${lorem(8, index)}\n${bullet} item three`, "",
    `1. first ${index}\n2. second\n3. third`, "",
    "```ts\n" + `function f${index}(x: number) {\n  return x * ${index};\n}\n` + "```", "",
    `| Name | Value | Note |\n|-|-|-|\n| a${index} | ${index} | short |\n` +
      `| b${index} | ${index * 2} | a much longer note ${index} |\n`,
  ].join("\n") + "\n";
}

/**
 * An unpadded 6×40 table. Its canonical form pads every cell to the widest in its column, which
 * shifts everything after it by thousands of characters. Row 20, column 2 holds `CELLMARK`.
 */
function wideTable(): string {
  const columns = 6;
  const header = Array.from({ length: columns }, (_, c) => `Column ${c}`);
  const body = Array.from({ length: 40 }, (_, r) =>
    Array.from({ length: columns }, (_, c) =>
      r === 20 && c === 2 ? "CELLMARK" : `r${r}c${c} ${lorem((r + c) % 5 + 1, r)}`));
  return [
    `|${header.join("|")}|`,
    `|${header.map(() => "-").join("|")}|`,
    ...body.map((row) => `|${row.join("|")}|`),
  ].join("\n") + "\n\n";
}

/**
 * A drift document of at least `targetBytes`, frontmatter included, holding every marker in
 * {@link MARKER_EDITS} once. The wide table follows the middle section.
 */
export function buildDriftDoc(targetBytes: number): string {
  const parts: string[] = [];
  let size = 0;
  const middle = Math.floor(Math.max(3, Math.round(targetBytes / section(0).length)) / 2);
  for (let i = 0; size < targetBytes; i++) {
    const marker = i === 0 ? MARKER_EDITS.start.from : i === middle ? MARKER_EDITS.middle.from : undefined;
    let text = section(i, marker);
    if (i === middle) {
      text += "\n" + wideTable();
    }
    parts.push(text);
    size += text.length;
  }
  parts.push(`## Last\n\nThe final paragraph ${MARKER_EDITS.end.from} here.\n`);
  return FRONTMATTER + parts.join("\n");
}

/** The clean counterpart of a drift document: its body in canonical form, behind the same frontmatter. */
export function buildCleanDoc(driftDoc: string, canonicalize: (markdown: string) => string): string {
  if (!driftDoc.startsWith(FRONTMATTER)) {
    throw new Error("Not a generated drift document");
  }
  return FRONTMATTER + canonicalize(driftDoc.slice(FRONTMATTER.length));
}
