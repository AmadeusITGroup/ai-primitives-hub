/**
 * BundleDownloader port — fetches bundle bytes from a URL and returns
 * them with a SHA-256 digest. Concrete adapters live in `infra`.
 * @module ports/bundle-downloader
 */
import type {
  Installable,
} from '../domain/install/installable';

/**
 * Result of a bundle download operation.
 */
export interface DownloadResult {
  /** Raw bundle bytes (zip). */
  bytes: Uint8Array;
  /** SHA-256 hex digest of the bytes. */
  sha256: string;
}

/**
 * Downloads bundle bytes and returns them with an integrity digest.
 */
export interface BundleDownloader {
  /**
   * Download the bundle referenced by `installable`.
   * @param installable Resolved Installable from the resolver.
   * @returns DownloadResult with bytes and SHA-256.
   * @throws {Error} On network failure or integrity mismatch.
   */
  download(installable: Installable): Promise<DownloadResult>;
}
