import { describe, expect, it } from "vitest";
import { resolveImageDomUrl } from "./image-urls";

describe("image DOM URL resolution", () => {
  const base = "http://milkj.localhost/local-image/editor-token/";

  it("routes document-relative and project-root-relative paths through the IDE", () => {
    expect(resolveImageDomUrl("./images/diagram one.png", base))
      .toBe(`${base}.%2Fimages%2Fdiagram%20one.png`);
    expect(resolveImageDomUrl("/docs/diagram.svg", base))
      .toBe(`${base}%2Fdocs%2Fdiagram.svg`);
  });

  it.each([
    "https://example.test/image.png",
    "http://example.test/image.png",
    "data:image/png;base64,AAAA",
    "blob:http://milkj.localhost/id",
    "//cdn.example.test/image.png",
  ])("leaves browser-loadable URL %s unchanged", (src) => {
    expect(resolveImageDomUrl(src, base)).toBe(src);
  });

  it("leaves local paths alone when the IDE did not provide an endpoint", () => {
    expect(resolveImageDomUrl("../image.png")).toBe("../image.png");
  });
});
