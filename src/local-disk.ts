import { resolve } from 'node:path';
import { ConfigError } from '@framework/core';
import { KitBackedDisk } from './kit-disk';

// The list bounds are defined with the shared kit-backed disk and re-exported
// here to keep `@framework/storage`'s historical import surface stable.
export { DEFAULT_LIST_LIMIT, MAX_LIST_LIMIT } from './kit-disk';

import { resolveInsideRoot, validateStoragePath } from './path-guard';
import type { DiskCapabilities, LocalDiskOptions } from './types';

/**
 * Local-filesystem disk. File operations are delegated to storagekit's local
 * driver (`createStorage({ type: 'local', ... })`), while this class keeps
 * owning the framework concerns: the path guard runs in front of every kit
 * call (see `path-guard.ts`) and kit errors are mapped onto the framework's
 * error catalog (see `kit.ts`).
 *
 * Each disk owns exactly one root directory; private and public disks are
 * separate instances with separate roots, so a private file is never
 * reachable through a public base URL.
 */
export class LocalStorageDisk extends KitBackedDisk {
  override readonly driver = 'local' as const;
  override readonly capabilities: DiskCapabilities = { streaming: true, signedUrls: false };
  /** Absolute filesystem root; every path resolution is checked against it. */
  readonly root: string;

  constructor(options: LocalDiskOptions) {
    if (typeof options.root !== 'string' || options.root.trim().length === 0) {
      throw new ConfigError([`Disk "${options.name}": root must be a non-empty directory path`]);
    }
    super({ name: options.name, visibility: options.visibility, publicBaseUrl: options.publicBaseUrl });
    this.root = resolve(options.root);
  }

  protected override kitOptions(): Record<string, unknown> {
    // storagekit local options (see `LocalStorageConfig`): root is required,
    // baseUrl powers nothing the framework uses (publicUrl stays synchronous
    // and framework-owned) but keeps kit-side `getUrl` working for tooling.
    const options: Record<string, unknown> = { root: this.root };
    const baseUrl = this.publicBaseUrl;
    if (baseUrl !== undefined) options.baseUrl = baseUrl;
    return options;
  }

  protected override guard(path: string): string {
    // Defense in depth: the charset/segment rules first, then the final
    // root-escape check, before storagekit ever resolves the key.
    resolveInsideRoot(this.root, path);
    return validateStoragePath(path);
  }

  protected override statNativeOptions(): Record<string, unknown> {
    // Follow symlinks, matching the `fs.stat` semantics this disk had before
    // the storagekit delegation (the kit defaults to `lstat`).
    return { followSymlinks: true };
  }
}
