import type { LedgerTransaction } from '../domain/types'
import { initialColumnMap, normalizeHeader } from '../importers/csv'
import { parseLedgerRows } from '../importers/transactions'

export const GOOGLE_SHEETS_READ_SCOPE = 'https://www.googleapis.com/auth/spreadsheets.readonly'
const SHEET_NAME = 'CUSTOS ANO'
const REQUIRED_SHEET_COLUMNS = ['description', 'date', 'month', 'year', 'category', 'amount', 'paymentMethod', 'isFixed', 'isEssential', 'id'] as const
const COLUMN_NAMES: Record<(typeof REQUIRED_SHEET_COLUMNS)[number], string> = {
  description: 'Descrição', date: 'Data', month: 'Mês', year: 'Ano', category: 'Categoria', amount: 'Custo',
  paymentMethod: 'Forma de pagamento', isFixed: 'É fixo?', isEssential: 'É essencial?', id: 'ID',
}

type GoogleTokenResponse = { access_token?: string; error?: string; error_description?: string }
type GoogleTokenClient = { requestAccessToken: (options?: { prompt?: string }) => void }
type GoogleIdentity = {
  accounts: { oauth2: {
    initTokenClient: (options: { client_id: string; scope: string; include_granted_scopes: boolean; callback: (response: GoogleTokenResponse) => void; error_callback?: (error: { type?: string; message?: string }) => void }) => GoogleTokenClient
    revoke: (token: string, callback?: () => void) => void
  } }
}

declare global {
  interface Window { google?: GoogleIdentity }
}

export interface GoogleSheetReadResult {
  spreadsheetId: string
  spreadsheetTitle: string
  transactions: LedgerTransaction[]
  rowCount: number
}

export class GoogleSheetsError extends Error {
  constructor(message: string, readonly code: 'CONFIG' | 'AUTH' | 'NOT_FOUND' | 'ACCESS' | 'TAB_MISSING' | 'HEADERS' | 'DUPLICATE_ID' | 'EMPTY' | 'NETWORK' | 'API') {
    super(message)
    this.name = 'GoogleSheetsError'
  }
}

let identityScriptPromise: Promise<GoogleIdentity> | null = null

function loadGoogleIdentityServices(): Promise<GoogleIdentity> {
  if (window.google?.accounts.oauth2) return Promise.resolve(window.google)
  if (!identityScriptPromise) identityScriptPromise = new Promise((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>('script[data-google-identity-services]')
    const script = existing ?? document.createElement('script')
    const failed = () => { identityScriptPromise = null; reject(new GoogleSheetsError('Não foi possível carregar a autenticação do Google. Verifique a conexão e tente novamente.', 'NETWORK')) }
    script.addEventListener('error', failed, { once: true })
    script.addEventListener('load', () => window.google?.accounts.oauth2 ? resolve(window.google) : failed(), { once: true })
    if (!existing) {
      script.src = 'https://accounts.google.com/gsi/client'
      script.async = true
      script.defer = true
      script.dataset.googleIdentityServices = 'true'
      document.head.appendChild(script)
    }
  })
  return identityScriptPromise
}

export async function requestGoogleSheetsAccessToken(clientId: string, prompt?: string): Promise<string> {
  if (!clientId.trim()) throw new GoogleSheetsError('Configure VITE_GOOGLE_CLIENT_ID para ativar a conexão com Google Sheets.', 'CONFIG')
  const google = await loadGoogleIdentityServices()
  return new Promise((resolve, reject) => {
    let settled = false
    const client = google.accounts.oauth2.initTokenClient({
      client_id: clientId.trim(), scope: GOOGLE_SHEETS_READ_SCOPE, include_granted_scopes: true,
      callback: (response) => {
        if (settled) return
        settled = true
        if (response.access_token) resolve(response.access_token)
        else reject(new GoogleSheetsError(response.error_description || 'O Google não autorizou o acesso de leitura à planilha.', 'AUTH'))
      },
      error_callback: (error) => {
        if (settled) return
        settled = true
        reject(new GoogleSheetsError(error.message || 'A janela de autorização foi bloqueada ou fechada.', 'AUTH'))
      },
    })
    // Leave the prompt unspecified for user-driven requests: GIS reuses an
    // existing grant and asks for consent only when it is actually needed.
    // An empty prompt is reserved for the one-time startup/token-renewal
    // attempt, where GIS must not open an account or consent chooser.
    if (prompt === undefined) client.requestAccessToken()
    else client.requestAccessToken({ prompt })
  })
}

export function revokeGoogleSheetsAccessToken(token: string): void {
  if (token && window.google?.accounts.oauth2) window.google.accounts.oauth2.revoke(token, () => undefined)
}

