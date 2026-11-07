import { resolve, sep } from 'node:path';
import { StorageError } from './errors';

/**
 * Every storage path is validated against this allow-list before it touches
 * the filesystem: letters, digits, dot, underscore, slash. Percent signs are
 * excluded on purpose, so percent-encoded traversal (`%2e%2e`) is rejected at
 * the charset step — storage paths are never URL-decoded.
 */
const PATH_CHARS = /^[a-zA-Z0-9._/-]+$/;

/**
 * Validates a disk-relative storage path and returns it in canonical form
 * (`/`-separated, no leading/trailing slash, no empty, `.` or `..` segments).
 * Throws `STORAGE_PATH_FORBIDDEN` on anything else, including:
 * absolute paths, `..` segments in any spelling (raw or percent-encoded),
 * Windows drive/backslash paths and empty paths.
 */
export function validateStoragePath(path: string): string {
  if (typeof path !== 'string' || path.length === 0) {
    throw new StorageError(
      'STORAGE_PATH_FORBIDDEN',
      `Storage paths must be non-empty strings, got ${JSON.stringify(path)}`,
    );
  }
  if (path.startsWith('/') || path.startsWith('\\')) {
    throw new StorageError('STORAGE_PATH_FORBIDDEN', `Storage paths must be relative, got ${JSON.stringify(path)}`);
  }
  if (!PATH_CHARS.test(path)) {
    throw new StorageError(
      'STORAGE_PATH_FORBIDDEN',
      `Storage path contains forbidden characters: ${JSON.stringify(path)}`,
    );
  }
  // Defense in depth: a path is never URL-decoded, but if it *were*, the
  // decoded spelling must still be safe (e.g. catches double-encodings).
  let decoded = path;
  try {
    decoded = decodeURIComponent(path);
  } catch {
    throw new StorageError('STORAGE_PATH_FORBIDDEN', `Storage path has malformed encoding: ${JSON.stringify(path)}`);
  }
  const segments = decoded.split('/');
  for (const segment of segments) {
    if (segment.length === 0 || segment === '.' || segment === '..') {
      throw new StorageError(
        'STORAGE_PATH_FORBIDDEN',
        `Storage path contains a forbidden "${segment || ''}" segment: ${JSON.stringify(path)}`,
      );
    }
  }
  return segments.join('/');
}

/**
 * Resolves a validated storage path against a disk root and refuses the result
 * when it escapes the root (final normalization check after the path rules
 * above). Returns the absolute filesystem path.
 */
export function resolveInsideRoot(root: string, path: string): string {
  const relative = validateStoragePath(path);
  const absolute = resolve(root, relative);
  const rootPrefix = resolve(root) + sep;
  if (!absolute.startsWith(rootPrefix)) {
    throw new StorageError(
      'STORAGE_PATH_FORBIDDEN',
      `Resolved path ${absolute} escapes the disk root ${resolve(root)}`,
    );
  }
  return absolute;
}
