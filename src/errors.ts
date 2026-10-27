import { FrameworkError } from '@framework/core';

/**
 * The storage error-code catalog. Every `StorageError` carries one of these
 * stable SCREAMING_SNAKE codes; callers switch on `code`, never on message text.
 */
export const STORAGE_ERROR_CODES = [
  'STORAGE_FILE_NOT_FOUND',
  'STORAGE_FILE_EXISTS',
  'STORAGE_PATH_FORBIDDEN',
  'STORAGE_VISIBILITY_FORBIDDEN',
  'STORAGE_CAPABILITY_UNSUPPORTED',
  'STORAGE_FILE_TOO_LARGE',
  'STORAGE_EXTENSION_FORBIDDEN',
  'STORAGE_LIST_LIMIT_INVALID',
  'STORAGE_DRIVER_UNAVAILABLE',
] as const;

export type StorageErrorCode = (typeof STORAGE_ERROR_CODES)[number];

/** Storage failure with a stable, catalogued machine-readable code. */
export class StorageError extends FrameworkError {
  constructor(
    override readonly code: StorageErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(code, message, options);
  }
}
