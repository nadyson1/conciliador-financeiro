import type { DecisionKind, PersistedDecision } from '../domain/localDecisions'
import { putPersistedDecision, deletePersistedDecision } from '../domain/localDecisions'
import { stableFingerprint } from '../domain/identity'

export const GOOGLE_DECISIONS_TAB = '_CONCILIADOR'
export const GOOGLE_DECISIONS_HEADERS = ['decisionId', 'decisionType', 'subjectFingerprint', 'status', 'relatedIds', 'metadata', 'createdAt', 'updatedAt', 'schemaVersion'] as const
const DELETED_STATUS = 'DELETED'
const TOMBSTONE_STORAGE_KEY = 'conciliador.googleSheets.decisionTombstones.v1'
type DecisionRow = { decision: PersistedDecision; status: 'ACTIVE' | 'DELETED'; createdAt: string }
export type DecisionTombstone = { updatedAt: string; decision: PersistedDecision }

function readTombstones(storage: Storage = localStorage): Record<string, DecisionTombstone> {
  try {
    const value: unknown = JSON.parse(storage.getItem(TOMBSTONE_STORAGE_KEY) ?? '{}')
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, DecisionTombstone> : {}
  } catch { return {} }
}

export function listDecisionTombstones(storage: Storage = localStorage) { return readTombstones(storage) }

export function addDecisionTombstone(decision: PersistedDecision, storage: Storage = localStorage) {
  const tombstones = readTombstones(storage)
  tombstones[decision.key] = { updatedAt: new Date().toISOString(), decision }
  storage.setItem(TOMBSTONE_STORAGE_KEY, JSON.stringify(tombstones))
}

export function removeDecisionTombstone(key: string, storage: Storage = localStorage) {
  const tombstones = readTombstones(storage)
  delete tombstones[key]
  if (Object.keys(tombstones).length) storage.setItem(TOMBSTONE_STORAGE_KEY, JSON.stringify(tombstones))
  else storage.removeItem(TOMBSTONE_STORAGE_KEY)
}

async function api(url: string, token: string, init: RequestInit = {}, fetcher: typeof fetch = fetch): Promise<Record<string, unknown>> {
  let response: Response
  try {
    response = await fetcher(url, { ...init, headers: { Authorization: `Bearer ${token}`, ...(init.body ? { 'Content-Type': 'application/json' } : {}), ...init.headers } })
  } catch { throw new Error('Falha de conexão ao sincronizar decisões no Google Sheets.') }
  if (response.status === 401) throw new Error('A autorização do Google expirou. Reconecte para sincronizar as decisões.')
  if (response.status === 403) throw new Error('A conta Google não tem permissão para sincronizar decisões nesta planilha.')
  if (!response.ok) throw new Error(`Não foi possível sincronizar decisões no Google Sheets (HTTP ${response.status}).`)
  return response.status === 204 ? {} : await response.json() as Record<string, unknown>
}

const spreadsheetBase = (id: string) => `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(id)}`
const rangePath = (range: string) => encodeURIComponent(range).replace(/%2F/g, '/')

async function ensureDecisionTab(id: string, token: string, fetcher: typeof fetch) {
  const base = spreadsheetBase(id)
  const metadata = await api(`${base}?fields=${encodeURIComponent('sheets.properties(sheetId,title)')}`, token, {}, fetcher)
  const sheets = metadata.sheets as { properties?: { sheetId?: number; title?: string } }[] | undefined
  if (!sheets?.some((sheet) => sheet.properties?.title === 'CUSTOS ANO')) throw new Error('A aba CUSTOS ANO não existe; a sincronização foi interrompida sem modificar abas.')
  if (!sheets?.some((sheet) => sheet.properties?.title === GOOGLE_DECISIONS_TAB)) {
    await api(`${base}:batchUpdate`, token, { method: 'POST', body: JSON.stringify({ requests: [{ addSheet: { properties: { title: GOOGLE_DECISIONS_TAB } } }] }) }, fetcher)
  }
  const valuesUrl = `${base}/values/${rangePath(`'${GOOGLE_DECISIONS_TAB}'!A:I`)}?valueRenderOption=UNFORMATTED_VALUE&majorDimension=ROWS`
  const values = await api(valuesUrl, token, {}, fetcher)
  const rows = (values.values as unknown[][] | undefined) ?? []
  if (!rows.length) {
    await writeValues(id, token, `'${GOOGLE_DECISIONS_TAB}'!A1:I1`, [[...GOOGLE_DECISIONS_HEADERS]], 'PUT', fetcher)
    return [[...GOOGLE_DECISIONS_HEADERS]]
  }
  const actualHeaders = rows[0].map((value) => String(value ?? ''))
  if (GOOGLE_DECISIONS_HEADERS.some((header, index) => actualHeaders[index] !== header)) throw new Error(`A aba ${GOOGLE_DECISIONS_TAB} tem cabeçalhos incompatíveis; nenhum dado foi alterado.`)
  return rows
}

