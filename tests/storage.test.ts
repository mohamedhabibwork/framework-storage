import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readdir, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Application, BootError, ConfigError } from '@framework/core';
import { STORAGE, storageDiskToken } from '../src/constants';
import { StorageError } from '../src/errors';
import { LocalStorageDisk } from '../src/local-disk';
import { resolveInsideRoot, validateStoragePath } from '../src/path-guard';
import { createStorageProvider } from '../src/provider';
import { pruneTemp } from '../src/temp';
import type { StorageConfig } from '../src/types';
import { assertUploadAllowed } from '../src/upload-guard';

/** Awaits a storage operation and returns its catalogued code (fails the test when it resolves). */
async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof StorageError) return error.code;
    throw error;
  }
  throw new Error('expected the storage operation to reject with a StorageError');
}

/** Same as {@link codeOf} for synchronous throws. */
function syncCodeOf(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    if (error instanceof StorageError) return error.code;
    throw error;
  }
  throw new Error('expected the function to throw a StorageError');
}

let base: string;
let privateDisk: LocalStorageDisk;
let publicDisk: LocalStorageDisk;

beforeAll(async () => {
  base = await mkdtemp(join(tmpdir(), 'fw-storage-'));
  privateDisk = new LocalStorageDisk({ name: 'private', root: join(base, 'private'), visibility: 'private' });
  publicDisk = new LocalStorageDisk({
    name: 'public',
    root: join(base, 'public'),
    visibility: 'public',
    publicBaseUrl: 'https://files.example.test/cdn/',
  });
});

afterAll(async () => {
  await rm(base, { recursive: true, force: true });
});

describe('disk round trip', () => {
  test('put/get round-trips text with metadata', async () => {
    await privateDisk.put('docs/hello.txt', 'hello storage');
    const file = await privateDisk.get('docs/hello.txt');
    expect(new TextDecoder().decode(file.content)).toBe('hello storage');
    expect(file.path).toBe('docs/hello.txt');
    expect(file.size).toBe(13);
    expect(file.contentType).toContain('text/plain');
    expect(file.lastModified).toBeInstanceOf(Date);
  });

  test('put/get round-trips binary bytes', async () => {
    const bytes = new Uint8Array([0, 1, 2, 254, 255]);
    await privateDisk.put('blobs/raw.bin', bytes);
    const file = await privateDisk.get('blobs/raw.bin');
    expect([...file.content]).toEqual([0, 1, 2, 254, 255]);
  });

  test('stream yields the stored bytes', async () => {
    const stream = await privateDisk.stream('docs/hello.txt');
    const chunks: Uint8Array[] = [];
    for await (const chunk of stream) chunks.push(chunk);
    const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
    const merged = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      merged.set(chunk, offset);
      offset += chunk.length;
    }
    expect(new TextDecoder().decode(merged)).toBe('hello storage');
  });

  test('exists and size report the stored file', async () => {
    expect(await privateDisk.exists('docs/hello.txt')).toBe(true);
    expect(await privateDisk.exists('docs/missing.txt')).toBe(false);
    expect(await privateDisk.size('docs/hello.txt')).toBe(13);
  });

  test('copy duplicates in place; move relocates', async () => {
    await privateDisk.copy('docs/hello.txt', 'backup/hello.txt');
    expect(await privateDisk.exists('backup/hello.txt')).toBe(true);
    expect(await privateDisk.exists('docs/hello.txt')).toBe(true);
    await privateDisk.move('backup/hello.txt', 'archive/2026/hello.txt');
    expect(await privateDisk.exists('backup/hello.txt')).toBe(false);
    expect(await privateDisk.exists('archive/2026/hello.txt')).toBe(true);
  });

  test('delete removes a file and tolerates repeats', async () => {
    await privateDisk.put('scratch/x.txt', 'x');
    await privateDisk.delete('scratch/x.txt');
    expect(await privateDisk.exists('scratch/x.txt')).toBe(false);
    await privateDisk.delete('scratch/x.txt');
  });

  test('get/size/stream/move/copy on a missing file throw STORAGE_FILE_NOT_FOUND', async () => {
    expect(await codeOf(privateDisk.get('nope.txt'))).toBe('STORAGE_FILE_NOT_FOUND');
    expect(await codeOf(privateDisk.size('nope.txt'))).toBe('STORAGE_FILE_NOT_FOUND');
    expect(await codeOf(privateDisk.stream('nope.txt'))).toBe('STORAGE_FILE_NOT_FOUND');
    expect(await codeOf(privateDisk.move('nope.txt', 'moved.txt'))).toBe('STORAGE_FILE_NOT_FOUND');
    expect(await codeOf(privateDisk.copy('nope.txt', 'copied.txt'))).toBe('STORAGE_FILE_NOT_FOUND');
  });

  test('list is sorted and bounded by an explicit limit', async () => {
    for (const name of ['log-4', 'log-0', 'log-2', 'log-1', 'log-3']) {
      await privateDisk.put(`logs/${name}.txt`, name);
    }
    const all = await privateDisk.list('logs');
    expect(all).toHaveLength(5);
    expect([...all]).toEqual([...all].sort());
    const bounded = await privateDisk.list('logs', { limit: 2 });
    expect(bounded).toHaveLength(2);
    expect([...bounded]).toEqual([...all.slice(0, 2)]);
    expect(await codeOf(privateDisk.list('logs', { limit: 0 }))).toBe('STORAGE_LIST_LIMIT_INVALID');
    expect(await codeOf(privateDisk.list('logs', { limit: 1001 }))).toBe('STORAGE_LIST_LIMIT_INVALID');
  });

  test('list without prefix covers the disk; unknown prefixes list empty', async () => {
    const paths = await privateDisk.list();
    expect(paths.length).toBeGreaterThanOrEqual(8);
    expect(await privateDisk.list('does-not-exist')).toEqual([]);
  });
});

