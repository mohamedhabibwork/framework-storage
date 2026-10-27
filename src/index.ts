// Public API of @framework/storage.
// Convention: every interface/type lives in `./types`; runtime values stay
// in their modules.
export {
  listStorageTypes,
  registerStorageDriver,
  type StorageDriverFactory,
  unregisterStorageDriver,
} from '@mohamedhabibwork/storagekit';
export { STORAGE, STORAGE_DRIVER_NAMES, storageDiskToken } from './constants';
export type { StorageErrorCode } from './errors';
export { STORAGE_ERROR_CODES, StorageError } from './errors';
export type { KitFileStat, KitStorage } from './kit';
export { createKitStorage, mapKitError } from './kit';
export type { KitDiskOptions } from './kit-disk';
export { KitBackedDisk, KitDriverDisk } from './kit-disk';
export { DEFAULT_LIST_LIMIT, LocalStorageDisk, MAX_LIST_LIMIT } from './local-disk';
// Path-safety helpers are re-exported so applications and CLI commands share
// the exact validation the disks run internally.
export { resolveInsideRoot, validateStoragePath } from './path-guard';
export {
  createStorageProvider,
  localDiskSchema,
  remoteDiskSchema,
  storageConfigSchema,
  storageDiskConfigSchema,
} from './provider';
export { pruneTemp } from './temp';
// Grouped conventions: every type in ./types.
export type {
  ByteRange,
  CopyOptions,
  DeleteOptions,
  DiskCapabilities,
  ListOptions,
  ListPage,
  LocalDiskConfig,
  LocalDiskOptions,
  MoveOptions,
  MultipartOptions,
  NativeOptions,
  PutOptions,
  ReadOptions,
  SignedUrlAction,
  SignedUrlOptions,
  StatOptions,
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
