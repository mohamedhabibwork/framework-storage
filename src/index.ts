// Public API of @framework/storage.
// Convention: every interface/type lives in `./types`; runtime values stay
// in their modules.
export { STORAGE, storageDiskToken } from './constants';
export type { StorageErrorCode } from './errors';
export { STORAGE_ERROR_CODES, StorageError } from './errors';
export { KitDriverDisk } from './kit-disk';
export { DEFAULT_LIST_LIMIT, LocalStorageDisk, MAX_LIST_LIMIT } from './local-disk';
// Path-safety helpers are re-exported so applications and CLI commands share
// the exact validation the disks run internally.
export { resolveInsideRoot, validateStoragePath } from './path-guard';
export { createStorageProvider } from './provider';
export { pruneTemp } from './temp';
// Grouped conventions: every type in ./types.
export type {
  DiskCapabilities,
  ListOptions,
  LocalDiskConfig,
  LocalDiskOptions,
  PutOptions,
  RemoteDiskConfig,
  RemoteDiskOptions,
  StorageConfig,
  StorageDisk,
  StorageDiskConfig,
  StorageDriverName,
  StoredFile,
  StoredFileMetadata,
  UploadGuardInput,
  Visibility,
} from './types';
export { assertUploadAllowed } from './upload-guard';
