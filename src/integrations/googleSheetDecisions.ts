import type { DecisionKind, PersistedDecision } from '../domain/localDecisions'
import { isDecisionStructurallyValid, type RemoteDecisionIntegrityIssue } from '../domain/decisionAudit'
import { nextDecisionTimestamp, putPersistedDecision, deletePersistedDecision } from '../domain/localDecisions'
import { stableFingerprint } from '../domain/identity'
import { serializeDecisionMutation } from '../domain/decisionMutationQueue'

export const GOOGLE_DECISIONS_TAB = '_CONCILIADOR'
export const GOOGLE_DECISIONS_HEADERS = ['decisionId', 'decisionType', 'subjectFingerprint', 'status', 'relatedIds', 'metadata', 'createdAt', 'updatedAt', 'schemaVersion'] as const
const DELETED_STATUS = 'DELETED'
const TOMBSTONE_STORAGE_KEY = 'conciliador.googleSheets.decisionTombstones.v1'
type DecisionRow = { decision: PersistedDecision; status: 'ACTIVE' | 'DELETED'; createdAt: string }
type ParsedRemoteRows = { records: DecisionRow[]; integrityIssues: RemoteDecisionIntegrityIssue[] }
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
  const current = tombstones[decision.key]
  tombstones[decision.key] = { updatedAt: nextDecisionTimestamp(decision.updatedAt, current?.updatedAt ?? ''), decision }
  storage.setItem(TOMBSTONE_STORAGE_KEY, JSON.stringify(tombstones))
}

export function removeDecisionTombstone(key: string, storage: Storage = localStorage) {
  const tombstones = readTombstones(storage)
  delete tombstones[key]
  if (Object.keys(tombstones).length) storage.setItem(TOMBSTONE_STORAGE_KEY, JSON.stringify(tombstones))
  else storage.removeItem(TOMBSTONE_STORAGE_KEY)
}

/** Restores the exact pre-mutation tombstone when a local composed write aborts. */
export function restoreDecisionTombstone(key: string, previous: DecisionTombstone | undefined, storage: Storage = localStorage) {
  const tombstones = readTombstones(storage)
  if (previous) tombstones[key] = previous
  else delete tombstones[key]
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

const validTimestamp = (value: unknown): value is string => {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value) || !Number.isFinite(Date.parse(value))) return false
  const [, year, month, day, hour, minute, second] = value.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})/) ?? []
  if (!year) return false
  const date = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)))
  return date.getUTCFullYear() === Number(year) && date.getUTCMonth() === Number(month) - 1 && date.getUTCDate() === Number(day)
    && Number(hour) <= 23 && Number(minute) <= 59 && Number(second) <= 59
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
    if (!validTimestamp(updatedAt) || !validTimestamp(createdAtValue)) return null
    return { status: statusValue === DELETED_STATUS ? 'DELETED' : 'ACTIVE', createdAt: createdAtValue, decision: { key, kind: kind as DecisionKind, identities, selected: parsedMetadata.selected as string[], updatedAt, schemaVersion: 1 } }
  } catch { return null }
}

function semanticRowSignature(row: unknown[]): string {
  return JSON.stringify(row.slice(1, 9).map((value) => {
    if (typeof value !== 'string') return value
    try { return JSON.stringify(JSON.parse(value)) } catch { return value }
  }))
}