async function writeValues(id: string, token: string, range: string, values: unknown[][], method: 'PUT' | 'POST', fetcher: typeof fetch) {
  const endpoint = method === 'POST' ? `${spreadsheetBase(id)}/values/${rangePath(range)}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS` : `${spreadsheetBase(id)}/values/${rangePath(range)}?valueInputOption=RAW`
  await api(endpoint, token, { method, body: JSON.stringify({ majorDimension: 'ROWS', values }) }, fetcher)
}

function toRow(decision: PersistedDecision, status: 'ACTIVE' | 'DELETED' = 'ACTIVE', createdAt = decision.updatedAt): unknown[] {
  const timestamp = decision.updatedAt
  return [stableFingerprint([decision.key]), decision.kind, stableFingerprint([decision.identities[0] ?? '']), status, JSON.stringify(decision.identities), JSON.stringify({ selected: decision.selected }), createdAt, timestamp, decision.schemaVersion]
}

function fromRow(row: unknown[]): DecisionRow | null {
  const [decisionId, kind, subjectFingerprint, statusValue, relatedIds, metadata, createdAtValue, updatedAt, version] = row
  const validKinds: DecisionKind[] = ['PAIR_CONFIRMED', 'PAIR_REJECTED', 'BANK_IGNORED', 'SHEET_IGNORED', 'COMPOSITION_CONFIRMED', 'STATEMENT_MATCH_CONFIRMED', 'CARD_MISSING_CONFIRMED', 'CARD_PURCHASE_IGNORED', 'CARD_REVIEW_REJECTED_CANDIDATES', 'MISSING_ADDED_TO_SHEET']
  if (typeof decisionId !== 'string' || typeof kind !== 'string' || !validKinds.includes(kind as DecisionKind)) return null
  if (Number(version) !== 1 || (statusValue !== 'ACTIVE' && statusValue !== DELETED_STATUS)) return null
  try {
    const identities = JSON.parse(String(relatedIds)) as unknown
    const parsedMetadata = JSON.parse(String(metadata)) as { selected?: unknown }
    if (!Array.isArray(identities) || identities.some((identity) => typeof identity !== 'string') || !Array.isArray(parsedMetadata.selected) || parsedMetadata.selected.some((identity) => typeof identity !== 'string')) return null
    const key = `${kind}:${JSON.stringify(identities)}`
    if (decisionId !== stableFingerprint([key]) || subjectFingerprint !== stableFingerprint([identities[0] ?? ''])) return null
    const stamp = typeof updatedAt === 'string' && !Number.isNaN(Date.parse(updatedAt)) ? updatedAt : new Date(0).toISOString()
    const createdAt = typeof createdAtValue === 'string' && !Number.isNaN(Date.parse(createdAtValue)) ? createdAtValue : stamp
    return { status: statusValue === DELETED_STATUS ? 'DELETED' : 'ACTIVE', createdAt, decision: { key, kind: kind as DecisionKind, identities, selected: parsedMetadata.selected as string[], updatedAt: stamp, schemaVersion: 1 } }
  } catch { return null }
}

export type ReadOnlyGoogleDecisions = { exists: boolean; active: PersistedDecision[]; tombstones: PersistedDecision[] }

/** Read-only audit access. Unlike syncGoogleSheetDecisions this never creates a tab, writes rows, or updates IndexedDB. */
export async function readGoogleSheetDecisionsReadOnly(id: string, token: string, fetcher: typeof fetch = fetch): Promise<ReadOnlyGoogleDecisions> {
  const base = spreadsheetBase(id)
  const metadata = await api(`${base}?fields=${encodeURIComponent('sheets.properties(sheetId,title)')}`, token, {}, fetcher)
  const sheets = metadata.sheets as { properties?: { title?: string } }[] | undefined
  if (!sheets?.some((sheet) => sheet.properties?.title === 'CUSTOS ANO')) throw new Error('A aba CUSTOS ANO não foi encontrada; a auditoria não modificou a planilha.')
  if (!sheets?.some((sheet) => sheet.properties?.title === GOOGLE_DECISIONS_TAB)) return { exists: false, active: [], tombstones: [] }
  const valuesUrl = `${base}/values/${rangePath(`'${GOOGLE_DECISIONS_TAB}'!A:I`)}?valueRenderOption=UNFORMATTED_VALUE&majorDimension=ROWS`
  const values = await api(valuesUrl, token, {}, fetcher)
  const rows = (values.values as unknown[][] | undefined) ?? []
  if (!rows.length) return { exists: true, active: [], tombstones: [] }
  const headers = rows[0].map((value) => String(value ?? ''))
  if (GOOGLE_DECISIONS_HEADERS.some((header, index) => headers[index] !== header)) throw new Error(`A aba ${GOOGLE_DECISIONS_TAB} tem cabeçalhos incompatíveis; a auditoria não modificou dados.`)
  const parsed = rows.slice(1).filter((row) => row.some((value) => value !== '' && value != null)).map(fromRow)
  if (parsed.some((item) => item == null)) throw new Error(`Há decisão inválida em ${GOOGLE_DECISIONS_TAB}; a auditoria não modificou dados.`)
  const records = parsed as DecisionRow[]
  return { exists: true, active: records.filter((item) => item.status === 'ACTIVE').map((item) => item.decision), tombstones: records.filter((item) => item.status === 'DELETED').map((item) => item.decision) }
}