describe('path traversal prevention', () => {
  const attempts = [
    '../escape.txt',
    '..',
    'a/../../b',
    '../../etc/passwd',
    'safe/../../../escape',
    '/etc/passwd',
    '%2e%2e/escape',
    'a/%2e%2e%2fescape',
    'a/..%2fescape',
    'C:/Windows/system32/config',
    'back\\slash.txt',
    'a//double/slash',
    './dot-relative',
    'a/../b',
  ];

  test.each(attempts)('rejects %j on every operation with STORAGE_PATH_FORBIDDEN', async (attempt) => {
    expect(await codeOf(privateDisk.put(attempt, 'evil'))).toBe('STORAGE_PATH_FORBIDDEN');
    expect(await codeOf(privateDisk.get(attempt))).toBe('STORAGE_PATH_FORBIDDEN');
    expect(await codeOf(privateDisk.delete(attempt))).toBe('STORAGE_PATH_FORBIDDEN');
    expect(await codeOf(privateDisk.list(attempt))).toBe('STORAGE_PATH_FORBIDDEN');
    expect(await codeOf(privateDisk.move('docs/hello.txt', attempt))).toBe('STORAGE_PATH_FORBIDDEN');
    expect(await codeOf(privateDisk.copy('docs/hello.txt', attempt))).toBe('STORAGE_PATH_FORBIDDEN');
    // Use the public disk here so the path (not the visibility) rule fires first.
    expect(syncCodeOf(() => publicDisk.publicUrl(attempt))).toBe('STORAGE_PATH_FORBIDDEN');
  });

  test('the guard resolves strictly inside the disk root', () => {
    expect(validateStoragePath('a/b/c.txt')).toBe('a/b/c.txt');
    const inside = resolveInsideRoot(privateDisk.root, 'a/b/c.txt');
    expect(inside.startsWith(`${privateDisk.root}/`)).toBe(true);
    expect(() => resolveInsideRoot(privateDisk.root, '..')).toThrow(/forbidden/);
  });

  test('no traversal attempt left a file outside the disk root', async () => {
    expect(await Bun.file(join(base, 'escape.txt')).exists()).toBe(false);
    expect(await Bun.file(join(base, 'b')).exists()).toBe(false);
    const baseEntries = await readdir(base);
    expect(baseEntries.filter((entry) => !['private', 'public'].includes(entry))).toEqual([]);
  });
});

describe('visibility separation', () => {
  test('publicUrl joins the configured base on the public disk', () => {
    expect(publicDisk.publicUrl('img/logo.png')).toBe('https://files.example.test/cdn/img/logo.png');
  });

  test('publicUrl throws STORAGE_VISIBILITY_FORBIDDEN on the private disk', () => {
    expect(syncCodeOf(() => privateDisk.publicUrl('docs/hello.txt'))).toBe('STORAGE_VISIBILITY_FORBIDDEN');
  });

  test('a private-disk file never appears under the public root', async () => {
    await privateDisk.put('secret/credentials.txt', 's3cret');
    expect(await privateDisk.exists('secret/credentials.txt')).toBe(true);
    expect(await publicDisk.exists('secret/credentials.txt')).toBe(false);
    expect(await Bun.file(join(publicDisk.root, 'secret/credentials.txt')).exists()).toBe(false);
  });

  test('per-put visibility overrides cannot cross the private/public split', async () => {
    expect(await codeOf(privateDisk.put('promo.txt', 'x', { visibility: 'public' }))).toBe(
      'STORAGE_VISIBILITY_FORBIDDEN',
    );
    expect(await codeOf(publicDisk.put('leak.txt', 'x', { visibility: 'private' }))).toBe(
      'STORAGE_VISIBILITY_FORBIDDEN',
    );
  });

  test('public disks must declare a public base URL', () => {
    expect(
      () => new LocalStorageDisk({ name: 'broken-public', root: join(base, 'broken'), visibility: 'public' }),
    ).toThrow(ConfigError);
  });
});

describe('capability honesty', () => {
  test('local disks declare streaming but no signed URLs', () => {
    expect(privateDisk.capabilities).toEqual({ streaming: true, signedUrls: false });
    expect(privateDisk.driver).toBe('local');
  });

  test('signedUrl throws STORAGE_CAPABILITY_UNSUPPORTED', async () => {
    expect(await codeOf(privateDisk.signedUrl('docs/hello.txt'))).toBe('STORAGE_CAPABILITY_UNSUPPORTED');
  });
});

