import { Readable } from 'node:stream';
import { ConfigError } from '@framework/core';
import { StorageError } from './errors';
import { createKitStorage, type KitFileStat, type KitStorage, mapKitError, rethrowMapped } from './kit';
import { validateStoragePath } from './path-guard';
import type {
  CopyOptions,
  DeleteOptions,
  DiskCapabilities,
  ListOptions,
  ListPage,
  MoveOptions,
  PutOptions,
  ReadOptions,
  RemoteDiskOptions,
  SignedUrlOptions,
  StatOptions,
  StorageDisk,
  StorageDriverName,
  StoredFile,
  Visibility,
} from './types';

/** Default `list` bound (spec: listings must be bounded and explicit). */
export const DEFAULT_LIST_LIMIT = 100;
/** Hard ceiling for `list` limits, so a caller cannot ask for "everything". */
export const MAX_LIST_LIMIT = 1000;

/** Shared constructor options for every storagekit-backed disk. */
export interface KitDiskOptions {
  readonly name: string;
  readonly visibility: Visibility;
  readonly publicBaseUrl?: string;
}

/**
 * Base class for disks whose file operations are delegated to the storagekit
 * engine. The framework's own path guard (`path-guard.ts`) still runs in
 * front of every kit call — defense in depth, so hostile paths are rejected
 * by the framework before the engine ever sees them — and kit errors are
 * mapped back onto the framework's error catalog (`kit.ts`).
 */
export abstract class KitBackedDisk implements StorageDisk {
  abstract readonly driver: StorageDriverName;
  abstract readonly capabilities: DiskCapabilities;
  readonly name: string;
  readonly visibility: Visibility;
  readonly #publicBaseUrl: string | undefined;
  #kit: Promise<KitStorage> | undefined;

  protected constructor(options: KitDiskOptions) {
    this.name = options.name;
    this.visibility = options.visibility;
    if (this.visibility === 'public') {
      const publicBaseUrl = options.publicBaseUrl;
      if (typeof publicBaseUrl !== 'string' || publicBaseUrl.trim().length === 0) {
        throw new ConfigError([`Disk "${this.name}" is public but declares no publicBaseUrl`]);
      }
      this.#publicBaseUrl = publicBaseUrl.replace(/\/+$/, '');
    }
  }

  /** Base URL serving this disk's root, without trailing slashes (public disks only). */
  protected get publicBaseUrl(): string | undefined {
    return this.#publicBaseUrl;
  }

