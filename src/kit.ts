import {
  createStorage,
  type FileStat,
  type Storage,
  StorageInvalidConfigError,
  StorageInvalidPathError,
  StorageNotFoundError,
  StorageUnsupportedOperationError,
} from '@mohamedhabibwork/storagekit';
import { StorageError } from './errors';

/**
 * The storagekit engine behind every disk. The kit's root entry never loads a
 * cloud SDK; `createStorage` lazy-loads only the configured driver's module
 * and raises `StorageInvalidConfigError` when a cloud driver's peer SDK is
 * missing or its options are invalid.
 */

/** A storagekit instance for any driver (non-builtin drivers get `unknown` native bags). */
export type KitStorage = Storage<string>;

/** storagekit's per-file metadata as returned by `stat`. */
export type KitFileStat = FileStat<string>;

/**
 * Creates the storagekit instance for `driver` (e.g. `local` with
 * `{ root, baseUrl }`, or `s3` with the application's pass-through options).
 *
 * storagekit signals unknown driver types and missing peer SDKs with
 * `StorageInvalidConfigError`; both are mapped to the catalogued
 * `STORAGE_DRIVER_UNAVAILABLE` so application code never has to depend on kit
 * error classes. The kit's factory switch is per-driver generic, while the
 * framework treats every driver uniformly — hence the erased view.
 */
export async function createKitStorage(
  driver: string,
  kitOptions: Readonly<Record<string, unknown>>,
): Promise<KitStorage> {
  const config = { type: driver, ...kitOptions };
  try {
    return (await createStorage(config as never)) as unknown as KitStorage;
  } catch (error) {
    if (error instanceof StorageInvalidConfigError) {
      throw new StorageError(
        'STORAGE_DRIVER_UNAVAILABLE',
        `Storage driver ${JSON.stringify(driver)} is unavailable: ${error.message}`,
        { cause: error },
      );
    }
    throw error;
  }
}

/**
 * Maps storagekit's error taxonomy onto the framework's storage catalog.
 * Framework errors (and anything unrelated) pass through untouched.
 */
export function mapKitError(error: unknown): unknown {
  if (error instanceof StorageError) return error;
  if (error instanceof StorageNotFoundError) {
    return new StorageError('STORAGE_FILE_NOT_FOUND', error.message, { cause: error });
  }
  if (error instanceof StorageInvalidPathError) {
    return new StorageError('STORAGE_PATH_FORBIDDEN', error.message, { cause: error });
  }
  if (error instanceof StorageUnsupportedOperationError) {
    return new StorageError('STORAGE_CAPABILITY_UNSUPPORTED', error.message, { cause: error });
  }
  return error;
}

/** For `.catch(...)` on kit calls: maps the kit error, then rethrows. */
export function rethrowMapped(error: unknown): never {
  throw mapKitError(error);
}
