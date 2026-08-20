const PASSTHROUGH_IMAGE_URL = /^(?:[a-z][a-z\d+.-]*:|\/\/|#)/i;

/** Maps project-relative image paths to MilkJ's per-editor local-image endpoint. */
export function resolveImageDomUrl(src: string, localImageBaseUrl?: string): string {
  if (!localImageBaseUrl || PASSTHROUGH_IMAGE_URL.test(src)) return src;
  return `${localImageBaseUrl}${encodeURIComponent(src)}`;
}
