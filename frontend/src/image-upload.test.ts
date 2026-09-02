// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest";
import {
  ImageUploadClient,
  createImageUploader,
  encodeImageUploadMessage,
  readFileAsBase64,
} from "./image-upload";

const PNG_BYTES: Uint8Array<ArrayBuffer> = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);

function pngFile(name = "shot.png", bytes: Uint8Array<ArrayBuffer> = PNG_BYTES): File {
  return new File([bytes], name, { type: "image/png" });
}

describe("image upload wire format", () => {
  it("encodes the request with a percent-encoded file name and raw base64", () => {
    expect(encodeImageUploadMessage("r1", "my shot.png", "image/png", "iVBORw0KGgo="))
      .toBe("image:upload:r1:my%20shot.png:image/png:iVBORw0KGgo=");
  });

  it("reads a file as bare base64", async () => {
    await expect(readFileAsBase64(pngFile())).resolves.toBe("iVBORw==");
  });
});

describe("ImageUploadClient", () => {
  const readBase64 = () => Promise.resolve("iVBORw==");

  it("sends the encoded upload and resolves with the IDE's path", async () => {
    const send = vi.fn();
    const client = new ImageUploadClient({ send, nextRequestId: () => "req-1" });

    const upload = client.upload(pngFile("diagram.png"));
    await vi.waitFor(() => expect(send).toHaveBeenCalledOnce());
    expect(send).toHaveBeenCalledWith("image:upload:req-1:diagram.png:image/png:iVBORw==");

    client.complete("req-1", "images/diagram.png");
    await expect(upload).resolves.toBe("images/diagram.png");
  });

  it("resolves null when the IDE refuses, times out, or the reply is unknown", async () => {
    vi.useFakeTimers();
    try {
      const ids = ["a", "b"];
      const client = new ImageUploadClient({
        send: () => undefined,
        timeoutMs: 1_000,
        nextRequestId: () => ids.shift()!,
        readBase64,
      });

      const refused = client.upload(pngFile());
      const timedOut = client.upload(pngFile());
      await Promise.resolve();
      client.complete("a", null);
      client.complete("unknown", "images/x.png");
      await vi.advanceTimersByTimeAsync(1_000);

      await expect(refused).resolves.toBeNull();
      await expect(timedOut).resolves.toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("refuses oversized, empty, and non-image files without contacting the IDE", async () => {
    const send = vi.fn();
    const client = new ImageUploadClient({ send, maxBytes: 3 });

    await expect(client.upload(pngFile("big.png", new Uint8Array(4)))).resolves.toBeNull();
    await expect(client.upload(pngFile("empty.png", new Uint8Array(0)))).resolves.toBeNull();
    await expect(client.upload(new File(["text"], "notes.txt", { type: "text/plain" })))
      .resolves.toBeNull();
    expect(send).not.toHaveBeenCalled();
  });

  it("settles every pending upload on dispose", async () => {
    const client = new ImageUploadClient({ send: () => undefined, readBase64 });
    const upload = client.upload(pngFile());
    await Promise.resolve();
    client.dispose();
    await expect(upload).resolves.toBeNull();
  });
});

describe("createImageUploader", () => {
  const schema = {
    nodes: {
      "image-block": {
        createAndFill: (attrs: { src: string }) => ({ type: "image-block", attrs }),
      },
    },
  } as unknown as Parameters<ReturnType<typeof createImageUploader>>[1];

  function fileList(...files: File[]): FileList {
    return {
      length: files.length,
      item: (index: number) => files[index] ?? null,
    } as unknown as FileList;
  }

  it("inserts a node per stored image and skips refused ones", async () => {
    const uploader = createImageUploader({
      upload: async (file) => (file.name === "ok.png" ? "images/ok.png" : null),
    });

    const nodes = await uploader(
      fileList(pngFile("ok.png"), pngFile("refused.png"), new File(["x"], "a.txt", { type: "text/plain" })),
      schema,
    );

    expect(nodes).toEqual([{ type: "image-block", attrs: { src: "images/ok.png" } }]);
  });

  it("never rejects, so the upload placeholder is always cleaned up", async () => {
    const uploader = createImageUploader({
      upload: () => Promise.reject(new Error("boom")),
    });
    await expect(uploader(fileList(pngFile()), schema)).resolves.toEqual([]);
  });
});
