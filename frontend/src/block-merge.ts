import type DiffMatchPatch from "diff-match-patch";
import type { MarkdownBlock, MarkdownBlockSplitter } from "./markdown-blocks";
import type { MarkdownCanonicalizer } from "./source-preserving-sync";

/** Private-use code points, one per distinct block key, for aligning block sequences with a diff. */
const KEY_CODE_START = 0xe000;
const KEY_CODE_LIMIT = 0xf900 - KEY_CODE_START;

interface MergeContext {
  dmp: DiffMatchPatch;
  source: string;
  edited: string;
  canonicalize: MarkdownCanonicalizer;
}

/** One slot of the alignment; -1 means the block exists on only one side. */
interface BlockSlot {
  sourceIndex: number;
  editedIndex: number;
}

/**
 * Merges the editor's canonical text into the source by aligning parsed blocks rather than diffing
 * the two documents as strings: a block the edit left alone emits its source bytes and its source
 * gaps verbatim, a block the edit changed or inserted emits the editor's bytes, and a deleted block
 * emits nothing. Nothing is located by fuzzy matching, so no amount of serializer normalization
 * elsewhere in the document can move where an edit lands.
 *
 * Returns undefined when the blocks cannot be aligned; the caller must still validate the result by
 * canonical equivalence.
 */
export function mergeEditByBlocks(
  dmp: DiffMatchPatch,
  sourceMarkdown: string,
  editedCanonicalMarkdown: string,
  splitBlocks: MarkdownBlockSplitter,
  canonicalize: MarkdownCanonicalizer,
): string | undefined {
  const sourceRoot = splitBlocks(sourceMarkdown);
  const editedRoot = splitBlocks(editedCanonicalMarkdown);
  if (!sourceRoot || !editedRoot) {
    return undefined;
  }
  return mergeContainer(
    { dmp, source: sourceMarkdown, edited: editedCanonicalMarkdown, canonicalize },
    sourceRoot,
    editedRoot,
  );
}

/** Merges the children of one aligned container pair, emitting the source's own structure around them. */
function mergeContainer(
  context: MergeContext,
  sourceContainer: MarkdownBlock,
  editedContainer: MarkdownBlock,
): string | undefined {
  const sourceBlocks = sourceContainer.children;
  const editedBlocks = editedContainer.children;
  const slots = alignBlocks(context.dmp, sourceBlocks, editedBlocks);
  if (!slots) {
    return undefined;
  }

  const first = sourceBlocks[0];
  const last = sourceBlocks[sourceBlocks.length - 1];
  // Whatever the container writes before its first block — a `> ` or `- ` marker, a document's
  // leading blank lines — is structure, not content, and is always kept. A container with no blocks
  // of its own is entirely prefix, so an insertion lands after its marker.
  let merged = context.source.slice(sourceContainer.start, first?.start ?? sourceContainer.end);
  let previous: BlockSlot | undefined;
  for (const slot of slots) {
    const text = mergedBlockText(context, sourceBlocks, editedBlocks, slot);
    if (text === undefined) {
      continue;
    }
    merged += separatorBefore(context, sourceBlocks, editedBlocks, previous, slot) + text;
    previous = slot;
  }
  if (last) {
    merged += context.source.slice(last.end, sourceContainer.end);
  }
  return merged;
}

/** The bytes one slot contributes, or undefined when the edit deleted the block. */
function mergedBlockText(
  context: MergeContext,
  sourceBlocks: MarkdownBlock[],
  editedBlocks: MarkdownBlock[],
  slot: BlockSlot,
): string | undefined {
  const edited = editedBlocks[slot.editedIndex];
  if (!edited) {
    return undefined;
  }
  const editedText = context.edited.slice(edited.start, edited.end);
  const source = sourceBlocks[slot.sourceIndex];
  if (!source) {
    return editedText;
  }
  if (source.key === edited.key) {
    return context.source.slice(source.start, source.end);
  }
  if (source.type !== edited.type || !source.children.length || !edited.children.length) {
    return editedText;
  }

  // Same container on both sides: recurse so untouched children keep their source bytes. The
  // recursion splices editor bytes between source bytes, which the source's own syntax can reject —
  // a source `-` bullet next to the editor's `*` starts a second list — so keep the finer merge only
  // while the container still means what the editor holds, judged by the same canonical equivalence
  // that vets the whole document. Falling back to the editor's container is always safe.
  const mergedChildren = mergeContainer(context, source, edited);
  if (mergedChildren === undefined || mergedChildren === editedText) {
    return editedText;
  }
  try {
    return context.canonicalize(mergedChildren) === context.canonicalize(editedText)
      ? mergedChildren
      : editedText;
  } catch {
    return editedText;
  }
}