function parseRemoteRows(rows: unknown[][]): ParsedRemoteRows {
  const dataRows = rows.slice(1).map((row, index) => ({ row, physicalRow: index + 2 })).filter(({ row }) => row.some((value) => value !== '' && value != null))
  const rowsByDecisionId = new Map<string, { row: unknown[]; physicalRow: number }[]>()
  dataRows.forEach(({ row, physicalRow }) => {
    const id = typeof row[0] === 'string' ? row[0].trim() : ''
    if (id) rowsByDecisionId.set(id, [...(rowsByDecisionId.get(id) ?? []), { row, physicalRow }])
  })
  const duplicateIds = new Set([...rowsByDecisionId].filter(([, copies]) => copies.length > 1).map(([id]) => id))
  const integrityIssues: RemoteDecisionIntegrityIssue[] = []
  const records: DecisionRow[] = []
  const blockedIds = new Set<string>()
  dataRows.forEach(({ row, physicalRow }) => {
    const decisionId = typeof row[0] === 'string' ? row[0].trim() : undefined
    const parsed = fromRow(row)
    if (decisionId && duplicateIds.has(decisionId)) {
      blockedIds.add(decisionId)
      return
    }
    if (parsed) { records.push(parsed); return }
    const kind = typeof row[1] === 'string' ? row[1] : ''
    let identities: unknown = null
    try { identities = JSON.parse(String(row[4])) } catch { /* invalid JSON is kept as a diagnostic only */ }
    const knownKey = Array.isArray(identities) && identities.every((item) => typeof item === 'string') && kind
      ? `${kind}:${JSON.stringify(identities)}` : undefined
    const invalidFields: string[] = []
    if (!validTimestamp(row[7])) invalidFields.push('updatedAt')
    if (!validTimestamp(row[6])) invalidFields.push('createdAt')
    const rowsForId = decisionId ? rowsByDecisionId.get(decisionId) ?? [] : []
    const semanticSignatures = new Set(rowsForId.map(({ row: duplicateRow }) => semanticRowSignature(duplicateRow)))
    integrityIssues.push({
      code: invalidFields.includes('updatedAt') ? 'INVALID_DECISION_TIMESTAMP' : 'INVALID_REMOTE_DECISION_ROW',
      ...(decisionId ? { decisionId } : {}), decisionKeys: knownKey ? [knownKey] : [], physicalRows: [physicalRow],
      status: row[3] === 'ACTIVE' || row[3] === 'DELETED' ? row[3] : 'UNKNOWN',
      ...(invalidFields.length ? { invalidFields } : {}),
      ...(rowsForId.length > 1 ? { semanticallyDivergent: semanticSignatures.size > 1 } : {}),
      reason: invalidFields.length ? `Timestamp inválido em ${invalidFields.join(' e ')}.` : 'A estrutura da linha não corresponde ao contrato V1 esperado.',
    })
  })
  duplicateIds.forEach((decisionId) => {
    const copies = rowsByDecisionId.get(decisionId)!
    const keys = [...new Set(copies.map(({ row }) => {
      try {
        const identities = JSON.parse(String(row[4])) as unknown
        return typeof row[1] === 'string' && Array.isArray(identities) && identities.every((item) => typeof item === 'string') ? `${row[1]}:${JSON.stringify(identities)}` : ''
      } catch { return '' }
    }).filter(Boolean))]
    const divergent = new Set(copies.map(({ row }) => semanticRowSignature(row))).size > 1
    integrityIssues.push({ code: 'DUPLICATE_REMOTE_DECISION_ID', decisionId, decisionKeys: keys, physicalRows: copies.map(({ physicalRow }) => physicalRow), status: copies.every(({ row }) => row[3] === copies[0].row[3]) && (copies[0].row[3] === 'ACTIVE' || copies[0].row[3] === 'DELETED') ? copies[0].row[3] as 'ACTIVE' | 'DELETED' : 'UNKNOWN', semanticallyDivergent: divergent, reason: divergent ? 'O mesmo decisionId aparece em linhas com conteúdo semanticamente diferente.' : 'O mesmo decisionId aparece em mais de uma linha física equivalente.' })
  })
  return { records: records.filter((record) => !blockedIds.has(stableFingerprint([record.decision.key]))), integrityIssues }
}

export type ReadOnlyGoogleDecisions = { exists: boolean; active: PersistedDecision[]; tombstones: PersistedDecision[]; integrityIssues: RemoteDecisionIntegrityIssue[] }

/** Read-only audit access. Unlike syncGoogleSheetDecisions this never creates a tab, writes rows, or updates IndexedDB. */
export async function readGoogleSheetDecisionsReadOnly(id: string, token: string, fetcher: typeof fetch = fetch): Promise<ReadOnlyGoogleDecisions> {
  const base = spreadsheetBase(id)
  const metadata = await api(`${base}?fields=${encodeURIComponent('sheets.properties(sheetId,title)')}`, token, {}, fetcher)
  const sheets = metadata.sheets as { properties?: { title?: string } }[] | undefined
  if (!sheets?.some((sheet) => sheet.properties?.title === 'CUSTOS ANO')) throw new Error('A aba CUSTOS ANO não foi encontrada; a auditoria não modificou a planilha.')
  if (!sheets?.some((sheet) => sheet.properties?.title === GOOGLE_DECISIONS_TAB)) return { exists: false, active: [], tombstones: [], integrityIssues: [] }
  const valuesUrl = `${base}/values/${rangePath(`'${GOOGLE_DECISIONS_TAB}'!A:I`)}?valueRenderOption=UNFORMATTED_VALUE&majorDimension=ROWS`
  const values = await api(valuesUrl, token, {}, fetcher)
  const rows = (values.values as unknown[][] | undefined) ?? []
  if (!rows.length) return { exists: true, active: [], tombstones: [], integrityIssues: [] }
  const headers = rows[0].map((value) => String(value ?? ''))
  if (GOOGLE_DECISIONS_HEADERS.some((header, index) => headers[index] !== header)) throw new Error(`A aba ${GOOGLE_DECISIONS_TAB} tem cabeçalhos incompatíveis; a auditoria não modificou dados.`)
  const parsed = parseRemoteRows(rows)
  return { exists: true, active: parsed.records.filter((item) => item.status === 'ACTIVE').map((item) => item.decision), tombstones: parsed.records.filter((item) => item.status === 'DELETED').map((item) => item.decision), integrityIssues: parsed.integrityIssues }
}

