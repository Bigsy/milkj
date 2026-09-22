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
import { type MarkdownBlock, splitMarkdownBlocks } from "../src/markdown-blocks";
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
function canonicalize(markdown: string): string {
  step("canonicalize");
  const start = performance.now();
  try {
    return canonicalizeRaw(markdown);
  } finally {
    const elapsed = performance.now() - start;
    canonTime += elapsed;
    canonCalls++;
    canonMax = Math.max(canonMax, elapsed);
    step("merge strategy");
  }
}
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
  const coordinates = dmp.diff_main(canonicalBefore, source);
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
        for (const mode of ["cold", "warm"] as const) {
          const name = `${doc} | ${label} | ${editName} | ${mode}`;
          it(name, () => {
            currentCase = name;
            const p = prepared.get(`${doc} ${label}`);
            if (!p || p.skip) {
              result(`${name} | skipped (${p?.skip ?? "not prepared"})`);
              return;
            }
            const caseStart = performance.now();
            step("prepare case: canonicalize before");
            const before = timed(() => p.canonicalBefore ?? canonicalizeRaw(p.source));
            p.canonicalBefore = before.value;
            const editedSource = p.source.replace(edit.from, edit.to);
            if (editedSource === p.source) {
              result(`${name} | marker missing`);
              return;
            }
            step("prepare case: canonicalize edited");
            const editedTimed = timed(() => canonicalizeRaw(editedSource));
            if (before.ms > CALL_CAP_MS || editedTimed.ms > CALL_CAP_MS) {
              result(
                `${name} | >10 s in canonicalize (setup: before ${before.ms.toFixed(0)} ms, ` +
                `edited ${editedTimed.ms.toFixed(0)} ms)`,
              );
              return;
            }
            const edited = editedTimed.value;
            const patchWinner = patchCandidate(p.source, p.canonicalBefore, edited);
            const runs = p.source.length >= 1_000_000 ? 3 : 5;
            type Run = {
              ms: number; canonMs: number; canonN: number; canonMax: number;
              splitMs: number; splitN: number; winner: string;
            };
            const measured: Run[] = [];
            let capNote = "";
            for (let r = 0; r < runs + 1; r++) {
              if (performance.now() - caseStart > CASE_CAP_MS) {
                capNote = ` | >60 s case cap hit after ${measured.length} measured runs`;
                break;
              }
              canonTime = 0; canonCalls = 0; canonMax = 0; splitTime = 0; splitCalls = 0;
              step("mergeSourcePreservingEdit");
              const { value: merged, ms } = timed(() => mergeSourcePreservingEdit(
                p.source,
                edited,
                canonicalize,
                mode === "warm" ? p.canonicalBefore : undefined,
                split,
              ));
              const overCap = ms > CALL_CAP_MS;
              // The first run warms the JIT and is discarded unless it is the only one that fits.
              if (r > 0 || overCap) {
                measured.push({
                  ms, canonMs: canonTime, canonN: canonCalls, canonMax, splitMs: splitTime, splitN: splitCalls,
                  winner: !merged.ok
                    ? "FAILED"
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
              `split ${run.splitMs.toFixed(0)} ms in ${run.splitN} | ` +
              `other ${(run.ms - run.canonMs - run.splitMs).toFixed(0)} ms | ${run.winner}${capNote}`,
            );
          });
        }
      }
    }
  });
}
