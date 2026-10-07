import type { LedgerTransaction } from '../domain/types'
import { initialColumnMap, normalizeHeader } from '../importers/csv'
import { parseLedgerRows } from '../importers/transactions'
import { normalizeAmount, normalizeDate, parseBoolean } from '../importers/normalize'
import { COST_YEAR_PAYMENT_METHODS } from '../features/costYearRecord'

export const GOOGLE_SHEETS_SCOPE = 'https://www.googleapis.com/auth/spreadsheets'
export const GOOGLE_DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.readonly'
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

export interface CostYearRecordInput {
  description: string
  date: string
  category: string
  amount: number
  paymentMethod: string
  isFixed: boolean
  isEssential: boolean
}

export interface CostYearAppendResult extends GoogleSheetReadResult {
  transaction: LedgerTransaction
  alreadyPresent: boolean
}

export class GoogleSheetsError extends Error {
  constructor(message: string, readonly code: 'CONFIG' | 'AUTH' | 'NOT_FOUND' | 'ACCESS' | 'TAB_MISSING' | 'HEADERS' | 'DUPLICATE_ID' | 'DUPLICATE_RECORD' | 'INTEGRITY' | 'AMBIGUOUS' | 'EMPTY' | 'NETWORK' | 'API') {
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

export async function requestGoogleSheetsAccessToken(clientId: string, prompt?: string, includeDrive = false): Promise<string> {
  if (!clientId.trim()) throw new GoogleSheetsError('Configure VITE_GOOGLE_CLIENT_ID para ativar a conexão com Google Sheets.', 'CONFIG')
  const google = await loadGoogleIdentityServices()
  return new Promise((resolve, reject) => {
    let settled = false
    const client = google.accounts.oauth2.initTokenClient({
      client_id: clientId.trim(), scope: includeDrive ? `${GOOGLE_SHEETS_SCOPE} ${GOOGLE_DRIVE_SCOPE}` : GOOGLE_SHEETS_SCOPE, include_granted_scopes: true,
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

export function mapGoogleSheetValues(values: unknown[][], options: { allowEmpty?: boolean } = {}): LedgerTransaction[] {
  const headers = (values[0] ?? []).map((value) => String(value ?? '').trim())
  const map = initialColumnMap(headers, 'sheet')
  const missing = REQUIRED_SHEET_COLUMNS.filter((key) => !map[key])
  if (missing.length) {
    throw new GoogleSheetsError(`Cabeçalhos ausentes ou alterados na aba CUSTOS ANO: ${missing.map((key) => COLUMN_NAMES[key]).join(', ')}.`, 'HEADERS')
  }
  const normalizedHeaders = headers.map(normalizeHeader)
  const duplicated = normalizedHeaders.find((header, index) => Boolean(header) && normalizedHeaders.indexOf(header) !== index)
  if (duplicated) throw new GoogleSheetsError(`Há cabeçalhos repetidos na aba CUSTOS ANO: ${headers[normalizedHeaders.indexOf(duplicated)]}.`, 'HEADERS')
  const rows = values.slice(1).flatMap((valuesRow, index) => {
    const row = Object.fromEntries(headers.map((header, columnIndex) => [header, String(valuesRow[columnIndex] ?? '').trim()]))
    const hasFinancialData = [map.description, map.date, map.amount, map.category, map.paymentMethod, map.id].some((column) => Boolean(column && row[column]))
    // Validation-only rows commonly contain FALSE in checkbox columns. They are not records.
    if (!hasFinancialData) return []
    const missing = [map.description, map.date, map.amount, map.id].filter((column) => !row[column])
    if (missing.length) {
      const labels = missing.map((column) => headers.find((header) => header === column) ?? column)
      throw new GoogleSheetsError(`Integridade inválida na linha ${index + 2} da CUSTOS ANO: falta ${labels.join(', ')}.`, 'INTEGRITY')
    }
    return [row]
  })
  const nonEmptyIds = rows.map((row) => row[map.id!]).filter(Boolean)
  if (new Set(nonEmptyIds).size !== nonEmptyIds.length) throw new GoogleSheetsError('A coluna ID contém valores repetidos. A leitura foi interrompida para preservar a identidade dos lançamentos.', 'DUPLICATE_ID')
  const parsed = parseLedgerRows(rows, map)
  if (parsed.issues.length) throw new GoogleSheetsError(`A aba CUSTOS ANO contém ${parsed.issues.length} linha(s) com Data, Descrição ou Custo inválido. Corrija os dados na planilha e atualize novamente; os dados atuais foram mantidos.`, 'EMPTY')
  if (!parsed.transactions.length && !options.allowEmpty) throw new GoogleSheetsError('A aba CUSTOS ANO não contém lançamentos válidos para conciliar.', 'EMPTY')
  return parsed.transactions
}

function columnLetter(index: number) {
  let number = index + 1, label = ''
  while (number > 0) { const remainder = (number - 1) % 26; label = String.fromCharCode(65 + remainder) + label; number = Math.floor((number - 1) / 26) }
  return label
}

function costYearHeaderIndexes(headers: string[]) {
  const indexes = {} as Record<(typeof REQUIRED_SHEET_COLUMNS)[number], number>
  for (const key of REQUIRED_SHEET_COLUMNS) {
    const index = headers.findIndex((header) => header.trim() === COLUMN_NAMES[key])
    if (index < 0) throw new GoogleSheetsError(`Não foi possível adicionar: o cabeçalho exato “${COLUMN_NAMES[key]}” não foi encontrado em CUSTOS ANO.`, 'HEADERS')
    indexes[key] = index
  }
  return indexes
}

function normalizeCostDescription(value: string) { return value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().replace(/\s+/g, ' ') }
function matchesCostRecord(transaction: LedgerTransaction, input: CostYearRecordInput) {
  return transaction.date === input.date && transaction.amount === input.amount
    && normalizeCostDescription(transaction.originalDescription) === normalizeCostDescription(input.description)
    && normalizeHeader(transaction.paymentMethod) === normalizeHeader(input.paymentMethod)
}

type CostYearHeaderIndexes = Record<(typeof REQUIRED_SHEET_COLUMNS)[number], number>

function checkboxIsFalse(value: unknown) {
  if (value === false) return true
  return ['false', 'nao', '0'].includes(normalizeHeader(String(value ?? '')))
}

function hasLogicalRecordEvidence(row: unknown[], indexes: CostYearHeaderIndexes) {
  const main = [indexes.description, indexes.date, indexes.amount, indexes.category, indexes.paymentMethod, indexes.id]
  return main.some((index) => String(row[index] ?? '').trim() !== '')
    || [indexes.isFixed, indexes.isEssential].some((index) => row[index] != null && !checkboxIsFalse(row[index]) && String(row[index]).trim() !== '')
}

function hasAnyWriteConflictEvidence(row: unknown[], indexes: CostYearHeaderIndexes) {
  return row.some((value, index) => {
    if (index === indexes.month || index === indexes.year) return false
    if ((index === indexes.isFixed || index === indexes.isEssential) && checkboxIsFalse(value)) return false
    return String(value ?? '').trim() !== ''
  })
}

function logicalNextRow(values: unknown[][], indexes: CostYearHeaderIndexes) {
  let next = 2
  values.slice(1).forEach((row, index) => { if (hasLogicalRecordEvidence(row, indexes)) next = index + 3 })
  return next
}

function nextSafeWriteRow(values: unknown[][], indexes: CostYearHeaderIndexes) {
  const first = logicalNextRow(values, indexes)
  // Search past occupied/non-record cells without touching them; validation-only FALSE and formula blanks remain safe.
  for (let rowNumber = first; rowNumber <= Math.max(values.length + 1, first + 1); rowNumber += 1) {
    if (!hasAnyWriteConflictEvidence(values[rowNumber - 1] ?? [], indexes)) return rowNumber
  }
  return Math.max(values.length + 1, first)
}

function writeRanges(rowNumber: number, indexes: CostYearHeaderIndexes, input: CostYearRecordInput, id: string) {
  const cells = new Map<number, unknown>([
    [indexes.description, input.description.trim()],
    [indexes.date, (() => { const [year, month, day] = input.date.split('-'); return `${day}/${month}/${year}` })()],
    [indexes.category, input.category.trim()],
    [indexes.amount, input.amount / 100],
    [indexes.paymentMethod, input.paymentMethod.trim()],
    [indexes.isFixed, input.isFixed],
    [indexes.isEssential, input.isEssential],
    [indexes.id, id],
  ])
  const sorted = [...cells.entries()].sort(([a], [b]) => a - b)
  const groups: { start: number; end: number; values: unknown[] }[] = []
  for (const [column, value] of sorted) {
    const current = groups.at(-1)
    if (current && column === current.end + 1) { current.end = column; current.values.push(value) }
    else groups.push({ start: column, end: column, values: [value] })
  }
  return groups.map((group) => ({ range: `'${SHEET_NAME}'!${columnLetter(group.start)}${rowNumber}:${columnLetter(group.end)}${rowNumber}`, values: [group.values] }))
}

function expectedMonth(date: string) {
  const names = ['Janeiro', 'Fevereiro', 'Março', 'Abril', 'Maio', 'Junho', 'Julho', 'Agosto', 'Setembro', 'Outubro', 'Novembro', 'Dezembro']
  const month = Number(date.slice(5, 7))
  return `${String(month).padStart(2, '0')} - ${names[month - 1]}`
}

function verifyWrittenCostYearRow(row: unknown[], indexes: CostYearHeaderIndexes, input: CostYearRecordInput, id: string) {
  const actualDate = normalizeDate(String(row[indexes.date] ?? ''))
  const actualAmount = normalizeAmount(String(row[indexes.amount] ?? ''))
  const fixed = parseBoolean(String(row[indexes.isFixed] ?? ''))
  const essential = parseBoolean(String(row[indexes.isEssential] ?? ''))
  const valid = String(row[indexes.description] ?? '').trim() === input.description.trim()
    && actualDate === input.date
    && String(row[indexes.category] ?? '').trim() === input.category.trim()
    && actualAmount === input.amount
    && normalizeHeader(String(row[indexes.paymentMethod] ?? '')) === normalizeHeader(input.paymentMethod)
    && fixed === input.isFixed && essential === input.isEssential
    && String(row[indexes.id] ?? '').trim() === id
    && normalizeHeader(String(row[indexes.month] ?? '')) === normalizeHeader(expectedMonth(input.date))
    && String(row[indexes.year] ?? '').trim() === input.date.slice(0, 4)
  if (!valid) throw new GoogleSheetsError('A gravação foi enviada, mas a releitura da linha não confirmou todos os campos ou as fórmulas de Mês/Ano. Atualize CUSTOS ANO antes de tentar novamente.', 'AMBIGUOUS')
}

export function generateCostYearId(existingIds: Iterable<string>, randomBytes?: (buffer: Uint8Array) => Uint8Array) {
  const secureRandom = randomBytes ?? ((buffer: Uint8Array) => {
    if (!globalThis.crypto?.getRandomValues) throw new GoogleSheetsError('Este navegador não oferece geração segura de ID. Nenhuma linha foi adicionada.', 'CONFIG')
    return globalThis.crypto.getRandomValues(buffer)
  })
  const existing = new Set([...existingIds].map((id) => id.trim().toLowerCase()).filter(Boolean))
  for (let attempt = 0; attempt < 32; attempt += 1) {
    const bytes = secureRandom(new Uint8Array(4))
    const id = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
    if (!existing.has(id.toLowerCase())) return id
  }
  throw new GoogleSheetsError('Não foi possível gerar um ID único após várias tentativas. Nenhuma linha foi adicionada.', 'DUPLICATE_ID')
}

async function getSheetValues(spreadsheetId: string, token: string, fetcher: typeof fetch) {
  const base = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}`
  const metadata = await getJson(`${base}?fields=${encodeURIComponent('spreadsheetId,properties.title,sheets.properties(sheetId,title)')}`, token, fetcher)
  const sheets = metadata.sheets as { properties?: { title?: string } }[] | undefined
  if (!sheets?.some((sheet) => sheet.properties?.title === SHEET_NAME)) throw new GoogleSheetsError('A aba obrigatória CUSTOS ANO não foi encontrada. Nenhuma alteração foi feita.', 'TAB_MISSING')
  const range = encodeURIComponent("'CUSTOS ANO'!A:ZZ")
  const response = await getJson(`${base}/values/${range}?valueRenderOption=FORMATTED_VALUE&majorDimension=ROWS`, token, fetcher)
  return { base, metadata, values: (response.values as unknown[][] | undefined) ?? [] }
}

/** Adds exactly one confirmed expense into an explicitly selected free row; never delegates row choice to values.append. */
export async function appendCostYearRecord(spreadsheetIdInput: string, accessToken: string, input: CostYearRecordInput, fetcher: typeof fetch = fetch, options: { randomBytes?: (buffer: Uint8Array) => Uint8Array } = {}): Promise<CostYearAppendResult> {
  const spreadsheetId = extractSpreadsheetId(spreadsheetIdInput)
  if (!input.description.trim() || normalizeDate(input.date) !== input.date || !Number.isInteger(input.amount) || input.amount <= 0 || !input.category.trim() || !COST_YEAR_PAYMENT_METHODS.some((method) => method === input.paymentMethod) || typeof input.isFixed !== 'boolean' || typeof input.isEssential !== 'boolean') {
    throw new GoogleSheetsError('Revise descrição, data, categoria, custo, forma de pagamento e opções de fixo/essencial antes de adicionar.', 'INTEGRITY')
  }
  let snapshot = await getSheetValues(spreadsheetId, accessToken, fetcher)
  if (!snapshot.values.length) throw new GoogleSheetsError('A CUSTOS ANO não possui cabeçalhos; nenhuma alteração foi feita.', 'HEADERS')
  const headers = snapshot.values[0].map((value) => String(value ?? '').trim())
  const indexes = costYearHeaderIndexes(headers)
  let transactions: LedgerTransaction[] = []
  let targetRow = 0
  let title = 'Planilha Google'

  // A competing AppSheet/manual write may occupy our candidate after the initial scan.
  // Re-read the full ledger and recalculate, then re-read that exact row immediately before writing.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (!snapshot.values.length) throw new GoogleSheetsError('A CUSTOS ANO não possui cabeçalhos; nenhuma alteração foi feita.', 'HEADERS')
    const currentHeaders = snapshot.values[0].map((value) => String(value ?? '').trim())
    const currentIndexes = costYearHeaderIndexes(currentHeaders)
    if (currentHeaders.some((value, index) => value !== headers[index])) throw new GoogleSheetsError('Os cabeçalhos de CUSTOS ANO mudaram durante a gravação. Atualize a planilha e tente novamente.', 'AMBIGUOUS')
    transactions = mapGoogleSheetValues(snapshot.values, { allowEmpty: true })
    if (!transactions.some((transaction) => transaction.category === input.category.trim())) throw new GoogleSheetsError('A categoria escolhida não aparece entre as categorias já usadas em CUSTOS ANO. Nenhuma linha foi adicionada.', 'INTEGRITY')
    const duplicates = transactions.filter((transaction) => matchesCostRecord(transaction, input))
    if (duplicates.length > 1) throw new GoogleSheetsError('Já existem várias linhas iguais na CUSTOS ANO. Revise a planilha antes de adicionar outra.', 'DUPLICATE_RECORD')
    if (duplicates.length === 1) return { spreadsheetId, spreadsheetTitle: (snapshot.metadata.properties as { title?: string } | undefined)?.title || title, transactions, rowCount: transactions.length, transaction: duplicates[0], alreadyPresent: true }

    title = (snapshot.metadata.properties as { title?: string } | undefined)?.title || title
    targetRow = nextSafeWriteRow(snapshot.values, currentIndexes)
    const rowRange = encodeURIComponent(`'${SHEET_NAME}'!A${targetRow}:ZZ${targetRow}`)
    const rowResult = await getJson(`${snapshot.base}/values/${rowRange}?valueRenderOption=FORMATTED_VALUE&majorDimension=ROWS`, accessToken, fetcher)
    const currentRow = ((rowResult.values as unknown[][] | undefined) ?? [])[0] ?? []
    if (!hasAnyWriteConflictEvidence(currentRow, currentIndexes)) break
    if (attempt === 2) throw new GoogleSheetsError('A linha candidata mudou durante a gravação. Nenhum dado foi sobrescrito; atualize CUSTOS ANO e tente novamente.', 'AMBIGUOUS')
    snapshot = await getSheetValues(spreadsheetId, accessToken, fetcher)
  }

  const id = generateCostYearId(transactions.map((transaction) => transaction.sheetRecordId), options.randomBytes)
  const data = writeRanges(targetRow, indexes, input, id)
  const batchUrl = `${snapshot.base}/values:batchUpdate`
  let writeError: unknown
  try {
    const response = await fetcher(batchUrl, { method: 'POST', headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ valueInputOption: 'USER_ENTERED', data }) })
    if (response.status === 401) throw new GoogleSheetsError('A autorização expirou. Reconecte o Google e verifique a CUSTOS ANO antes de tentar novamente.', 'AUTH')
    if (response.status === 403) throw new GoogleSheetsError('O Google recusou a escrita. Confirme que você tem permissão de edição na CUSTOS ANO.', 'ACCESS')
    if (!response.ok) throw new GoogleSheetsError(`O Google Sheets recusou a escrita (HTTP ${response.status}). Nenhuma nova tentativa automática será feita.`, 'API')
    await response.json()
  } catch (error) {
    writeError = error instanceof TypeError
      ? new GoogleSheetsError('A conexão caiu durante a gravação. O resultado pode ser incerto; a linha será relida antes de informar o resultado.', 'AMBIGUOUS')
      : error
  }

  const exactRowRange = encodeURIComponent(`'${SHEET_NAME}'!A${targetRow}:ZZ${targetRow}`)
  let writtenRow: unknown[]
  try {
    const rowResult = await getJson(`${snapshot.base}/values/${exactRowRange}?valueRenderOption=FORMATTED_VALUE&majorDimension=ROWS`, accessToken, fetcher)
    writtenRow = ((rowResult.values as unknown[][] | undefined) ?? [])[0] ?? []
  } catch {
    if (writeError) throw writeError
    throw new GoogleSheetsError('A gravação foi enviada, mas não foi possível reler a linha exata para confirmar os dados. Atualize CUSTOS ANO antes de tentar novamente.', 'AMBIGUOUS')
  }
  if (String(writtenRow[indexes.id] ?? '').trim() !== id) {
    if (writeError) throw writeError
    if (hasAnyWriteConflictEvidence(writtenRow, indexes)) throw new GoogleSheetsError('A linha foi ocupada por outra alteração antes da confirmação. Nenhum retry foi feito; atualize CUSTOS ANO para evitar duplicidade.', 'AMBIGUOUS')
    throw new GoogleSheetsError('A gravação não foi confirmada na linha reservada. Nenhum retry automático foi feito.', 'AMBIGUOUS')
  }
  // One values.batchUpdate request carries all non-contiguous ranges; no blank/null is sent to Mês/Ano.
  // Only report success after every field, generated ID, and derived month/year value is visible on readback.
  verifyWrittenCostYearRow(writtenRow, indexes, input, id)
  if (writeError) {
    // A transport error is resolved only when the full row can be confirmed, as above.
    writeError = undefined
  }

  let updated: GoogleSheetReadResult
  try { updated = await readGoogleSheetLedger(spreadsheetId, accessToken, fetcher) }
  catch {
    throw new GoogleSheetsError('A linha foi gravada, mas não foi possível atualizar os dados da CUSTOS ANO. Atualize antes de tentar novamente; a linha confirmada não foi repetida.', 'AMBIGUOUS')
  }
  const written = updated.transactions.find((transaction) => transaction.sheetRecordId === id)
  if (!written) throw new GoogleSheetsError('A linha foi confirmada no endereço, mas não apareceu na releitura completa da CUSTOS ANO. Atualize antes de tentar novamente.', 'AMBIGUOUS')
  return { ...updated, transaction: written, alreadyPresent: false }
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
  return { spreadsheetId, spreadsheetTitle: properties?.title || 'Planilha Google', transactions, rowCount: transactions.length }
}
