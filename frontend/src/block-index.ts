import DiffMatchPatch from "diff-match-patch";
import { DEFINITION_TYPES, type KnownBlockKey, type TopLevelBlock } from "./markdown-blocks";
import { matchSequences } from "./sequence-align";

/** The top-level blocks of one exact text. */
export interface BlockIndex {
  readonly text: string;
  readonly blocks: readonly TopLevelBlock[];
}

/** What the guard needs from the active Milkdown editor. */
export interface MarkdownStructure {
  /** Top-level blocks of `markdown`, or undefined when their ranges cannot be trusted. */
  splitTopLevel(markdown: string): TopLevelBlock[] | undefined;
  /**
   * Canonicalizes exactly as the merge's canonicalizer does, and reports the input's top-level
   * blocks from that same parse, so indexing a candidate costs no parse of its own. `blocks` is
   * undefined when the parse could not be observed.
   */
  canonicalizeObserving(
    markdown: string,
    knownKey?: KnownBlockKey,
  ): { canonical: string; blocks: TopLevelBlock[] | undefined };
}

/** A range [start, end) of the source the candidate may rewrite. */
export interface SourceRegion {
  start: number;
  end: number;
}

/** Where one untouched stretch of the source reappears in the candidate. */
export interface KeptStretch {
  sourceStart: number;
  sourceEnd: number;
  candidateStart: number;
}

/** One change of the canonical text: [start, end) of the old text became [editedStart, editedEnd). */
interface TextChange {
  start: number;
  end: number;
  editedStart: number;
  editedEnd: number;
}

/**
 * Most unmatched blocks the source ↔ canonical alignment may need. Beyond it the correspondence
 * is not trusted and the merge is rejected rather than guessed.
 */
const MAX_ALIGNMENT_EDITS = 500;
/** Changed canonical line runs up to this size are refined to exact characters. */
const MAX_REFINED_CHANGE = 20_000;
const DEFINITION_LINE = /^ {0,3}\[[^\]\n]+\]:/m;

/**
 * Remembers the top-level blocks of the source and of its canonical form across edits, so the
 * byte-exact guard parses only what an edit changed. Parsing either whole text costs about as much
 * as canonicalizing it, and every accepted edit replaces both, so a cache keyed on the texts alone
 * would miss on every keystroke. Instead an accepted candidate is indexed from the parse its own
 * equivalence check already ran, and the edited canonical text from the old index plus a parse of
 * just the stretch the edit changed. Entries are keyed by exact text, so an IDE push, or anything
 * else that changes either text, falls back to a full split.
 */
export class SourceBlockIndex {
  private source?: BlockIndex;
  private canonical?: BlockIndex;

  constructor(readonly structure: MarkdownStructure) {}

  /** Canonicalizes the source, indexing its blocks from the same parse. */
  canonicalizeSource(sourceMarkdown: string): string {
    const observed = this.structure.canonicalizeObserving(sourceMarkdown);
    if (observed.blocks) {
      this.source = { text: sourceMarkdown, blocks: observed.blocks };
    }
    return observed.canonical;
  }

  /**
   * Works out which source regions the edit from `canonicalBefore` to `edited` may rewrite. Returns
   * a reason instead when that cannot be established unambiguously.
   */
  prepare(sourceMarkdown: string, canonicalBefore: string, edited: string): EditRegions | string {
    const source = this.indexOf(sourceMarkdown, this.source);
    const canonical = this.indexOf(canonicalBefore, this.canonical);
    if (!source || !canonical) {
      return UNKNOWN_REGIONS;
    }
    this.source = source;
    this.canonical = canonical;
    return EditRegions.derive(this, source, canonical, edited);
  }

  /** What is currently indexed; for tests. */
  indexed(): { source?: BlockIndex; canonical?: BlockIndex } {
    return { source: this.source, canonical: this.canonical };
  }

  /** Records an accepted merge: the candidate is the new source, `edited` the new canonical text. */
  accept(source: BlockIndex | undefined, canonical: BlockIndex | undefined) {
    this.source = source;
    this.canonical = canonical;
  }

  private indexOf(text: string, cached: BlockIndex | undefined): BlockIndex | undefined {
    if (cached?.text === text) {
      return cached;
    }
    const blocks = this.structure.splitTopLevel(text);
    return blocks ? { text, blocks } : undefined;
  }
}

const UNKNOWN_REGIONS = "MilkJ could not tell which part of the Markdown the rich-text change edited.";