async function upsertRows(id: string, token: string, decisions: { decision: PersistedDecision; status: 'ACTIVE' | 'DELETED' }[], existingRows: unknown[][], fetcher: typeof fetch) {
  const rowsById = new Map<string, number>()
  existingRows.slice(1).forEach((row, index) => { if (typeof row[0] === 'string') rowsById.set(row[0], index + 2) })
  // Apply tombstones before activations so a partial remote write can temporarily
  // omit a decision, but cannot expose both sides of a logical replacement.
  const ordered = [...decisions].sort((left, right) => Number(right.status === 'DELETED') - Number(left.status === 'DELETED'))
  for (const item of ordered) {
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
  return serializeDecisionMutation(`google-sheet:${id}`, async () => {
    const rows = await ensureDecisionTab(id, token, fetcher)
    await upsertRows(id, token, [{ decision, status: 'ACTIVE' }], rows, fetcher)
  })
}

export type DecisionSyncResult = PersistedDecision[] & { integrityIssues: RemoteDecisionIntegrityIssue[] }
async function syncGoogleSheetDecisionsNow(id: string, token: string, localDecisions: PersistedDecision[], tombstones: Record<string, DecisionTombstone>, fetcher: typeof fetch): Promise<DecisionSyncResult> {
  // Keep malformed/legacy records available in local storage for diagnostics, but never
  // let them overwrite a valid remote row or participate in the effective decision set.
  const applicableLocal = localDecisions.filter(isDecisionStructurallyValid)
  const applicableTombstones = Object.fromEntries(Object.entries(tombstones).filter(([, tombstone]) => isDecisionStructurallyValid(tombstone?.decision) && !Number.isNaN(Date.parse(tombstone?.updatedAt ?? ''))))
  const rows = await ensureDecisionTab(id, token, fetcher)
  const parsedRows = parseRemoteRows(rows)
  const integrityIssues = parsedRows.integrityIssues
  const blockedKeys = new Set(integrityIssues.flatMap((issue) => [...issue.decisionKeys, ...(issue.decisionId ? applicableLocal.filter((decision) => stableFingerprint([decision.key]) === issue.decisionId).map((decision) => decision.key) : [])]))
  const remote = parsedRows.records.filter((item) => !blockedKeys.has(item.decision.key))
  const safeApplicableLocal = applicableLocal.filter((decision) => !blockedKeys.has(decision.key))
  const safeTombstones = Object.fromEntries(Object.entries(applicableTombstones).filter(([key]) => !blockedKeys.has(key)))
  const merged = new Map<string, DecisionRow>()
  remote.forEach((item) => merged.set(item.decision.key, item))
  safeApplicableLocal.forEach((decision) => {
    const current = merged.get(decision.key)
    if (!current || Date.parse(decision.updatedAt) > Date.parse(current.decision.updatedAt)) merged.set(decision.key, { decision, status: 'ACTIVE', createdAt: current?.createdAt ?? decision.updatedAt })
  })
  Object.entries(safeTombstones).forEach(([key, tombstone]) => {
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
  const blockedIds = new Set(integrityIssues.map((issue) => issue.decisionId).filter((value): value is string => Boolean(value)))
  await upsertRows(id, token, changed.filter((item) => !blockedIds.has(stableFingerprint([item.decision.key]))), rows, fetcher)
  const active = [...merged.values()].filter((item) => item.status === 'ACTIVE').map((item) => item.decision)
  const localKeys = new Set(safeApplicableLocal.map((item) => item.key))
  for (const item of merged.values()) {
    if (item.status === 'DELETED') await deletePersistedDecision(item.decision.key)
    else if (!localKeys.has(item.decision.key) || applicableLocal.find((local) => local.key === item.decision.key)?.updatedAt !== item.decision.updatedAt) await putPersistedDecision(item.decision)
  }
  const result = active.filter((decision) => !blockedKeys.has(decision.key)) as DecisionSyncResult
  Object.defineProperty(result, 'integrityIssues', { value: integrityIssues, enumerable: false })
  return result
}

export function syncGoogleSheetDecisions(id: string, token: string, localDecisions: PersistedDecision[], tombstones: Record<string, DecisionTombstone> = {}, fetcher: typeof fetch = fetch): Promise<DecisionSyncResult> {
  return serializeDecisionMutation(`google-sheet:${id}`, () => syncGoogleSheetDecisionsNow(id, token, localDecisions, tombstones, fetcher))
}

export async function syncOneGoogleSheetDecision(id: string, token: string, decision: PersistedDecision, fetcher: typeof fetch = fetch) {
  await saveGoogleSheetDecision(id, token, decision, fetcher)
}

export async function syncOneGoogleSheetDeletion(id: string, token: string, decision: PersistedDecision, deletedAt: string, fetcher: typeof fetch = fetch) {
  return serializeDecisionMutation(`google-sheet:${id}`, async () => {
    const rows = await ensureDecisionTab(id, token, fetcher)
    await upsertRows(id, token, [{ decision: { ...decision, updatedAt: deletedAt }, status: 'DELETED' }], rows, fetcher)
  })
}