export function extractSpreadsheetId(input: string): string {
  const value = input.trim()
  const match = value.match(/\/spreadsheets\/d\/([a-zA-Z0-9_-]+)/)
  const id = match?.[1] ?? value
  if (!/^[a-zA-Z0-9_-]{10,}$/.test(id)) throw new GoogleSheetsError('Informe a URL completa ou o ID válido da planilha Google.', 'CONFIG')
  return id
}

export function mapGoogleSheetValues(values: unknown[][]): LedgerTransaction[] {
  const headers = (values[0] ?? []).map((value) => String(value ?? '').trim())
  const map = initialColumnMap(headers, 'sheet')
  const missing = REQUIRED_SHEET_COLUMNS.filter((key) => !map[key])
  if (missing.length) {
    throw new GoogleSheetsError(`Cabeçalhos ausentes ou alterados na aba CUSTOS ANO: ${missing.map((key) => COLUMN_NAMES[key]).join(', ')}.`, 'HEADERS')
  }
  const normalizedHeaders = headers.map(normalizeHeader)
  const duplicated = normalizedHeaders.find((header, index) => Boolean(header) && normalizedHeaders.indexOf(header) !== index)
  if (duplicated) throw new GoogleSheetsError(`Há cabeçalhos repetidos na aba CUSTOS ANO: ${headers[normalizedHeaders.indexOf(duplicated)]}.`, 'HEADERS')
  const rows = values.slice(1).map((valuesRow) => Object.fromEntries(headers.map((header, index) => [header, String(valuesRow[index] ?? '').trim()])))
    .filter((row) => Object.values(row).some(Boolean))
  const nonEmptyIds = rows.map((row) => row[map.id!]).filter(Boolean)
  if (new Set(nonEmptyIds).size !== nonEmptyIds.length) throw new GoogleSheetsError('A coluna ID contém valores repetidos. A leitura foi interrompida para preservar a identidade dos lançamentos.', 'DUPLICATE_ID')
  const parsed = parseLedgerRows(rows, map)
  if (parsed.issues.length) throw new GoogleSheetsError(`A aba CUSTOS ANO contém ${parsed.issues.length} linha(s) com Data, Descrição ou Custo inválido. Corrija os dados na planilha e atualize novamente; os dados atuais foram mantidos.`, 'EMPTY')
  if (!parsed.transactions.length) throw new GoogleSheetsError('A aba CUSTOS ANO não contém lançamentos válidos para conciliar.', 'EMPTY')
  return parsed.transactions
}

async function getJson(url: string, accessToken: string, fetcher: typeof fetch): Promise<Record<string, unknown>> {
  let response: Response
  try {
    response = await fetcher(url, { method: 'GET', headers: { Authorization: `Bearer ${accessToken}` } })
  } catch {
    throw new GoogleSheetsError('Falha de conexão ao Google Sheets. A conciliação atual foi mantida.', 'NETWORK')
  }
  if (response.status === 401) throw new GoogleSheetsError('A autorização expirou. Conecte novamente para atualizar os dados.', 'AUTH')
  if (response.status === 403) throw new GoogleSheetsError('Acesso negado. Verifique se a conta Google pode visualizar esta planilha.', 'ACCESS')
  if (response.status === 404) throw new GoogleSheetsError('Planilha não encontrada. Confira o URL/ID e o acesso da conta Google.', 'NOT_FOUND')
  if (!response.ok) throw new GoogleSheetsError(`Falha ao consultar Google Sheets (HTTP ${response.status}). A conciliação atual foi mantida.`, 'API')
  return await response.json() as Record<string, unknown>
}

export async function readGoogleSheetLedger(spreadsheetIdInput: string, accessToken: string, fetcher: typeof fetch = fetch): Promise<GoogleSheetReadResult> {
  const spreadsheetId = extractSpreadsheetId(spreadsheetIdInput)
  const base = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}`
  const metadata = await getJson(`${base}?fields=${encodeURIComponent('spreadsheetId,properties.title,sheets.properties(sheetId,title)')}`, accessToken, fetcher)
  const sheets = metadata.sheets as { properties?: { title?: string } }[] | undefined
  if (!sheets?.some((sheet) => sheet.properties?.title === SHEET_NAME)) {
    throw new GoogleSheetsError('A aba obrigatória CUSTOS ANO não foi encontrada. O conciliador não cria nem renomeia abas.', 'TAB_MISSING')
  }
  const range = encodeURIComponent("'CUSTOS ANO'!A:ZZ")
  const valuesResponse = await getJson(`${base}/values/${range}?valueRenderOption=FORMATTED_VALUE&majorDimension=ROWS`, accessToken, fetcher)
  const values = valuesResponse.values as unknown[][] | undefined
  if (!values?.length) throw new GoogleSheetsError('A aba CUSTOS ANO está vazia.', 'EMPTY')
  const transactions = mapGoogleSheetValues(values)
  const properties = metadata.properties as { title?: string } | undefined
  return { spreadsheetId, spreadsheetTitle: properties?.title || 'Planilha Google', transactions, rowCount: values.length - 1 }
}