/**
 * The regions of the source one edit may rewrite, derived only from the source, its canonical form
 * and the edited text — never from a merge strategy's idea of what it changed.
 *
 * Every changed range of the canonical text is mapped to the top-level canonical units it touches
 * (a block, or the gap between two blocks for a change that only falls between them), and each
 * unit to its counterpart in the source through an alignment of block keys. A canonical block
 * whose counterpart is missing or ambiguous — unmatched, or one of a run of identical blocks the
 * alignment could have paired differently — rejects the edit instead of widening the region.
 */
export class EditRegions {
  private constructor(
    private readonly owner: SourceBlockIndex,
    readonly source: BlockIndex,
    private readonly canonical: BlockIndex,
    private readonly edited: string,
    private readonly changes: TextChange[],
    /** Sorted, disjoint source regions. */
    readonly regions: SourceRegion[],
    /** Inclusive range of canonical units the changes touched (even = gap, odd = block). */
    private readonly touchedUnits: [number, number],
  ) {}

  static derive(
    owner: SourceBlockIndex,
    source: BlockIndex,
    canonical: BlockIndex,
    edited: string,
  ): EditRegions | string {
    const changes = textChanges(canonical.text, edited);
    const units = new CanonicalUnits(canonical);
    const partner = alignBlocks(source.blocks, canonical.blocks);
    if (!partner) {
      return UNKNOWN_REGIONS;
    }

    const regions: SourceRegion[] = [];
    let firstUnit = Infinity;
    let lastUnit = -Infinity;
    for (const change of changes) {
      const [from, to] = units.touched(change.start, change.end);
      firstUnit = Math.min(firstUnit, from);
      lastUnit = Math.max(lastUnit, to);
      let region: SourceRegion | undefined;
      for (let unit = from; unit <= to; unit++) {
        const range = sourceRangeOf(unit, source, canonical, partner);
        if (!range) {
          return UNKNOWN_REGIONS;
        }
        region = region
          ? { start: Math.min(region.start, range.start), end: Math.max(region.end, range.end) }
          : range;
      }
      if (region) {
        regions.push(region);
      }
    }
    if (!regions.length) {
      return UNKNOWN_REGIONS;
    }
    return new EditRegions(
      owner,
      source,
      canonical,
      edited,
      changes,
      mergeRegions(regions),
      [firstUnit, lastUnit],
    );
  }

  /**
   * How the candidate keeps the source outside the regions: each untouched stretch, in order and
   * byte for byte, with only the regions between them replaced. Undefined when it does not.
   */
  check(candidate: string): KeptStretch[] | undefined {
    const text = this.source.text;
    const stretches: Array<[number, number]> = [];
    let cursor = 0;
    for (const region of this.regions) {
      stretches.push([cursor, region.start]);
      cursor = region.end;
    }
    stretches.push([cursor, text.length]);

    const kept: KeptStretch[] = [];
    let position = 0;
    for (let i = 0; i < stretches.length; i++) {
      const [start, end] = stretches[i];
      const stretch = text.slice(start, end);
      let at: number;
      if (i === 0) {
        at = candidate.startsWith(stretch) ? 0 : -1;
      } else if (i === stretches.length - 1) {
        at = candidate.length - stretch.length;
        if (at < position || !candidate.endsWith(stretch)) {
          at = -1;
        }
      } else {
        // Leftmost placement: if the stretches fit in order anywhere, they fit leftmost-first.
        at = candidate.indexOf(stretch, position);
      }
      if (at < 0) {
        return undefined;
      }
      kept.push({ sourceStart: start, sourceEnd: end, candidateStart: at });
      position = at + stretch.length;
    }
    return kept;
  }

  /** Canonicalizes a checked candidate, indexing its blocks and reusing the keys of kept blocks. */
  canonicalize(candidate: string, kept: KeptStretch[]): { canonical: string; blocks: TopLevelBlock[] | undefined } {
    return this.owner.structure.canonicalizeObserving(candidate, this.keptKeys(candidate, kept));
  }

  /** Records the accepted candidate and its blocks, and derives the edited text's index. */
  accept(candidate: string, candidateBlocks: TopLevelBlock[] | undefined) {
    this.owner.accept(
      candidateBlocks ? { text: candidate, blocks: candidateBlocks } : undefined,
      this.editedIndex(),
    );
  }

