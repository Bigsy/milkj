/**
 * Caret and scroll position, so reopening a file (or restarting the IDE) lands where the user left
 * off. The page reports its state to the IDE, which persists it with the editor tab and hands it
 * back after the content of a reopened file has been pushed.
 *
 * Wire format (page -> IDE): `viewstate:<selection anchor>:<scrollTop>`, both non-negative integers.
 * Restore (IDE -> page): `window.milkjSetViewState(anchor, scrollTop)`.
 */
export const VIEW_STATE_PREFIX = "viewstate:";
const DEFAULT_DEBOUNCE_MS = 300;

export interface ViewState {
  anchor: number;
  scrollTop: number;
}

export function encodeViewStateMessage(state: ViewState): string {
  return `${VIEW_STATE_PREFIX}${state.anchor}:${state.scrollTop}`;
}

/** Accepts what the IDE (or a browser API) hands over only when both parts are usable positions. */
export function normalizeViewState(anchor: unknown, scrollTop: unknown): ViewState | undefined {
  const normalizedAnchor = normalizeOffset(anchor);
  const normalizedScrollTop = normalizeOffset(scrollTop);
  if (normalizedAnchor === undefined || normalizedScrollTop === undefined) {
    return undefined;
  }
  return { anchor: normalizedAnchor, scrollTop: normalizedScrollTop };
}

function normalizeOffset(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return undefined;
  }
  // Scroll offsets are fractional under browser zoom; the IDE stores integers.
  const rounded = Math.round(value);
  return rounded < 0 ? undefined : rounded;
}

export interface ViewStateReporterOptions {
  send(message: string): void;
  debounceMs?: number;
}

/** Coalesces the flood of scroll and selection events into one message per pause. */
export class ViewStateReporter {
  private readonly send: (message: string) => void;
  private readonly debounceMs: number;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private pending: ViewState | undefined;
  private lastSent: ViewState | undefined;

  constructor(options: ViewStateReporterOptions) {
    this.send = options.send;
    this.debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS;
  }

  report(state: ViewState): void {
    this.pending = state;
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
    }
    this.timer = setTimeout(() => this.flush(), this.debounceMs);
  }

  /** Sends the latest state now, if it differs from what the IDE already has. */
  flush(): void {
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    const state = this.pending;
    this.pending = undefined;
    if (!state) return;
    if (this.lastSent && this.lastSent.anchor === state.anchor && this.lastSent.scrollTop === state.scrollTop) {
      return;
    }
    this.lastSent = state;
    this.send(encodeViewStateMessage(state));
  }

  dispose(): void {
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    this.pending = undefined;
  }
}
