import { type Token, token } from '@framework/core';
import type { StorageDisk } from './types';

/** The application's default storage disk (config `storage.default`). */
export const STORAGE = token<StorageDisk>('storage.disk');

/** Characters allowed in a disk name (kept in sync with the token name below). */
const DISK_NAME = /^[a-zA-Z0-9._-]+$/;

/**
 * Token for one named disk from the `storage.disks` map, e.g.
 * `storageDiskToken('public')` -> `storage.disk.public`. Tokens are cached per
 * name so every call for the same disk returns the identical binding (tokens
 * carry a fresh `Symbol` per construction). Per-disk bindings are created by
 * `createStorageProvider`; resolve them directly in tests or tools.
 */
const diskTokens = new Map<string, Token<StorageDisk>>();

export function storageDiskToken(name: string): Token<StorageDisk> {
  if (!DISK_NAME.test(name)) throw new Error(`Invalid storage disk name: ${JSON.stringify(name)}`);
  const cached = diskTokens.get(name);
  if (cached) return cached;
  const created = token<StorageDisk>(`storage.disk.${name}`);
  diskTokens.set(name, created);
  return created;
}
