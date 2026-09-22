// Benchmarks the page-side sync path on large documents: `pnpm run bench:sync`. Results are
// appended to bench/out/results.txt (or $BENCH_OUT/results.txt) as each case finishes, and
// current.txt names the step in progress, so a run that stalls in synchronous code still shows
// where it is.

import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { Editor, editorViewCtx, parserCtx, remarkCtx, rootCtx, serializerCtx } from "@milkdown/kit/core";
import { commonmark } from "@milkdown/kit/preset/commonmark";
import { gfm } from "@milkdown/kit/preset/gfm";
import DiffMatchPatch from "diff-match-patch";
import { afterAll, beforeAll, describe, it } from "vitest";
import { EditRegions, type MarkdownStructure, SourceBlockIndex } from "../src/block-index";
import {
  type MarkdownBlock,
  parseObservingBlocks,
  splitMarkdownBlocks,
  splitTopLevelBlocks,
} from "../src/markdown-blocks";
import { alignSource } from "../src/source-alignment";
import { mergeSourcePreservingEdit } from "../src/source-preserving-sync";
import {
  buildCleanDoc,
  buildDriftDoc,
  FRONTMATTER,
  MARKER_EDITS,
  type MarkerEdit,
} from "../src/test-support/large-markdown";

// The config sets Vitest's root to frontend/; under jsdom import.meta.url is not a file URL.
const OUT = process.env.BENCH_OUT ?? `${process.cwd()}/bench/out`;
const RESULTS = `${OUT}/results.txt`;
const CURRENT = `${OUT}/current.txt`;
const CALL_CAP_MS = 10_000;
const CASE_CAP_MS = 60_000;

const SIZES: Array<[string, number]> = [["50KB", 50_000], ["200KB", 200_000], ["1MB", 1_000_000]];
const EDITS: Array<[string, MarkerEdit]> = [
  ["start", MARKER_EDITS.start],
  ["middle", MARKER_EDITS.middle],
  ["end", MARKER_EDITS.end],
  ["table cell", MARKER_EDITS.tableCell],
];

function result(line: string) {
  console.log(line);
  appendFileSync(RESULTS, `${line}\n`);
}

let currentCase = "";
function step(name: string) {
  writeFileSync(CURRENT, `${new Date().toISOString()} case=${currentCase} step=${name}\n`);
}

let editor: Editor;
beforeAll(async () => {
  mkdirSync(OUT, { recursive: true });
  writeFileSync(RESULTS, "");
  const root = document.body.appendChild(document.createElement("div"));
  editor = await Editor.make().config((ctx) => ctx.set(rootCtx, root)).use(commonmark).use(gfm).create();
});
afterAll(async () => {
  await editor.destroy();
});

const parse = (markdown: string) => editor.action((ctx) => ctx.get(parserCtx)(markdown));
const serialize = (doc: ReturnType<typeof parse>) => editor.action((ctx) => ctx.get(serializerCtx)(doc));
const canonicalizeRaw = (markdown: string) => serialize(parse(markdown));

// Instrumented wrappers, reset before every measured merge.
let canonTime = 0, canonCalls = 0, canonMax = 0, splitTime = 0, splitCalls = 0;
let guardTime = 0, topSplitTime = 0, topSplitCalls = 0;
function resetCounters() {
  canonTime = 0; canonCalls = 0; canonMax = 0; splitTime = 0; splitCalls = 0;
  guardTime = 0; topSplitTime = 0; topSplitCalls = 0;
}
function countCanonicalize<T>(fn: () => T): T {
  step("canonicalize");
  const start = performance.now();
  try {
    return fn();
  } finally {
    const elapsed = performance.now() - start;
    canonTime += elapsed;
    canonCalls++;
    canonMax = Math.max(canonMax, elapsed);
    step("merge strategy");
  }
}
function canonicalize(markdown: string): string {
  return countCanonicalize(() => canonicalizeRaw(markdown));
}

