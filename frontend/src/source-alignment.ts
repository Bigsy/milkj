import type DiffMatchPatch from "diff-match-patch";
import { matchSequences } from "./sequence-align";

export type Diff = [number, string];

/** How the canonical text corresponds to the source, as diff-match-patch diffs from one to the other. */
export interface SourceAlignment {
  /** Whole-line diffs; a line pair that differs only in formatting is its own delete + insert. */
  lines: Diff[];
  /** Character diffs, for translating canonical positions into source positions. */
  characters: Diff[];
}

/**
 * Most unmatched lines the normalized alignment may need before it gives up. Formatting drift is
 * normalized away, so real documents stay far below this; past it the texts genuinely differ and
 * the caller falls back to a timed diff.
 */
const MAX_UNMATCHED_LINES = 2_000;
/** Line pairs up to this length are refined to character diffs. */
const MAX_REFINED_PAIR = 10_000;

/**
 * Aligns the canonical text with the source even when nearly every line differs in formatting.
 * A plain diff of the two degrades on drifted documents — `*` bullets, `__bold__`, setext headings,
 * unpadded tables — until it times out and returns a few document-sized chunks. Instead, each line
 * is normalized to erase differences Crepe's serializer introduces, and the non-blank lines are
 * aligned by their normalized text; blank lines and setext underlines are formatting only, so they
 * are left out of the alignment and reconciled locally between the lines that anchor it. Each
 * anchored pair then maps characters by a diff of just that pair.
 *
 * Returns undefined when the texts differ by more than formatting; the caller falls back to a timed
 * character diff.
 */
export function alignSource(
  dmp: DiffMatchPatch,
  canonicalBefore: string,
  source: string,
): SourceAlignment | undefined {
  const canonicalLines = splitLines(canonicalBefore);
  const sourceLines = splitLines(source);
  const ids = new Map<string, number>();
  const anchorsOf = (lines: string[]) => {
    const positions: number[] = [];
    const lineIds: number[] = [];
    let previousBlank = true;
    lines.forEach((line, index) => {
      const normalized = normalizeLine(line);
      const blank = normalized === "";
      const underline = !previousBlank && SETEXT_UNDERLINE.test(line);
      previousBlank = blank;
      if (blank || underline) {
        return;
      }
      let id = ids.get(normalized);
      if (id === undefined) {
        id = ids.size;
        ids.set(normalized, id);
      }
      positions.push(index);
      lineIds.push(id);
    });
    return { positions, lineIds };
  };
  const canonicalAnchors = anchorsOf(canonicalLines);
  const sourceAnchors = anchorsOf(sourceLines);
  const pairs = matchSequences(canonicalAnchors.lineIds, sourceAnchors.lineIds, MAX_UNMATCHED_LINES);
  if (!pairs) {
    return undefined;
  }

  const lines: Diff[] = [];
  const push = (operation: number, text: string) => {
    if (!text) return;
    const last = lines[lines.length - 1];
    if (last && last[0] === operation) {
      last[1] += text;
    } else {
      lines.push([operation, text]);
    }
  };
  let canonicalAt = 0;
  let sourceAt = 0;
  const reconcile = (canonicalEnd: number, sourceEnd: number) => {
    // Unanchored lines between two anchors: blank lines, underlines and lines only one side has.
    // Byte-equal ones (the blank lines both sides share) still diff as equal.
    const canonicalGap = canonicalLines.slice(canonicalAt, canonicalEnd).join("");
    const sourceGap = sourceLines.slice(sourceAt, sourceEnd).join("");
    if (canonicalGap && sourceGap) {
      for (const [operation, text] of lineDiff(dmp, canonicalGap, sourceGap)) {
        push(operation, text);
      }
    } else {
      push(-1, canonicalGap);
      push(1, sourceGap);
    }
  };
  for (const [canonicalAnchor, sourceAnchor] of pairs) {
    const canonicalIndex = canonicalAnchors.positions[canonicalAnchor];
    const sourceIndex = sourceAnchors.positions[sourceAnchor];
    reconcile(canonicalIndex, sourceIndex);
    const canonicalLine = canonicalLines[canonicalIndex];
    const sourceLine = sourceLines[sourceIndex];
    if (canonicalLine === sourceLine) {
      push(0, canonicalLine);
    } else {
      // A pair that differs in formatting stays its own replacement, so a line-granular merge can
      // rewrite that one line without widening into its neighbours.
      lines.push([-1, canonicalLine], [1, sourceLine]);
    }
    canonicalAt = canonicalIndex + 1;
    sourceAt = sourceIndex + 1;
  }
  reconcile(canonicalLines.length, sourceLines.length);

  return { lines, characters: refineCharacters(dmp, lines) };
}

