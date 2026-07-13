import type { Node as ProseMirrorNode } from "@milkdown/kit/prose/model";
import type { HarperCorrection, LintBatch, MappedIssue, TextRun } from "./types";

const MAX_BATCH = 4000;
const OVERLAP = 200;
const EXCLUDED_NODES = new Set(["code_block", "html", "html_block", "html_inline", "image", "math_inline", "math_block"]);

interface SourceRun {
  text: string;
  docFrom: number;
  docTo: number;
  block: ProseMirrorNode | null;
  separatorBefore: "" | " " | "\n\n";
}

export function extractLintBatches(doc: ProseMirrorNode): LintBatch[] {
  const sourceRuns: SourceRun[] = [];
  let current: SourceRun | undefined;

  doc.descendants((node, pos, parent) => {
    if (EXCLUDED_NODES.has(node.type.name)) {
      current = undefined;
      return false;
    }
    if (!node.isText) return true;
    if (node.marks.some((mark) => mark.type.name === "inlineCode" || mark.type.name === "inline_code")) {
      current = undefined;
      return false;
    }
    const text = node.text ?? "";
    if (!text) return false;
    if (current && current.docTo === pos && current.block === parent) {
      current.text += text;
      current.docTo += text.length;
    } else {
      const previous = sourceRuns.at(-1);
      current = {
        text,
        docFrom: pos,
        docTo: pos + text.length,
        block: parent,
        // An excluded inline node interrupts mapping, not the surrounding sentence. Preserve any
        // surrounding whitespace (or add one space) without allowing a correction to cross the gap.
        separatorBefore: previous
          ? (previous.block === parent
            ? (/\s$/.test(previous.text) || /^\s/.test(text) ? "" : " ")
            : "\n\n")
          : "",
      };
      sourceRuns.push(current);
    }
    return false;
  });

  // ProseMirror reports adjacent marked text at contiguous positions. Merge those, while node gaps
  // (hard breaks, excluded inline content, and block boundaries) remain explicit separators.
  const merged: SourceRun[] = [];
  for (const run of sourceRuns) {
    const previous = merged.at(-1);
    if (previous && previous.docTo === run.docFrom && previous.block === run.block) {
      previous.text += run.text;
      previous.docTo = run.docTo;
    } else {
      merged.push({ ...run });
    }
  }
  return packRuns(merged);
}

function packRuns(runs: SourceRun[]): LintBatch[] {
  const batches: LintBatch[] = [];
  let text = "";
  let mapped: TextRun[] = [];
  const flush = () => {
    if (mapped.length) batches.push({ text, runs: mapped });
    text = "";
    mapped = [];
  };
  for (const run of runs) {
    if (run.text.length > MAX_BATCH) {
      flush();
      const windows: Array<{ start: number; end: number }> = [];
      for (let windowStart = 0; windowStart < run.text.length; windowStart += MAX_BATCH - OVERLAP) {
        const start = safeBoundary(run.text, windowStart, 1);
        const end = safeBoundary(run.text, Math.min(run.text.length, windowStart + MAX_BATCH), -1);
        windows.push({ start, end });
        if (end === run.text.length) break;
      }
      windows.forEach(({ start, end }, index) => {
        const chunk = run.text.slice(start, end);
        const trustedStart = index === 0
          ? start
          : safeBoundary(run.text, Math.floor((windows[index - 1]!.end + start) / 2), 1);
        const trustedEnd = index === windows.length - 1
          ? end
          : safeBoundary(run.text, Math.floor((end + windows[index + 1]!.start) / 2), 1);
        batches.push({
          text: chunk,
          runs: [{ textFrom: 0, textTo: chunk.length, docFrom: run.docFrom + start, docTo: run.docFrom + end }],
          trustedFrom: trustedStart - start,
          trustedTo: trustedEnd - start,
        });
      });
      continue;
    }
    const separator = mapped.length ? run.separatorBefore : "";
    if (text.length + separator.length + run.text.length > MAX_BATCH) flush();
    if (mapped.length) text += run.separatorBefore;
    const textFrom = text.length;
    text += run.text;
    mapped.push({ textFrom, textTo: text.length, docFrom: run.docFrom, docTo: run.docTo });
  }
  flush();
  return batches;
}

function safeBoundary(text: string, offset: number, bias: -1 | 1): number {
  const value = text.charCodeAt(offset);
  return value >= 0xdc00 && value <= 0xdfff ? offset + bias : offset;
}

export function mapCorrection(batch: LintBatch, correction: HarperCorrection, id: string): MappedIssue | null {
  const trustedFrom = batch.trustedFrom ?? 0;
  const trustedTo = batch.trustedTo ?? batch.text.length;
  if (correction.startIndex < trustedFrom || correction.endIndex > trustedTo) return null;
  const run = batch.runs.find(({ textFrom, textTo }) =>
    correction.startIndex >= textFrom && correction.endIndex <= textTo,
  );
  if (!run) return null;
  return {
    ...correction,
    id,
    from: run.docFrom + correction.startIndex - run.textFrom,
    to: run.docFrom + correction.endIndex - run.textFrom,
  };
}
