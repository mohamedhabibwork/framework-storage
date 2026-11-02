/**
 * Runs the disk contract against a real S3-compatible server (MinIO from
 * `deployment/compose.yaml`, started by `bun run db:up`). One suite per driver,
 * since each builds its client differently.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { Application } from '@framework/core';
import { CreateBucketCommand, DeleteBucketCommand, ListObjectsV2Command, S3Client } from '@aws-sdk/client-s3';
import {
  createStorageProvider,
  KitDriverDisk,
  STORAGE,
  type StorageConfig,
  type StorageDisk,
  StorageError,
} from '../src';

const MINIO_URL = process.env.MINIO_URL ?? 'http://127.0.0.1:59000';
const MINIO_USER = process.env.MINIO_ROOT_USER ?? 'framework';
const MINIO_PASSWORD = process.env.MINIO_ROOT_PASSWORD ?? 'framework-secret';
const credentials = { accessKeyId: MINIO_USER, secretAccessKey: MINIO_PASSWORD };
const endpoint = new URL(MINIO_URL);
const STARTUP_DEADLINE_MS = 30_000;

const bucket = `framework-test-${crypto.randomUUID()}`;
const s3 = new S3Client({ region: 'us-east-1', endpoint: MINIO_URL, forcePathStyle: true, credentials });

const DISKS: readonly [string, () => StorageDisk][] = [
  [
    's3',
    () =>
      new KitDriverDisk({
        name: 's3',
        driver: 's3',
        visibility: 'private',
        options: {
          bucket,
          region: 'us-east-1',
          endpoint: MINIO_URL,
          forcePathStyle: true,
          credentials,
          prefix: 's3-suite',
        },
      }),
  ],
  [
    'r2',
    () =>
      new KitDriverDisk({
        name: 'r2',
        driver: 'r2',
        visibility: 'private',
        options: { bucket, endpoint: MINIO_URL, forcePathStyle: true, credentials, prefix: 'r2-suite' },
      }),
  ],
  [
    'minio',
    () =>
      new KitDriverDisk({
        name: 'minio',
        driver: 'minio',
        visibility: 'private',
        options: {
          bucket,
          endPoint: endpoint.hostname,
          port: Number(endpoint.port),
          useSSL: false,
          accessKey: MINIO_USER,
          secretKey: MINIO_PASSWORD,
          region: 'us-east-1',
          prefix: 'minio-suite',
        },
      }),
  ],
];

const text = (content: Uint8Array): string => new TextDecoder().decode(content);

const codeOf = (error: unknown): string | undefined => (error instanceof StorageError ? error.code : undefined);

beforeAll(async () => {
  const deadline = Date.now() + STARTUP_DEADLINE_MS;
  for (;;) {
    const ready = await fetch(`${MINIO_URL}/minio/health/live`).then(
      (response) => response.ok,
      () => false,
    );
    if (ready) break;
    if (Date.now() > deadline) throw new Error(`MinIO is not reachable at ${MINIO_URL}; run \`bun run db:up\``);
    await Bun.sleep(200);
  }
  await s3.send(new CreateBucketCommand({ Bucket: bucket }));
});

afterAll(async () => {
  for (const [, create] of DISKS) {
    const disk = create();
    for (const path of await disk.list('', { limit: 1000 })) await disk.delete(path);
  }
  await s3.send(new DeleteBucketCommand({ Bucket: bucket }));
  s3.destroy();
});

describe.each(DISKS)('the %s driver', (_name, create) => {
  const disk = create();

  test('round-trips content, type and size', async () => {
    await disk.put('docs/hello.txt', 'hello world', { contentType: 'text/plain' });

    const file = await disk.get('docs/hello.txt');

    expect(text(file.content)).toBe('hello world');
    expect(file.contentType).toStartWith('text/plain');
    expect(file.size).toBe(11);
    expect(await disk.size('docs/hello.txt')).toBe(11);
    expect(await disk.exists('docs/hello.txt')).toBe(true);
  });

  test('round-trips binary content unchanged', async () => {
    const bytes = crypto.getRandomValues(new Uint8Array(1024));

    await disk.put('bin/random.dat', bytes);

    expect(new Uint8Array((await disk.get('bin/random.dat')).content)).toEqual(bytes);
  });

  test('streams a file', async () => {
    await disk.put('docs/stream.txt', 'streamed body');
    const chunks: Uint8Array[] = [];

    for await (const chunk of await disk.stream('docs/stream.txt')) chunks.push(chunk);

    expect(text(Buffer.concat(chunks))).toBe('streamed body');
  });

  test('a missing file maps to STORAGE_FILE_NOT_FOUND', async () => {
    expect(await disk.exists('missing.txt')).toBe(false);
    expect(codeOf(await disk.get('missing.txt').catch((error: unknown) => error))).toBe('STORAGE_FILE_NOT_FOUND');
    expect(codeOf(await disk.size('missing.txt').catch((error: unknown) => error))).toBe('STORAGE_FILE_NOT_FOUND');
  });

  test('lists recursively under a prefix, in order and bounded', async () => {
    await disk.put('list/b.txt', 'b');
    await disk.put('list/a.txt', 'a');
    await disk.put('list/nested/c.txt', 'c');
    await disk.put('listing-other.txt', 'x');

    expect(await disk.list('list')).toEqual(['list/a.txt', 'list/b.txt', 'list/nested/c.txt']);
    expect(await disk.list('list', { limit: 2 })).toHaveLength(2);
  });

  test('pages through a listing', async () => {
    await disk.put('pages/1.txt', '1');
    await disk.put('pages/2.txt', '2');
    await disk.put('pages/3.txt', '3');

    const first = await disk.listPage('pages', { limit: 2 });
    const second = await disk.listPage('pages', { limit: 2, ...(first.cursor ? { cursor: first.cursor } : {}) });

    expect(first.files).toHaveLength(2);
    expect(first.hasMore).toBe(true);
    expect([...first.files, ...second.files]).toEqual(['pages/1.txt', 'pages/2.txt', 'pages/3.txt']);
    expect(second.hasMore).toBe(false);
  });

  test('copies and moves', async () => {
    await disk.put('move/source.txt', 'body');

    await disk.copy('move/source.txt', 'move/copy.txt');
    await disk.move('move/source.txt', 'move/moved.txt');

    expect(text((await disk.get('move/copy.txt')).content)).toBe('body');
    expect(text((await disk.get('move/moved.txt')).content)).toBe('body');
    expect(await disk.exists('move/source.txt')).toBe(false);
  });

  test('deletes, and deleting a missing file is not an error', async () => {
    await disk.put('gone.txt', 'x');

    await disk.delete('gone.txt');
    await disk.delete('gone.txt');

    expect(await disk.exists('gone.txt')).toBe(false);
  });

  test('a signed read URL works, and the unsigned URL does not', async () => {
    await disk.put('signed/read.txt', 'signed body');

    const url = await disk.signedUrl('signed/read.txt', { expiresIn: 60 });
    const response = await fetch(url);

    expect(response.status).toBe(200);
    expect(await response.text()).toBe('signed body');
    expect((await fetch(url.split('?')[0] as string)).status).toBe(403);
  });

  test('a signed URL stops working once it expires', async () => {
    await disk.put('signed/short.txt', 'short');
    const url = await disk.signedUrl('signed/short.txt', { expiresIn: 1 });

    await Bun.sleep(2_100);

    expect((await fetch(url)).status).toBe(403);
  });

  test('path traversal is refused before reaching the server', async () => {
    expect(codeOf(await disk.put('../escape.txt', 'x').catch((error: unknown) => error))).toBe(
      'STORAGE_PATH_FORBIDDEN',
    );
  });

  test('stays inside its prefix', async () => {
    await disk.put('prefix-check.txt', 'x');

    const raw = await s3.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: `${_name}-suite/prefix-check` }));

    expect(raw.Contents?.map((object) => object.Key)).toEqual([`${_name}-suite/prefix-check.txt`]);
    expect(await disk.list('')).toContain('prefix-check.txt');
  });
});

describe('failure modes', () => {
  test('wrong credentials fail, and never show the secret', async () => {
    const disk = new KitDriverDisk({
      name: 'bad',
      driver: 's3',
      visibility: 'private',
      options: {
        bucket,
        region: 'us-east-1',
        endpoint: MINIO_URL,
        forcePathStyle: true,
        credentials: { accessKeyId: MINIO_USER, secretAccessKey: 'wrong-secret-value' },
      },
    });

    const failure = (await disk.put('x.txt', 'x').catch((error: unknown) => error)) as Error;

    expect(failure).toBeInstanceOf(Error);
    expect(failure.message).not.toContain('wrong-secret-value');
  });

  test('a missing bucket fails', async () => {
    const disk = new KitDriverDisk({
      name: 'nobucket',
      driver: 's3',
      visibility: 'private',
      options: {
        bucket: `missing-${crypto.randomUUID()}`,
        region: 'us-east-1',
        endpoint: MINIO_URL,
        forcePathStyle: true,
        credentials,
      },
    });

    await expect(disk.put('x.txt', 'x')).rejects.toBeInstanceOf(Error);
  });
});

describe('createStorageProvider', () => {
  test('boots a configured s3 disk and serves it', async () => {
    type Config = { readonly storage: StorageConfig };
    const config: Config = {
      storage: {
        default: 'files',
        disks: {
          files: {
            driver: 's3',
            visibility: 'private',
            options: {
              bucket,
              region: 'us-east-1',
              endpoint: MINIO_URL,
              forcePathStyle: true,
              credentials,
              prefix: 'app',
            },
          },
        },
      },
    };
    const application = await new Application<Config>({
      config,
      providers: [createStorageProvider<Config>()],
    }).boot();
    const disk = application.container.resolve(STORAGE);

    await disk.put('provider.txt', 'from the provider');

    expect(text((await disk.get('provider.txt')).content)).toBe('from the provider');
    await disk.delete('provider.txt');
    await application.shutdown();
  });
});
