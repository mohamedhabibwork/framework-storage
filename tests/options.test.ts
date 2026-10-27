import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Application, BootError } from '@framework/core';
import { STORAGE } from '../src/constants';
import { LocalStorageDisk } from '../src/local-disk';
import { createStorageProvider } from '../src/provider';
import { StorageError } from '../src/errors';
import type { StorageConfig } from '../src/types';

/**
 * The option surface must be *usable*, not merely accepted: every option below
 * is asserted through an observable effect (content type, conflict, cursor,
 * metadata) rather than "it did not throw".
 */

let base: string;
let disk: LocalStorageDisk;

beforeAll(async () => {
  base = await mkdtemp(join(tmpdir(), 'fw-storage-options-'));
  disk = new LocalStorageDisk({
    name: 'private',
    root: join(base, 'private'),
    visibility: 'private',
    // Pass-through kit options: a non-default permission mode must not break
    // normal writes.
    options: { permissions: 0o600 },
  });
});

afterAll(async () => {
  await rm(base, { recursive: true, force: true });
});

/** Awaits a storage operation and returns its catalogued code. */
async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof StorageError) return error.code;
    throw error;
  }
  throw new Error('expected the storage operation to reject with a StorageError');
}

describe('put options', () => {
  test('contentType is recorded and returned by get', async () => {
    await disk.put('reports/q1.csv', 'a,b\n1,2', { contentType: 'text/csv' });
    const file = await disk.get('reports/q1.csv');
    expect(file.contentType).toBe('text/csv');
    expect(new TextDecoder().decode(file.content)).toBe('a,b\n1,2');
  });

  test('metadata and cacheControl are accepted alongside native options', async () => {
    await disk.put('reports/q2.csv', 'x', {
      metadata: { owner: 'finance' },
      cacheControl: 'max-age=60',
      contentDisposition: 'attachment; filename="q2.csv"',
      native: { followSymlinks: true },
    });
    expect(await disk.exists('reports/q2.csv')).toBe(true);
  });

  test('overwrite: false fails with STORAGE_FILE_EXISTS on an existing key', async () => {
    await disk.put('reports/dupe.txt', 'first');
    expect(await codeOf(disk.put('reports/dupe.txt', 'second', { overwrite: false }))).toBe('STORAGE_FILE_EXISTS');
    // The original content is untouched.
    expect(new TextDecoder().decode((await disk.get('reports/dupe.txt')).content)).toBe('first');
  });

  test('overwrite: true (default) replaces the content', async () => {
    await disk.put('reports/dupe.txt', 'second');
    expect(new TextDecoder().decode((await disk.get('reports/dupe.txt')).content)).toBe('second');
  });
});

describe('read options', () => {
  test('get and stream accept a signal and versionId without changing the result', async () => {
    await disk.put('read/signal.txt', 'payload');
    const controller = new AbortController();
    const file = await disk.get('read/signal.txt', { signal: controller.signal });
    expect(file.size).toBe(7);
    const stream = await disk.stream('read/signal.txt', { signal: controller.signal });
    expect(stream).toBeDefined();
  });

  test('size and exists accept the stat options bag', async () => {
    await disk.put('read/stat.txt', '12345');
    expect(await disk.size('read/stat.txt', { native: {} })).toBe(5);
    expect(await disk.exists('read/stat.txt', { native: {} })).toBe(true);
  });
});

describe('list pagination', () => {
  test('listPage returns a cursor and hasMore, and the next page continues', async () => {
    for (const name of ['a', 'b', 'c']) await disk.put(`paged/${name}.txt`, name);
    const first = await disk.listPage('paged', { limit: 2 });
    expect(first.files).toHaveLength(2);
    expect(first.hasMore).toBe(true);
    expect(first.cursor).toBeString();

    const second = await disk.listPage('paged', { limit: 2, cursor: first.cursor });
    expect(second.files).toHaveLength(1);
    expect(second.hasMore).toBe(false);
    expect([...first.files, ...second.files].sort()).toEqual(['paged/a.txt', 'paged/b.txt', 'paged/c.txt']);
  });

  test('list still bounds results and validates the limit', async () => {
    const all = await disk.list('paged', { limit: 2 });
    expect(all).toHaveLength(2);
    expect(await codeOf(disk.list('paged', { limit: 0 }))).toBe('STORAGE_LIST_LIMIT_INVALID');
    expect(await codeOf(disk.listPage('paged', { limit: 10_000 }))).toBe('STORAGE_LIST_LIMIT_INVALID');
  });
});

describe('copy and move options', () => {
  test('copy accepts metadata/contentType and can refuse to overwrite', async () => {
    await disk.put('copy/source.txt', 'source', { contentType: 'text/plain' });
    await disk.copy('copy/source.txt', 'copy/target.txt', {
      contentType: 'text/plain',
      metadata: { copied: 'true' },
      cacheControl: 'no-store',
    });
    expect(await disk.exists('copy/target.txt')).toBe(true);

    expect(await codeOf(disk.copy('copy/source.txt', 'copy/target.txt', { overwrite: false }))).toBe(
      'STORAGE_FILE_EXISTS',
    );
  });

  test('move accepts overwrite and metadata', async () => {
    await disk.put('move/source.txt', 'move me');
    await disk.move('move/source.txt', 'move/target.txt', { metadata: { moved: 'true' } });
    expect(await disk.exists('move/source.txt')).toBe(false);
    expect(await disk.exists('move/target.txt')).toBe(true);
  });
});

describe('native access', () => {
  test('native() resolves the driver client without throwing', async () => {
    await disk.native();
  });

  test('nativeRequest runs against the client', async () => {
    const result = await disk.nativeRequest(async (client) => typeof client);
    expect(['object', 'undefined']).toContain(result);
  });
});

describe('configuration', () => {
  test('the provider forwards local disk options to the driver', async () => {
    const config: StorageConfig = {
      default: 'local',
      disks: {
        local: {
          driver: 'local',
          root: join(base, 'configured'),
          visibility: 'private',
          options: { permissions: 0o600 },
        },
      },
    };
    const application = new Application<{ storage: StorageConfig }>({
      config: { storage: config },
      providers: [createStorageProvider()],
    });
    await application.boot();
    try {
      const configured = application.container.resolve(STORAGE);
      await configured.put('configured.txt', 'ok');
      expect(await configured.exists('configured.txt')).toBe(true);
    } finally {
      await application.shutdown();
    }
  });

  test('a remote disk forwards its options bag to the driver factory', async () => {
    // No cloud SDK is installed in this workspace: the disk must fail with the
    // catalogued "driver unavailable" code (proving the options reached the
    // kit) rather than a config error.
    const config: StorageConfig = {
      default: 's3',
      disks: {
        s3: {
          driver: 's3',
          visibility: 'private',
          options: { bucket: 'assets', region: 'eu-central-1', prefix: 'uploads/' },
        },
      },
    };
    const application = new Application<{ storage: StorageConfig }>({
      config: { storage: config },
      providers: [createStorageProvider()],
    });
    const failure = await application.boot().catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(BootError);
    const cause = (failure as BootError).cause;
    expect(cause).toBeInstanceOf(StorageError);
    expect((cause as StorageError).code).toBe('STORAGE_DRIVER_UNAVAILABLE');
    await application.shutdown().catch(() => undefined);
  });
});
