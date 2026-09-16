// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import { cssFontFamily, fontOverrideCss, installFontOverrides } from "./fonts";

describe("font family values", () => {
  it("quotes names and escapes quotes and backslashes", () => {
    expect(cssFontFamily("Fira Sans")).toBe('"Fira Sans"');
    expect(cssFontFamily(' Foo "Bar" \\ Baz ')).toBe('"Foo \\"Bar\\" \\\\ Baz"');
  });

  it("strips control characters and rejects blank or overlong names", () => {
    expect(cssFontFamily("Fira\nSans\u0007")).toBe('"FiraSans"');
    expect(cssFontFamily("")).toBeUndefined();
    expect(cssFontFamily("   ")).toBeUndefined();
    expect(cssFontFamily(undefined)).toBeUndefined();
    expect(cssFontFamily("x".repeat(201))).toBeUndefined();
  });
});

describe("font override CSS", () => {
  it("is empty when every family is blank", () => {
    expect(fontOverrideCss({})).toBe("");
    expect(fontOverrideCss({ text: "", heading: " ", code: undefined })).toBe("");
  });

  it("only overrides the properties that were set, with generic fallbacks", () => {
    const css = fontOverrideCss({ text: "Fira Sans", code: "JetBrains Mono" });

    expect(css).toContain(':root[data-theme][data-editor-theme] body .milkdown {');
    expect(css).toContain('--crepe-font-default: "Fira Sans", system-ui, sans-serif;');
    expect(css).toContain('--crepe-font-code: "JetBrains Mono", ui-monospace, monospace;');
    expect(css).not.toContain("--crepe-font-title");
  });

  it("maps the heading family to Crepe's title font", () => {
    expect(fontOverrideCss({ heading: "Rubik" })).toContain(
      '--crepe-font-title: "Rubik", system-ui, sans-serif;',
    );
  });
});

describe("installed font overrides", () => {
  it("writes into one style element and clears it when the fonts go back to default", () => {
    const overrides = installFontOverrides();
    const style = document.head.querySelector<HTMLStyleElement>("style.milkj-fonts")!;
    expect(style).not.toBeNull();

    overrides.apply({ text: "Fira Sans" });
    expect(style.textContent).toContain('"Fira Sans"');

    overrides.apply({});
    expect(style.textContent).toBe("");
    expect(document.head.querySelectorAll("style.milkj-fonts")).toHaveLength(1);
  });
});
