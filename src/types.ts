/**
 * Every interface and type alias of `@framework/storage` in one import point.
 * Runtime values (classes, tokens, helpers) stay in their own modules.
 */

/** File visibility. `public` files are reachable through the disk's configured public base URL. */
export type Visibility = 'private' | 'public';

/**
 * Provider-native options bag, forwarded verbatim to the driver's SDK. This is
 * storagekit's escape hatch: anything the framework does not model (S3
 * `StorageClass`, `ServerSideEncryption`, Azure `tier`, GCS `predefinedAcl`, …)
 * travels here and is typed by the kit per driver.
 */
export type NativeOptions = Readonly<Record<string, unknown>>;

/** Byte range for a partial read (`offset` + optional `length`). */
export interface ByteRange {
  readonly offset: number;
  readonly length?: number;
}

/** Multipart/chunked upload tuning (drivers that support it). */
export interface MultipartOptions {
  readonly enabled?: boolean;
  /** Part size in bytes. */
  readonly partSize?: number;
  /** Maximum number of concurrent part transfers. */
  readonly concurrency?: number;
}

/** Extra options for `put` (storagekit's upload options). */
export interface PutOptions {
  /**
   * Visibility for this write. Local disks keep every file inside their own
   * root, so the override must match the disk's own visibility; anything else
   * throws `STORAGE_VISIBILITY_FORBIDDEN` (a private-disk file can never be
   * "promoted" to public by a call-site flag).
   */
  readonly visibility?: Visibility;
  /** MIME type recorded with the object (defaults to the extension's type). */
  readonly contentType?: string;
  /** User metadata stored alongside the object. */
  readonly metadata?: Readonly<Record<string, string>>;
  /** `Cache-Control` header for downloads (CDN behaviour on cloud drivers). */
  readonly cacheControl?: string;
  /** `Content-Disposition` header (e.g. `attachment; filename="report.pdf"`). */
  readonly contentDisposition?: string;
  /** `Content-Encoding` header (e.g. `gzip`). */
  readonly contentEncoding?: string;
  /** `false` fails with `STORAGE_FILE_EXISTS` when the key is already present. */
  readonly overwrite?: boolean;
  /** Multipart upload tuning; ignored by drivers without multipart support. */
  readonly multipart?: MultipartOptions;
  /** Abort the upload. */
  readonly signal?: AbortSignal;
  /** Provider-native upload options (see {@link NativeOptions}). */
  readonly native?: NativeOptions;
}

/** Extra options for `get` and `stream`. */
export interface ReadOptions {
  /** Object version to read (drivers with versioning: S3, GCS). */
  readonly versionId?: string;
  /** Partial read: byte offset and length. */
  readonly range?: ByteRange;
  /** Abort the download. */
  readonly signal?: AbortSignal;
  /** Provider-native download options. */
  readonly native?: NativeOptions;
}

/** Extra options for `delete`. */
export interface DeleteOptions {
  readonly versionId?: string;
  readonly signal?: AbortSignal;
  readonly native?: NativeOptions;
}

/** Extra options for `exists` and `size`. */
export interface StatOptions {
  readonly versionId?: string;
  readonly signal?: AbortSignal;
  readonly native?: NativeOptions;
}

/** Extra options for `list` / `listPage`. */
export interface ListOptions {
  /**
   * Maximum number of entries returned per page. Defaults to 100, capped at
   * 1000 — listing is always bounded.
   */
  readonly limit?: number;
  /** Opaque continuation token from a previous {@link ListPage}. */
  readonly cursor?: string;
  /** Walk every nested prefix instead of one level (default: true for `list`). */
  readonly recursive?: boolean;
  readonly signal?: AbortSignal;
  readonly native?: NativeOptions;
}

/** One page of a bounded listing. */
export interface ListPage {
  /** Disk-relative paths, lexicographically sorted. */
  readonly files: readonly string[];
  /** Pass back as `options.cursor` to continue; absent when exhausted. */
  readonly cursor?: string;
  readonly hasMore: boolean;
}

