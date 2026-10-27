import { readdir, rmdir, stat, unlink } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { StorageError } from './errors';

export interface PruneTempOptions {
  /** Reference "now" in epoch ms; lets tests backdate deterministically. Defaults to `Date.now()`. */
  readonly now?: number;
  /** Safety bound on files removed per call. Defaults to 1000. */
  readonly limit?: number;
}

/**
 * Removes framework-owned temporary files older than `olderThanMs` under the
 * given temp root and prunes directories the removal left empty. Returns the
 * number of files removed.
 *
 * Convention (spec §8: temporary-upload cleanup): the temp root is dedicated
 * (e.g. `storage/framework/tmp`) and configured separately from the private
 * and public disk roots — only files the framework itself staged there are
 * ever pruned, so user uploads in `storage/app` are never touched.
 *
 * A missing root is a no-op (returns 0); a filesystem root as `root` is refused.
 */
export async function pruneTemp(root: string, olderThanMs: number, options: PruneTempOptions = {}): Promise<number> {
  const absoluteRoot = resolve(root);
  if (absoluteRoot === dirname(absoluteRoot)) {
    throw new StorageError('STORAGE_PATH_FORBIDDEN', 'pruneTemp refuses to operate on a filesystem root');
  }
  if (!Number.isFinite(olderThanMs) || olderThanMs < 0) {
    throw new StorageError(
      'STORAGE_PATH_FORBIDDEN',
      `olderThanMs must be a non-negative finite number, got ${olderThanMs}`,
    );
  }
  try {
    await stat(absoluteRoot);
  } catch (error) {
    if (isMissing(error)) return 0;
    throw error;
  }
  const cutoff = (options.now ?? Date.now()) - olderThanMs;
  const limit = options.limit ?? 1000;
  const removed: string[] = [];
  const directories: string[] = [];
  await walk(absoluteRoot, cutoff, limit, removed, directories);
  // Deepest-first rmdir of directories the pruning emptied; failures are fine.
  for (const directory of directories.reverse()) {
    await rmdir(directory).catch(() => undefined);
  }
  return removed.length;
}

function isMissing(error: unknown): boolean {
  return (
    typeof error === 'object' && error !== null && 'code' in error && (error as { code: unknown }).code === 'ENOENT'
  );
}

async function walk(
  directory: string,
  cutoff: number,
  limit: number,
  removed: string[],
  directories: string[],
): Promise<void> {
  directories.push(directory);
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (removed.length >= limit) return;
    const absolute = join(directory, entry.name);
    if (entry.isDirectory()) {
      await walk(absolute, cutoff, limit, removed, directories);
      continue;
    }
    if (!entry.isFile()) continue;
    const metadata = await stat(absolute);
    if (metadata.mtimeMs <= cutoff) {
      await unlink(absolute);
      removed.push(absolute);
    }
  }
}