  /**
   * Keys of blocks the candidate kept byte for byte. A block's key depends only on its own bytes,
   * except through link reference and footnote definitions elsewhere in the document; when the
   * merge touched any of those, every key is recomputed.
   */
  private keptKeys(candidate: string, kept: KeptStretch[]): KnownBlockKey | undefined {
    const sourceBlocks = this.source.blocks;
    const byStart = new Map<number, TopLevelBlock>();
    let block = 0;
    for (const stretch of kept) {
      while (block < sourceBlocks.length && sourceBlocks[block].start < stretch.sourceStart) {
        block++;
      }
      const shift = stretch.candidateStart - stretch.sourceStart;
      for (; block < sourceBlocks.length && sourceBlocks[block].end <= stretch.sourceEnd; block++) {
        const current = sourceBlocks[block];
        byStart.set(current.start + shift, { ...current, start: current.start + shift, end: current.end + shift });
      }
    }
    const regionTouchesDefinition = sourceBlocks.some((current) =>
      DEFINITION_TYPES.has(current.type) && this.regions.some((region) =>
        current.start < region.end && region.start < current.end));
    const insertsDefinition = kept.some((stretch, i) => {
      const next = kept[i + 1];
      const insertedFrom = stretch.candidateStart + stretch.sourceEnd - stretch.sourceStart;
      return next !== undefined && DEFINITION_LINE.test(candidate.slice(insertedFrom, next.candidateStart));
    });
    if (regionTouchesDefinition || insertsDefinition) {
      return undefined;
    }
    return (type, start, end) => {
      const known = byStart.get(start);
      return known && known.end === end && known.type === type ? known.key : undefined;
    };
  }

  /**
   * The edited text's blocks: the canonical blocks outside the changed stretch, shifted, plus a
   * parse of just that stretch. Canonical text is Milkdown's own serialization, where top-level
   * blocks are separated by blank lines, fences are always closed and nothing continues lazily, so
   * a stretch that starts and ends at such a separator parses alone as it does in place. Anything
   * else — a stretch not bounded by blank lines, or definitions that change how other blocks parse —
   * leaves the edited text unindexed, and the next edit splits it in full.
   */
  private editedIndex(): BlockIndex | undefined {
    const blocks = this.canonical.blocks;
    const text = this.canonical.text;
    const edited = this.edited;
    const delta = edited.length - text.length;
    if (!blocks.length) {
      const all = this.splitEdited(0, text.length);
      return all && { text: edited, blocks: all };
    }

    const [firstUnit, lastUnit] = this.touchedUnits;
    // A touched gap pulls in the blocks on either side of it, so the stretch spans whole blocks.
    let first = firstUnit % 2 === 1 ? (firstUnit - 1) / 2 : Math.max(0, firstUnit / 2 - 1);
    let last = lastUnit % 2 === 1 ? (lastUnit - 1) / 2 : Math.min(blocks.length - 1, lastUnit / 2);
    const separated = (before: number, after: number) => text.slice(before, after).includes("\n\n");
    while (first > 0 && !separated(blocks[first - 1].end, blocks[first].start)) {
      first--;
    }
    while (last < blocks.length - 1 && !separated(blocks[last].end, blocks[last + 1].start)) {
      last++;
    }
    const start = first === 0 ? 0 : blocks[first].start;
    const end = last === blocks.length - 1 ? text.length : blocks[last].end;
    if (this.changes.some((change) => change.start < start || change.end > end)) {
      return undefined;
    }
    if (blocks.slice(first, last + 1).some((block) => DEFINITION_TYPES.has(block.type))) {
      return undefined;
    }
    const stretch = this.splitEdited(start, end);
    if (!stretch) {
      return undefined;
    }
    const shifted = blocks.slice(last + 1).map((block) => ({
      ...block,
      start: block.start + delta,
      end: block.end + delta,
    }));
    return { text: edited, blocks: [...blocks.slice(0, first), ...stretch, ...shifted] };
  }

  /** Parses the edited text's version of canonical [start, end), in edited-text offsets. */
  private splitEdited(start: number, end: number): TopLevelBlock[] | undefined {
    const editedEnd = end + this.edited.length - this.canonical.text.length;
    const parsed = this.owner.structure.splitTopLevel(this.edited.slice(start, editedEnd));
    if (!parsed || parsed.some((block) => DEFINITION_TYPES.has(block.type))) {
      return undefined;
    }
    return parsed.map((block) => ({ ...block, start: block.start + start, end: block.end + start }));
  }
}

