import type { DriveFolderKind } from './googleDriveStorage'

export interface GoogleDriveFile {
  id: string
  name: string
  mimeType: string
  modifiedTime: string
  size?: string
  capabilities?: { canDownload?: boolean }
}

export class GoogleDriveError extends Error {
  constructor(message: string, readonly code: 'CONFIG' | 'AUTH' | 'API' | 'ACCESS' | 'NOT_FOUND' | 'DOWNLOAD' | 'PICKER') { super(message); this.name = 'GoogleDriveError' }
}

function driveError(status: number, detail = ''): GoogleDriveError {
  if (status === 401) return new GoogleDriveError('A autorização do Google Drive expirou. Reconecte o Google e tente novamente.', 'AUTH')
  if (status === 403) return new GoogleDriveError('O Google Drive recusou o acesso. Confirme o escopo de leitura e se a Google Drive API está habilitada.', 'ACCESS')
  if (status === 404) return new GoogleDriveError('A pasta ou arquivo não existe mais ou não está acessível nesta conta Google.', 'NOT_FOUND')
  return new GoogleDriveError(detail || `O Google Drive respondeu com erro HTTP ${status}.`, 'API')
}

export async function listGoogleDriveFolder(folderId: string, accessToken: string, fetcher: typeof fetch = fetch): Promise<GoogleDriveFile[]> {
  const files: GoogleDriveFile[] = []
  let pageToken = ''
  do {
    const params = new URLSearchParams({
      q: `'${folderId.replaceAll("'", "\\'")}' in parents and trashed = false`,
      fields: 'nextPageToken,files(id,name,mimeType,modifiedTime,size,capabilities(canDownload))',
      pageSize: '1000', orderBy: 'name',
    })
    if (pageToken) params.set('pageToken', pageToken)
    let response: Response
    try { response = await fetcher(`https://www.googleapis.com/drive/v3/files?${params}`, { headers: { Authorization: `Bearer ${accessToken}` } }) }
    catch { throw new GoogleDriveError('Não foi possível conectar à Google Drive API.', 'API') }
    if (!response.ok) throw driveError(response.status)
    const result = await response.json() as { files?: GoogleDriveFile[]; nextPageToken?: string }
    files.push(...(result.files ?? []))
    pageToken = result.nextPageToken ?? ''
  } while (pageToken)
  return files
}

export async function downloadGoogleDriveFile(fileId: string, accessToken: string, fetcher: typeof fetch = fetch): Promise<Blob> {
  let response: Response
  try { response = await fetcher(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?alt=media`, { headers: { Authorization: `Bearer ${accessToken}` } }) }
  catch { throw new GoogleDriveError('Não foi possível baixar o arquivo do Google Drive.', 'DOWNLOAD') }
  if (!response.ok) throw driveError(response.status)
  try { return await response.blob() } catch { throw new GoogleDriveError('O arquivo foi localizado, mas não pôde ser lido neste dispositivo.', 'DOWNLOAD') }
}

export function isSupportedDriveFile(file: GoogleDriveFile, kind: DriveFolderKind): boolean {
  const name = file.name.toLocaleLowerCase('pt-BR')
  if (kind === 'invoices') return file.mimeType === 'application/pdf' || name.endsWith('.pdf')
  return name.endsWith('.csv') || ['text/csv', 'application/vnd.ms-excel', 'application/csv'].includes(file.mimeType)
}

type PickerDocument = { id: string; name: string; mimeType: string }
type PickerApi = {
  Action: { PICKED: string; CANCEL: string }
  ViewId: { FOLDERS: string }
  DocsView: new (viewId: string) => { setMimeTypes: (types: string) => unknown; setSelectFolderEnabled: (enabled: boolean) => unknown; setIncludeFolders: (enabled: boolean) => unknown }
  PickerBuilder: new () => {
    addView: (view: unknown) => unknown; setOAuthToken: (token: string) => unknown; setDeveloperKey: (key: string) => unknown
    setAppId: (id: string) => unknown; setCallback: (callback: (data: { action?: string; docs?: PickerDocument[] }) => void) => unknown
    build: () => { setVisible: (visible: boolean) => void }
  }
}
type GoogleApi = { load: (api: string, options: { callback: () => void }) => void; picker?: PickerApi }
declare global { interface Window { gapi?: GoogleApi } }
let pickerScriptPromise: Promise<PickerApi> | null = null

async function loadPicker(): Promise<PickerApi> {
  const googleWithPicker = window as Window & { google?: { picker?: PickerApi } }
  if (googleWithPicker.google?.picker) return googleWithPicker.google.picker
  if (!pickerScriptPromise) pickerScriptPromise = new Promise((resolve, reject) => {
    const ready = () => {
      const gapi = window.gapi
      if (!gapi) { pickerScriptPromise = null; reject(new GoogleDriveError('Não foi possível carregar o seletor Google Drive.', 'PICKER')); return }
      gapi.load('picker', { callback: () => {
        const api = (window as Window & { google?: { picker?: PickerApi } }).google?.picker ?? gapi.picker
        if (api) resolve(api)
        else { pickerScriptPromise = null; reject(new GoogleDriveError('O seletor Google Drive não ficou disponível.', 'PICKER')) }
      } })
    }
    const failed = () => { pickerScriptPromise = null; reject(new GoogleDriveError('Não foi possível carregar o seletor Google Drive.', 'PICKER')) }
    const existing = document.querySelector<HTMLScriptElement>('script[data-google-api]')
    if (window.gapi) ready()
    else if (existing) { existing.addEventListener('load', ready, { once: true }); existing.addEventListener('error', failed, { once: true }) }
    else {
      const script = document.createElement('script'); script.src = 'https://apis.google.com/js/api.js'; script.async = true; script.defer = true; script.dataset.googleApi = 'true'
      script.onload = ready; script.onerror = failed; document.head.appendChild(script)
    }
  })
  return pickerScriptPromise
}

export async function selectGoogleDriveFolder(accessToken: string, apiKey: string, projectNumber: string): Promise<{ id: string; name: string } | null> {
  if (!apiKey.trim() || !projectNumber.trim()) throw new GoogleDriveError('Configure VITE_GOOGLE_API_KEY e VITE_GOOGLE_PROJECT_NUMBER para usar o seletor de pastas do Drive.', 'CONFIG')
  const picker = await loadPicker()
  const view = new picker.DocsView(picker.ViewId.FOLDERS)
  view.setMimeTypes('application/vnd.google-apps.folder')
  view.setIncludeFolders(true)
  view.setSelectFolderEnabled(true)
  return new Promise((resolve, reject) => {
    try {
      const builder = new picker.PickerBuilder()
      builder.addView(view); builder.setOAuthToken(accessToken); builder.setDeveloperKey(apiKey); builder.setAppId(projectNumber)
      builder.setCallback((data) => {
        if (data.action === picker.Action.CANCEL) resolve(null)
        else if (data.action === picker.Action.PICKED) {
          const folder = data.docs?.[0]
          if (!folder?.id || !folder.name) reject(new GoogleDriveError('O seletor não retornou uma pasta válida.', 'PICKER'))
          else resolve({ id: folder.id, name: folder.name })
        }
      })
      builder.build().setVisible(true)
    } catch { reject(new GoogleDriveError('Não foi possível abrir o seletor de pastas Google Drive.', 'PICKER')) }
  })
}
