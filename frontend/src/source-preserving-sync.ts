import DiffMatchPatch from "diff-match-patch";
import { mergeEditByBlocks } from "./block-merge";
import type { MarkdownBlockSplitter } from "./markdown-blocks";

export type MarkdownCanonicalizer = (markdown: string) => string;

export type SourceMergeResult =
  | { ok: true; markdown: string }
  | { ok: false; reason: string };

/**
 * Applies a WYSIWYG edit to the exact Markdown source that came from IntelliJ.
 *
 * Crepe parses Markdown into a document model and serializes that model back into its preferred
 * formatting. Applying the editor's serialized text directly would therefore rewrite unrelated
 * source (and can destroy syntax which Crepe does not model). Instead, reconstruct the source with
 * only the edit applied, and trust no reconstruction until it is proven equivalent to the editor's
 * document by parsing and serializing it through the active Milkdown schema. Several strategies
 * produce a candidate; the first one that proves equivalent wins.
 */
export function mergeSourcePreservingEdit(
  sourceMarkdown: string,
  editedCanonicalMarkdown: string,
  canonicalize: MarkdownCanonicalizer,
  knownCanonicalSource?: string,
  splitBlocks?: MarkdownBlockSplitter,
): SourceMergeResult {
  let canonicalBefore: string;
  if (knownCanonicalSource !== undefined) {
    canonicalBefore = knownCanonicalSource;
  } else {
    try {
      canonicalBefore = canonicalize(sourceMarkdown);
    } catch {
      return failure("MilkJ could not parse the original Markdown safely.");
    }
  }

  if (canonicalBefore === editedCanonicalMarkdown) {
    return { ok: true, markdown: sourceMarkdown };
  }

  const dmp = new DiffMatchPatch();
  // Keep pathological documents from tying up JCEF indefinitely. A timed-out diff still produces
  // a valid coarse patch, which must pass the canonical-equivalence check below before it is used.
  dmp.Diff_Timeout = 0.1;
  const patches = dmp.patch_make(canonicalBefore, editedCanonicalMarkdown);
  // patch_apply locates each hunk by fuzzy-matching near its recorded position, and its search
  // radius only spans a few hundred characters. The recorded positions are canonical-text
  // coordinates, but the text being patched is the original source, whose formatting can drift far
  // beyond that radius — one table whose cells the serializer pads to the widest column shifts
  // everything below it by thousands of characters. Translate each hunk's position into source
  // coordinates first.
  const coordinateDiffs = dmp.diff_main(canonicalBefore, sourceMarkdown);
  // @types/diff-match-patch mistypes patch_make's elements as the patch_obj constructor.
  for (const patch of patches as unknown as Array<{ start1: number | null; start2: number | null }>) {
    if (patch.start1 !== null) {
      patch.start1 = dmp.diff_xIndex(coordinateDiffs, patch.start1);
    }
    if (patch.start2 !== null) {
      patch.start2 = dmp.diff_xIndex(coordinateDiffs, patch.start2);
    }
  }
  const [patchedCandidate, applied] = dmp.patch_apply(patches, sourceMarkdown);

  // Candidates are produced lazily and in increasing blast radius: a later one only runs when
  // every earlier one failed the equivalence check below.
  const rawCandidates: Array<() => string | undefined> = [];
  if (!applied.some((didApply) => !didApply)) {
    rawCandidates.push(() => patchedCandidate);
  }
  // Fuzzy patching cannot handle an edit INSIDE a heavily normalized region: the hunk's own text
  // is canonical (a table row padded to the widest column, say) and does not exist in the source
  // in that form, no matter where the matcher looks. Fall back to a line-granular merge: regions
  // the edit did not touch keep their source lines byte-for-byte, regions it did touch take the
  // editor's lines verbatim. The equivalence check below vets either candidate before it is
  // trusted.
  rawCandidates.push(() =>
    mergeEditByLines(dmp, canonicalBefore, editedCanonicalMarkdown, sourceMarkdown)
  );
  // Last resort: align the two documents by parsed block instead of by text. It is the only
  // strategy that cannot mistake where an edit landed, but it rewrites a whole edited block (or
  // list item) in the editor's formatting, so the line merge gets first refusal.
  if (splitBlocks) {
    rawCandidates.push(() =>
      mergeEditByBlocks(dmp, sourceMarkdown, editedCanonicalMarkdown, splitBlocks, canonicalize)
    );
  }

  let canonicalEdited: string | undefined;
  let reason = "MilkJ could not map the rich-text change onto the original Markdown.";
  const tried = new Set<string>();
  for (const produceCandidate of rawCandidates) {
    let rawCandidate: string | undefined;
    try {
      rawCandidate = produceCandidate();
    } catch {
      continue;
    }
    if (rawCandidate === undefined || tried.has(rawCandidate)) {
      continue;
    }
    tried.add(rawCandidate);
    const candidate = preserveSourceLineEndings(sourceMarkdown, rawCandidate);

    if (!leadingFrontmatterWasPreserved(sourceMarkdown, candidate)) {
      reason = "The rich-text change would modify the document frontmatter.";
      continue;
    }

    let canonicalCandidate: string;
    try {
      canonicalCandidate = canonicalize(candidate);
    } catch {
      reason = "The merged Markdown could not be parsed safely.";
      continue;
    }
    if (canonicalCandidate !== editedCanonicalMarkdown) {
      // While the user is typing, the editor can hold states that no Markdown string parses back
      // to — e.g. a paragraph ending in the space that was just typed: serialization emits the
      // trailing space, but parsing strips it, so no candidate can ever canonicalize to the edited
      // string byte-for-byte. Failing here would revert the user's in-progress edit, so prove
      // equivalence one parse round-trip further instead: the candidate and the edited text must
      // parse to the same document.
      try {
        canonicalEdited ??= canonicalize(editedCanonicalMarkdown);
      } catch {
        reason = "The merged Markdown was not equivalent to the rich-text document.";
        continue;
      }
      if (canonicalCandidate !== canonicalEdited) {
        reason = "The merged Markdown was not equivalent to the rich-text document.";
        continue;
      }
    }

    return { ok: true, markdown: candidate };
  }

  return failure(reason);
}

