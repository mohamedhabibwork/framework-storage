/**
 * Every interface and type alias of `@framework/storage` in one import point.
 * Runtime values (classes, tokens, helpers) stay in their own modules.
 */

/** File visibility. `public` files are reachable through the disk's configured public base URL. */
export type Visibility = 'private' | 'public';

/** Extra options for `put`. */
export interface PutOptions {
  /**
   * Visibility for this write. Local disks keep every file inside their own
   * root, so the override must match the disk's own visibility; anything else
   * throws `STORAGE_VISIBILITY_FORBIDDEN` (a private-disk file can never be
   * "promoted" to public by a call-site flag).
   */
  readonly visibility?: Visibility;
}

/** Extra options for `list`. */
export interface ListOptions {
  /**
   * Maximum number of entries returned. Defaults to 100, capped at 1000.
   * Listing is bounded by design: entries beyond the limit are dropped and
   * there is no pagination — narrow the prefix instead.
   */
  readonly limit?: number;
}

/** Metadata about a stored file (returned alongside content by `get`). */
export interface StoredFileMetadata {
  readonly size: number;
  readonly lastModified: Date;
  /** MIME type derived from the file extension, when derivable. */
  readonly contentType?: string | undefined;
}

/** A stored file: raw content bytes plus its metadata. */
export interface StoredFile extends StoredFileMetadata {
  /** Disk-relative path, exactly as passed in (canonical form, `/` separators). */
  readonly path: string;
  readonly content: Uint8Array;
}

/**
 * What a disk can and cannot do, declared up front so callers can branch
 * without try/catch. Local disks stream but never sign URLs; cloud disks
 * delegate signed access to storagekit.
 */
export interface DiskCapabilities {
  readonly streaming: boolean;
  readonly signedUrls: boolean;
}

/**
 * Storage drivers available through the storagekit engine. `local` ships with
 * the framework; every other driver is constructed through storagekit's
 * `createStorage` switch and needs that driver's peer SDK installed (e.g.
 * `@aws-sdk/client-s3` for `s3`), otherwise creating the disk fails with
 * `STORAGE_DRIVER_UNAVAILABLE`. The `(string & {})` member keeps editor
 * autocomplete for the known names while accepting kit-registered custom
 * drivers.
 */
export type StorageDriverName = 'local' | 's3' | 'r2' | 'minio' | 'azure' | 'gcs' | 'oracle' | 'rustfs' | (string & {});

/** The storage-disk contract (spec §8). Paths are disk-relative and `/`-separated. */
export interface StorageDisk {
  readonly name: string;
  /** The storagekit driver powering this disk (see {@link StorageDriverName}). */
  readonly driver: StorageDriverName;
  /** The disk's own visibility; every file on the disk lives under it. */
  readonly visibility: Visibility;
  readonly capabilities: DiskCapabilities;
  put(path: string, data: string | Uint8Array, options?: PutOptions): Promise<void>;
  /** Reads content bytes plus metadata (size, lastModified, contentType). */
  get(path: string): Promise<StoredFile>;
  /**
   * Streaming read; prefer over `get` for large files. The stream is a web
   * `ReadableStream` that also supports `for await` iteration (the runtimes
   * this framework targets iterate web streams natively).
   */
  stream(path: string): Promise<ReadableStream<Uint8Array> & AsyncIterable<Uint8Array>>;
  /** Removes the file; deleting a missing path is a no-op. */
  delete(path: string): Promise<void>;
  exists(path: string): Promise<boolean>;
  size(path: string): Promise<number>;
  /** Bounded recursive listing under `prefix` (defaults to the disk root). */
  list(prefix?: string, options?: ListOptions): Promise<readonly string[]>;
  move(from: string, to: string): Promise<void>;
  copy(from: string, to: string): Promise<void>;
  /**
   * Public URL for a path. Only public disks answer; private disks throw
   * `STORAGE_VISIBILITY_FORBIDDEN` — a private file never resolves to a URL.
   */
  publicUrl(path: string): string;
  /** Throws `STORAGE_CAPABILITY_UNSUPPORTED` on drivers without signed access (local). */
  signedUrl(path: string, ttlSeconds?: number): Promise<string>;
}

/** Options for `LocalStorageDisk`. */
export interface LocalDiskOptions {
  readonly name: string;
  /** Root directory (absolute, or relative to the process cwd). Created on demand. */
  readonly root: string;
  readonly visibility: Visibility;
  /**
   * Base URL serving this disk's root, e.g. `'/storage'` or
   * `'https://cdn.example.com/files'` (no trailing slash needed). Required for
   * `visibility: 'public'` disks, forbidden to rely on for private disks —
   * a private root is never served through a public URL.
   */
  readonly publicBaseUrl?: string;
}

/** Configuration entry for one disk. */
export interface LocalDiskConfig {
  readonly driver: 'local';
  readonly root: string;
  readonly visibility: Visibility;
  readonly publicBaseUrl?: string;
}

/**
 * Configuration entry for a cloud disk backed by a storagekit driver. Only
 * `driver` and the framework-owned visibility fields are validated here; the
 * `options` bag is forwarded verbatim to storagekit's `createStorage` and is
 * validated by the kit (and its peer SDK) when the disk is created. Missing
 * peer SDKs surface as `STORAGE_DRIVER_UNAVAILABLE`.
 */
export interface RemoteDiskConfig {
  readonly driver: Exclude<StorageDriverName, 'local'>;
  /** Pass-through options for storagekit's `createStorage` (bucket, region, credentials, prefix, ...). */
  readonly options?: Readonly<Record<string, unknown>>;
  /** Defaults to `private`. */
  readonly visibility?: Visibility;
  /** Required for `visibility: 'public'` disks (same rule as local disks). */
  readonly publicBaseUrl?: string;
}

/** Options for `KitDriverDisk`. */
export interface RemoteDiskOptions {
  readonly name: string;
  readonly driver: Exclude<StorageDriverName, 'local'>;
  /** Pass-through options for storagekit's `createStorage`. */
  readonly options?: Readonly<Record<string, unknown>>;
  /** Defaults to `private`. */
  readonly visibility?: Visibility;
  readonly publicBaseUrl?: string;
}

export type StorageDiskConfig = LocalDiskConfig | RemoteDiskConfig;

/** `storage` section of application configuration. */
export interface StorageConfig {
  /** Name of the disk bound to the `STORAGE` token. */
  readonly default: string;
  readonly disks: Readonly<Record<string, StorageDiskConfig>>;
}

/** Input for `assertUploadAllowed` (spec: validate upload sizes/content). */
export interface UploadGuardInput {
  /** Size of the pending upload in bytes (e.g. from a Content-Length or buffered body). */
  readonly size: number;
  /** Hard cap in bytes. */
  readonly maxBytes: number;
  /** Case-insensitive allow-list (e.g. `['png', 'jpg']`). Omit to allow every extension. */
  readonly allowedExtensions?: readonly string[];
  /** Original filename the extension is derived from; required when `allowedExtensions` is set. */
  readonly filename?: string;
}
