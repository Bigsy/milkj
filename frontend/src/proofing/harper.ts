import { Dialect, WorkerLinter, type Lint } from "harper.js";
import { binary } from "harper.js/binary";
import { normalizeHarperLints } from "./normalize";
import type { HarperEngineResult, ProofingDialect } from "./types";

const DIALECTS: Record<Exclude<ProofingDialect, "AUTO">, Dialect> = {
  AMERICAN: Dialect.American,
  BRITISH: Dialect.British,
  AUSTRALIAN: Dialect.Australian,
  CANADIAN: Dialect.Canadian,
  INDIAN: Dialect.Indian,
};

export type ResolvedDialect = Exclude<ProofingDialect, "AUTO">;

export interface HarperLinter {
  setup(): Promise<void>;
  lint(text: string, options?: { language?: "plaintext" }): Promise<Lint[]>;
  clearWords(): Promise<void>;
  importWords(words: string[]): Promise<void>;
  loadWeirpackFromBytes(bytes: Uint8Array | number[]): Promise<Record<string, unknown> | undefined>;
  setDialect(dialect: Dialect): Promise<void>;
  dispose(): Promise<void>;
}

export type HarperLinterFactory = (dialect: Dialect) => HarperLinter;

export function resolveDialect(dialect: ProofingDialect, language = navigator.language): ResolvedDialect {
  if (dialect !== "AUTO") return dialect;
  const region = language.split(/[-_]/)[1]?.toUpperCase();
  if (region === "GB") return "BRITISH";
  if (region === "AU") return "AUSTRALIAN";
  if (region === "CA") return "CANADIAN";
  if (region === "IN") return "INDIAN";
  return "AMERICAN";
}

export class HarperEngine {
  private worker: HarperLinter | undefined;
  private dialect: ResolvedDialect | undefined;
  private dictionaryFingerprint: string | undefined;
  private weirpackFingerprint: string | undefined;
  private tail: Promise<unknown> = Promise.resolve();
  private disposed = false;

  constructor(
    private readonly createLinter: HarperLinterFactory =
      (dialect) => new WorkerLinter({ binary, dialect }),
  ) {}

  lint(
    text: string,
    dialect: ResolvedDialect,
    dictionary: readonly string[],
    weirpacks: readonly string[] = [],
  ): Promise<HarperEngineResult> {
    const words = [...dictionary];
    const dictionaryFingerprint = JSON.stringify(words);
    const weirpackFingerprint = JSON.stringify(weirpacks);
    return this.enqueue(async () => {
      if (this.disposed) return { corrections: [], error: "Harper has been disposed" };
      let lints: Lint[] = [];
      try {
        const recreateWorker = !this.worker ||
          this.dialect !== dialect ||
          this.weirpackFingerprint !== weirpackFingerprint ||
          (weirpacks.length > 0 && this.dictionaryFingerprint !== dictionaryFingerprint);
        if (recreateWorker) {
          const previousWorker = this.worker;
          this.worker = undefined;
          try { await previousWorker?.dispose(); } catch { /* replace it regardless */ }
          const worker = this.createLinter(DIALECTS[dialect]);
          this.worker = worker;
          await worker.setup();
          this.dialect = dialect;
          await worker.clearWords();
          if (words.length) await worker.importWords(words);
          for (const encoded of weirpacks) {
            const failures = await worker.loadWeirpackFromBytes(decodeBase64(encoded));
            if (failures && Object.keys(failures).length > 0) {
              throw new Error(
                `Weirpack tests failed for: ${Object.keys(failures).join(", ")}`,
              );
            }
          }
          this.dictionaryFingerprint = dictionaryFingerprint;
          this.weirpackFingerprint = weirpackFingerprint;
        }
        const worker = this.worker;
        if (!worker) throw new Error("Harper failed to initialize");
        if (!recreateWorker && this.dictionaryFingerprint !== dictionaryFingerprint) {
          await worker.clearWords();
          if (words.length) await worker.importWords(words);
          this.dictionaryFingerprint = dictionaryFingerprint;
        }
        lints = await worker.lint(text, { language: "plaintext" });
        return { corrections: normalizeHarperLints(text, lints) };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.warn("MilkJ Harper proofing failed:", message);
        const failedWorker = this.worker;
        this.worker = undefined;
        this.dialect = undefined;
        this.dictionaryFingerprint = undefined;
        this.weirpackFingerprint = undefined;
        try { await failedWorker?.dispose(); } catch { /* preserve the lint error */ }
        return { corrections: [], error: message };
      } finally {
        for (const lint of lints) {
          try { lint.free(); } catch { /* best-effort WASM cleanup */ }
        }
      }
    });
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    await this.tail.catch(() => undefined);
    const worker = this.worker;
    this.worker = undefined;
    this.dialect = undefined;
    this.dictionaryFingerprint = undefined;
    this.weirpackFingerprint = undefined;
    if (worker) await worker.dispose();
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.tail.then(operation, operation);
    this.tail = result.catch(() => undefined);
    return result;
  }
}

function decodeBase64(encoded: string): Uint8Array {
  const binary = atob(encoded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}
