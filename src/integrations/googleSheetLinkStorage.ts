const STORAGE_KEY = 'conciliador.googleSheets.link.v1'
export const GOOGLE_SHEET_TAB_NAME = 'CUSTOS ANO'

export interface SavedGoogleSheetLink {
  spreadsheetId: string
  sheetName: typeof GOOGLE_SHEET_TAB_NAME
  spreadsheetTitle: string
  lastUpdated: string | null
  autoConnect: boolean
}

export function loadGoogleSheetLink(storage: Storage = localStorage): SavedGoogleSheetLink | null {
  try {
    const raw = storage.getItem(STORAGE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as Partial<SavedGoogleSheetLink>
    if (typeof parsed.spreadsheetId !== 'string' || !/^[a-zA-Z0-9_-]{10,}$/.test(parsed.spreadsheetId)
      || parsed.sheetName !== GOOGLE_SHEET_TAB_NAME) return null
    return {
      spreadsheetId: parsed.spreadsheetId,
      sheetName: GOOGLE_SHEET_TAB_NAME,
      spreadsheetTitle: typeof parsed.spreadsheetTitle === 'string' ? parsed.spreadsheetTitle : 'Planilha Google',
      lastUpdated: typeof parsed.lastUpdated === 'string' ? parsed.lastUpdated : null,
      autoConnect: parsed.autoConnect !== false,
    }
  } catch { return null }
}

export function saveGoogleSheetLink(link: SavedGoogleSheetLink, storage: Storage = localStorage): void {
  storage.setItem(STORAGE_KEY, JSON.stringify({
    spreadsheetId: link.spreadsheetId,
    sheetName: GOOGLE_SHEET_TAB_NAME,
    spreadsheetTitle: link.spreadsheetTitle,
    lastUpdated: link.lastUpdated,
    autoConnect: link.autoConnect,
  }))
}

export function forgetGoogleSheetLink(storage: Storage = localStorage): void {
  storage.removeItem(STORAGE_KEY)
}