/**
 * The canonical text as alternating units: gap 0, block 0, gap 1, …, block n-1, gap n. Unit u is
 * [bounds[u], bounds[u + 1]); even units are gaps (possibly empty), odd units are blocks.
 */
class CanonicalUnits {
  private readonly bounds: number[];

  constructor(index: BlockIndex) {
    this.bounds = [0];
    for (const block of index.blocks) {
      this.bounds.push(block.start, block.end);
    }
    this.bounds.push(index.text.length);
  }

  /**
   * The inclusive unit range a change of [start, end) touches. A pure insertion touches every unit
   * whose closed range contains its position, so an insertion at a block's edge touches the block
   * and the gap: which of the two the diff credits it to is arbitrary.
   */
  touched(start: number, end: number): [number, number] {
    if (start < end) {
      return [this.lastStartingAtOrBefore(start), this.lastStartingAtOrBefore(end - 1)];
    }
    return [this.firstEndingAtOrAfter(start), this.lastStartingAtOrBefore(start)];
  }

  /**
   * The last unit u with bounds[u] ≤ position. Below the text's end that unit is never empty: an
   * empty unit starts where the next one does.
   */
  private lastStartingAtOrBefore(position: number): number {
    let low = 0;
    let high = this.bounds.length - 2;
    while (low < high) {
      const middle = (low + high + 1) >> 1;
      if (this.bounds[middle] <= position) {
        low = middle;
      } else {
        high = middle - 1;
      }
    }
    return low;
  }

  /** The first unit u with bounds[u + 1] ≥ position. */
  private firstEndingAtOrAfter(position: number): number {
    let low = 0;
    let high = this.bounds.length - 2;
    while (low < high) {
      const middle = (low + high) >> 1;
      if (this.bounds[middle + 1] >= position) {
        high = middle;
      } else {
        low = middle + 1;
      }
    }
    return low;
  }
}

/**
 * For every canonical block, the index of the source block holding the same content, or -1. Pairs
 * come from aligning the key sequences; a lone unmatched block on each side between two matched
 * pairs is the same block in formatting Milkdown does not preserve exactly, and pairs too. Blocks in
 * a run of identical keys that also holds an unmatched block are left unpaired: the alignment could
 * as well have paired them differently. Undefined when the alignment exceeds its budget.
 */
function alignBlocks(
  sourceBlocks: readonly TopLevelBlock[],
  canonicalBlocks: readonly TopLevelBlock[],
): Int32Array | undefined {
  const ids = new Map<string, number>();
  const intern = (blocks: readonly TopLevelBlock[]) => Int32Array.from(blocks, (block) => {
    let id = ids.get(block.key);
    if (id === undefined) {
      id = ids.size;
      ids.set(block.key, id);
    }
    return id;
  });
  const sourceIds = intern(sourceBlocks);
  const canonicalIds = intern(canonicalBlocks);
  const pairs = matchSequences(sourceIds, canonicalIds, MAX_ALIGNMENT_EDITS);
  if (!pairs) {
    return undefined;
  }

  const partner = new Int32Array(canonicalBlocks.length).fill(-1);
  const sourcePaired = new Uint8Array(sourceBlocks.length);
  let previous: [number, number] = [-1, -1];
  for (const pair of [...pairs, [sourceBlocks.length, canonicalBlocks.length] as [number, number]]) {
    if (pair[0] - previous[0] === 2 && pair[1] - previous[1] === 2) {
      partner[previous[1] + 1] = previous[0] + 1;
      sourcePaired[previous[0] + 1] = 1;
    }
    if (pair[0] < sourceBlocks.length) {
      partner[pair[1]] = pair[0];
      sourcePaired[pair[0]] = 1;
    }
    previous = pair;
  }

  // Unpair every block in an identical-key run that holds an unmatched block on either side.
  const unpairRuns = (ids: Int32Array, paired: (index: number) => boolean, unpair: (index: number) => void) => {
    for (let start = 0; start < ids.length;) {
      let end = start + 1;
      while (end < ids.length && ids[end] === ids[start]) {
        end++;
      }
      let ambiguous = false;
      for (let i = start; i < end && !ambiguous; i++) {
        ambiguous = !paired(i);
      }
      if (ambiguous) {
        for (let i = start; i < end; i++) {
          unpair(i);
        }
      }
      start = end;
    }
  };
  const canonicalOf = new Int32Array(sourceBlocks.length).fill(-1);
  partner.forEach((source, canonical) => {
    if (source >= 0) canonicalOf[source] = canonical;
  });
  unpairRuns(sourceIds, (i) => sourcePaired[i] === 1, (i) => {
    if (canonicalOf[i] >= 0) partner[canonicalOf[i]] = -1;
  });
  unpairRuns(canonicalIds, (i) => partner[i] >= 0, (i) => {
    partner[i] = -1;
  });
  return partner;
}

