import type { MappedIssue } from "./types";

export const MAX_DICTIONARY_WORD_LENGTH = 64;

const SENTENCE_PUNCTUATION = /^[.,;:!?…"'“”‘’()[\]{}]+|[.,;:!?…"'“”‘’()[\]{}]+$/gu;

export function normalizeDictionary(values: unknown): string[] {
  if (!Array.isArray(values)) return [];
  return [...new Set(values
    .filter((value): value is string => typeof value === "string")
    .map((value) => value.trim())
    .filter(isValidDictionaryWord))]
    .sort();
}

export function isValidDictionaryWord(word: string): boolean {
  return word.length > 0 &&
    word.length <= MAX_DICTIONARY_WORD_LENGTH &&
    !/\s/u.test(word) &&
    /[\p{L}\p{N}]/u.test(word);
}

export function dictionaryCandidate(currentText: string, issue: MappedIssue): string | null {
  if (
    issue.from < 0 ||
    issue.to <= issue.from ||
    issue.to - issue.from !== currentText.length ||
    !issue.types.some((type) => type.toLowerCase().includes("spelling"))
  ) return null;

  const candidate = currentText.replace(SENTENCE_PUNCTUATION, "");
  return isValidDictionaryWord(candidate) ? candidate : null;
}

export function isDictionaryEligible(currentText: string, issue: MappedIssue): boolean {
  return dictionaryCandidate(currentText, issue) !== null;
}