const structure: MarkdownStructure = {
  splitTopLevel(markdown) {
    step("top-level split");
    const start = performance.now();
    try {
      return splitTopLevelBlocks(editor.ctx.get(remarkCtx), markdown);
    } finally {
      topSplitTime += performance.now() - start;
      topSplitCalls++;
      step("guard");
    }
  },
  canonicalizeObserving: (markdown, knownKey) => countCanonicalize(() => editor.action((ctx) => {
    const { result, blocks } = parseObservingBlocks(ctx.get(remarkCtx), markdown, ctx.get(parserCtx), knownKey);
    return { canonical: ctx.get(serializerCtx)(result), blocks };
  })),
};

// Time the guard's own work: deriving regions, checking candidates and re-indexing accepted ones.
function timeGuard<T extends object>(prototype: T, method: keyof T) {
  const original = prototype[method] as (...args: unknown[]) => unknown;
  (prototype as Record<keyof T, unknown>)[method] = function (this: unknown, ...args: unknown[]) {
    const start = performance.now();
    const canonBefore = canonTime;
    try {
      return original.apply(this, args);
    } finally {
      // canonicalizeObserving runs inside EditRegions.canonicalize and is canonicalize time.
      guardTime += performance.now() - start - (canonTime - canonBefore);
    }
  };
}
timeGuard(SourceBlockIndex.prototype, "prepare");
timeGuard(EditRegions.prototype, "check");
timeGuard(EditRegions.prototype, "accept");
function split(markdown: string): MarkdownBlock | undefined {
  step("splitBlocks");
  const start = performance.now();
  try {
    return splitMarkdownBlocks(editor.ctx.get(remarkCtx), markdown);
  } finally {
    splitTime += performance.now() - start;
    splitCalls++;
    step("merge strategy (block)");
  }
}

function timed<T>(fn: () => T): { value: T; ms: number } {
  const start = performance.now();
  const value = fn();
  return { value, ms: performance.now() - start };
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? NaN;
}

/**
 * The patch strategy's candidate, computed without canonicalizing, so the winning strategy can be
 * named. Mirrors the patch strategy in source-preserving-sync.ts and must be kept in step with it.
 */
function patchCandidate(source: string, canonicalBefore: string, edited: string): string | undefined {
  const dmp = new DiffMatchPatch();
  dmp.Diff_Timeout = 0.1;
  const patches = dmp.patch_make(canonicalBefore, edited);
  const coordinates = alignSource(dmp, canonicalBefore, source)?.characters
    ?? dmp.diff_main(canonicalBefore, source);
  for (const patch of patches as unknown as Array<{ start1: number | null; start2: number | null }>) {
    if (patch.start1 !== null) patch.start1 = dmp.diff_xIndex(coordinates, patch.start1);
    if (patch.start2 !== null) patch.start2 = dmp.diff_xIndex(coordinates, patch.start2);
  }
  const [candidate, applied] = dmp.patch_apply(patches, source);
  return applied.some((didApply) => !didApply) ? undefined : candidate;
}

/**
 * What Milkdown's listener does on every document change before our code runs: compare the new
 * document with the previous one, then serialize the whole document (plugin-listener, debounced
 * 200 ms). Measured on editor states, so the document is the one the editor's plugins produced.
 */
function measureListenerSerialization(label: string, source: string, edit: MarkerEdit) {
  step("listener serialization");
  const runs = source.length >= 1_000_000 ? 3 : 5;
  const eqTimes: number[] = [];
  const serializeTimes: number[] = [];
  editor.action((ctx) => {
    const view = ctx.get(editorViewCtx);
    const pushed = view.state.apply(
      view.state.tr.replaceWith(0, view.state.doc.content.size, parse(source).content),
    );
    // Type the edit's extra character right after the marker.
    let at = -1;
    pushed.doc.descendants((node, pos) => {
      if (at >= 0) return false;
      const offset = node.isText ? node.text!.indexOf(edit.from) : -1;
      if (offset >= 0) at = pos + offset + edit.from.length;
      return true;
    });
    if (at < 0) {
      return;
    }
    const edited = pushed.apply(pushed.tr.insertText(edit.to.slice(edit.from.length), at));
    const serializer = ctx.get(serializerCtx);
    for (let r = 0; r < runs + 1; r++) {
      const eq = timed(() => pushed.doc.eq(edited.doc));
      const serialized = timed(() => serializer(edited.doc));
      if (r > 0) {
        eqTimes.push(eq.ms);
        serializeTimes.push(serialized.ms);
      }
      if (serialized.ms > CALL_CAP_MS) break;
    }
  });
  result(
    `[${label}] listener per update: doc.eq ${median(eqTimes).toFixed(1)} ms, ` +
    `serialize ${median(serializeTimes).toFixed(0)} ms (n=${serializeTimes.length})`,
  );
}

