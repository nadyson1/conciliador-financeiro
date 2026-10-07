export type DriveFolderKind = 'invoices' | 'statements'
export interface SavedDriveFolder { id: string; name: string }
export interface SavedDriveFolders { invoices: SavedDriveFolder | null; statements: SavedDriveFolder | null }
export interface DriveFileIndexEntry {
  driveFileId: string
  modifiedTime: string
  size: string | null
  mimeType: string
  kind: DriveFolderKind
  folderId: string
  processingStatus: 'PROCESSED' | 'ERROR'
}
export interface DriveFolderSnapshot { folderId: string; fileIds: string[] }
export type DriveFolderSnapshots = Partial<Record<DriveFolderKind, DriveFolderSnapshot>>

export function isDriveFileUnchanged(file: { id: string; modifiedTime: string; size?: string; mimeType: string }, previous: DriveFileIndexEntry | undefined, processedModifiedTime: string | undefined, kind: DriveFolderKind, folderId: string): boolean {
  return processedModifiedTime === (file.modifiedTime ?? '')
    && previous?.processingStatus === 'PROCESSED'
    && previous.driveFileId === file.id
    && previous.modifiedTime === (file.modifiedTime ?? '')
    && previous.size === (file.size ?? null)
    && previous.mimeType === file.mimeType
    && previous.kind === kind
    && previous.folderId === folderId
}

const FOLDERS_KEY = 'conciliador.google-drive.folders.v1'
const INDEX_KEY = 'conciliador.google-drive.file-index.v1'
const LAST_SYNC_KEY = 'conciliador.google-drive.last-sync.v1'
const FOLDER_SNAPSHOTS_KEY = 'conciliador.google-drive.folder-snapshots.v1'
const emptyFolders: SavedDriveFolders = { invoices: null, statements: null }

export function loadDriveFolders(storage: Storage = localStorage): SavedDriveFolders {
  try {
    const value = JSON.parse(storage.getItem(FOLDERS_KEY) ?? 'null') as Partial<SavedDriveFolders> | null
    return value ? { invoices: value.invoices ?? null, statements: value.statements ?? null } : emptyFolders
  } catch { return emptyFolders }
}

export function saveDriveFolders(folders: SavedDriveFolders, storage: Storage = localStorage): void {
  storage.setItem(FOLDERS_KEY, JSON.stringify(folders))
}

export function loadDriveFileIndex(storage: Storage = localStorage): Record<string, DriveFileIndexEntry> {
  try {
    const value = JSON.parse(storage.getItem(INDEX_KEY) ?? '{}') as Record<string, DriveFileIndexEntry>
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {}
  } catch { return {} }
}

export function saveDriveFileIndex(index: Record<string, DriveFileIndexEntry>, storage: Storage = localStorage): void {
  storage.setItem(INDEX_KEY, JSON.stringify(index))
}

export function clearDriveFileIndex(storage: Storage = localStorage): void { storage.removeItem(INDEX_KEY) }
export function loadDriveFolderSnapshots(storage: Storage = localStorage): DriveFolderSnapshots {
  try {
    const value = JSON.parse(storage.getItem(FOLDER_SNAPSHOTS_KEY) ?? '{}') as DriveFolderSnapshots
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {}
  } catch { return {} }
}
export function saveDriveFolderSnapshots(snapshots: DriveFolderSnapshots, storage: Storage = localStorage): void {
  storage.setItem(FOLDER_SNAPSHOTS_KEY, JSON.stringify(snapshots))
}
/** A first listing establishes a baseline; only IDs absent from the same folder's previous snapshot are missing. */
export function missingDriveFileIds(previous: DriveFolderSnapshot | undefined, folderId: string, currentFileIds: string[]): string[] {
  if (!previous || previous.folderId !== folderId) return []
  const current = new Set(currentFileIds)
  return previous.fileIds.filter((id) => !current.has(id))
}
export function loadDriveLastSync(storage: Storage = localStorage): string | null { return storage.getItem(LAST_SYNC_KEY) }
export function saveDriveLastSync(value: string, storage: Storage = localStorage): void { storage.setItem(LAST_SYNC_KEY, value) }
