import { StorageError } from './errors';
import type { UploadGuardInput } from './types';

/**
 * Validates an upload's size (and extension, when an allow-list is configured)
 * *before* anything is persisted to a disk (spec §8: validate upload
 * sizes/content). Throws:
 * - `STORAGE_FILE_TOO_LARGE` when `size` exceeds `maxBytes`,
 * - `STORAGE_EXTENSION_FORBIDDEN` when `allowedExtensions` is set and the
 *   `filename` is missing or its extension is not on the (case-insensitive) list.
 */
export function assertUploadAllowed({ size, maxBytes, allowedExtensions, filename }: UploadGuardInput): void {
  if (typeof size !== 'number' || !Number.isFinite(size) || size < 0) {
    throw new StorageError('STORAGE_FILE_TOO_LARGE', `Upload size must be a non-negative finite number, got ${size}`);
  }
  if (!Number.isFinite(maxBytes) || maxBytes <= 0) {
    throw new RangeError(`maxBytes must be a positive finite number, got ${maxBytes}`);
  }
  if (size > maxBytes) {
    throw new StorageError('STORAGE_FILE_TOO_LARGE', `Upload of ${size} bytes exceeds the ${maxBytes}-byte limit`);
  }
  if (allowedExtensions !== undefined) {
    const allowed = new Set(allowedExtensions.map((extension) => extension.toLowerCase()));
    const extension = filename?.includes('.') ? (filename.split('.').pop() ?? '').toLowerCase() : '';
    if (extension.length === 0 || !allowed.has(extension)) {
      throw new StorageError(
        'STORAGE_EXTENSION_FORBIDDEN',
        `Upload extension ${JSON.stringify(extension || undefined)} is not allowed; allowed: ${[...allowed].join(', ')}`,
      );
    }
  }
}
