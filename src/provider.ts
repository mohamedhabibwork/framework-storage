import { ConfigError, defineProvider, type ServiceProvider } from '@framework/core';
import { z } from 'zod/v4';
import { STORAGE, storageDiskToken } from './constants';
import { type KitBackedDisk, KitDriverDisk } from './kit-disk';
import { LocalStorageDisk } from './local-disk';
import type { LocalDiskConfig, RemoteDiskConfig, StorageConfig } from './types';

export { STORAGE, storageDiskToken };

const DISK_NAME = /^[a-zA-Z0-9._-]+$/;

/**
 * Schema for `local` disks — the only driver whose configuration is validated
 * here in full. storagekit re-validates the kit-side options when the engine
 * instance is created.
 */
export const localDiskSchema = z.object({
  driver: z.literal('local'),
  root: z.string().min(1),
  visibility: z.enum(['private', 'public']),
  publicBaseUrl: z.string().min(1).optional(),
});

/**
 * Schema for storagekit cloud drivers (`s3`, `r2`, `gcs`, ...): only the
 * framework-owned fields are checked; the `options` bag is forwarded verbatim
 * to storagekit's `createStorage` and is that driver's own contract (bad or
 * missing kit options — including an uninstalled peer SDK — fail with
 * `STORAGE_DRIVER_UNAVAILABLE`).
 */
export const remoteDiskSchema = z.object({
  driver: z.string().min(1),
  visibility: z.enum(['private', 'public']).default('private'),
  publicBaseUrl: z.string().min(1).optional(),
  options: z.record(z.string(), z.unknown()).optional(),
});

/** Schema for one `storage.disks` entry (`local` or remote storagekit driver). */
export const storageDiskConfigSchema = z.union([localDiskSchema, remoteDiskSchema]);

/** Validated shape of the application's `storage` configuration section. */
export const storageConfigSchema = z.object({
  default: z.string().min(1).default('local'),
  disks: z.record(z.string(), storageDiskConfigSchema),
});

function zodIssues(label: string, error: z.ZodError): string[] {
  return error.issues.map(
    (issue) => `${label}${issue.path.length > 0 ? `.${issue.path.map(String).join('.')}` : ''}: ${issue.message}`,
  );
}

function requirePublicBaseUrl(label: string, visibility: string, publicBaseUrl: string | undefined): string[] {
  if (visibility === 'public' && publicBaseUrl === undefined) {
    return [`${label}: public disks must declare publicBaseUrl`];
  }
  return [];
}

function parseLocalDisk(name: string, entry: unknown): LocalDiskConfig {
  const label = `storage.disks.${name}`;
  const parsed = localDiskSchema.safeParse(entry);
  if (!parsed.success) throw new ConfigError(zodIssues(label, parsed.error));
  const issues = requirePublicBaseUrl(label, parsed.data.visibility, parsed.data.publicBaseUrl);
  if (issues.length > 0) throw new ConfigError(issues);
  return parsed.data;
}

function parseRemoteDisk(name: string, entry: unknown): RemoteDiskConfig {
  const label = `storage.disks.${name}`;
  const parsed = remoteDiskSchema.safeParse(entry);
  if (!parsed.success) throw new ConfigError(zodIssues(label, parsed.error));
  const issues = requirePublicBaseUrl(label, parsed.data.visibility, parsed.data.publicBaseUrl);
  if (issues.length > 0) throw new ConfigError(issues);
  return parsed.data as RemoteDiskConfig;
}

/** One validated disk entry, tagged with the implementation that will serve it. */
type ValidatedDisk =
  | { readonly kind: 'local'; readonly config: LocalDiskConfig }
  | { readonly kind: 'remote'; readonly config: RemoteDiskConfig };

/**
 * Validates the `storage` section and returns the validated per-disk configs.
 * `local` disks get the zod schema above; cloud disks only declare their
 * driver plus framework-owned visibility fields. Unavailable drivers are
 * *not* a config error — they surface as `STORAGE_DRIVER_UNAVAILABLE` when
 * the disk's storagekit instance is created (boot or first use).
 */
function validateStorageConfig(config: StorageConfig): Map<string, ValidatedDisk> {
  const issues: string[] = [];
  if (typeof config.default !== 'string' || config.default.length === 0) {
    issues.push('storage.default must name the default disk');
  } else if (!(config.default in config.disks)) {
    issues.push(`storage.default references unknown disk "${config.default}"`);
  }
  const validated = new Map<string, ValidatedDisk>();
  for (const [name, disk] of Object.entries(config.disks)) {
    if (!DISK_NAME.test(name)) {
      issues.push(`storage.disks: invalid disk name "${name}"`);
      continue;
    }
    try {
      validated.set(
        name,
        disk.driver === 'local'
          ? { kind: 'local', config: parseLocalDisk(name, disk) }
          : { kind: 'remote', config: parseRemoteDisk(name, disk) },
      );
    } catch (error) {
      if (error instanceof ConfigError) issues.push(...error.issues);
      else throw error;
    }
  }
  if (issues.length > 0) throw new ConfigError(issues);
  return validated;
}

/**
 * Registers the configured storage disks (spec §8). Every entry of
 * `storage.disks` becomes a singleton under `storageDiskToken(name)`, and the
 * `storage.default` disk is additionally bound to `STORAGE`. Applications add
 * it to their provider list after the core provider.
 *
 * `local` disks are handled by `LocalStorageDisk`; every other driver is
 * constructed through storagekit's `createStorage` switch (`KitDriverDisk`)
 * and requires that driver's peer SDK. Boot creates every disk's engine
 * instance eagerly, so an unavailable driver fails boot with
 * `STORAGE_DRIVER_UNAVAILABLE` instead of failing on the first file
 * operation. storagekit keeps no closeable resources, so there is nothing to
 * dispose at shutdown.
 */
export function createStorageProvider<TConfig extends { readonly storage: StorageConfig }>(): ServiceProvider<TConfig> {
  // Disks built during `register`; booted eagerly below so an unavailable
  // driver (unknown type, missing peer SDK, invalid kit options) fails boot
  // with STORAGE_DRIVER_UNAVAILABLE instead of failing on the first file
  // operation.
  const instances: KitBackedDisk[] = [];
  return defineProvider<TConfig>({
    name: 'storage',
    register({ container, config }) {
      const storage = config.storage;
      const disks = validateStorageConfig(storage);
      for (const [name, disk] of disks) {
        const instance: KitBackedDisk =
          disk.kind === 'local'
            ? new LocalStorageDisk({
                name,
                root: disk.config.root,
                visibility: disk.config.visibility,
                ...(disk.config.publicBaseUrl !== undefined ? { publicBaseUrl: disk.config.publicBaseUrl } : {}),
              })
            : new KitDriverDisk({
                name,
                driver: disk.config.driver,
                visibility: disk.config.visibility,
                options: disk.config.options,
                ...(disk.config.publicBaseUrl !== undefined ? { publicBaseUrl: disk.config.publicBaseUrl } : {}),
              });
        instances.push(instance);
        container.singleton(storageDiskToken(name), () => instance);
      }
      container.singleton(STORAGE, (r) => r.resolve(storageDiskToken(storage.default)));
    },
    async boot() {
      await Promise.all(instances.map((instance) => instance.ready()));
    },
  });
}
