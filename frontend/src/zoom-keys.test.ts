// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest";
import { installZoomShortcuts, zoomCommandForKey } from "./zoom-keys";

function key(init: KeyboardEventInit): KeyboardEvent {
  return new KeyboardEvent("keydown", { cancelable: true, bubbles: true, ...init });
}

describe("zoomCommandForKey", () => {
  it.each([
    ["Ctrl+=", { ctrlKey: true, key: "=" }, "in"],
    ["Cmd+=", { metaKey: true, key: "=" }, "in"],
    ["Cmd+Shift+= (as +)", { metaKey: true, shiftKey: true, key: "+" }, "in"],
    ["Ctrl+-", { ctrlKey: true, key: "-" }, "out"],
    ["Ctrl+0", { ctrlKey: true, key: "0" }, "reset"],
    ["Ctrl+NumpadAdd", { ctrlKey: true, key: "Unidentified", code: "NumpadAdd" }, "in"],
    ["Ctrl+NumpadSubtract", { ctrlKey: true, key: "Unidentified", code: "NumpadSubtract" }, "out"],
    ["Ctrl+Numpad0", { ctrlKey: true, key: "Unidentified", code: "Numpad0" }, "reset"],
  ])("maps %s", (_name, init, expected) => {
    expect(zoomCommandForKey(key(init))).toBe(expected);
  });

  it.each([
    ["plain =", { key: "=" }],
    ["plain 0", { key: "0" }],
    ["Alt+Ctrl+=", { ctrlKey: true, altKey: true, key: "=" }],
    ["Ctrl+Shift+-", { ctrlKey: true, shiftKey: true, key: "_" }],
    ["Ctrl+Shift+0", { ctrlKey: true, shiftKey: true, key: "0" }],
    ["Ctrl+F", { ctrlKey: true, key: "f" }],
  ])("ignores %s", (_name, init) => {
    expect(zoomCommandForKey(key(init))).toBeUndefined();
  });
});

describe("installZoomShortcuts", () => {
  it("sends the command and swallows the key until disposed", () => {
    const send = vi.fn();
    const dispose = installZoomShortcuts({ send });

    const zoomIn = key({ ctrlKey: true, key: "=" });
    window.dispatchEvent(zoomIn);
    expect(send).toHaveBeenCalledWith("zoom:in");
    expect(zoomIn.defaultPrevented).toBe(true);

    const other = key({ ctrlKey: true, key: "b" });
    window.dispatchEvent(other);
    expect(other.defaultPrevented).toBe(false);
    expect(send).toHaveBeenCalledOnce();

    dispose();
    window.dispatchEvent(key({ ctrlKey: true, key: "0" }));
    expect(send).toHaveBeenCalledOnce();
  });

  it("leaves a key alone that another handler already claimed", () => {
    const send = vi.fn();
    const dispose = installZoomShortcuts({ send });
    const claimed = key({ metaKey: true, key: "-" });
    claimed.preventDefault();

    window.dispatchEvent(claimed);

    expect(send).not.toHaveBeenCalled();
    dispose();
  });
});
