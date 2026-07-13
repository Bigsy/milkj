import type { HarperCorrection } from "./types";

interface WasmValue {
  [key: string]: unknown;
}

const REPLACE = new Set<unknown>([0, "replace"]);
const REMOVE = new Set<unknown>([1, "remove"]);
const INSERT_AFTER = new Set<unknown>([2, "insertafter", "insert_after", "insert-after"]);

function call(value: WasmValue | null | undefined, name: string): unknown {
  try {
    const member = value?.[name];
    return typeof member === "function" ? member.call(value) : member;
  } catch {
    return undefined;
  }
}

function free(value: WasmValue | null | undefined): void {
  call(value, "free");
}

function isCodePointBoundary(text: string, offset: number): boolean {
  if (offset <= 0 || offset >= text.length) return true;
  const before = text.charCodeAt(offset - 1);
  const after = text.charCodeAt(offset);
  return !(before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff);
}

function readSpan(text: string, lint: WasmValue): { start: number; end: number } | null {
  const span = call(lint, "span") as WasmValue | undefined;
  try {
    const start = Number(span?.start);
    const end = Number(span?.end);
    if (
      !Number.isInteger(start) ||
      !Number.isInteger(end) ||
      start < 0 ||
      end < start ||
      end > text.length ||
      !isCodePointBoundary(text, start) ||
      !isCodePointBoundary(text, end)
    ) {
      return null;
    }
    return { start, end };
  } finally {
    free(span);
  }
}

function normalizedKind(kind: unknown): unknown {
  return typeof kind === "string" ? kind.replace(/[\s_-]/g, "").toLowerCase() : kind;
}

function readSuggestion(
  suggestion: WasmValue,
  span: { start: number; end: number },
): { start: number; end: number; replacement: string } | null {
  const kind = normalizedKind(call(suggestion, "kind"));
  let start = span.start;
  let end = span.end;
  let replacement: unknown;
  if (REPLACE.has(kind)) {
    replacement = call(suggestion, "get_replacement_text");
  } else if (REMOVE.has(kind)) {
    replacement = "";
  } else if (INSERT_AFTER.has(kind)) {
    start = span.end;
    end = span.end;
    replacement = call(suggestion, "get_replacement_text");
  } else {
    return null;
  }
  return typeof replacement === "string" ? { start, end, replacement } : null;
}

export function normalizeHarperLints(text: string, rawLints: unknown[]): HarperCorrection[] {
  const issues: Array<HarperCorrection & { order: number }> = [];
  const lints = rawLints as WasmValue[];
  lints.forEach((lint, lintIndex) => {
    const span = readSpan(text, lint);
    if (!span) return;
    const rawSuggestions = call(lint, "suggestions");
    const groups = new Map<string, string[]>();
    if (Array.isArray(rawSuggestions)) {
      for (const raw of rawSuggestions as WasmValue[]) {
        try {
          const suggestion = readSuggestion(raw, span);
          if (!suggestion) continue;
          const key = `${suggestion.start}:${suggestion.end}`;
          const replacements = groups.get(key) ?? [];
          if (!replacements.includes(suggestion.replacement)) replacements.push(suggestion.replacement);
          groups.set(key, replacements);
        } finally {
          free(raw);
        }
      }
    }
    const rawType = call(lint, "lint_kind");
    const type = typeof rawType === "string" && rawType.trim()
      ? rawType.trim().toLowerCase()
      : "miscellaneous";
    const rawMessage = call(lint, "message");
    const common = {
      types: [type],
      explanation: typeof rawMessage === "string" ? rawMessage : "",
    };
    if (groups.size === 0) {
      issues.push({
        startIndex: span.start,
        endIndex: span.end,
        correction: null,
        suggestions: [],
        ...common,
        order: lintIndex,
      });
    } else {
      let groupIndex = 0;
      for (const [key, replacements] of groups) {
        const [startIndex, endIndex] = key.split(":").map(Number);
        issues.push({
          startIndex,
          endIndex,
          correction: replacements[0] ?? null,
          suggestions: replacements.map((replacement) => ({ replacement })),
          ...common,
          order: lintIndex + groupIndex++ / 1000,
        });
      }
    }
  });
  return issues
    .sort((a, b) => a.startIndex - b.startIndex || a.endIndex - b.endIndex || a.order - b.order)
    .map(({ order: _order, ...issue }) => issue);
}
