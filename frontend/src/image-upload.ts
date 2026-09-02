import type { Node as ProseMirrorNode, Schema } from "@milkdown/kit/prose/model";

/**
 * Pasted and dropped images travel to the IDE, which writes them next to the Markdown file and
 * answers with the path the Markdown should reference. Without this, Crepe falls back to
 * `URL.createObjectURL`, and the Markdown ends up holding a `blob:` URL that dies on reload.
 *
 * Wire format (page -> IDE): `image:upload:<request id>:<urlencoded file name>:<mime>:<base64>`.
 * Reply (IDE -> page): `window.milkjImageUploaded(requestId, relativePathOrNull)`.
 */
export const IMAGE_UPLOAD_PREFIX = "image:upload:";
export const MAX_IMAGE_UPLOAD_BYTES = 10 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 30_000;

export interface ImageUploadClientOptions {
  send(message: string): void;
  maxBytes?: number;
  timeoutMs?: number;
  nextRequestId?: () => string;
  readBase64?: (file: Blob) => Promise<string>;
}

interface PendingUpload {
  resolve(path: string | null): void;
  timer: ReturnType<typeof setTimeout>;
}

export function encodeImageUploadMessage(
  requestId: string,
  fileName: string,
  mimeType: string,
  base64: string,
): string {
  return `${IMAGE_UPLOAD_PREFIX}${requestId}:${encodeURIComponent(fileName)}:${mimeType}:${base64}`;
}

/** Reads a file as base64 without the `data:` URL prefix. */
export function readFileAsBase64(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error("Unable to read the image"));
    reader.onload = () => {
      const result = typeof reader.result === "string" ? reader.result : "";
      const separator = result.indexOf(",");
      resolve(separator >= 0 ? result.substring(separator + 1) : "");
    };
    reader.readAsDataURL(file);
  });
}

/** Correlates outbound upload requests with the IDE's asynchronous replies. */
export class ImageUploadClient {
  private readonly pending = new Map<string, PendingUpload>();
  private readonly send: (message: string) => void;
  private readonly maxBytes: number;
  private readonly timeoutMs: number;
  private readonly nextRequestId: () => string;
  private readonly readBase64: (file: Blob) => Promise<string>;
  private sequence = 0;

  constructor(options: ImageUploadClientOptions) {
    this.send = options.send;
    this.maxBytes = options.maxBytes ?? MAX_IMAGE_UPLOAD_BYTES;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.nextRequestId = options.nextRequestId ?? (() => `${Date.now().toString(36)}-${++this.sequence}`);
    this.readBase64 = options.readBase64 ?? readFileAsBase64;
  }

  /** Resolves to the Markdown path for the stored image, or null when the IDE refused it. */
  async upload(file: File): Promise<string | null> {
    if (!file.type.startsWith("image/") || file.size === 0 || file.size > this.maxBytes) {
      return null;
    }
    const base64 = await this.readBase64(file);
    if (!base64) {
      return null;
    }
    const requestId = this.nextRequestId();
    return new Promise<string | null>((resolve) => {
      const timer = setTimeout(() => this.complete(requestId, null), this.timeoutMs);
      this.pending.set(requestId, { resolve, timer });
      this.send(encodeImageUploadMessage(requestId, file.name || "image", file.type, base64));
    });
  }

  /** Called by the IDE (via `window.milkjImageUploaded`) once the file is written or refused. */
  complete(requestId: string, path: string | null | undefined): void {
    const entry = this.pending.get(requestId);
    if (!entry) return;
    this.pending.delete(requestId);
    clearTimeout(entry.timer);
    entry.resolve(typeof path === "string" && path.length > 0 ? path : null);
  }

  dispose(): void {
    for (const [requestId] of this.pending) {
      this.complete(requestId, null);
    }
  }
}

type SchemaLike = Pick<Schema, "nodes">;

/**
 * Replacement for Crepe's built-in `uploadConfig.uploader`: images the IDE refused are dropped
 * rather than inserted with an empty or `blob:` source. (Rejecting would strand the upload
 * plugin's placeholder widget in the document, so this never throws.)
 */
export function createImageUploader(
  client: Pick<ImageUploadClient, "upload">,
): (files: FileList, schema: SchemaLike) => Promise<ProseMirrorNode[]> {
  return async (files, schema) => {
    const nodeType = schema.nodes["image-block"] ?? schema.nodes["image"];
    if (!nodeType) return [];
    const images: File[] = [];
    for (let index = 0; index < files.length; index++) {
      const file = files.item(index);
      if (file && file.type.startsWith("image/")) images.push(file);
    }
    const sources = await Promise.all(images.map((file) => client.upload(file).catch(() => null)));
    const nodes: ProseMirrorNode[] = [];
    for (const src of sources) {
      const node = src ? nodeType.createAndFill({ src }) : null;
      if (node) nodes.push(node);
    }
    return nodes;
  };
}
