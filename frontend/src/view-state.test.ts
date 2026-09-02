import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ViewStateReporter, encodeViewStateMessage, normalizeViewState } from "./view-state";

describe("view state protocol", () => {
  it("encodes anchor and scroll offset as a colon-separated message", () => {
    expect(encodeViewStateMessage({ anchor: 42, scrollTop: 1200 })).toBe("viewstate:42:1200");
  });

  it("normalizes usable positions and rounds fractional scroll offsets", () => {
    expect(normalizeViewState(0, 0)).toEqual({ anchor: 0, scrollTop: 0 });
    expect(normalizeViewState(17, 380.6)).toEqual({ anchor: 17, scrollTop: 381 });
  });

  it.each([
    ["negative anchor", -1, 0],
    ["negative scroll", 3, -20],
    ["NaN", Number.NaN, 0],
    ["infinite", 1, Number.POSITIVE_INFINITY],
    ["string", "12", 0],
    ["missing", undefined, 0],
  ])("rejects %s", (_name, anchor, scrollTop) => {
    expect(normalizeViewState(anchor, scrollTop)).toBeUndefined();
  });
});

describe("ViewStateReporter", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("debounces a burst of reports into the last state", () => {
    const send = vi.fn();
    const reporter = new ViewStateReporter({ send, debounceMs: 100 });

    reporter.report({ anchor: 1, scrollTop: 10 });
    reporter.report({ anchor: 2, scrollTop: 20 });
    vi.advanceTimersByTime(99);
    expect(send).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(send).toHaveBeenCalledOnce();
    expect(send).toHaveBeenCalledWith("viewstate:2:20");
  });

  it("does not resend an unchanged state", () => {
    const send = vi.fn();
    const reporter = new ViewStateReporter({ send, debounceMs: 50 });

    reporter.report({ anchor: 5, scrollTop: 0 });
    vi.advanceTimersByTime(50);
    reporter.report({ anchor: 5, scrollTop: 0 });
    vi.advanceTimersByTime(50);
    expect(send).toHaveBeenCalledOnce();

    reporter.report({ anchor: 5, scrollTop: 8 });
    vi.advanceTimersByTime(50);
    expect(send).toHaveBeenCalledTimes(2);
    expect(send).toHaveBeenLastCalledWith("viewstate:5:8");
  });

  it("flushes the pending state immediately on demand and drops it on dispose", () => {
    const send = vi.fn();
    const reporter = new ViewStateReporter({ send, debounceMs: 1000 });

    reporter.report({ anchor: 9, scrollTop: 90 });
    reporter.flush();
    expect(send).toHaveBeenCalledWith("viewstate:9:90");

    reporter.report({ anchor: 10, scrollTop: 100 });
    reporter.dispose();
    vi.advanceTimersByTime(1000);
    expect(send).toHaveBeenCalledOnce();
  });
});