/**
 * The text between the previous emitted block and this one. Blocks still adjacent in the source keep
 * the source's own gap (its blank lines, a tight list's single newline); otherwise the editor's gap
 * between the same two blocks describes the new structure.
 */
function separatorBefore(
  context: MergeContext,
  sourceBlocks: MarkdownBlock[],
  editedBlocks: MarkdownBlock[],
  previous: BlockSlot | undefined,
  slot: BlockSlot,
): string {
  if (!previous) {
    return "";
  }
  if (slot.sourceIndex === previous.sourceIndex + 1) {
    const before = sourceBlocks[previous.sourceIndex];
    const after = sourceBlocks[slot.sourceIndex];
    if (before && after) {
      return context.source.slice(before.end, after.start);
    }
  }
  if (slot.editedIndex === previous.editedIndex + 1) {
    const before = editedBlocks[previous.editedIndex];
    const after = editedBlocks[slot.editedIndex];
    if (before && after) {
      return context.edited.slice(before.end, after.start);
    }
  }
  return "\n\n";
}

/**
 * Aligns two block sequences by content. Each distinct key becomes one private-use code point, so
 * the sequences diff as short strings: equal runs are untouched blocks, and a deleted run followed
 * by an inserted one is the same slot rewritten. Returns undefined when the document holds more
 * distinct blocks than there are code points to spend on them.
 */
function alignBlocks(
  dmp: DiffMatchPatch,
  sourceBlocks: MarkdownBlock[],
  editedBlocks: MarkdownBlock[],
): BlockSlot[] | undefined {
  const codes = new Map<string, string>();
  const encode = (blocks: MarkdownBlock[]): string | undefined => {
    let encoded = "";
    for (const block of blocks) {
      let code = codes.get(block.key);
      if (code === undefined) {
        if (codes.size >= KEY_CODE_LIMIT) {
          return undefined;
        }
        code = String.fromCharCode(KEY_CODE_START + codes.size);
        codes.set(block.key, code);
      }
      encoded += code;
    }
    return encoded;
  };
  const sourceCodes = encode(sourceBlocks);
  const editedCodes = encode(editedBlocks);
  if (sourceCodes === undefined || editedCodes === undefined) {
    return undefined;
  }

  const slots: BlockSlot[] = [];
  let sourceIndex = 0;
  let editedIndex = 0;
  let pendingDeletions = 0;
  const flushDeletions = () => {
    while (pendingDeletions > 0) {
      slots.push({ sourceIndex: sourceIndex++, editedIndex: -1 });
      pendingDeletions--;
    }
  };
  for (const [operation, codeRun] of dmp.diff_main(sourceCodes, editedCodes, false)) {
    if (operation === -1) {
      flushDeletions();
      pendingDeletions = codeRun.length;
      continue;
    }
    if (operation === 0) {
      flushDeletions();
    }
    for (let i = 0; i < codeRun.length; i++) {
      if (operation === 1 && pendingDeletions === 0) {
        slots.push({ sourceIndex: -1, editedIndex: editedIndex++ });
        continue;
      }
      // An inserted block that replaces a just-deleted one is the same slot, rewritten.
      if (operation === 1) {
        pendingDeletions--;
      }
      slots.push({ sourceIndex: sourceIndex++, editedIndex: editedIndex++ });
    }
    flushDeletions();
  }
  flushDeletions();
  if (sourceIndex !== sourceBlocks.length || editedIndex !== editedBlocks.length) {
    return undefined;
  }
  return slots;
}
