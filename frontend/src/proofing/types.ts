export type ProofingDialect =
  | "AUTO"
  | "AMERICAN"
  | "BRITISH"
  | "AUSTRALIAN"
  | "CANADIAN"
  | "INDIAN";

export interface HarperSuggestion {
  replacement: string;
}

export interface HarperCorrection {
  startIndex: number;
  endIndex: number;
  correction: string | null;
  suggestions: HarperSuggestion[];
  types: string[];
  explanation: string;
}

export interface TextRun {
  textFrom: number;
  textTo: number;
  docFrom: number;
  docTo: number;
}

export interface LintBatch {
  text: string;
  runs: TextRun[];
  trustedFrom?: number;
  trustedTo?: number;
}

export interface MappedIssue extends HarperCorrection {
  id: string;
  from: number;
  to: number;
}

export type ProofingStatus =
  | "idle"
  | "initializing"
  | "checking"
  | "ready"
  | "error"
  | "disabled";

export interface HarperEngineResult {
  corrections: HarperCorrection[];
  error?: string;
}
