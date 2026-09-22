import type { MarkdownBlock, MarkdownBlockSplitter } from "./markdown-blocks";
import { matchSequences } from "./sequence-align";
import type { MarkdownCanonicalizer } from "./source-preserving-sync";

/**
 * Most blocks one container's alignment may leave unmatched. Real edits change a few blocks; past
 * this the documents differ too much for a block-by-block merge to be worth its cost.
 */
const MAX_BLOCK_EDITS = 100;

interface MergeContext {
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
    { source: sourceMarkdown, edited: editedCanonicalMarkdown, canonicalize },
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
  const slots = alignBlocks(sourceBlocks, editedBlocks);
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
 * The text between the previous emitted block and this one. A block keeps the gap the source wrote
 * in front of it, and a block the edit inserted borrows the gap the source wrote after its
 * predecessor: either way the separator is the one this container uses, which the editor's gap cannot
 * be trusted to describe. Milkdown serializes every bullet list loose, so taking the editor's gap at
 * a junction it touched turns a tight source list loose — and bullet spread is invisible to canonical
 * equivalence, so nothing downstream would catch it. Only a junction the source knows nothing about,
 * such as a block appended past its last one, falls back to the editor's own gap.
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
  const sourceGapBefore = (index: number): string | undefined => {
    const before = sourceBlocks[index - 1];
    const after = sourceBlocks[index];
    return before && after ? context.source.slice(before.end, after.start) : undefined;
  };
  const sourceGap = sourceGapBefore(slot.sourceIndex) ?? sourceGapBefore(previous.sourceIndex + 1);
  if (sourceGap !== undefined) {
    return sourceGap;
  }
  const before = editedBlocks[previous.editedIndex];
  const after = editedBlocks[slot.editedIndex];
  return before && after ? context.edited.slice(before.end, after.start) : "\n\n";
}

/**
 * Aligns two block sequences by content with a Myers diff over their keys, capped at
 * MAX_BLOCK_EDITS unmatched blocks: equal keys are untouched blocks, and between two of them the
 * unmatched blocks pair up in order as the same slots rewritten, leaving the surplus deleted or
 * inserted. Returns undefined past the cap, so a heavily changed container costs bounded work and
 * yields no candidate.
 */
function alignBlocks(
  sourceBlocks: MarkdownBlock[],
  editedBlocks: MarkdownBlock[],
): BlockSlot[] | undefined {
  const ids = new Map<string, number>();
  const intern = (blocks: MarkdownBlock[]) => blocks.map((block) => {
    let id = ids.get(block.key);
    if (id === undefined) {
      id = ids.size;
      ids.set(block.key, id);
    }
    return id;
  });
  const pairs = matchSequences(intern(sourceBlocks), intern(editedBlocks), MAX_BLOCK_EDITS);
  if (!pairs) {
    return undefined;
  }

  const slots: BlockSlot[] = [];
  let sourceIndex = 0;
  let editedIndex = 0;
  for (const [sourceMatch, editedMatch] of [...pairs, [sourceBlocks.length, editedBlocks.length]]) {
    while (sourceIndex < sourceMatch && editedIndex < editedMatch) {
      slots.push({ sourceIndex: sourceIndex++, editedIndex: editedIndex++ });
    }
    while (sourceIndex < sourceMatch) {
      slots.push({ sourceIndex: sourceIndex++, editedIndex: -1 });
    }
    while (editedIndex < editedMatch) {
      slots.push({ sourceIndex: -1, editedIndex: editedIndex++ });
    }
    if (sourceMatch < sourceBlocks.length) {
      slots.push({ sourceIndex: sourceIndex++, editedIndex: editedIndex++ });
    }
  }
  return slots;
}