/** Line diffs refined into character diffs wherever a deletion is directly replaced. */
function refineCharacters(dmp: DiffMatchPatch, lines: Diff[]): Diff[] {
  const characters: Diff[] = [];
  for (let i = 0; i < lines.length; i++) {
    const [operation, text] = lines[i];
    const next = lines[i + 1];
    if (operation === -1 && next?.[0] === 1 && text.length + next[1].length <= MAX_REFINED_PAIR) {
      characters.push(...(dmp.diff_main(text, next[1], false) as Diff[]));
      i++;
    } else {
      characters.push([operation, text]);
    }
  }
  return characters;
}

const SETEXT_UNDERLINE = /^ {0,3}(?:=+|-+)[ \t]*\r?\n?$/;
const THEMATIC_BREAK = /^(?:(?:\*[ \t]*){3,}|(?:-[ \t]*){3,}|(?:_[ \t]*){3,})$/;
const TABLE_DELIMITER_CELL = /^(:?)-+(:?)$/;

/**
 * A line with the differences Crepe's serializer introduces erased: indentation, blockquote and
 * list markers, heading and fence style, thematic breaks, `__` emphasis, escapes, table padding,
 * hard-break markers and runs of whitespace. Only used to find which lines correspond, never to
 * produce output, so an over-eager normalization costs at most a misaligned line that the merge's
 * own checks then reject.
 */
export function normalizeLine(line: string): string {
  let text = line.replace(/\r?\n$/, "").replace(/[ \t]+$/, "").replace(/\\$/, "");
  let quote = "";
  const quoteMatch = /^(?:[ \t]*>)+[ \t]?/.exec(text);
  if (quoteMatch) {
    quote = ">".repeat(quoteMatch[0].split(">").length - 1);
    text = text.slice(quoteMatch[0].length);
  }
  text = text.trimStart();
  if (THEMATIC_BREAK.test(text)) {
    return `${quote}---`;
  }
  const fence = /^(`{3,}|~{3,})[ \t]*([^`\s]*)/.exec(text);
  if (fence) {
    return `${quote}\`\`\`${fence[2]}`;
  }
  text = text
    .replace(/^#{1,6}(?:[ \t]+|$)/, "")
    .replace(/[ \t]+#+$/, "")
    .replace(/^[*+-][ \t]+/, "- ")
    .replace(/^\d{1,9}[.)][ \t]+/, "1. ");
  if (text.startsWith("|")) {
    const cells = text.replace(/^\||\|$/g, "").split(/(?<!\\)\|/).map((cell) => {
      const trimmed = cell.trim();
      const delimiter = TABLE_DELIMITER_CELL.exec(trimmed);
      return delimiter ? `${delimiter[1]}-${delimiter[2]}` : trimmed;
    });
    text = `|${cells.join("|")}|`;
  }
  return quote + text
    .replaceAll("__", "**")
    .replace(/\\([!-/:-@[-`{-~])/g, "$1")
    .replace(/[ \t]+/g, " ");
}

function splitLines(text: string): string[] {
  const lines = text.split("\n");
  const last = lines.pop()!;
  const result = lines.map((line) => `${line}\n`);
  if (last !== "") {
    result.push(last);
  }
  return result;
}

/** Line-mode diff: each diff chunk's text is a whole number of lines. */
export function lineDiff(dmp: DiffMatchPatch, before: string, after: string): Diff[] {
  const encoded = dmp.diff_linesToChars_(before, after);
  const diffs = dmp.diff_main(encoded.chars1, encoded.chars2, false);
  dmp.diff_charsToLines_(diffs, encoded.lineArray);
  return diffs as Diff[];
}