type Prepared = { source: string; lines: number; canonicalBefore?: string; skip?: string };
const prepared = new Map<string, Prepared>();

/**
 * cold: the first edit after an IDE push, with nothing known about the source.
 * warm: canonical form and block index of the source already known.
 * chained: the next keystroke after an accepted edit, with everything the accepted merge left
 *   behind — the steady state while typing.
 */
const MODES = ["cold", "warm", "chained"] as const;
type Mode = (typeof MODES)[number];

interface Case {
  source: string;
  canonicalBefore: string;
  knownCanonical: string | undefined;
  edited: string;
  /** A fresh block index in the state this mode starts from. */
  index: () => SourceBlockIndex;
}

function prepareCase(p: Prepared, edit: MarkerEdit, mode: Mode): Case | string {
  p.canonicalBefore ??= canonicalizeRaw(p.source);
  const editedSource = p.source.replace(edit.from, edit.to);
  if (editedSource === p.source) {
    return "marker missing";
  }
  const edited = canonicalizeRaw(editedSource);
  if (mode === "cold") {
    return {
      source: p.source,
      canonicalBefore: p.canonicalBefore,
      knownCanonical: undefined,
      edited,
      index: () => new SourceBlockIndex(structure),
    };
  }
  const sourceIndex = { text: p.source, blocks: structure.splitTopLevel(p.source)! };
  const canonicalIndex = { text: p.canonicalBefore, blocks: structure.splitTopLevel(p.canonicalBefore)! };
  const primed = () => {
    const index = new SourceBlockIndex(structure);
    index.accept(sourceIndex, canonicalIndex);
    return index;
  };
  if (mode === "warm") {
    return { source: p.source, canonicalBefore: p.canonicalBefore, knownCanonical: p.canonicalBefore, edited, index: primed };
  }
  // Accept the marker edit, then time typing one more character right after it.
  const first = primed();
  const accepted = mergeSourcePreservingEdit(p.source, edited, canonicalizeRaw, p.canonicalBefore, split, first);
  if (!accepted.ok) {
    return `first edit of the chain failed (${accepted.reason})`;
  }
  const after = first.indexed();
  const next = canonicalizeRaw(edited.replace(edit.to, `${edit.to}y`));
  return {
    source: accepted.markdown,
    canonicalBefore: edited,
    knownCanonical: edited,
    edited: next,
    index: () => {
      const index = new SourceBlockIndex(structure);
      index.accept(after.source, after.canonical);
      return index;
    },
  };
}