/**
 * Merges the canonical-text edit into the source at line granularity. The canonical "before" text
 * is the pivot: each of its lines corresponds to source lines (via a line diff of the two) and has
 * a fate in the edited text (via a second line diff). Canonical line runs the edit left untouched
 * emit their source lines byte-for-byte; runs the edit touched emit the editor's lines verbatim.
 * Every output line is therefore either exact source or exact editor output — never a splice of
 * the two — and heavy normalization drift (padded tables, escaping) cannot corrupt bytes the way
 * character-level patching can. The caller must validate the result by canonical equivalence.
 */
function mergeEditByLines(
  dmp: DiffMatchPatch,
  canonicalBefore: string,
  editedCanonicalMarkdown: string,
  sourceMarkdown: string,
): string {
  const toSource = lineDiff(dmp, canonicalBefore, sourceMarkdown);
  const toEdited = lineDiff(dmp, canonicalBefore, editedCanonicalMarkdown);

  // For every canonical line: the source text of the run it belongs to, or its own text when it
  // maps to source 1:1. Source-only lines (no canonical counterpart) anchor before a canonical
  // line index.
  type Run = { start: number; end: number; sourceText: string };
  const lineRun: Array<Run | undefined> = [];
  const equalLine: Array<string | undefined> = [];
  const sourceOnlyAt = new Map<number, string>();
  {
    let index = 0;
    let pendingDeleted: { start: number; end: number } | undefined;
    for (const [operation, text] of toSource) {
      if (operation === 0) {
        pendingDeleted = undefined;
        for (const line of splitKeepingNewlines(text)) {
          equalLine[index++] = line;
        }
      } else if (operation === -1) {
        const lineCount = splitKeepingNewlines(text).length;
        pendingDeleted = { start: index, end: index + lineCount };
        const run: Run = { ...pendingDeleted, sourceText: "" };
        for (let i = run.start; i < run.end; i++) {
          lineRun[i] = run;
        }
        index = run.end;
      } else if (pendingDeleted) {
        // Source lines replacing the just-deleted canonical lines: one replace run.
        const run = lineRun[pendingDeleted.start]!;
        run.sourceText += text;
        pendingDeleted = undefined;
      } else {
        sourceOnlyAt.set(index, (sourceOnlyAt.get(index) ?? "") + text);
      }
    }
  }

  // For every canonical line: whether the edit kept it, plus editor-inserted text anchored before
  // a canonical line index.
  const lineKept: boolean[] = [];
  const insertedAt = new Map<number, string>();
  {
    let index = 0;
    for (const [operation, text] of toEdited) {
      if (operation === 1) {
        insertedAt.set(index, (insertedAt.get(index) ?? "") + text);
        continue;
      }
      const lineCount = splitKeepingNewlines(text).length;
      for (let i = 0; i < lineCount; i++) {
        lineKept[index++] = operation === 0;
      }
    }
  }

  const totalLines = Math.max(lineRun.length, equalLine.length, lineKept.length);
  let result = "";
  for (let index = 0; index <= totalLines; index++) {
    result += sourceOnlyAt.get(index) ?? "";
    result += insertedAt.get(index) ?? "";
    if (index === totalLines) {
      break;
    }
    const run = lineRun[index];
    if (!run) {
      // 1:1 line: emit the source byte-equal line if the edit kept it.
      if (lineKept[index]) {
        result += equalLine[index] ?? "";
      }
      continue;
    }
    if (index !== run.start) {
      continue;
    }
    let dirty = false;
    for (let i = run.start; i < run.end && !dirty; i++) {
      dirty = !lineKept[i] || (i > run.start && insertedAt.has(i));
    }
    if (!dirty) {
      result += run.sourceText;
      continue;
    }
    // The edit touched this normalized region: emit the editor's version of it.
    for (let i = run.start; i < run.end; i++) {
      if (i > run.start) {
        result += insertedAt.get(i) ?? "";
      }
      if (lineKept[i]) {
        result += canonicalLineAt(toSource, i);
      }
    }
  }
  return result;
}

