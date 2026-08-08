// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { findBareProjectFileLinks, installProjectLinks } from "./project-links";

describe("project file links", () => {
  afterEach(() => {
    document.body.replaceChildren();
  });

  it.each([
    ["Ctrl", { ctrlKey: true }],
    ["Cmd", { metaKey: true }],
  ])("sends a raw relative href for %s-click", (_name, modifier) => {
    document.body.innerHTML = '<a href="src/My%20File.kt#L12"><strong>open</strong></a>';
    const navigate = vi.fn();
    const dispose = installProjectLinks({ navigate });

    const event = click(document.querySelector("strong")!, modifier);

    expect(navigate).toHaveBeenCalledOnce();
    expect(navigate).toHaveBeenCalledWith("src/My%20File.kt#L12");
    expect(event.defaultPrevented).toBe(true);
    dispose();
  });

  it("does nothing for plain, non-primary, and outside clicks", () => {
    document.body.innerHTML = '<a href="src/Foo.kt">open</a><span>outside</span>';
    const navigate = vi.fn();
    const dispose = installProjectLinks({ navigate });
    const anchor = document.querySelector("a")!;
    // Keep jsdom from attempting its unimplemented page navigation after these intentionally
    // unhandled clicks; this listener is unrelated to the project-link handler under test.
    anchor.addEventListener("click", (event) => event.preventDefault());

    click(anchor);
    click(anchor, { ctrlKey: true, button: 1 });
    click(anchor, { metaKey: true, button: 2 });
    click(document.querySelector("span")!, { ctrlKey: true });

    expect(navigate).not.toHaveBeenCalled();
    dispose();
  });

  it.each([
    "http://example.com/file.kt",
    "https://example.com/file.kt",
    "mailto:test@example.com",
    "javascript:alert(1)",
    "data:text/plain,test",
    "#installation",
    "//example.com/file.kt",
    "raw\\path.kt",
    "C:/source/Foo.kt",
  ])("suppresses but does not send non-candidate %s", (href) => {
    const anchor = document.createElement("a");
    anchor.setAttribute("href", href);
    anchor.textContent = "open";
    document.body.append(anchor);
    const navigate = vi.fn();
    const bubbled = vi.fn();
    document.body.addEventListener("click", bubbled);
    const dispose = installProjectLinks({ navigate });

    const event = click(anchor, { ctrlKey: true });

    expect(event.defaultPrevented).toBe(true);
    expect(bubbled).not.toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();
    dispose();
  });

  it.each(["/src/Foo.kt#L2", "file:///project/src/Foo.kt#L2", "#L2"])(
    "sends supported candidate %s",
    (href) => {
      const anchor = document.createElement("a");
      anchor.setAttribute("href", href);
      document.body.append(anchor);
      const navigate = vi.fn();
      const dispose = installProjectLinks({ navigate });

      const event = click(anchor, { metaKey: true });

      expect(event.defaultPrevented).toBe(true);
      expect(navigate).toHaveBeenCalledWith(href);
      dispose();
    },
  );

  it("survives DOM replacement and disposal removes the listener", () => {
    const navigate = vi.fn();
    const dispose = installProjectLinks({ navigate });
    document.body.innerHTML = '<div class="milkdown"><a href="first.kt">first</a></div>';
    click(document.querySelector("a")!, { ctrlKey: true });
    document.body.innerHTML = '<div class="milkdown"><a href="second.kt">second</a></div>';
    click(document.querySelector("a")!, { ctrlKey: true });

    dispose();
    const anchorAfterDispose = document.querySelector("a")!;
    anchorAfterDispose.addEventListener("click", (event) => event.preventDefault());
    click(anchorAfterDispose, { ctrlKey: true });

    expect(navigate.mock.calls).toEqual([["first.kt"], ["second.kt"]]);
  });

  it("finds LLM-style bare project paths without changing their text", () => {
    const text = "Open src/main/Foo.kt#L2, /src/project/file and ../README.md. Also #L20.";

    expect(findBareProjectFileLinks(text).map(({ href }) => href)).toEqual([
      "src/main/Foo.kt#L2",
      "/src/project/file",
      "../README.md",
      "#L20",
    ]);
  });

  it("finds file URLs and strips ordinary sentence punctuation", () => {
    const text = "See file:///project/src/My%20File.kt#L2.";
    expect(findBareProjectFileLinks(text)).toEqual([{
      from: 4,
      to: text.length - 1,
      href: "file:///project/src/My%20File.kt#L2",
    }]);
  });

  it.each([
    "Use and/or when appropriate",
    "Visit https://example.com/src/File.kt",
    "Send mailto:user@example.com/a/b",
    "Open //example.com/src/File.kt",
    "Avoid raw\\src/File.kt",
    "Avoid C:/src/File.kt",
    "Reject src/File.kt?query=true",
    "Reject src/File.kt#installation",
    "Reject src/File.kt#L0",
  ])("does not decorate unrelated or unsafe bare text: %s", (text) => {
    expect(findBareProjectFileLinks(text)).toEqual([]);
  });

  it("navigates a decorated bare path on modifier-click", () => {
    document.body.innerHTML =
      '<p>Open <code><span data-milkj-project-href="../src/Foo.kt#L4">../src/Foo.kt#L4</span></code></p>';
    const navigate = vi.fn();
    const dispose = installProjectLinks({ navigate });

    const event = click(document.querySelector("span")!, { ctrlKey: true });

    expect(event.defaultPrevented).toBe(true);
    expect(navigate).toHaveBeenCalledWith("../src/Foo.kt#L4");
    dispose();
  });
});

function click(
  target: Element,
  options: Pick<MouseEventInit, "ctrlKey" | "metaKey" | "button"> = {},
): MouseEvent {
  const event = new MouseEvent("click", {
    bubbles: true,
    cancelable: true,
    button: 0,
    ...options,
  });
  target.dispatchEvent(event);
  return event;
}