/** Extra options for `copy`. */
export interface CopyOptions {
  /** `false` fails when the destination exists (default: overwrite). */
  readonly overwrite?: boolean;
  readonly contentType?: string;
  readonly metadata?: Readonly<Record<string, string>>;
  readonly cacheControl?: string;
  readonly contentDisposition?: string;
  readonly contentEncoding?: string;
  readonly signal?: AbortSignal;
  readonly native?: NativeOptions;
}

/** Extra options for `move`. */
export interface MoveOptions {
  readonly overwrite?: boolean;
  readonly contentType?: string;
  readonly metadata?: Readonly<Record<string, string>>;
  readonly signal?: AbortSignal;
  readonly native?: NativeOptions;
}

/** What a signed URL may be used for (S3 presigner verbs). */
export type SignedUrlAction = 'read' | 'write' | 'delete';

/** Extra options for `signedUrl`. */
export interface SignedUrlOptions {
  /** Defaults to `read`. */
  readonly action?: SignedUrlAction;
  /** Seconds until expiry (default 3600, capped at 7 days by the kit). */
  readonly expiresIn?: number;
  readonly signal?: AbortSignal;
  readonly native?: NativeOptions;
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
  get(path: string, options?: ReadOptions): Promise<StoredFile>;
  /**
   * Streaming read; prefer over `get` for large files. The stream is a web
   * `ReadableStream` that also supports `for await` iteration (the runtimes
   * this framework targets iterate web streams natively).
   */
  stream(path: string, options?: ReadOptions): Promise<ReadableStream<Uint8Array> & AsyncIterable<Uint8Array>>;
  /** Removes the file; deleting a missing path is a no-op. */
  delete(path: string, options?: DeleteOptions): Promise<void>;
  exists(path: string, options?: StatOptions): Promise<boolean>;
  size(path: string, options?: StatOptions): Promise<number>;
  /** Bounded recursive listing under `prefix` (defaults to the disk root). */
  list(prefix?: string, options?: ListOptions): Promise<readonly string[]>;
  /** One page of a bounded listing, with a continuation cursor. */
  listPage(prefix?: string, options?: ListOptions): Promise<ListPage>;
  move(from: string, to: string, options?: MoveOptions): Promise<void>;
  copy(from: string, to: string, options?: CopyOptions): Promise<void>;
  /**
   * Public URL for a path. Only public disks answer; private disks throw
   * `STORAGE_VISIBILITY_FORBIDDEN` — a private file never resolves to a URL.
   */
  publicUrl(path: string): string;
  /**
   * Signed URL for read/write/delete access. Accepts a bare TTL in seconds for
   * backwards compatibility, or the full {@link SignedUrlOptions}.
   * Throws `STORAGE_CAPABILITY_UNSUPPORTED` on drivers without signed access.
   */
  signedUrl(path: string, options?: SignedUrlOptions | number): Promise<string>;
  /**
   * The underlying storagekit client for this driver (S3Client, BlobServiceClient,
   * …). `unknown` by design: the concrete type depends on the configured driver.
   */
  native(): unknown;
  /** Escape hatch for SDK operations the framework does not wrap. */
  nativeRequest<T>(fn: (client: unknown) => Promise<T>): Promise<T>;
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
  /** Extra storagekit local-driver options (`permissions`, `createDirectories`, …). */
  readonly options?: Readonly<Record<string, unknown>>;
}

/** Configuration entry for one disk. */
export interface LocalDiskConfig {
  readonly driver: 'local';
  readonly root: string;
  readonly visibility: Visibility;
  readonly publicBaseUrl?: string;
  /**
   * Extra storagekit local-driver options (`baseUrl`, `prefix`, `permissions`,
   * `createDirectories`, `followSymlinks`, …). `root` is owned by the framework
   * and cannot be overridden here.
   */
  readonly options?: Readonly<Record<string, unknown>>;
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