/** The canonical-before text's line at the given index, recovered from the line diff. */
function canonicalLineAt(toSource: Array<[number, string]>, target: number): string {
  let index = 0;
  for (const [operation, text] of toSource) {
    if (operation === 1) {
      continue;
    }
    for (const line of splitKeepingNewlines(text)) {
      if (index === target) {
        return line;
      }
      index++;
    }
  }
  return "";
}

function splitKeepingNewlines(text: string): string[] {
  const lines = text.split("\n");
  const last = lines.pop()!;
  const result = lines.map((line) => `${line}\n`);
  if (last !== "") {
    result.push(last);
  }
  return result;
}

/** Line-mode diff: each diff chunk's text is a whole number of lines. */
function lineDiff(dmp: DiffMatchPatch, before: string, after: string): Array<[number, string]> {
  const encoded = dmp.diff_linesToChars_(before, after);
  const diffs = dmp.diff_main(encoded.chars1, encoded.chars2, false);
  dmp.diff_charsToLines_(diffs, encoded.lineArray);
  return diffs as Array<[number, string]>;
}

function preserveSourceLineEndings(source: string, candidate: string): string {
  if (!source.includes("\r\n") || source.replaceAll("\r\n", "").includes("\n")) {
    return candidate;
  }
  // Crepe serializes inserted lines with LF. In an exclusively CRLF document, convert only bare
  // newlines introduced by the patch; existing CRLF sequences remain byte-for-byte unchanged.
  return candidate.replace(/(^|[^\r])\n/g, "$1\r\n");
}

function failure(reason: string): SourceMergeResult {
  return { ok: false, reason };
}

/** Frontmatter is opaque to Crepe, so never allow a fuzzy patch to alter it. */
function leadingFrontmatterWasPreserved(before: string, after: string): boolean {
  const frontmatter = leadingFrontmatter(before);
  return frontmatter === undefined || after.startsWith(frontmatter);
}

function leadingFrontmatter(markdown: string): string | undefined {
  const opening = /^(?:\uFEFF)?(---|\+\+\+)[^\S\r\n]*(?:\r\n|\n)/.exec(markdown);
  if (!opening) return undefined;

  const delimiter = opening[1];
  const closing = delimiter === "---"
    ? /^(?:---|\.\.\.)[^\S\r\n]*(?:\r\n|\n|$)/gm
    : /^\+\+\+[^\S\r\n]*(?:\r\n|\n|$)/gm;
  closing.lastIndex = opening[0].length;
  const match = closing.exec(markdown);
  if (!match) return undefined;
  const content = markdown.slice(opening[0].length, match.index);
  // Avoid mistaking a pair of ordinary thematic breaks at the start of a Markdown document for
  // frontmatter. Both supported formats need at least one plausible top-level property.
  const hasProperty = delimiter === "---"
    ? /^(?:[A-Za-z_][\w.-]*|["'][^"']+["']):(?:[ \t]|$)/m.test(content)
    : /^[A-Za-z_][\w.-]*[ \t]*=/m.test(content);
  if (!hasProperty) return undefined;
  return markdown.slice(0, match.index + match[0].length);
}
