import { Readable } from 'node:stream';
import { ConfigError } from '@framework/core';
import { StorageError } from './errors';
import { createKitStorage, type KitFileStat, type KitStorage, mapKitError, rethrowMapped } from './kit';
import { validateStoragePath } from './path-guard';
import type {
  DiskCapabilities,
  ListOptions,
  PutOptions,
  RemoteDiskOptions,
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
    await kit.upload(key, data).catch(rethrowMapped);
  }

  async get(path: string): Promise<StoredFile> {
    const key = this.guard(path);
    const metadata = await this.#requireStat(key);
    const kit = await this.kit();
    const downloaded = await kit.download(key).catch(rethrowMapped);
    const content = await downloaded.buffer().catch(rethrowMapped);
    return {
      path: validateStoragePath(path),
      content,
      size: metadata.size,
      lastModified: metadata.lastModified ?? new Date(0),
      contentType: metadata.contentType,
    };
  }

  async stream(path: string): Promise<ReadableStream<Uint8Array> & AsyncIterable<Uint8Array>> {
    const key = this.guard(path);
    await this.#requireStat(key);
    const kit = await this.kit();
    const downloaded = await kit.download(key).catch(rethrowMapped);
    // storagekit hands back a Node readable; `toWeb` returns a stream that is
    // both a web ReadableStream and `for await`-able at runtime.
    return Readable.toWeb(downloaded.stream) as unknown as ReadableStream<Uint8Array> & AsyncIterable<Uint8Array>;
  }

  async delete(path: string): Promise<void> {
    const key = this.guard(path);
    const kit = await this.kit();
    await kit.delete(key).catch(rethrowMapped);
  }

  async exists(path: string): Promise<boolean> {
    const key = this.guard(path);
    try {
      await this.#requireStat(key);
      return true;
    } catch (error) {
      if (error instanceof StorageError && error.code === 'STORAGE_FILE_NOT_FOUND') return false;
      throw error;
    }
  }

  async size(path: string): Promise<number> {
    const key = this.guard(path);
    return (await this.#requireStat(key)).size;
  }

  async list(prefix = '', options: ListOptions = {}): Promise<readonly string[]> {
    const limit = options.limit ?? DEFAULT_LIST_LIMIT;
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIST_LIMIT) {
      throw new StorageError(
        'STORAGE_LIST_LIMIT_INVALID',
        `list limit must be an integer in [1, ${MAX_LIST_LIMIT}], got ${limit}`,
      );
    }
    const normalizedPrefix = prefix.length > 0 ? `${this.guard(prefix.replace(/\/+$/, ''))}/` : '';
    const kit = await this.kit();
    const matches: string[] = [];
    try {
      // storagekit walks recursively and yields files only; stop at the bound
      // and restore the contract's lexicographic order.
      for await (const entry of kit.iterate(normalizedPrefix)) {
        matches.push(entry.path);
        if (matches.length >= limit) break;
      }
    } catch (error) {
      throw mapKitError(error);
    }
    return matches.sort();
  }

  async move(from: string, to: string): Promise<void> {
    const fromKey = this.guard(from);
    const toKey = this.guard(to);
    await this.#requireStat(fromKey);
    const kit = await this.kit();
    await kit.move(fromKey, toKey).catch(rethrowMapped);
  }

  async copy(from: string, to: string): Promise<void> {
    const fromKey = this.guard(from);
    const toKey = this.guard(to);
    await this.#requireStat(fromKey);
    const kit = await this.kit();
    await kit.copy(fromKey, toKey).catch(rethrowMapped);
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

  async signedUrl(path: string, ttlSeconds?: number): Promise<string> {
    if (!this.capabilities.signedUrls) {
      throw new StorageError(
        'STORAGE_CAPABILITY_UNSUPPORTED',
        `Disk "${this.name}" (driver ${this.driver}) does not support signed URLs`,
      );
    }
    const key = this.guard(path);
    const kit = await this.kit();
    return kit.getSignedUrl(key, ttlSeconds === undefined ? {} : { expiresIn: ttlSeconds }).catch(rethrowMapped);
  }

  /** Stats a guarded key, mapping kit errors and refusing paths that are not files. */
  async #requireStat(key: string): Promise<KitFileStat> {
    const kit = await this.kit();
    const metadata = await kit.stat(key, { native: this.statNativeOptions() }).catch(rethrowMapped);
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