async function upsertRows(id: string, token: string, decisions: { decision: PersistedDecision; status: 'ACTIVE' | 'DELETED' }[], existingRows: unknown[][], fetcher: typeof fetch) {
  const rowsById = new Map<string, number>()
  existingRows.slice(1).forEach((row, index) => { if (typeof row[0] === 'string') rowsById.set(row[0], index + 2) })
  for (const item of decisions) {
    const rowNumber = rowsById.get(stableFingerprint([item.decision.key]))
    if (rowNumber) {
      const oldRow = existingRows[rowNumber - 1]
      const createdAt = typeof oldRow?.[6] === 'string' && !Number.isNaN(Date.parse(oldRow[6] as string)) ? oldRow[6] as string : item.decision.updatedAt
      await writeValues(id, token, `'${GOOGLE_DECISIONS_TAB}'!A${rowNumber}:I${rowNumber}`, [toRow(item.decision, item.status, createdAt)], 'PUT', fetcher)
    }
    else await writeValues(id, token, `'${GOOGLE_DECISIONS_TAB}'!A:I`, [toRow(item.decision, item.status)], 'POST', fetcher)
  }
}

export async function saveGoogleSheetDecision(id: string, token: string, decision: PersistedDecision, fetcher: typeof fetch = fetch) {
  const rows = await ensureDecisionTab(id, token, fetcher)
  await upsertRows(id, token, [{ decision, status: 'ACTIVE' }], rows, fetcher)
}

export async function syncGoogleSheetDecisions(id: string, token: string, localDecisions: PersistedDecision[], tombstones: Record<string, DecisionTombstone> = {}, fetcher: typeof fetch = fetch): Promise<PersistedDecision[]> {
  const rows = await ensureDecisionTab(id, token, fetcher)
  const dataRows = rows.slice(1).filter((row) => row.some((value) => value !== '' && value != null))
  const parsedRows = dataRows.map((row) => fromRow(row))
  if (parsedRows.some((item) => item === null)) throw new Error(`Há decisão inválida ou versão incompatível na aba ${GOOGLE_DECISIONS_TAB}; nenhum dado local foi substituído.`)
  const remote = parsedRows.filter((item): item is DecisionRow => item !== null)
  const merged = new Map<string, DecisionRow>()
  remote.forEach((item) => merged.set(item.decision.key, item))
  localDecisions.forEach((decision) => {
    const current = merged.get(decision.key)
    if (!current || Date.parse(decision.updatedAt) > Date.parse(current.decision.updatedAt)) merged.set(decision.key, { decision, status: 'ACTIVE', createdAt: current?.createdAt ?? decision.updatedAt })
  })
  Object.entries(tombstones).forEach(([key, tombstone]) => {
    const { updatedAt, decision } = tombstone
    const current = merged.get(key)
    if (!current || Date.parse(updatedAt) >= Date.parse(current.decision.updatedAt)) {
      merged.set(key, { decision: { ...decision, updatedAt }, status: 'DELETED', createdAt: current?.createdAt ?? decision.updatedAt })
    }
  })
  const changed = [...merged.values()].filter((item) => {
    const existing = remote.find((old) => old.decision.key === item.decision.key)
    return !existing || existing.status !== item.status || existing.decision.updatedAt !== item.decision.updatedAt || JSON.stringify(existing.decision) !== JSON.stringify(item.decision)
  })
  await upsertRows(id, token, changed, rows, fetcher)
  const active = [...merged.values()].filter((item) => item.status === 'ACTIVE').map((item) => item.decision)
  const localKeys = new Set(localDecisions.map((item) => item.key))
  for (const item of merged.values()) {
    if (item.status === 'DELETED') await deletePersistedDecision(item.decision.key)
    else if (!localKeys.has(item.decision.key) || localDecisions.find((local) => local.key === item.decision.key)?.updatedAt !== item.decision.updatedAt) await putPersistedDecision(item.decision)
  }
  return active
}

export async function syncOneGoogleSheetDecision(id: string, token: string, decision: PersistedDecision, fetcher: typeof fetch = fetch) {
  await saveGoogleSheetDecision(id, token, decision, fetcher)
}

export async function syncOneGoogleSheetDeletion(id: string, token: string, decision: PersistedDecision, deletedAt: string, fetcher: typeof fetch = fetch) {
  const rows = await ensureDecisionTab(id, token, fetcher)
  await upsertRows(id, token, [{ decision: { ...decision, updatedAt: deletedAt }, status: 'DELETED' }], rows, fetcher)
}