for (const [label, bytes] of SIZES) {
  describe(label, () => {
    it(`prepare ${label}`, () => {
      currentCase = `prepare ${label}`;
      const drift = buildDriftDoc(bytes);
      step("canonicalize drift body (setup)");
      const clean = timed(() => buildCleanDoc(drift, canonicalizeRaw));
      if (clean.ms > CALL_CAP_MS) {
        const skip = `setup canonicalize >10 s (${(clean.ms / 1000).toFixed(1)} s)`;
        result(`[${label}] ${skip}, skipping size`);
        prepared.set(`clean ${label}`, { source: "", lines: 0, skip });
        prepared.set(`drift ${label}`, { source: "", lines: 0, skip });
        return;
      }
      prepared.set(`clean ${label}`, { source: clean.value, lines: clean.value.split("\n").length });
      prepared.set(`drift ${label}`, { source: drift, lines: drift.split("\n").length });

      const parseTimes: number[] = [];
      const serializeTimes: number[] = [];
      const runs = bytes >= 1_000_000 ? 3 : 5;
      const start = performance.now();
      for (let r = 0; r < runs + 1 && performance.now() - start < CASE_CAP_MS; r++) {
        step("standalone parse");
        const parsed = timed(() => parse(clean.value));
        step("standalone serialize");
        const serialized = timed(() => serialize(parsed.value));
        if (r > 0) {
          parseTimes.push(parsed.ms);
          serializeTimes.push(serialized.ms);
        }
        if (parsed.ms + serialized.ms > CALL_CAP_MS) break;
      }
      result(
        `[${label}] ${clean.value.length} chars, ${clean.value.split("\n").length} lines: ` +
        `parse ${median(parseTimes).toFixed(0)} ms, serialize ${median(serializeTimes).toFixed(0)} ms ` +
        `(n=${parseTimes.length})`,
      );
      measureListenerSerialization(label, drift.slice(FRONTMATTER.length), MARKER_EDITS.middle);
    });

    for (const doc of ["clean", "drift"] as const) {
      for (const [editName, edit] of EDITS) {
        for (const mode of MODES) {
          const name = `${doc} | ${label} | ${editName} | ${mode}`;
          it(name, () => {
            currentCase = name;
            const p = prepared.get(`${doc} ${label}`);
            if (!p || p.skip) {
              result(`${name} | skipped (${p?.skip ?? "not prepared"})`);
              return;
            }
            const caseStart = performance.now();
            step("prepare case");
            const setup = timed(() => prepareCase(p, edit, mode));
            if (typeof setup.value === "string") {
              result(`${name} | ${setup.value}`);
              return;
            }
            if (setup.ms > CASE_CAP_MS / 2) {
              result(`${name} | setup took ${(setup.ms / 1000).toFixed(1)} s, skipping`);
              return;
            }
            const c = setup.value;
            const patchWinner = patchCandidate(c.source, c.canonicalBefore, c.edited);
            const runs = c.source.length >= 1_000_000 ? 3 : 5;
            type Run = {
              ms: number; canonMs: number; canonN: number; canonMax: number; splitMs: number;
              splitN: number; guardMs: number; topSplitMs: number; topSplitN: number; winner: string;
            };
            const measured: Run[] = [];
            let capNote = "";
            for (let r = 0; r < runs + 1; r++) {
              if (performance.now() - caseStart > CASE_CAP_MS) {
                capNote = ` | >60 s case cap hit after ${measured.length} measured runs`;
                break;
              }
              const index = c.index();
              resetCounters();
              step("mergeSourcePreservingEdit");
              const { value: merged, ms } = timed(() => mergeSourcePreservingEdit(
                c.source,
                c.edited,
                canonicalize,
                c.knownCanonical,
                split,
                index,
              ));
              const overCap = ms > CALL_CAP_MS;
              // The first run warms the JIT and is discarded unless it is the only one that fits.
              if (r > 0 || overCap) {
                measured.push({
                  ms, canonMs: canonTime, canonN: canonCalls, canonMax, splitMs: splitTime,
                  splitN: splitCalls, guardMs: guardTime, topSplitMs: topSplitTime, topSplitN: topSplitCalls,
                  winner: !merged.ok
                    ? `FAILED (${merged.reason})`
                    : merged.markdown === patchWinner ? "patch" : splitCalls > 0 ? "block" : "line",
                });
              }
              if (overCap) {
                capNote = ` | >10 s single call (${(ms / 1000).toFixed(1)} s)`;
                break;
              }
            }
            // Report the median run's own breakdown, so its parts add up to its total.
            const run = [...measured].sort((a, b) => a.ms - b.ms)[Math.floor(measured.length / 2)];
            if (!run) {
              result(`${name} | no measured runs${capNote}`);
              return;
            }
            result(
              `${name} | ${p.lines} lines | median ${run.ms.toFixed(0)} ms (n=${measured.length}) | ` +
              `canon ${run.canonMs.toFixed(0)} ms in ${run.canonN} calls (max ${run.canonMax.toFixed(0)}) | ` +
              `guard ${run.guardMs.toFixed(1)} ms (top-level splits ${run.topSplitMs.toFixed(0)} ms in ` +
              `${run.topSplitN}) | block split ${run.splitMs.toFixed(0)} ms in ${run.splitN} | ` +
              `other ${(run.ms - run.canonMs - run.guardMs - run.splitMs).toFixed(0)} ms | ` +
              `${run.winner}${capNote}`,
            );
          });
        }
      }
    }
  });
}
