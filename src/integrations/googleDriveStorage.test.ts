import { beforeEach, describe, expect, it } from 'vitest'
import { isDriveFileUnchanged, loadDriveFileIndex, loadDriveFolders, loadDriveLastSync, saveDriveFileIndex, saveDriveFolders, saveDriveLastSync } from './googleDriveStorage'

describe('metadados locais do Google Drive', () => {
  beforeEach(() => localStorage.clear())

  it('persiste pastas selecionadas e restaura seus IDs e nomes após reload', () => {
    const folders = { invoices: { id: 'invoice-folder-id', name: 'Faturas' }, statements: { id: 'statement-folder-id', name: 'Extratos' } }
    saveDriveFolders(folders)
    expect(loadDriveFolders()).toEqual(folders)
  })

  it('salva somente metadados do índice e horário, sem token nem conteúdo financeiro', () => {
    saveDriveFileIndex({ 'drive-id': { driveFileId: 'drive-id', modifiedTime: '2026-10-06T09:00:00Z', size: '123', mimeType: 'application/pdf', kind: 'invoices', folderId: 'folder', processingStatus: 'PROCESSED' } })
    saveDriveLastSync('2026-10-06T09:01:00Z')
    const serialized = Array.from({ length: localStorage.length }, (_, index) => localStorage.getItem(localStorage.key(index)!) ?? '').join(' ')
    expect(loadDriveFileIndex()['drive-id'].processingStatus).toBe('PROCESSED')
    expect(loadDriveLastSync()).toBe('2026-10-06T09:01:00Z')
    expect(serialized).not.toContain('access_token')
    expect(serialized).not.toContain('memory-token')
    expect(serialized).not.toContain('transaction')
    expect(serialized).not.toContain('blob:')
  })

  it('só considera arquivo sem alteração depois que ele foi processado nesta sessão', () => {
    const file = { id: 'id', modifiedTime: 'v1', size: '10', mimeType: 'text/csv' }
    const previous = { driveFileId: 'id', modifiedTime: 'v1', size: '10', mimeType: 'text/csv', kind: 'statements' as const, folderId: 'folder', processingStatus: 'PROCESSED' as const }
    expect(isDriveFileUnchanged(file, previous, 'v1', 'statements', 'folder')).toBe(true)
    expect(isDriveFileUnchanged(file, previous, undefined, 'statements', 'folder')).toBe(false)
    expect(isDriveFileUnchanged({ ...file, modifiedTime: 'v2' }, previous, 'v2', 'statements', 'folder')).toBe(false)
    expect(isDriveFileUnchanged(file, { ...previous, processingStatus: 'ERROR' }, 'v1', 'statements', 'folder')).toBe(false)
  })
})
