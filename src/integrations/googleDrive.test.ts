import { describe, expect, it, vi } from 'vitest'
import { downloadGoogleDriveFile, GoogleDriveError, isSupportedDriveFile, listGoogleDriveFolder, selectGoogleDriveFolder } from './googleDrive'

const response = (body: unknown, status = 200, blob = new Blob(['local'])) => ({ ok: status >= 200 && status < 300, status, json: async () => body, blob: async () => blob }) as Response

describe('Google Drive somente como fonte de arquivos', () => {
  it('lista arquivos da pasta solicitada com token de leitura e segue páginas', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(response({ files: [{ id: 'pdf-1', name: 'fatura.pdf', mimeType: 'application/pdf', modifiedTime: '2026-10-01' }], nextPageToken: 'next' }))
      .mockResolvedValueOnce(response({ files: [{ id: 'csv-1', name: 'extrato.csv', mimeType: 'text/csv', modifiedTime: '2026-10-02' }] }))
    const files = await listGoogleDriveFolder('folder-1', 'memory-token', fetcher)
    expect(files.map((file) => file.id)).toEqual(['pdf-1', 'csv-1'])
    expect(fetcher).toHaveBeenCalledTimes(2)
    expect(fetcher.mock.calls.every((call) => (call[1] as RequestInit).method == null)).toBe(true)
    expect((fetcher.mock.calls[0][1] as RequestInit).headers).toEqual({ Authorization: 'Bearer memory-token' })
    expect(new URL(fetcher.mock.calls[0][0] as string).searchParams.get('q')).toContain("'folder-1' in parents")
  })

  it('baixa somente conteúdo em memória sem qualquer chamada de escrita', async () => {
    const fetcher = vi.fn().mockResolvedValue(response(null, 200, new Blob(['csv local'])))
    const blob = await downloadGoogleDriveFile('file/id', 'memory-token', fetcher)
    expect(await blob.text()).toBe('csv local')
    expect(fetcher).toHaveBeenCalledWith('https://www.googleapis.com/drive/v3/files/file%2Fid?alt=media', { headers: { Authorization: 'Bearer memory-token' } })
    expect(['POST', 'PATCH', 'PUT', 'DELETE']).not.toContain((fetcher.mock.calls[0][1] as RequestInit).method)
  })

  it('converte erros de permissão, arquivo removido e token expirado em mensagens específicas', async () => {
    for (const [status, code] of [[401, 'AUTH'], [403, 'ACCESS'], [404, 'NOT_FOUND']] as const) {
      await expect(listGoogleDriveFolder('folder', 'token', vi.fn().mockResolvedValue(response({}, status)))).rejects.toMatchObject({ code })
    }
    await expect(downloadGoogleDriveFile('file', 'token', vi.fn().mockResolvedValue(response({}, 403)))).rejects.toBeInstanceOf(GoogleDriveError)
  })

  it('filtra por conteúdo/tipo, ignorando arquivos que não pertencem à pasta', () => {
    expect(isSupportedDriveFile({ id: 'a', name: 'invoice.PDF', mimeType: 'application/octet-stream', modifiedTime: '' }, 'invoices')).toBe(true)
    expect(isSupportedDriveFile({ id: 'b', name: 'data.csv', mimeType: 'text/plain', modifiedTime: '' }, 'statements')).toBe(true)
    expect(isSupportedDriveFile({ id: 'c', name: 'notes.txt', mimeType: 'text/plain', modifiedTime: '' }, 'statements')).toBe(false)
    expect(isSupportedDriveFile({ id: 'd', name: 'sheet.csv', mimeType: 'text/csv', modifiedTime: '' }, 'invoices')).toBe(false)
  })

  it('usa o Picker oficial para seleção explícita de pastas', async () => {
    const setMimeTypes = vi.fn(), setIncludeFolders = vi.fn(), setSelectFolderEnabled = vi.fn(), setVisible = vi.fn()
    let pickerCallback: (data: { action?: string; docs?: { id: string; name: string }[] }) => void = () => undefined
    const picker = {
      Action: { PICKED: 'picked', CANCEL: 'cancel' }, ViewId: { FOLDERS: 'folders' },
      DocsView: vi.fn(function () { return { setMimeTypes, setIncludeFolders, setSelectFolderEnabled } }),
      PickerBuilder: vi.fn(function () { return { addView: vi.fn(), setOAuthToken: vi.fn(), setDeveloperKey: vi.fn(), setAppId: vi.fn(), setCallback: (callback: typeof pickerCallback) => { pickerCallback = callback }, build: () => ({ setVisible }) } }),
    }
    ;(window as unknown as { google?: unknown }).google = { picker }
    const pending = selectGoogleDriveFolder('memory-token', 'api-key', '123456')
    await Promise.resolve()
    pickerCallback({ action: 'picked', docs: [{ id: 'folder-id', name: 'Faturas' }] })
    await expect(pending).resolves.toEqual({ id: 'folder-id', name: 'Faturas' })
    expect(setMimeTypes).toHaveBeenCalledWith('application/vnd.google-apps.folder')
    expect(setIncludeFolders).toHaveBeenCalledWith(true)
    expect(setSelectFolderEnabled).toHaveBeenCalledWith(true)
    expect(setVisible).toHaveBeenCalledWith(true)
  })
})