/** The source range standing for one canonical unit, or undefined when it has no unambiguous one. */
function sourceRangeOf(
  unit: number,
  source: BlockIndex,
  canonical: BlockIndex,
  partner: Int32Array,
): SourceRegion | undefined {
  const sourceBlocks = source.blocks;
  if (unit % 2 === 1) {
    const counterpart = partner[(unit - 1) / 2];
    return counterpart < 0
      ? undefined
      : { start: sourceBlocks[counterpart].start, end: sourceBlocks[counterpart].end };
  }
  // A gap maps to the source gap between the counterparts of its neighbours, and only when no
  // source block of its own sits in between.
  const gap = unit / 2;
  const before = gap > 0 ? partner[gap - 1] : -1;
  const after = gap < canonical.blocks.length ? partner[gap] : sourceBlocks.length;
  if ((gap > 0 && before < 0) || (gap < canonical.blocks.length && after < 0) || after !== before + 1) {
    return undefined;
  }
  return {
    start: before >= 0 ? sourceBlocks[before].end : 0,
    end: after < sourceBlocks.length ? sourceBlocks[after].start : source.text.length,
  };
}

function mergeRegions(regions: SourceRegion[]): SourceRegion[] {
  const sorted = [...regions].sort((a, b) => a.start - b.start || a.end - b.end);
  const merged: SourceRegion[] = [];
  for (const region of sorted) {
    const last = merged[merged.length - 1];
    if (last && region.start <= last.end) {
      last.end = Math.max(last.end, region.end);
    } else {
      merged.push({ ...region });
    }
  }
  return merged;
}

/**
 * The changes from `before` to `after`: a line diff finds the changed runs cheaply however large
 * the texts, and each run is refined to exact characters when it is small enough. A line diff that
 * runs out of time returns coarser runs, which only makes regions larger for edits already too
 * scattered to diff; it never drops a change.
 */
function textChanges(before: string, after: string): TextChange[] {
  const dmp = new DiffMatchPatch();
  dmp.Diff_Timeout = 1;
  const encoded = dmp.diff_linesToChars_(before, after);
  const lineDiffs = dmp.diff_main(encoded.chars1, encoded.chars2, false);
  dmp.diff_charsToLines_(lineDiffs, encoded.lineArray);

  const changes: TextChange[] = [];
  let position = 0;
  let editedPosition = 0;
  let run: TextChange | undefined;
  const flush = () => {
    if (run) {
      changes.push(...refine(dmp, before, after, run));
      run = undefined;
    }
  };
  for (const [operation, text] of lineDiffs) {
    if (operation === 0) {
      flush();
      position += text.length;
      editedPosition += text.length;
      continue;
    }
    run ??= { start: position, end: position, editedStart: editedPosition, editedEnd: editedPosition };
    if (operation === -1) {
      position += text.length;
      run.end = position;
    } else {
      editedPosition += text.length;
      run.editedEnd = editedPosition;
    }
  }
  flush();
  return changes;
}

function refine(dmp: DiffMatchPatch, before: string, after: string, run: TextChange): TextChange[] {
  if (run.end - run.start + run.editedEnd - run.editedStart > MAX_REFINED_CHANGE) {
    return [run];
  }
  const changes: TextChange[] = [];
  let position = run.start;
  let editedPosition = run.editedStart;
  let current: TextChange | undefined;
  for (const [operation, text] of dmp.diff_main(
    before.slice(run.start, run.end),
    after.slice(run.editedStart, run.editedEnd),
    false,
  )) {
    if (operation === 0) {
      if (current) changes.push(current);
      current = undefined;
      position += text.length;
      editedPosition += text.length;
      continue;
    }
    current ??= { start: position, end: position, editedStart: editedPosition, editedEnd: editedPosition };
    if (operation === -1) {
      position += text.length;
      current.end = position;
    } else {
      editedPosition += text.length;
      current.editedEnd = editedPosition;
    }
  }
  if (current) changes.push(current);
  return changes;
}
