// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import fixtures from "../../protocol/fixtures.json";
import { type IdeMessage, type PageMessage, sendToIde } from "./protocol";

/** One message per type, keyed by it: a new type does not compile until it has a fixture. */
type FixtureSet<M extends { type: string }> = { [K in M["type"]]: Extract<M, { type: K }> };

// Typed copies of protocol/fixtures.json. The compiler checks them against protocol.ts; the tests
// below check they are exactly the contract the Kotlin side (BridgeProtocolTest) is held to.
const page: FixtureSet<PageMessage> = {
  ready: { type: "ready" },
  markdown: {
    type: "markdown",
    revision: 7,
    markdown: "# Title\r\n\r\nQuote \" backslash \\ tab \t and Ångström 🎉\n",
  },
  roundtripError: {
    type: "roundtripError",
    reason: "The merged Markdown was not equivalent to the rich-text document.",
  },
  dictionaryAdd: { type: "dictionaryAdd", word: "C++" },
  navigateFile: { type: "navigateFile", href: "src/main/kotlin/Foo.kt#L2-L5" },
  navigateUrl: { type: "navigateUrl", href: "https://example.com/docs?q=a+b#top" },
  imageUpload: {
    type: "imageUpload",
    requestId: "req-1",
    fileName: "my shot.png",
    mimeType: "image/png",
    base64: "iVBORw==",
  },
  viewState: { type: "viewState", anchor: 42, scrollTop: 1200 },
  zoom: { type: "zoom", command: "in" },
};

const ide: FixtureSet<IdeMessage> = {
  setMarkdown: {
    type: "setMarkdown",
    markdown: "# Title\r\n\r\nQuote \" backslash \\ and </script> 🎉\n",
    revision: 8,
  },
  applyConfig: {
    type: "applyConfig",
    config: {
      theme: "dark",
      configuredTheme: "FOLLOW_IDE",
      editorTheme: "FRAME",
      mermaidTheme: "FOREST",
      defaultEditor: "MILKJ",
      placeholder: "Say \"hi\"\nthen \\ write",
      textFontFamily: "Fira Sans",
      headingFontFamily: "",
      codeFontFamily: "JetBrains Mono",
      proofingEnabled: true,
      proofingDialect: "AMERICAN",
      customDictionary: ["C++", "Ångström"],
      weirpacks: ["YWJj"],
      readonly: false,
      localImageBaseUrl: "http://milkj.localhost/local-image/token/",
    },
  },
  setViewState: { type: "setViewState", anchor: 42, scrollTop: 1200 },
  imageUploaded: { type: "imageUploaded", requestId: "req-1", path: "images/my-shot.png" },
};

describe("bridge protocol contract", () => {
  it("defines exactly the page messages in protocol/fixtures.json", () => {
    expect(page).toStrictEqual(fixtures.page);
  });

  it("defines exactly the IDE messages in protocol/fixtures.json", () => {
    expect(ide).toStrictEqual(fixtures.ide);
  });
});

describe("sendToIde", () => {
  afterEach(() => {
    delete window.milkjSendToIde;
  });

  it("serializes one message per call", () => {
    const send = vi.fn();
    window.milkjSendToIde = send;

    sendToIde(page.markdown);

    expect(send).toHaveBeenCalledOnce();
    expect(JSON.parse(send.mock.calls[0][0])).toStrictEqual(fixtures.page.markdown);
  });

  it("drops messages until the IDE has installed the bridge", () => {
    expect(() => sendToIde(page.ready)).not.toThrow();
  });
});
