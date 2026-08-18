import DiffMatchPatch from "diff-match-patch";

export type MarkdownCanonicalizer = (markdown: string) => string;

export type SourceMergeResult =
  | { ok: true; markdown: string }
  | { ok: false; reason: string };

/**
 * Applies a WYSIWYG edit to the exact Markdown source that came from IntelliJ.
 *
 * Crepe parses Markdown into a document model and serializes that model back into its preferred
 * formatting. Applying the editor's serialized text directly would therefore rewrite unrelated
 * source (and can destroy syntax which Crepe does not model). Instead, create a patch between the
 * normalized before/after documents, apply only that patch to the original source, then prove the
 * candidate is equivalent by parsing and serializing it through the active Milkdown schema.
 */
export function mergeSourcePreservingEdit(
  sourceMarkdown: string,
  editedCanonicalMarkdown: string,
  canonicalize: MarkdownCanonicalizer,
  knownCanonicalSource?: string,
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
  const [patchedCandidate, applied] = dmp.patch_apply(patches, sourceMarkdown);

  if (applied.some((didApply) => !didApply)) {
    return failure("MilkJ could not map the rich-text change onto the original Markdown.");
  }
  const candidate = preserveSourceLineEndings(sourceMarkdown, patchedCandidate);

  if (!leadingFrontmatterWasPreserved(sourceMarkdown, candidate)) {
    return failure("The rich-text change would modify the document frontmatter.");
  }

  let canonicalCandidate: string;
  try {
    canonicalCandidate = canonicalize(candidate);
  } catch {
    return failure("The merged Markdown could not be parsed safely.");
  }
  if (canonicalCandidate !== editedCanonicalMarkdown) {
    // While the user is typing, the editor can hold states that no Markdown string parses back to
    // — e.g. a paragraph ending in the space that was just typed: serialization emits the trailing
    // space, but parsing strips it, so no candidate can ever canonicalize to the edited string
    // byte-for-byte. Failing here would revert the user's in-progress edit, so prove equivalence
    // one parse round-trip further instead: the candidate and the edited text must parse to the
    // same document.
    let canonicalEdited: string;
    try {
      canonicalEdited = canonicalize(editedCanonicalMarkdown);
    } catch {
      return failure("The merged Markdown was not equivalent to the rich-text document.");
    }
    if (canonicalCandidate !== canonicalEdited) {
      return failure("The merged Markdown was not equivalent to the rich-text document.");
    }
  }

  return { ok: true, markdown: candidate };
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
