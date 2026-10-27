/**
 * BundleExtractor port — decodes zip bytes into a path→bytes map.
 * Concrete adapters live in `infra`. Tests inject a dict-backed fake.
 * @module ports/bundle-extractor
 */

/**
 * The raw bytes of one extracted file, optionally carrying the Unix
 * permission bits (`rwxrwxrwx`) its source recorded (issue #577).
 *
 * `mode` absent means unknown: the installed file keeps the default mode.
 * The mode lives on the bytes object itself, so map copies keep it, but a
 * byte copy (`Buffer.from`, `slice`) drops it.
 */
export type ExtractedFile = Uint8Array & { readonly mode?: number };

/**
 * Extracted bundle files: relative path → raw bytes (plus optional mode).
 * A plain `Map<string, Uint8Array>` is still a valid value.
 */
export type ExtractedFiles = ReadonlyMap<string, ExtractedFile>;

/**
 * Decodes bundle (zip) bytes into a file map.
 */
export interface BundleExtractor {
  /**
   * Extract the bundle zip into a path → bytes map. Adapters may attach
   * each file's recorded mode with `withFileMode`.
   * @param bytes Raw bundle bytes from the downloader.
   * @returns Map of relative paths to file contents.
   */
  extract(bytes: Uint8Array): Promise<ExtractedFiles>;
}