describe('upload guard', () => {
  test('accepts uploads within the limit', () => {
    expect(() => assertUploadAllowed({ size: 10, maxBytes: 10 })).not.toThrow();
  });

  test('rejects oversize uploads with STORAGE_FILE_TOO_LARGE', () => {
    expect(syncCodeOf(() => assertUploadAllowed({ size: 11, maxBytes: 10 }))).toBe('STORAGE_FILE_TOO_LARGE');
  });

  test('rejects disallowed extensions with STORAGE_EXTENSION_FORBIDDEN', () => {
    const rejected = () =>
      assertUploadAllowed({ size: 1, maxBytes: 10, allowedExtensions: ['png', 'jpg'], filename: 'report.pdf' });
    expect(syncCodeOf(rejected)).toBe('STORAGE_EXTENSION_FORBIDDEN');
    expect(() =>
      assertUploadAllowed({ size: 1, maxBytes: 10, allowedExtensions: ['png'], filename: 'photo.PNG' }),
    ).not.toThrow();
  });

  test('extension rules require a filename', () => {
    expect(syncCodeOf(() => assertUploadAllowed({ size: 1, maxBytes: 10, allowedExtensions: ['png'] }))).toBe(
      'STORAGE_EXTENSION_FORBIDDEN',
    );
  });
});

describe('pruneTemp', () => {
  test('removes only files older than the cutoff and drops emptied directories', async () => {
    const tempRoot = join(base, 'tmp-root');
    await mkdir(join(tempRoot, 'stale'), { recursive: true });
    const oldPath = join(tempRoot, 'stale/old.bin');
    const freshPath = join(tempRoot, 'fresh.bin');
    await writeFile(oldPath, 'old');
    await writeFile(freshPath, 'fresh');
    const past = new Date(Date.now() - 60_000);
    await utimes(oldPath, past, past);

    expect(await pruneTemp(tempRoot, 10_000)).toBe(1);
    expect(await Bun.file(oldPath).exists()).toBe(false);
    expect(await Bun.file(freshPath).exists()).toBe(true);
    await expect(stat(join(tempRoot, 'stale'))).rejects.toThrow();
  });

  test('is a no-op on a missing root and refuses a filesystem root', async () => {
    expect(await pruneTemp(join(base, 'missing-tmp'), 1_000)).toBe(0);
    expect(
      await pruneTemp('/', 1_000).catch((error: unknown) => (error instanceof StorageError ? error.code : 'no-error')),
    ).toBe('STORAGE_PATH_FORBIDDEN');
  });
});

describe('provider', () => {
  test('binds STORAGE to the default disk and each disk under its token', async () => {
    const application = new Application<{ storage: StorageConfig }>({
      config: {
        storage: {
          default: 'local',
          disks: {
            local: { driver: 'local', root: join(base, 'app-private'), visibility: 'private' },
            public: {
              driver: 'local',
              root: join(base, 'app-public'),
              visibility: 'public',
              publicBaseUrl: '/storage',
            },
          },
        },
      },
      providers: [createStorageProvider()],
    });
    await application.boot();
    try {
      const disk = application.container.resolve(STORAGE);
      expect(disk.name).toBe('local');
      expect(disk.visibility).toBe('private');
      const appPublicDisk = application.container.resolve(storageDiskToken('public'));
      expect(appPublicDisk.visibility).toBe('public');
      await disk.put('provider.txt', 'ok');
      expect(await disk.exists('provider.txt')).toBe(true);
      expect(await appPublicDisk.exists('provider.txt')).toBe(false);
      expect(appPublicDisk.publicUrl('shared/logo.png')).toBe('/storage/shared/logo.png');
    } finally {
      await application.shutdown();
    }
  });

  test('rejects invalid storage configuration at boot', async () => {
    const application = new Application<{ storage: StorageConfig }>({
      config: {
        storage: {
          default: 'missing',
          disks: { local: { driver: 'local', root: '', visibility: 'public' } },
        },
      },
      providers: [createStorageProvider()],
    });
    const failure = await application.boot().catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(BootError);
    expect((failure as BootError).cause).toBeInstanceOf(ConfigError);
  });

  test('a cloud driver without its peer SDK fails at boot with STORAGE_DRIVER_UNAVAILABLE', async () => {
    const application = new Application<{ storage: StorageConfig }>({
      config: {
        storage: {
          default: 'assets',
          // `s3` without kit options: storagekit raises StorageInvalidConfigError
          // ("s3 storage requires a non-empty `bucket`"), which the provider maps
          // to the catalogued STORAGE_DRIVER_UNAVAILABLE.
          disks: { assets: { driver: 's3', visibility: 'private' } },
        },
      },
      providers: [createStorageProvider()],
    });
    const failure = await application.boot().catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(BootError);
    const cause = (failure as BootError).cause;
    expect(cause).toBeInstanceOf(StorageError);
    expect((cause as StorageError).code).toBe('STORAGE_DRIVER_UNAVAILABLE');
  });
});