  /**
   * Resolves the storagekit instance lazily; a failed creation is retried on
   * the next call (e.g. after installing a missing peer SDK in dev).
   */
  protected kit(): Promise<KitStorage> {
    this.#kit ??= createKitStorage(this.driver, this.kitOptions()).catch((error: unknown) => {
      this.#kit = undefined;
      throw mapKitError(error);
    });
    return this.#kit;
  }

  /** storagekit config for this disk (everything except the `type` field). */
  protected abstract kitOptions(): Record<string, unknown>;

  /**
   * The framework path guard. Every incoming path passes through here before
   * storagekit is involved; disks with a filesystem root (local) override it
   * to add the root-escape check.
   */
  protected guard(path: string): string {
    return validateStoragePath(path);
  }

  /** Extra `native` stat options; the local driver follows symlinks like `fs.stat` did. */
  protected statNativeOptions(): Record<string, unknown> {
    return {};
  }

  /** Creates the storagekit instance eagerly; the provider calls this at boot to fail fast. */
  async ready(): Promise<void> {
    await this.kit();
  }

  async put(path: string, data: string | Uint8Array, options: PutOptions = {}): Promise<void> {
    if (options.visibility !== undefined && options.visibility !== this.visibility) {
      throw new StorageError(
        'STORAGE_VISIBILITY_FORBIDDEN',
        `Disk "${this.name}" only stores ${this.visibility} files; a ${options.visibility} write would blur the private/public split`,
      );
    }
    const key = this.guard(path);
    const kit = await this.kit();
    await kit
      .upload(key, data, {
        ...(options.contentType !== undefined ? { contentType: options.contentType } : {}),
        ...(options.metadata !== undefined ? { metadata: { ...options.metadata } } : {}),
        ...(options.cacheControl !== undefined ? { cacheControl: options.cacheControl } : {}),
        ...(options.contentDisposition !== undefined ? { contentDisposition: options.contentDisposition } : {}),
        ...(options.contentEncoding !== undefined ? { contentEncoding: options.contentEncoding } : {}),
        ...(options.overwrite !== undefined ? { overwrite: options.overwrite } : {}),
        ...(options.multipart !== undefined ? { multipart: { ...options.multipart } } : {}),
        ...(options.signal !== undefined ? { signal: options.signal } : {}),
        ...(options.native !== undefined ? { native: options.native } : {}),
      })
      .catch(rethrowMapped);
  }

  async get(path: string, options: ReadOptions = {}): Promise<StoredFile> {
    const key = this.guard(path);
    const metadata = await this.#requireStat(key, options);
    const kit = await this.kit();
    const downloaded = await kit.download(key, this.downloadOptions(options)).catch(rethrowMapped);
    const content = await downloaded.buffer().catch(rethrowMapped);
    return {
      path: validateStoragePath(path),
      content,
      size: metadata.size,
      lastModified: metadata.lastModified ?? new Date(0),
      contentType: metadata.contentType,
    };
  }

  async stream(
    path: string,
    options: ReadOptions = {},
  ): Promise<ReadableStream<Uint8Array> & AsyncIterable<Uint8Array>> {
    const key = this.guard(path);
    await this.#requireStat(key, options);
    const kit = await this.kit();
    const downloaded = await kit.download(key, this.downloadOptions(options)).catch(rethrowMapped);
    // storagekit hands back a Node readable; `toWeb` returns a stream that is
    // both a web ReadableStream and `for await`-able at runtime.
    return Readable.toWeb(downloaded.stream) as unknown as ReadableStream<Uint8Array> & AsyncIterable<Uint8Array>;
  }

  async delete(path: string, options: DeleteOptions = {}): Promise<void> {
    const key = this.guard(path);
    const kit = await this.kit();
    await kit
      .delete(key, {
        ...(options.versionId !== undefined ? { versionId: options.versionId } : {}),
        ...(options.signal !== undefined ? { signal: options.signal } : {}),
        ...(options.native !== undefined ? { native: options.native } : {}),
      })
      .catch(rethrowMapped);
  }

  async exists(path: string, options: StatOptions = {}): Promise<boolean> {
    const key = this.guard(path);
    try {
      await this.#requireStat(key, options);
      return true;
    } catch (error) {
      if (error instanceof StorageError && error.code === 'STORAGE_FILE_NOT_FOUND') return false;
      throw error;
    }
  }

  async size(path: string, options: StatOptions = {}): Promise<number> {
    const key = this.guard(path);
    return (await this.#requireStat(key, options)).size;
  }

  async list(prefix = '', options: ListOptions = {}): Promise<readonly string[]> {
    const limit = this.#listLimit(options.limit);
    const normalizedPrefix = this.#listPrefix(prefix);
    const kit = await this.kit();
    const matches: string[] = [];
    try {
      // storagekit walks recursively and yields files only; stop at the bound
      // and restore the contract's lexicographic order.
      for await (const entry of kit.iterate(normalizedPrefix, {
        ...(options.signal !== undefined ? { signal: options.signal } : {}),
        ...(options.native !== undefined ? { native: options.native } : {}),
      })) {
        matches.push(entry.path);
        if (matches.length >= limit) break;
      }
    } catch (error) {
      throw mapKitError(error);
    }
    return matches.sort();
  }

  /**
   * One bounded page plus the kit's continuation cursor. Unlike `list`, which
   * walks until it has `limit` entries, this maps straight onto the driver's
   * pagination — use it for large prefixes where cursor paging beats
   * "narrow the prefix".
   */
  async listPage(prefix = '', options: ListOptions = {}): Promise<ListPage> {
    const limit = this.#listLimit(options.limit);
    const normalizedPrefix = this.#listPrefix(prefix);
    const kit = await this.kit();
    const page = await kit
      .list({
        prefix: normalizedPrefix,
        limit,
        recursive: options.recursive ?? true,
        ...(options.cursor !== undefined ? { cursor: options.cursor } : {}),
        ...(options.signal !== undefined ? { signal: options.signal } : {}),
        ...(options.native !== undefined ? { native: options.native } : {}),
      })
      .catch(rethrowMapped);
    return {
      files: page.files.map((file) => file.path).sort(),
      hasMore: page.hasMore,
      ...(page.cursor !== undefined ? { cursor: page.cursor } : {}),
    };
  }

  async move(from: string, to: string, options: MoveOptions = {}): Promise<void> {
    const fromKey = this.guard(from);
    const toKey = this.guard(to);
    await this.#requireStat(fromKey);
    const kit = await this.kit();
    await kit
      .move(fromKey, toKey, {
        ...(options.overwrite !== undefined ? { overwrite: options.overwrite } : {}),
        ...(options.contentType !== undefined ? { contentType: options.contentType } : {}),
        ...(options.metadata !== undefined ? { metadata: { ...options.metadata } } : {}),
        ...(options.signal !== undefined ? { signal: options.signal } : {}),
        ...(options.native !== undefined ? { native: options.native } : {}),
      })
      .catch(rethrowMapped);
  }

  async copy(from: string, to: string, options: CopyOptions = {}): Promise<void> {
    const fromKey = this.guard(from);
    const toKey = this.guard(to);
    await this.#requireStat(fromKey);
    const kit = await this.kit();
    await kit
      .copy(fromKey, toKey, {
        ...(options.overwrite !== undefined ? { overwrite: options.overwrite } : {}),
        ...(options.contentType !== undefined ? { contentType: options.contentType } : {}),
        ...(options.metadata !== undefined ? { metadata: { ...options.metadata } } : {}),
        ...(options.cacheControl !== undefined ? { cacheControl: options.cacheControl } : {}),
        ...(options.contentDisposition !== undefined ? { contentDisposition: options.contentDisposition } : {}),
        ...(options.contentEncoding !== undefined ? { contentEncoding: options.contentEncoding } : {}),
        ...(options.signal !== undefined ? { signal: options.signal } : {}),
        ...(options.native !== undefined ? { native: options.native } : {}),
      })
      .catch(rethrowMapped);
  }

  publicUrl(path: string): string {
    if (this.visibility !== 'public' || this.#publicBaseUrl === undefined) {
      throw new StorageError(
        'STORAGE_VISIBILITY_FORBIDDEN',
        `Disk "${this.name}" is private; its root must never be exposed through a public URL`,
      );
    }
    return `${this.#publicBaseUrl}/${this.guard(path)}`;
  }

  async signedUrl(path: string, options: SignedUrlOptions | number = {}): Promise<string> {
    if (!this.capabilities.signedUrls) {
      throw new StorageError(
        'STORAGE_CAPABILITY_UNSUPPORTED',
        `Disk "${this.name}" (driver ${this.driver}) does not support signed URLs`,
      );
    }
    const normalized: SignedUrlOptions = typeof options === 'number' ? { expiresIn: options } : options;
    const key = this.guard(path);
    const kit = await this.kit();
    return kit
      .getSignedUrl(key, {
        ...(normalized.action !== undefined ? { action: normalized.action } : {}),
        ...(normalized.expiresIn !== undefined ? { expiresIn: normalized.expiresIn } : {}),
        ...(normalized.signal !== undefined ? { signal: normalized.signal } : {}),
        ...(normalized.native !== undefined ? { native: normalized.native } : {}),
      })
      .catch(rethrowMapped);
  }

  /**
   * The driver's native SDK client. Only valid for kit-backed drivers; the
   * framework's own guard rails (path validation, error mapping) do not apply
   * to operations issued directly on it.
   */
  async native(): Promise<unknown> {
    return (await this.kit()).native();
  }

  /** Runs `fn` against the native client, mapping kit errors like every other call. */
  async nativeRequest<T>(fn: (client: unknown) => Promise<T>): Promise<T> {
    const kit = await this.kit();
    return kit.nativeRequest<T>(fn).catch(rethrowMapped);
  }

  /** Validates and normalizes a list bound (1..MAX_LIST_LIMIT, default 100). */
  #listLimit(limit: number | undefined): number {
    const value = limit ?? DEFAULT_LIST_LIMIT;
    if (!Number.isInteger(value) || value < 1 || value > MAX_LIST_LIMIT) {
      throw new StorageError(
        'STORAGE_LIST_LIMIT_INVALID',
        `list limit must be an integer in [1, ${MAX_LIST_LIMIT}], got ${value}`,
      );
    }
    return value;
  }

  /** Guards a listing prefix and normalizes the trailing slash. */
  #listPrefix(prefix: string): string {
    return prefix.length > 0 ? `${this.guard(prefix.replace(/\/+$/, ''))}/` : '';
  }

  /** Maps {@link ReadOptions} onto storagekit's download options. */
  downloadOptions(options: ReadOptions): Record<string, unknown> {
    return {
      ...(options.versionId !== undefined ? { versionId: options.versionId } : {}),
      ...(options.range !== undefined ? { range: { ...options.range } } : {}),
      ...(options.signal !== undefined ? { signal: options.signal } : {}),
      ...(options.native !== undefined ? { native: options.native } : {}),
    };
  }

  /** Stats a guarded key, mapping kit errors and refusing paths that are not files. */
  async #requireStat(key: string, options: StatOptions = {}): Promise<KitFileStat> {
    const kit = await this.kit();
    const metadata = await kit
      .stat(key, {
        native: { ...this.statNativeOptions(), ...(options.native ?? {}) },
        ...(options.versionId !== undefined ? { versionId: options.versionId } : {}),
        ...(options.signal !== undefined ? { signal: options.signal } : {}),
      })
      .catch(rethrowMapped);
    const stats = (metadata.native as { stats?: { isFile(): boolean } } | undefined)?.stats;
    if (stats !== undefined && !stats.isFile()) {
      throw new StorageError('STORAGE_FILE_NOT_FOUND', `Storage path is not a file: ${JSON.stringify(key)}`);
    }
    return metadata;
  }
}

/**
 * Disk backed by a storagekit cloud driver (`s3`, `r2`, `gcs`, ...). The kit
 * instance (and therefore the driver's peer SDK) is created lazily on first
 * use — or eagerly at provider boot — and a missing SDK surfaces as
 * `STORAGE_DRIVER_UNAVAILABLE`. Cloud disks advertise signed URLs; drivers
 * that cannot honor an operation still fail with `STORAGE_CAPABILITY_UNSUPPORTED`.
 */
export class KitDriverDisk extends KitBackedDisk {
  override readonly driver: Exclude<StorageDriverName, 'local'>;
  override readonly capabilities: DiskCapabilities = { streaming: true, signedUrls: true };
  readonly #kitOptions: Readonly<Record<string, unknown>>;

  constructor(options: RemoteDiskOptions) {
    super({
      name: options.name,
      visibility: options.visibility ?? 'private',
      publicBaseUrl: options.publicBaseUrl,
    });
    this.driver = options.driver;
    this.#kitOptions = options.options ?? {};
  }

  protected override kitOptions(): Record<string, unknown> {
    return { ...this.#kitOptions };
  }
}
