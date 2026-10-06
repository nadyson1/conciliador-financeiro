import { useEffect, useMemo, useRef, useState } from 'react'
import type { ChangeEvent, ReactNode } from 'react'
import type { BankTransaction, CardStatement, CardStatementMatch, CardStatementTransaction, ColumnMap, CsvDocument, LedgerTransaction, ReconciliationItem, Transaction } from './domain/types'
import { readCsvFile, initialColumnMap } from './importers/csv'
import { parseBankRows, parseLedgerRows } from './importers/transactions'
import { identifyStatementPayments, readCardStatementPdf, reconcileCardStatement } from './importers/cardStatement'
import { normalizeDate } from './importers/normalize'
import { canonicalCompositionKey, findPlausibleLedgerCandidates, pairKey, reconcile } from './matching/reconcile'
import { exportCardPayments, exportDuplicates, exportMissing, exportOutOfScope, exportReviews, exportSummary } from './features/export'
import { bankIdentity, cardTransactionIdentity, sheetIdentity } from './domain/identity'
import { clearPersistedDecisions, decisionKey, deletePersistedDecision, listPersistedDecisions, savePersistedDecision } from './domain/localDecisions'
import type { DecisionKind, PersistedDecision } from './domain/localDecisions'
import { GoogleSheetsPanel } from './components/GoogleSheetsPanel'
import type { GoogleSheetsConnectionInfo } from './components/GoogleSheetsPanel'
import { PwaUpdateNotice } from './components/PwaUpdateNotice'
import { AddCostYearDialog } from './components/AddCostYearDialog'
import { canAddMissingToCostYear } from './features/missingEligibility'
import { GoogleSheetsError, appendCostYearRecord, readGoogleSheetLedger, requestGoogleSheetsAccessToken, revokeGoogleSheetsAccessToken } from './integrations/googleSheets'
import { addDecisionTombstone, listDecisionTombstones, removeDecisionTombstone, syncGoogleSheetDecisions, syncOneGoogleSheetDecision, syncOneGoogleSheetDeletion } from './integrations/googleSheetDecisions'
import { forgetGoogleSheetLink, GOOGLE_SHEET_TAB_NAME, loadGoogleSheetLink, saveGoogleSheetLink } from './integrations/googleSheetLinkStorage'
import type { SavedGoogleSheetLink } from './integrations/googleSheetLinkStorage'

type Mode = 'sheet' | 'bank'
type SourceStatus = 'EMPTY' | 'LOADED' | 'VALIDATED' | 'ACCEPTED'
type Dataset = { sheet: LedgerTransaction[]; bank: BankTransaction[] }
type UploadState = { fileName: string; csv: CsvDocument; map: ColumnMap; valid: Transaction[]; issues: { row: number; message: string }[]; rowCount: number; ignoredRows: number } | null
type CardPdfEntry = { key: string; fingerprint: string; fileName: string; status: 'PROCESSING' | 'PROCESSED' | 'DIVERGENCE' | 'ERROR'; statement: CardStatement | null; legacyStatementIdentity?: string; error?: string }
type MissingWriteTarget = { kind: 'BANK'; bank: BankTransaction } | { kind: 'STATEMENT'; statement: CardStatement; transaction: CardStatementTransaction }
const emptyData: Dataset = { sheet: [], bank: [] }
const currency = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' })
const dateLabel = (date: string) => {
  const normalized = normalizeDate(date)
  if (!normalized) return date
  const [year, month, day] = normalized.split('-')
  return `${day}/${month}/${year}`
}
const formatCents = (cents: number) => currency.format(cents / 100)
async function fingerprintFile(file: File) {
  const buffer = typeof file.arrayBuffer === 'function' ? await file.arrayBuffer() : await new Promise<ArrayBuffer>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => reader.result instanceof ArrayBuffer ? resolve(reader.result) : reject(new Error('PDF read failed'))
    reader.onerror = () => reject(reader.error ?? new Error('PDF read failed'))
    reader.readAsArrayBuffer(file)
  })
  const bytes = new Uint8Array(buffer)
  if (globalThis.crypto?.subtle) {
    const digest = new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', bytes))
    return Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('')
  }
  let first = 0x811c9dc5, second = 0x9e3779b9
  for (let index = 0; index < bytes.length; index += 1) {
    first = Math.imul(first ^ bytes[index], 0x01000193) >>> 0
    second = Math.imul(second ^ (bytes[index] + index), 0x85ebca6b) >>> 0
  }
  return `${bytes.length}-${first.toString(16).padStart(8, '0')}${second.toString(16).padStart(8, '0')}`
}

const fieldTitles: Record<keyof ColumnMap, string> = {
  date: 'Data', description: 'Descrição', amount: 'Valor / Custo', direction: 'Direção da conta', debit: 'Coluna de saídas (débitos)', credit: 'Coluna de entradas (créditos)',
  paymentMethod: 'Forma de pagamento', category: 'Categoria', month: 'Mês', year: 'Ano', isFixed: 'É fixo?', isEssential: 'É essencial?', id: 'ID da transação', balance: 'Saldo após lançamento',
}
const requiredFields: Record<Mode, (keyof ColumnMap)[]> = { sheet: ['date', 'description', 'amount'], bank: ['date', 'description'] }
const optionalFields: Record<Mode, (keyof ColumnMap)[]> = {
  sheet: ['month', 'year', 'category', 'paymentMethod', 'isFixed', 'isEssential', 'id'],
  bank: ['direction', 'debit', 'credit', 'id', 'balance', 'paymentMethod'],
}

export default function App() {
  const [uploads, setUploads] = useState<Record<Mode, UploadState>>({ sheet: null, bank: null })
  const [sourceStatus, setSourceStatus] = useState<Record<Mode, SourceStatus>>({ sheet: 'EMPTY', bank: 'EMPTY' })
  const [data, setData] = useState<Dataset>(emptyData)
  const [googleSheetLink, setGoogleSheetLink] = useState<SavedGoogleSheetLink | null>(loadGoogleSheetLink)
  const [googleSheetInfo, setGoogleSheetInfo] = useState<GoogleSheetsConnectionInfo | null>(() => {
    const saved = loadGoogleSheetLink()
    return saved ? { ...saved, rowCount: 0, connected: false } : null
  })
  const [sheetSource, setSheetSource] = useState<'csv' | 'google'>('csv')
  const ledgerSourceChangedByUser = useRef(false)
  const selectedLedgerSource = useRef<'csv' | 'google'>('csv')
  const [csvSheetAccepted, setCsvSheetAccepted] = useState(false)
  const [googleSheetRows, setGoogleSheetRows] = useState<LedgerTransaction[] | null>(null)
  const [googleLinkEditing, setGoogleLinkEditing] = useState(false)
  const [googleLoading, setGoogleLoading] = useState(false)
  const [googleError, setGoogleError] = useState('')
  const [googleDecisionStatus, setGoogleDecisionStatus] = useState('')
  const googleAccessToken = useRef('')
  const googleAutoReadAttempted = useRef(false)
  const googleClientId = import.meta.env.VITE_GOOGLE_CLIENT_ID ?? ''
  const [cardPdfs, setCardPdfs] = useState<CardPdfEntry[]>([])
  const seenPdfFingerprints = useRef(new Set<string>())
  const pdfSessionGeneration = useRef(0)
  const [cardPdfNotice, setCardPdfNotice] = useState('')
  const [savedDecisions, setSavedDecisions] = useState<PersistedDecision[]>([])
  const [pendingDecisionIds, setPendingDecisionIds] = useState<Set<string>>(() => new Set())
  const [decisionsReady, setDecisionsReady] = useState(false)
  const decisionStateRevision = useRef(0)
  const [screen, setScreen] = useState<'home' | 'results'>('home')
  const [tab, setTab] = useState<'overview' | 'review' | 'missing' | 'card' | 'statement' | 'duplicates' | 'outofscope' | 'flags'>('overview')
  const [filterYear, setFilterYear] = useState('all')
  const [filterMonth, setFilterMonth] = useState('all')
  const [fromDate, setFromDate] = useState('')
  const [toDate, setToDate] = useState('')
  const [error, setError] = useState('')
  const [installPrompt, setInstallPrompt] = useState<BeforeInstallPromptEvent | null>(null)
  const reconcileButtonRef = useRef<HTMLButtonElement | null>(null)
  const previousScreen = useRef(screen)
  const [showStickyReconcile, setShowStickyReconcile] = useState(false)
  const [missingToAdd, setMissingToAdd] = useState<MissingWriteTarget | null>(null)
  const [missingWriteError, setMissingWriteError] = useState('')
  const [missingWriteNotice, setMissingWriteNotice] = useState('')
  const [writingMissingId, setWritingMissingId] = useState('')
  const [reconnectingForWrite, setReconnectingForWrite] = useState(false)
  const writingMissingRef = useRef(new Set<string>())
  const [locallyAddedMissingPairs, setLocallyAddedMissingPairs] = useState<Record<string, string>>({})

  useEffect(() => {
    let active = true
    const revision = decisionStateRevision.current
    listPersistedDecisions().then((items) => {
      if (active && decisionStateRevision.current === revision) {
        setSavedDecisions(items)
        if (googleSheetLink) setPendingDecisionIds(new Set([...items.map((item) => item.key), ...Object.keys(listDecisionTombstones())]))
      }
    }).catch(() => { if (active) setError('Não foi possível acessar as decisões salvas neste dispositivo.') }).finally(() => { if (active) setDecisionsReady(true) })
    return () => { active = false }
  }, [])

  useEffect(() => {
    if (previousScreen.current === 'home' && screen === 'results') window.scrollTo({ top: 0, left: 0, behavior: 'auto' })
    previousScreen.current = screen
  }, [screen])

  useEffect(() => {
    if (screen !== 'home' || !reconcileButtonRef.current || typeof IntersectionObserver === 'undefined') {
      setShowStickyReconcile(false)
      return
    }
    const observer = new IntersectionObserver(([entry]) => setShowStickyReconcile(!entry.isIntersecting), { threshold: 0.01 })
    observer.observe(reconcileButtonRef.current)
    return () => observer.disconnect()
  }, [screen])

  function markDecisionPending(key: string, pending: boolean) {
    setPendingDecisionIds((current) => {
      const next = new Set(current)
      if (pending) next.add(key)
      else next.delete(key)
      return next
    })
  }

  useEffect(() => {
    const captureInstall = (event: Event) => {
      event.preventDefault()
      setInstallPrompt(event as BeforeInstallPromptEvent)
    }
    window.addEventListener('beforeinstallprompt', captureInstall)
    return () => window.removeEventListener('beforeinstallprompt', captureInstall)
  }, [])

  async function installApp() {
    if (!installPrompt) return
    await installPrompt.prompt()
    setInstallPrompt(null)
  }

  async function persistDecision(kind: DecisionKind, identities: string[], selected: string[] = []) {
    try {
      const key = decisionKey(kind, identities)
      const record = await savePersistedDecision({ key, kind, identities, selected })
      removeDecisionTombstone(key)
      decisionStateRevision.current += 1
      setSavedDecisions(await listPersistedDecisions())
      setError('')
      if (googleSheetLink?.spreadsheetId) {
        markDecisionPending(key, true)
        if (googleAccessToken.current) {
          try { await syncOneGoogleSheetDecision(googleSheetLink.spreadsheetId, googleAccessToken.current, record); markDecisionPending(key, false); setGoogleDecisionStatus('Decisões sincronizadas.') }
          catch { setGoogleDecisionStatus('Decisões mantidas neste dispositivo; falha de sincronização.') }
        }
      }
    } catch {
      setError('Não foi possível salvar esta decisão neste dispositivo. Ela continuará disponível apenas nesta sessão.')
    }
  }

  async function removeDecision(kind: DecisionKind, identities: string[]) {
    try {
      const key = decisionKey(kind, identities)
      const decision = (await listPersistedDecisions()).find((item) => item.key === key)
      if (decision) addDecisionTombstone(decision)
      await deletePersistedDecision(key)
      decisionStateRevision.current += 1
      setSavedDecisions(await listPersistedDecisions())
      if (decision && googleSheetLink?.spreadsheetId) {
        markDecisionPending(key, true)
        if (googleAccessToken.current) {
          try { await syncOneGoogleSheetDeletion(googleSheetLink.spreadsheetId, googleAccessToken.current, decision, listDecisionTombstones()[key].updatedAt); removeDecisionTombstone(key); markDecisionPending(key, false); setGoogleDecisionStatus('Decisões sincronizadas.') }
          catch { setGoogleDecisionStatus('Decisões mantidas neste dispositivo; falha de sincronização.') }
        }
      }
    } catch {
      setError('Não foi possível atualizar as decisões salvas neste dispositivo.')
    }
  }

  async function clearSavedDecisions() {
    if (!window.confirm('Apagar as confirmações e decisões salvas neste dispositivo e sincronizar a remoção com os outros dispositivos quando houver conexão? Esta ação não pode ser desfeita.')) return
    try {
      const existing = await listPersistedDecisions()
      existing.forEach((decision) => addDecisionTombstone(decision))
      await clearPersistedDecisions()
      decisionStateRevision.current += 1
      setSavedDecisions([])
      if (googleAccessToken.current && googleSheetLink?.spreadsheetId) {
        existing.forEach((decision) => markDecisionPending(decision.key, true))
        for (const decision of existing) {
          try { await syncOneGoogleSheetDeletion(googleSheetLink.spreadsheetId, googleAccessToken.current, decision, listDecisionTombstones()[decision.key].updatedAt); removeDecisionTombstone(decision.key); markDecisionPending(decision.key, false) }
          catch { setGoogleDecisionStatus('Limpeza salva neste dispositivo; sincronização pendente.'); break }
        }
      }
    } catch {
      setError('Não foi possível apagar as decisões salvas neste dispositivo.')
    }
  }

  async function synchronizeSavedDecisions(spreadsheetId: string, token: string) {
    setGoogleDecisionStatus('Sincronizando decisões…')
    const revision = decisionStateRevision.current
    try {
      const local = await listPersistedDecisions()
      const tombstones = listDecisionTombstones()
      const merged = await syncGoogleSheetDecisions(spreadsheetId, token, local, tombstones)
      if (decisionStateRevision.current === revision) {
        decisionStateRevision.current += 1
        setSavedDecisions(merged)
      }
      Object.keys(tombstones).forEach((key) => removeDecisionTombstone(key))
      setPendingDecisionIds((current) => {
        const next = new Set(current)
        local.forEach((decision) => next.delete(decision.key))
        Object.keys(tombstones).forEach((key) => next.delete(key))
        return next
      })
      setGoogleDecisionStatus('Decisões sincronizadas entre dispositivos.')
    } catch (error) {
      setGoogleDecisionStatus(error instanceof Error ? `Decisões mantidas neste dispositivo. ${error.message}` : 'Decisões mantidas neste dispositivo; não foi possível sincronizar.')
    }
  }

  async function syncDecisionsManually() {
    if (googleAccessToken.current && googleSheetLink?.spreadsheetId) await synchronizeSavedDecisions(googleSheetLink.spreadsheetId, googleAccessToken.current)
  }

  const decisionSyncSummary = googleDecisionStatus.startsWith('Decisões mantidas')
    ? googleDecisionStatus
    : googleSheetLink
      ? !googleSheetInfo?.connected
        ? `Google desconectado${pendingDecisionIds.size ? ` · ${pendingDecisionIds.size} decisão(ões) pendente(s)` : ''}`
        : pendingDecisionIds.size === 1 ? '1 decisão pendente' : pendingDecisionIds.size > 1 ? `${pendingDecisionIds.size} decisões pendentes` : 'Decisões sincronizadas'
      : 'Decisões salvas neste dispositivo'

  function clearSession() {
    pdfSessionGeneration.current += 1; seenPdfFingerprints.current.clear()
    const retainedGoogleSheet = sheetSource === 'google' ? googleSheetRows : null
    setData({ sheet: retainedGoogleSheet ?? [], bank: [] }); setCardPdfs([]); setCardPdfNotice(''); setScreen('home'); setUploads({ sheet: null, bank: null }); setSourceStatus({ sheet: retainedGoogleSheet?.length ? 'ACCEPTED' : 'EMPTY', bank: 'EMPTY' }); setCsvSheetAccepted(false); setGoogleSheetRows(retainedGoogleSheet); setGoogleError(''); setFilterYear('all'); setFilterMonth('all'); setFromDate(''); setToDate('')
  }

  async function loadGoogleSheet(input: string) {
    setGoogleLoading(true); setGoogleError('')
    try {
      const token = await requestGoogleSheetsAccessToken(googleClientId)
      const sheet = await readGoogleSheetLedger(input, token)
      googleAccessToken.current = token
      const lastUpdated = new Date().toISOString()
      const nextLink: SavedGoogleSheetLink = { spreadsheetId: sheet.spreadsheetId, sheetName: GOOGLE_SHEET_TAB_NAME, spreadsheetTitle: sheet.spreadsheetTitle, lastUpdated, autoConnect: true }
      setGoogleSheetLink(nextLink)
      let persistenceWarning = ''
      try { saveGoogleSheetLink(nextLink) } catch { persistenceWarning = 'Dados carregados, mas não foi possível salvar o vínculo neste dispositivo.' }
      setGoogleSheetRows(sheet.transactions)
      setGoogleSheetInfo({ ...nextLink, rowCount: sheet.rowCount, connected: true })
      setGoogleLinkEditing(false)
      const useGoogleLedger = !ledgerSourceChangedByUser.current || selectedLedgerSource.current === 'google'
      if (useGoogleLedger) {
        selectedLedgerSource.current = 'google'
        setData((current) => ({ ...current, sheet: sheet.transactions }))
        setSheetSource('google')
        setSourceStatus((current) => ({ ...current, sheet: 'ACCEPTED' }))
      }
      setGoogleError(persistenceWarning)
      await synchronizeSavedDecisions(sheet.spreadsheetId, token)
    } catch (error) {
      setGoogleError(error instanceof GoogleSheetsError ? error.message : 'Não foi possível ler a aba CUSTOS ANO. A conciliação atual foi mantida.')
    } finally { setGoogleLoading(false) }
  }

  async function connectGoogleSheet(input: string) { await loadGoogleSheet(input) }

  async function refreshGoogleSheet(spreadsheetId = googleSheetInfo?.spreadsheetId, automatic = false) {
    if (!spreadsheetId) return
    setGoogleLoading(true); setGoogleError('')
    try {
      let token = googleAccessToken.current
      if (!token) token = await requestGoogleSheetsAccessToken(googleClientId, '')
      googleAccessToken.current = token
      setGoogleSheetInfo((current) => current ? { ...current, connected: true } : current)
      let sheet
      try { sheet = await readGoogleSheetLedger(spreadsheetId, token) }
      catch (error) {
        if (!(error instanceof GoogleSheetsError) || error.code !== 'AUTH') throw error
        token = await requestGoogleSheetsAccessToken(googleClientId, '')
        googleAccessToken.current = token
        sheet = await readGoogleSheetLedger(spreadsheetId, token)
      }
      googleAccessToken.current = token
      const lastUpdated = new Date().toISOString()
      const nextLink: SavedGoogleSheetLink = { spreadsheetId: sheet.spreadsheetId, sheetName: GOOGLE_SHEET_TAB_NAME, spreadsheetTitle: sheet.spreadsheetTitle, lastUpdated, autoConnect: true }
      setGoogleSheetLink(nextLink)
      let persistenceWarning = ''
      try { saveGoogleSheetLink(nextLink) } catch { persistenceWarning = 'Dados atualizados, mas não foi possível salvar o vínculo neste dispositivo.' }
      setGoogleSheetRows(sheet.transactions)
      setGoogleSheetInfo({ ...nextLink, rowCount: sheet.rowCount, connected: true })
      setGoogleLinkEditing(false)
      const useGoogleLedger = !ledgerSourceChangedByUser.current || selectedLedgerSource.current === 'google'
      if (useGoogleLedger) {
        selectedLedgerSource.current = 'google'
        setSheetSource('google')
        setSourceStatus((current) => ({ ...current, sheet: 'ACCEPTED' }))
        setData((current) => ({ ...current, sheet: sheet.transactions }))
      }
      setGoogleError(persistenceWarning)
      await synchronizeSavedDecisions(sheet.spreadsheetId, token)
    } catch (error) {
      if (error instanceof GoogleSheetsError && error.code === 'AUTH') {
        googleAccessToken.current = ''
        if (googleSheetLink) {
          const nextLink = { ...googleSheetLink, autoConnect: false }
          setGoogleSheetLink(nextLink)
          try { saveGoogleSheetLink(nextLink) } catch { /* Retain the in-memory link and allow reconnection. */ }
        }
        setGoogleSheetInfo((current) => current ? { ...current, connected: false } : current)
        setGoogleError(automatic ? 'Não foi possível renovar a autorização automaticamente. O vínculo foi mantido; use Reconectar Google.' : error.message)
      } else setGoogleError(error instanceof GoogleSheetsError ? error.message : 'Não foi possível atualizar CUSTOS ANO. Os dados atuais foram mantidos.')
    } finally { setGoogleLoading(false) }
  }

  useEffect(() => {
    if (googleAutoReadAttempted.current) return
    googleAutoReadAttempted.current = true
    if (!googleSheetLink) return
    if (!googleSheetLink.autoConnect) {
      setGoogleError('Google desconectado. O vínculo foi mantido; reconecte para atualizar.')
      return
    }
    void refreshGoogleSheet(googleSheetLink.spreadsheetId, true)
  }, [])

  function disconnectGoogleSheet() {
    if (googleAccessToken.current) revokeGoogleSheetsAccessToken(googleAccessToken.current)
    googleAccessToken.current = ''
    if (googleSheetLink) {
      const nextLink = { ...googleSheetLink, autoConnect: false }
      setGoogleSheetLink(nextLink)
      try { saveGoogleSheetLink(nextLink) } catch { setGoogleError('Google desconectado, mas não foi possível atualizar a preferência local.') }
      setGoogleSheetInfo((current) => current ? { ...current, connected: false } : current)
    }
  }

  function forgetGoogleSheet() {
    if (googleAccessToken.current) revokeGoogleSheetsAccessToken(googleAccessToken.current)
    googleAccessToken.current = ''
    try { forgetGoogleSheetLink() } catch { setGoogleError('Não foi possível remover o vínculo salvo neste dispositivo.'); return }
    setGoogleSheetLink(null); setGoogleSheetInfo(null); setGoogleSheetRows(null); setGoogleLinkEditing(false); setGoogleError('')
    if (sheetSource === 'google') {
      ledgerSourceChangedByUser.current = true
      selectedLedgerSource.current = 'csv'
      if (csvSheetAccepted && uploads.sheet) { setSheetSource('csv'); setData((current) => ({ ...current, sheet: uploads.sheet!.valid as LedgerTransaction[] })); setSourceStatus((current) => ({ ...current, sheet: 'ACCEPTED' })) }
      else { setSheetSource('csv'); setData((current) => ({ ...current, sheet: [] })); setSourceStatus((current) => ({ ...current, sheet: 'EMPTY' })) }
    }
  }

  function toggleGoogleLinkEditing() { setGoogleLinkEditing((editing) => !editing) }

  function selectSheetSource(source: 'csv' | 'google') {
    ledgerSourceChangedByUser.current = true
    selectedLedgerSource.current = source
    setSheetSource(source)
    if (source === 'google') {
      if (googleSheetRows?.length) { setData((current) => ({ ...current, sheet: googleSheetRows })); setSourceStatus((current) => ({ ...current, sheet: 'ACCEPTED' })) }
      else setSourceStatus((current) => ({ ...current, sheet: 'EMPTY' }))
    } else if (csvSheetAccepted && uploads.sheet) {
      setData((current) => ({ ...current, sheet: uploads.sheet!.valid as LedgerTransaction[] })); setSourceStatus((current) => ({ ...current, sheet: 'ACCEPTED' }))
    } else {
      setData((current) => ({ ...current, sheet: [] })); setSourceStatus((current) => ({ ...current, sheet: 'EMPTY' }))
    }
  }

  const hydratedDecisions = useMemo(() => {
    const ignoredBankIds = new Set<string>(), rejectedPairKeys = new Set<string>(), confirmedPairs = new Map<string, string>(), confirmedCompositions = new Map<string, string[]>(), ignoredSheetIdentities = new Set<string>(), cardMissingConfirmed = new Set<string>()
    for (const record of savedDecisions) {
      if (record.kind === 'BANK_IGNORED') { const bank = data.bank.find((item) => bankIdentity(item) === record.identities[0]); if (bank) ignoredBankIds.add(bank.id) }
      if (record.kind === 'SHEET_IGNORED') ignoredSheetIdentities.add(record.identities[0])
      if (record.kind === 'PAIR_REJECTED') {
        const bank = data.bank.find((item) => bankIdentity(item) === record.identities[0]), sheet = data.sheet.find((item) => sheetIdentity(item) === record.identities[1])
        if (bank && sheet) rejectedPairKeys.add(pairKey(bank.id, sheet.id))
      }
      if (record.kind === 'PAIR_CONFIRMED') {
        const bank = data.bank.find((item) => bankIdentity(item) === record.identities[0]), sheet = data.sheet.find((item) => sheetIdentity(item) === record.selected[0])
        if (bank && sheet) confirmedPairs.set(bank.id, sheet.id)
      }
      if (record.kind === 'MISSING_ADDED_TO_SHEET') {
        const bank = data.bank.find((item) => bankIdentity(item) === record.identities[0])
        const sheet = data.sheet.find((item) => sheetIdentity(item) === record.selected[0])
        if (bank && sheet) confirmedPairs.set(bank.id, sheet.id)
        else if (bank) ignoredBankIds.add(bank.id)
      }
      if (record.kind === 'COMPOSITION_CONFIRMED' && (record.identities[1] === 'no-statement' || cardPdfs.some((entry) => entry.statement && (entry.statement.statementIdentity === record.identities[1] || entry.legacyStatementIdentity === record.identities[1])))) {
        const bank = data.bank.find((item) => bankIdentity(item) === record.identities[0])
        if (bank && record.selected.every((identity) => data.sheet.some((item) => sheetIdentity(item) === identity))) confirmedCompositions.set(bank.id, record.selected)
      }
      if (record.kind === 'CARD_MISSING_CONFIRMED' && cardPdfs.some((entry) => entry.statement && (record.identities[0].startsWith(`${entry.statement.statementIdentity}:`) || record.identities[0].startsWith(`${entry.legacyStatementIdentity}:`)))) cardMissingConfirmed.add(record.identities[0])
    }
    for (const [bankKey, sheetKey] of Object.entries(locallyAddedMissingPairs)) {
      const bank = data.bank.find((item) => bankIdentity(item) === bankKey)
      const sheet = data.sheet.find((item) => sheetIdentity(item) === sheetKey)
      if (bank && sheet) confirmedPairs.set(bank.id, sheet.id)
      else if (bank) ignoredBankIds.add(bank.id)
    }
    return { ignoredBankIds, ignoredSheetIdentities, rejectedPairKeys, confirmedPairs, confirmedCompositions, cardMissingConfirmed }
  }, [savedDecisions, data, cardPdfs, locallyAddedMissingPairs])
  const statementPayments = useMemo(() => identifyStatementPayments(cardPdfs.flatMap((entry) => entry.statement ? [entry.statement] : []), data.bank), [cardPdfs, data.bank])
  const result = useMemo(() => reconcile(data.bank, data.sheet, {
    ignoredBankIds: hydratedDecisions.ignoredBankIds, rejectedPairKeys: hydratedDecisions.rejectedPairKeys, confirmedPairs: hydratedDecisions.confirmedPairs, confirmedCompositions: hydratedDecisions.confirmedCompositions,
    identifiedCardPaymentIds: new Set([...statementPayments.values()].map((payment) => payment.id)),
  }), [data, hydratedDecisions, statementPayments])
  const statementResults = useMemo(() => {
    const usedSheetIds = new Set<string>()
    const parsed = cardPdfs.filter((entry): entry is CardPdfEntry & { statement: CardStatement } => entry.statement != null)
      .sort((a, b) => (a.statement.dueDate ?? '').localeCompare(b.statement.dueDate ?? '') || a.key.localeCompare(b.key))
    return parsed.map((entry) => {
      const confirmations = new Map<string, string>()
      for (const record of savedDecisions.filter((item) => item.kind === 'STATEMENT_MATCH_CONFIRMED')) {
        const transaction = entry.statement.transactions.find((item) => cardTransactionIdentity(entry.statement, item) === record.identities[0]
          || (entry.legacyStatementIdentity && cardTransactionIdentity(entry.legacyStatementIdentity, item) === record.identities[0]))
        const sheet = data.sheet.find((item) => sheetIdentity(item) === record.selected[0])
        if (transaction && sheet) confirmations.set(transaction.id, sheet.id)
      }
      const confirmedMissing = new Set<string>()
      for (const record of savedDecisions.filter((item) => item.kind === 'CARD_MISSING_CONFIRMED')) {
        const transaction = entry.statement.transactions.find((item) => cardTransactionIdentity(entry.statement, item) === record.identities[0]
          || (entry.legacyStatementIdentity && cardTransactionIdentity(entry.legacyStatementIdentity, item) === record.identities[0]))
        if (transaction) confirmedMissing.add(cardTransactionIdentity(entry.statement, transaction))
      }
      const result = reconcileCardStatement(entry.statement, data.sheet.filter((sheet) => !usedSheetIds.has(sheet.id)), confirmations)
      result.matches.filter((match) => match.status === 'CARD_MATCHED' && match.sheet).forEach((match) => usedSheetIds.add(match.sheet!.id))
      return { entry, statement: entry.statement, payment: statementPayments.get(entry.statement) ?? null, matches: result.matches, confirmations, confirmedMissing, extractedTotal: entry.statement.purchasesDebitsTotal ?? entry.statement.transactions.filter((transaction) => transaction.type === 'PURCHASE').reduce((sum, transaction) => sum + transaction.amount, 0), matchedTotal: result.eligibleSheetTotal, difference: result.difference }
    })
  }, [cardPdfs, data.sheet, savedDecisions, statementPayments])
  const years = useMemo(() => [...new Set([...data.bank.map((item) => item.year), ...data.sheet.map((item) => item.year)].filter(Boolean))].sort().reverse(), [data])
  const filteredItems = useMemo(() => result.items.filter(({ bank }) => inPeriod(bank, filterYear, filterMonth, fromDate, toDate)), [result.items, filterYear, filterMonth, fromDate, toDate])
  const filteredDuplicates = useMemo(() => result.duplicateGroups.filter((group) => inDatePeriod(group.date, filterYear, filterMonth, fromDate, toDate)), [result.duplicateGroups, filterYear, filterMonth, fromDate, toDate])
  const filteredSheet = useMemo(() => data.sheet.filter((sheet) => inPeriod(sheet, filterYear, filterMonth, fromDate, toDate)), [data.sheet, filterYear, filterMonth, fromDate, toDate])
  const shownReview = filteredItems.filter((item) => item.status === 'REVIEW')
  const shownCardDivergences = filteredItems.filter((item) => item.status === 'CARD_DIVERGENCE')
  const shownMissing = filteredItems.filter((item) => item.status === 'MISSING')
  const shownOutOfScope = filteredItems.filter((item) => item.status === 'OUT_OF_SCOPE')
  const shownMatched = filteredItems.filter((item) => item.status === 'MATCHED' && item.bank.type !== 'CARD_PAYMENT')
  const costCategories = [...new Set((googleSheetRows ?? []).map((item) => item.category.trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'pt-BR'))
  const investFacilYields = shownOutOfScope.filter((item) => item.bank.outOfScopeSubtype === 'INVEST_FACIL_YIELD')
  const otherOutOfScope = shownOutOfScope.filter((item) => item.bank.outOfScopeSubtype !== 'INVEST_FACIL_YIELD')
  const statementMatchedSheetIds = new Set(statementResults.flatMap((result) => result.matches.flatMap((match) => match.status === 'CARD_MATCHED' && match.sheet ? [match.sheet.id] : [])))
  const unmatchedFilteredSheet = result.unmatchedSheet.filter((sheet) => !statementMatchedSheetIds.has(sheet.id) && inPeriod(sheet, filterYear, filterMonth, fromDate, toDate))
  const canReconcile = sourceStatus.sheet === 'ACCEPTED' && data.sheet.length > 0 && ((sourceStatus.bank === 'ACCEPTED' && data.bank.length > 0) || cardPdfs.some((entry) => entry.statement != null))

  async function selectFile(mode: Mode, event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file) return
    setError('')
    const previousStatus = sourceStatus[mode]
    setSourceStatus((current) => ({ ...current, [mode]: 'LOADED' }))
    try {
      const csv = await readCsvFile(file)
      const map = initialColumnMap(csv.headers, mode) as ColumnMap
      const parsed = mode === 'sheet' ? parseLedgerRows(csv.rows, map) : parseBankRows(csv.rows, map)
      setUploads((current) => ({ ...current, [mode]: { fileName: file.name, csv, map, valid: parsed.transactions, issues: [...csv.parseErrors.map((message, index) => ({ row: index + 2, message })), ...parsed.issues], rowCount: parsed.rowCount, ignoredRows: parsed.ignoredRows } }))
      setSourceStatus((current) => ({ ...current, [mode]: 'VALIDATED' }))
    } catch {
      setSourceStatus((current) => ({ ...current, [mode]: previousStatus }))
      setError(`Não foi possível ler o CSV selecionado para ${mode === 'sheet' ? 'a planilha' : 'o extrato'}.`)
    }
  }

  async function selectCardPdfs(event: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(event.target.files ?? [])
    event.target.value = ''
    if (!files.length) return
    setCardPdfNotice('')
    const generation = pdfSessionGeneration.current
    let duplicates = 0
    for (const file of files) {
      try {
        const fingerprint = await fingerprintFile(file)
        if (generation !== pdfSessionGeneration.current) return
        if (seenPdfFingerprints.current.has(fingerprint)) { duplicates += 1; continue }
        seenPdfFingerprints.current.add(fingerprint)
        const key = `pdf-${fingerprint}`
        setCardPdfs((current) => [...current, { key, fingerprint, fileName: file.name, status: 'PROCESSING', statement: null }])
        try {
          const parsedStatement = await readCardStatementPdf(file)
          if (generation !== pdfSessionGeneration.current) return
          const statement: CardStatement = { ...parsedStatement, statementIdentity: `${parsedStatement.statementIdentity}-${fingerprint}`, transactions: parsedStatement.transactions.map((transaction) => ({ ...transaction, id: `${transaction.id}-${fingerprint}` })) }
          setCardPdfs((current) => current.map((entry) => entry.key === key ? { ...entry, statement, legacyStatementIdentity: parsedStatement.statementIdentity, status: statement.errors.length ? 'DIVERGENCE' : 'PROCESSED' } : entry))
        } catch {
          if (generation !== pdfSessionGeneration.current) return
          setCardPdfs((current) => current.map((entry) => entry.key === key ? { ...entry, status: 'ERROR', error: 'Não foi possível interpretar este PDF. Os demais arquivos seguem disponíveis.' } : entry))
        }
      } catch {
        duplicates += 1
      }
    }
    if (duplicates) setCardPdfNotice(`${duplicates} PDF(s) duplicado(s) ou ilegível(is) foram ignorados; os demais arquivos foram processados.`)
  }

  function removeCardPdf(key: string) {
    setCardPdfs((current) => current.filter((entry) => entry.key !== key))
  }

  function changeMap(mode: Mode, key: keyof ColumnMap, value: string) {
    setUploads((current) => {
      const entry = current[mode]
      if (!entry) return current
      const map = { ...entry.map, [key]: value }
      const parsed = mode === 'sheet' ? parseLedgerRows(entry.csv.rows, map) : parseBankRows(entry.csv.rows, map)
      return { ...current, [mode]: { ...entry, map, valid: parsed.transactions, issues: [...entry.csv.parseErrors.map((message, index) => ({ row: index + 2, message })), ...parsed.issues], rowCount: parsed.rowCount, ignoredRows: parsed.ignoredRows } }
    })
  }

  function acceptUpload(mode: Mode) {
    const entry = uploads[mode]
    if (!entry || !entry.valid.length) return
    const next = mode === 'sheet' ? { ...data, sheet: entry.valid as LedgerTransaction[] } : { ...data, bank: entry.valid as BankTransaction[] }
    setData(next)
    setSourceStatus((current) => ({ ...current, [mode]: 'ACCEPTED' }))
    if (mode === 'sheet') { setCsvSheetAccepted(true); setSheetSource('csv') }
    setError('')
  }

  function removeUpload(mode: Mode) {
    setUploads((current) => ({ ...current, [mode]: null }))
    if (mode === 'sheet') {
      setCsvSheetAccepted(false)
      if (sheetSource === 'csv') { setSourceStatus((current) => ({ ...current, sheet: 'EMPTY' })); setData((current) => ({ ...current, sheet: [] })) }
    } else { setSourceStatus((current) => ({ ...current, bank: 'EMPTY' })); setData((current) => ({ ...current, bank: [] })) }
  }

  function runReconciliation() {
    if (!canReconcile) {
      const missing = [sourceStatus.sheet !== 'ACCEPTED' ? 'CUSTOS ANO' : '', sourceStatus.bank !== 'ACCEPTED' && !cardPdfs.some((entry) => entry.statement) ? 'extrato bancário ou fatura PDF' : ''].filter(Boolean)
      setError(`Aceite as linhas válidas de ${missing.join(' e ')} antes de conciliar.`)
      return
    }
    setError('')
    setScreen('results')
    setTab('overview')
  }

  function decide(item: ReconciliationItem, decision: 'confirm' | 'reject' | 'ignore') {
    const bankId = bankIdentity(item.bank)
    if (decision === 'ignore') void persistDecision('BANK_IGNORED', [bankId])
    if (decision === 'confirm' && item.sheet) void persistDecision('PAIR_CONFIRMED', [bankId], [sheetIdentity(item.sheet)])
    if (decision === 'reject' && item.sheet && item.candidate) void persistDecision('PAIR_REJECTED', [bankId, sheetIdentity(item.sheet)])
  }

  function bankAddEligibility(item: ReconciliationItem) {
    const bankKey = bankIdentity(item.bank)
    const alreadyAdded = savedDecisions.some((record) => record.kind === 'MISSING_ADDED_TO_SHEET' && record.identities[0] === bankKey)
      || Object.prototype.hasOwnProperty.call(locallyAddedMissingPairs, bankKey)
    return canAddMissingToCostYear({ source: 'BANK', status: item.status, direction: item.bank.direction, type: item.bank.type, alreadyAdded, hasRequiredFields: Boolean(item.bank.date && item.bank.originalDescription && item.bank.amount > 0) })
  }

  function openBankMissing(item: ReconciliationItem) {
    const current = result.items.find((entry) => entry.bank.id === item.bank.id)
    if (!current || !bankAddEligibility(current).eligible) return
    setMissingWriteError(''); setMissingWriteNotice(''); setMissingToAdd({ kind: 'BANK', bank: current.bank })
  }

  function openCardMissing(statement: CardStatement, match: CardStatementMatch) {
    const identity = cardTransactionIdentity(statement, match.transaction)
    const alreadyAdded = savedDecisions.some((record) => record.kind === 'STATEMENT_MATCH_CONFIRMED' && record.identities[0] === identity)
    const eligible = canAddMissingToCostYear({ source: 'STATEMENT', status: match.status, direction: match.transaction.direction, type: match.transaction.type, alreadyAdded, hasRequiredFields: Boolean(match.transaction.date && match.transaction.originalDescription && match.transaction.amount > 0) })
    if (!eligible.eligible) return
    setMissingWriteError(''); setMissingWriteNotice(''); setMissingToAdd({ kind: 'STATEMENT', statement, transaction: match.transaction })
  }

  async function reconnectGoogleForCostWrite() {
    if (!googleSheetLink) { setMissingWriteError('Vincule uma planilha Google antes de adicionar lançamentos. Cancele e conecte a planilha na tela inicial.'); return }
    setReconnectingForWrite(true); setMissingWriteError('')
    try {
      const token = await requestGoogleSheetsAccessToken(googleClientId)
      const refreshed = await readGoogleSheetLedger(googleSheetLink.spreadsheetId, token)
      googleAccessToken.current = token
      const nextLink: SavedGoogleSheetLink = { ...googleSheetLink, spreadsheetTitle: refreshed.spreadsheetTitle, sheetName: GOOGLE_SHEET_TAB_NAME, lastUpdated: new Date().toISOString(), autoConnect: true }
      setGoogleSheetLink(nextLink); saveGoogleSheetLink(nextLink)
      setGoogleSheetInfo({ ...nextLink, rowCount: refreshed.rowCount, connected: true })
      setGoogleSheetRows(refreshed.transactions)
      if (selectedLedgerSource.current === 'google' || !ledgerSourceChangedByUser.current) { setData((current) => ({ ...current, sheet: refreshed.transactions })); setSourceStatus((current) => ({ ...current, sheet: 'ACCEPTED' })) }
      void synchronizeSavedDecisions(refreshed.spreadsheetId, token)
    } catch (error) { setMissingWriteError(error instanceof GoogleSheetsError ? error.message : 'Não foi possível reconectar ao Google Sheets. Os dados do formulário foram mantidos.') }
    finally { setReconnectingForWrite(false) }
  }

  async function addMissingToCostYear(target: MissingWriteTarget, record: Parameters<typeof appendCostYearRecord>[2]) {
    const targetKey = target.kind === 'BANK' ? bankIdentity(target.bank) : cardTransactionIdentity(target.statement, target.transaction)
    if (writingMissingRef.current.has(targetKey)) return
    if (!googleSheetLink) { setMissingWriteError('Vincule uma planilha Google para adicionar a nova linha.'); return }
    if (!googleAccessToken.current) { setMissingWriteError('Conecte o Google antes de adicionar. Seus dados preenchidos foram mantidos.'); return }
    if (target.kind === 'BANK') {
      const current = result.items.find((item) => item.bank.id === target.bank.id)
      if (!current || !bankAddEligibility(current).eligible) { setMissingWriteNotice('Este lançamento já não está elegível para inclusão; confira a conciliação atualizada.'); setMissingToAdd(null); return }
      const googleCandidates = googleSheetRows?.length ? findPlausibleLedgerCandidates(target.bank, googleSheetRows) : []
      if (googleCandidates.length) {
        setData((currentData) => {
          const existingIdentities = new Set(currentData.sheet.map(sheetIdentity))
          return { ...currentData, sheet: [...currentData.sheet, ...googleCandidates.filter((sheet) => !existingIdentities.has(sheetIdentity(sheet)))] }
        })
        setMissingWriteNotice('Este lançamento já existe em CUSTOS ANO; a correspondência foi atualizada sem criar duplicata.')
        setMissingToAdd(null)
        return
      }
    } else {
      const current = statementResults.find((entry) => entry.statement.statementIdentity === target.statement.statementIdentity)?.matches.find((match) => match.transaction.id === target.transaction.id)
      if (!current || !canAddMissingToCostYear({ source: 'STATEMENT', status: current.status, direction: target.transaction.direction, type: target.transaction.type, alreadyAdded: savedDecisions.some((record) => record.kind === 'STATEMENT_MATCH_CONFIRMED' && record.identities[0] === targetKey) }).eligible) {
        setMissingWriteNotice('Esta compra da fatura já não está elegível para inclusão; confira a conciliação atualizada.'); setMissingToAdd(null); return
      }
    }
    writingMissingRef.current.add(targetKey)
    setWritingMissingId(targetKey); setMissingWriteError('')
    try {
      const appended = await appendCostYearRecord(googleSheetLink.spreadsheetId, googleAccessToken.current, record)
      const nextLink: SavedGoogleSheetLink = { ...googleSheetLink, spreadsheetTitle: appended.spreadsheetTitle, sheetName: GOOGLE_SHEET_TAB_NAME, lastUpdated: new Date().toISOString(), autoConnect: true }
      setGoogleSheetLink(nextLink); saveGoogleSheetLink(nextLink)
      setGoogleSheetRows(appended.transactions)
      setGoogleSheetInfo({ ...nextLink, rowCount: appended.rowCount, connected: true })
      const selectedSheetKey = sheetIdentity(appended.transaction)
      if (target.kind === 'BANK') {
        const bankKey = bankIdentity(target.bank)
        setLocallyAddedMissingPairs((current) => ({ ...current, [bankKey]: selectedSheetKey }))
        if (selectedLedgerSource.current === 'google' || !ledgerSourceChangedByUser.current) {
          setData((current) => ({ ...current, sheet: appended.transactions }))
          setSourceStatus((current) => ({ ...current, sheet: 'ACCEPTED' }))
        }
        await persistDecision('MISSING_ADDED_TO_SHEET', [bankKey], [selectedSheetKey])
      } else {
        setData((current) => ({ ...current, sheet: current.sheet.some((sheet) => sheetIdentity(sheet) === selectedSheetKey) ? current.sheet : [...current.sheet, appended.transaction] }))
        setSourceStatus((current) => ({ ...current, sheet: 'ACCEPTED' }))
        await persistDecision('STATEMENT_MATCH_CONFIRMED', [targetKey], [selectedSheetKey])
      }
      setMissingWriteNotice(appended.alreadyPresent ? 'Já havia uma linha igual em CUSTOS ANO; o vínculo foi confirmado sem criar duplicata.' : target.kind === 'STATEMENT' ? 'Compra da fatura adicionada à CUSTOS ANO e conciliada.' : 'Lançamento adicionado à CUSTOS ANO e confirmado na conciliação.')
      setMissingToAdd(null)
      setMissingWriteError('')
    } catch (error) {
      if (error instanceof GoogleSheetsError && error.code === 'AUTH') {
        googleAccessToken.current = ''
        setGoogleSheetInfo((current) => current ? { ...current, connected: false } : current)
      }
      setMissingWriteError(error instanceof Error ? error.message : 'Não foi possível confirmar o append. Seus dados foram mantidos; atualize a planilha antes de tentar novamente.')
    } finally {
      writingMissingRef.current.delete(targetKey)
      setWritingMissingId('')
    }
  }

  function confirmComposition(item: ReconciliationItem, statementIdentity: string | null, sheetIds: string[]) {
    const identities = sheetIds.map((id) => { const sheet = data.sheet.find((entry) => entry.id === id || sheetIdentity(entry) === id); return sheet ? sheetIdentity(sheet) : id })
    void persistDecision('COMPOSITION_CONFIRMED', [bankIdentity(item.bank), statementIdentity ?? 'no-statement'], identities)
  }

  function confirmStatementMatch(statement: CardStatement, transactionId: string, sheetId: string) {
    const transaction = statement.transactions.find((item) => item.id === transactionId), sheet = data.sheet.find((item) => item.id === sheetId)
    if (transaction && sheet) void persistDecision('STATEMENT_MATCH_CONFIRMED', [cardTransactionIdentity(statement, transaction)], [sheetIdentity(sheet)])
  }

  function confirmCardMissing(statement: CardStatement, transactionId: string) {
    const transaction = statement.transactions.find((item) => item.id === transactionId)
    if (transaction) void persistDecision('CARD_MISSING_CONFIRMED', [cardTransactionIdentity(statement, transaction)])
  }
  function undoStatementDecision(kind: DecisionKind, statement: CardStatement, identities: string[]) {
    const currentIdentity = identities[0]
    const transaction = statement.transactions.find((item) => cardTransactionIdentity(statement, item) === currentIdentity)
    const entry = cardPdfs.find((item) => item.statement === statement)
    const legacyIdentity = transaction && entry?.legacyStatementIdentity ? cardTransactionIdentity(entry.legacyStatementIdentity, transaction) : null
    const stored = savedDecisions.find((record) => record.kind === kind && (record.identities[0] === currentIdentity || record.identities[0] === legacyIdentity))
    void removeDecision(kind, stored?.identities ?? identities)
  }
  function ignoreSheet(id: string) { const sheet = data.sheet.find((entry) => entry.id === id); if (sheet) void persistDecision('SHEET_IGNORED', [sheetIdentity(sheet)]) }
  const ignoredSheetIds = hydratedDecisions.ignoredSheetIdentities
  function compositionWasSaved(item: ReconciliationItem, statementIdentity: string | null) {
    return savedDecisions.some((record) => record.kind === 'COMPOSITION_CONFIRMED' && record.identities[0] === bankIdentity(item.bank) && (statementIdentity == null || record.identities[1] === statementIdentity))
  }
  function savedCompositionIdentity(item: ReconciliationItem) {
    return savedDecisions.find((record) => record.kind === 'COMPOSITION_CONFIRMED' && record.identities[0] === bankIdentity(item.bank))?.identities[1] ?? 'no-statement'
  }

  return (
    <div className={`app-shell ${screen === 'home' && showStickyReconcile ? 'app-shell-sticky' : ''}`}>
      <header className="topbar">
        <a className="brand" href="#inicio" onClick={(event) => { event.preventDefault(); setScreen('home') }} aria-label="Conciliador Financeiro, início">
          <span className="brand-mark" aria-hidden="true">↔</span><span>Conciliador<span className="brand-light"> Financeiro</span></span>
        </a>
        <div className="topbar-right">{installPrompt && <button className="button button-quiet button-small" onClick={installApp}>Instalar aplicativo</button>}<span className="privacy-pill"><span aria-hidden="true">●</span> Processamento neste dispositivo</span>{screen === 'results' && <button className="button button-quiet button-small" onClick={clearSession}>Nova conciliação</button>}</div>
      </header>

      <main>
        {screen === 'home' ? <>
          <section className="hero">
            <div className="hero-copy"><span className="eyebrow">SUA ROTINA FINANCEIRA, EM DIA</span><h1>O que passou pelo banco e ficou fora da planilha?</h1><p>Compare os lançamentos da aba <strong>CUSTOS ANO</strong> com seu extrato. Seus arquivos são lidos e analisados somente neste dispositivo.</p></div>
            <div className="hero-orbit" aria-hidden="true"><div className="orbit-card orbit-card-sheet"><span className="orbit-icon">▤</span><strong>Planilha</strong><small>CUSTOS ANO</small></div><span className="orbit-link">⟷</span><div className="orbit-card orbit-card-bank"><span className="orbit-icon">◈</span><strong>Extrato</strong><small>Banco / cartão</small></div><span className="orbit-dot dot-one"/><span className="orbit-dot dot-two"/></div>
          </section>
          {error && <div className="alert alert-error" role="alert">{error}</div>}
          <section className="import-section"><div className="section-heading"><div><span className="step-label">01 / DADOS DE LANÇAMENTOS</span><h2>Dados para conciliação</h2></div><span className="local-tag">◉&nbsp; Seus dados não saem daqui</span></div>
            <GoogleSheetsPanel configured={Boolean(googleClientId)} info={googleSheetInfo} loading={googleLoading} error={googleError} decisionStatus={decisionSyncSummary} editing={googleLinkEditing} onConnect={(input) => { void connectGoogleSheet(input) }} onRefresh={() => { void refreshGoogleSheet() }} onSyncDecisions={() => { void syncDecisionsManually() }} onDisconnect={disconnectGoogleSheet} onChangeSheet={toggleGoogleLinkEditing} onForgetLink={forgetGoogleSheet}/>
            <fieldset className="ledger-source-choice"><legend>FONTE DOS LANÇAMENTOS</legend><label><input type="radio" name="ledger-source" checked={sheetSource === 'google'} disabled={!googleSheetRows?.length} onChange={() => selectSheetSource('google')}/>Google Sheets{googleSheetInfo?.connected ? ' · conectado' : googleSheetRows?.length ? ' · disponível neste dispositivo' : ' · conecte e carregue os dados'}</label><label><input type="radio" name="ledger-source" checked={sheetSource === 'csv'} onChange={() => selectSheetSource('csv')}/>Importar CSV</label></fieldset>
            {sheetSource === 'google' && googleSheetRows?.length ? <div className="ledger-source-summary" role="status"><span aria-hidden="true">✓</span><div><strong>Lançamentos carregados do Google Sheets</strong><small>{googleSheetInfo?.spreadsheetTitle ?? 'Planilha vinculada'} · CUSTOS ANO · {googleSheetRows.length} linhas</small></div><button className="text-button" onClick={() => selectSheetSource('csv')}>Trocar para CSV</button></div> : null}
            <div className={`import-grid ${sheetSource === 'google' ? 'import-grid-google' : ''}`}>
              {sheetSource === 'csv' && <div className="import-step"><span className="step-label">01 / CUSTOS ANO · CSV</span><UploadCard title="Importar lançamentos" subtitle="CSV da tabela CUSTOS ANO" mode="sheet" status={sourceStatus.sheet} upload={uploads.sheet} onSelect={selectFile} onMapChange={changeMap} onAccept={() => acceptUpload('sheet')} onClear={() => removeUpload('sheet')} /></div>}
              <div className="import-step"><span className="step-label">02 / EXTRATO</span><UploadCard title="Importar extrato" subtitle="CSV do banco ou cartão" mode="bank" status={sourceStatus.bank} upload={uploads.bank} onSelect={selectFile} onMapChange={changeMap} onAccept={() => acceptUpload('bank')} onClear={() => removeUpload('bank')} /></div>
            </div>
            <div className="card-import-heading"><span className="step-label">03 / CARTÃO DE CRÉDITO</span><h3>Faturas do cartão</h3></div>
            <CardStatementUpload entries={cardPdfs} notice={cardPdfNotice} onSelect={selectCardPdfs} onRemove={removeCardPdf}/>
            <div className="launch-row"><div className="privacy-detail"><span className="lock-icon">⌑</span><span><strong>Processamento local</strong><small>PDF e CSV são processados neste dispositivo. As decisões ficam salvas localmente e podem sincronizar entre dispositivos.</small></span></div><div className="launch-action"><small>{!decisionsReady ? 'Carregando decisões locais…' : canReconcile ? 'Arquivos aceitos; conciliação pronta.' : sourceStatus.sheet === 'ACCEPTED' ? 'Falta aceitar as linhas válidas do extrato bancário.' : sourceStatus.bank === 'ACCEPTED' ? 'Falta aceitar as linhas válidas da CUSTOS ANO.' : 'Aceite a CUSTOS ANO e o extrato, ou importe a fatura PDF.'}</small><button ref={reconcileButtonRef} className="button button-primary button-launch" aria-hidden={showStickyReconcile} tabIndex={showStickyReconcile ? -1 : undefined} onClick={runReconciliation} disabled={!canReconcile || !decisionsReady}>Conciliar agora <span aria-hidden="true">↗</span></button></div></div>
          </section>
          <section className="how-section"><span className="step-label">02 / O QUE ACONTECE</span><div className="how-grid"><HowCard number="01" title="Validar" copy="Confira cabeçalhos, linhas válidas e possíveis problemas."/><HowCard number="02" title="Comparar" copy="Valores, datas e descrições formam candidatos explicáveis."/><HowCard number="03" title="Revisar" copy="Você confirma ou ignora cada caso incerto."/></div></section>
        </> : <>
          <section className="results-heading"><div><span className="eyebrow">CONCILIAÇÃO LOCAL</span><h1>Visão geral</h1><p>Compare o resultado, refine o período e revise os casos sinalizados.</p></div><button className="button button-outline" onClick={() => setScreen('home')}>← Voltar aos arquivos</button></section>
          <section className="results-sync-bar" aria-label="Sincronização das decisões"><div><strong role={googleDecisionStatus.startsWith('Decisões mantidas') ? 'alert' : 'status'} aria-live={googleDecisionStatus.startsWith('Decisões mantidas') ? 'assertive' : 'polite'}>{decisionSyncSummary}</strong><small>{googleSheetLink ? 'As decisões ficam neste dispositivo e sincronizam pela planilha vinculada.' : 'As decisões ficam salvas neste dispositivo.'}</small></div>{googleSheetInfo?.connected ? <button className="button button-outline" disabled={googleDecisionStatus === 'Sincronizando decisões…'} onClick={syncDecisionsManually}>{googleDecisionStatus === 'Sincronizando decisões…' ? 'Sincronizando…' : 'Sincronizar decisões'}</button> : googleSheetLink ? <button className="button button-outline" onClick={() => setScreen('home')}>Reconectar Google</button> : null}</section>
          <FilterBar years={years} year={filterYear} month={filterMonth} fromDate={fromDate} toDate={toDate} onYear={setFilterYear} onMonth={setFilterMonth} onFrom={setFromDate} onTo={setToDate}/>
          {missingWriteNotice && <p className="cost-write-notice" role="status">{missingWriteNotice}</p>}
          <div className="stat-grid">
            <Metric label="Conciliadas" value={filteredItems.filter((item) => item.status === 'MATCHED').length} tone="green" icon="✓" onClick={() => setTab('overview')}/>
            <Metric label="Para revisar" value={shownReview.length} tone="amber" icon="!" onClick={() => setTab('review')}/>
            <Metric label="Ausentes" value={shownMissing.length} tone="red" icon="⌕" onClick={() => setTab('missing')}/>
            <Metric label="Divergências de cartão" value={shownCardDivergences.length} tone="blue" icon="▣" onClick={() => setTab('card')}/>
            {statementResults.length > 0 && <Metric label="Compras do cartão ausentes" value={statementResults.reduce((sum, result) => sum + result.matches.filter((match) => match.status === 'CARD_MISSING').length, 0)} tone="red" icon="⌕" onClick={() => setTab('statement')}/>}
            <Metric label="Duplicidades" value={filteredDuplicates.length} tone="orange" icon="Ⅱ" onClick={() => setTab('duplicates')}/>
            <Metric label="Fora do escopo" value={shownOutOfScope.length} tone="blue" icon="ℹ" onClick={() => setTab('outofscope')}/>
          </div>
          <div className="tab-row" role="tablist" aria-label="Seções da conciliação"><Tab active={tab === 'overview'} onClick={() => setTab('overview')}>Resumo</Tab><Tab active={tab === 'review'} onClick={() => setTab('review')}>Revisão <span className="tab-count">{shownReview.length}</span></Tab><Tab active={tab === 'missing'} onClick={() => setTab('missing')}>Ausentes <span className="tab-count">{shownMissing.length}</span></Tab><Tab active={tab === 'card'} onClick={() => setTab('card')}>Faturas <span className="tab-count">{shownCardDivergences.length}</span></Tab>{statementResults.length > 0 && <Tab active={tab === 'statement'} onClick={() => setTab('statement')}>Faturas PDF <span className="tab-count">{statementResults.reduce((sum, result) => sum + result.matches.filter((match) => match.status === 'CARD_MISSING').length, 0)}</span></Tab>}<Tab active={tab === 'duplicates'} onClick={() => setTab('duplicates')}>Duplicidades <span className="tab-count">{filteredDuplicates.length}</span></Tab><Tab active={tab === 'outofscope'} onClick={() => setTab('outofscope')}>Fora do escopo <span className="tab-count">{shownOutOfScope.length}</span></Tab><Tab active={tab === 'flags'} onClick={() => setTab('flags')}>Sinalizações</Tab></div>
          {tab === 'overview' && <>
            <div className="summary-grid"><section className="panel"><PanelTitle title="Movimentação no período" note="Valores apresentados em reais"/><div className="totals-list"><AmountRow label="Total de movimentações do banco" amount={filteredItems.filter((item) => item.bank.direction === 'DEBIT' || item.bank.direction === 'CREDIT').reduce((sum, item) => sum + item.bank.amount, 0)} /><AmountRow label="Saídas" amount={filteredItems.filter((item) => item.bank.direction === 'DEBIT').reduce((sum, item) => sum + item.bank.amount, 0)}/><AmountRow label="Entradas" amount={filteredItems.filter((item) => item.bank.direction === 'CREDIT').reduce((sum, item) => sum + item.bank.amount, 0)}/><AmountRow label="Lançamentos da planilha" amount={filteredSheet.reduce((sum, item) => sum + item.amount, 0)} strong/></div></section>
              <section className="panel"><PanelTitle title="Arquivos usados" note="Dados temporários nesta sessão"/><div className="file-summary"><FileLine icon="▤" title="Tabela CUSTOS ANO" detail={`${data.sheet.length} linhas válidas`} /><FileLine icon="◈" title="Extrato bancário" detail={`${data.bank.length} movimentações válidas`} /></div>{result.totals.finalBalance != null && <div className="balance-box"><span>Saldo inicial</span><strong>{formatCents(result.totals.initialBalance ?? 0)}</strong><span>Saldo final informado</span><strong>{formatCents(result.totals.finalBalance)}</strong><span>Saldo calculado</span><strong>{formatCents(result.totals.calculatedFinalBalance ?? 0)}</strong><span>Diferença</span><strong className={result.totals.balanceDifference === 0 ? 'good-text' : 'warning-text'}>{formatCents(result.totals.balanceDifference ?? 0)}</strong></div>}</section></div>
            <section className="panel recent-panel"><PanelTitle title="Atividade para acompanhar" note="Os itens abaixo precisam da sua atenção" action={<button className="text-button" onClick={() => setTab('review')}>Ver revisão →</button>}/>{shownReview.length + shownMissing.length ? <div className="activity-list">{[...shownReview, ...shownMissing].slice(0, 5).map((item) => <ActivityItem key={item.bank.id} item={item}/>)}</div> : <EmptyState title="Tudo em dia por aqui" copy="Nenhuma ausência ou correspondência pendente para o período selecionado."/>}</section>
            {shownMatched.length > 0 && <details className="panel matched-details" open={shownMatched.some((item) => item.candidate?.matchMethod === 'STRUCTURAL')}><summary><span><strong>Correspondências encontradas · {shownMatched.length}</strong><small>Abra para ver evidências, descrição e confiança</small></span><span aria-hidden="true">⌄</span></summary><div className="matched-list">{shownMatched.map((item) => <MatchedDetail key={item.bank.id} item={item} confirmedPreviously={savedDecisions.some((record) => record.kind === 'PAIR_CONFIRMED' && record.identities[0] === bankIdentity(item.bank))} onUndo={() => { if (item.sheet) void removeDecision('PAIR_CONFIRMED', [bankIdentity(item.bank)]) }}/>)}</div></details>}
            {cardPdfs.length > 0 && <section className="panel"><PanelTitle title="Faturas PDF desta conciliação" note="Totais agregados; cada arquivo mantém sua análise independente."/>{cardPdfs.map((entry) => { const item = statementResults.find((result) => result.entry.key === entry.key); const status = entry.status === 'PROCESSING' ? 'Processando…' : entry.status === 'PROCESSED' ? '✓ Processado' : entry.status === 'DIVERGENCE' ? '⚠ Divergência' : '⚠ Erro de parsing'; return <div className="card-pdf-status" key={entry.key}><div><strong>{entry.fileName}</strong><small>{status}{item ? ` · Vencimento ${item.statement.dueDate ? dateLabel(item.statement.dueDate) : 'não identificado'} · Total ${item.statement.reportedTotal == null ? 'indisponível' : formatCents(item.statement.reportedTotal)} · ${item.matches.filter((match) => match.status === 'CARD_MISSING').length} compra(s) ausente(s)` : entry.error ? ` · ${entry.error}` : ''}</small>{item && <small>{item.payment ? `Pagamento identificado: ${dateLabel(item.payment.date)} · ${formatCents(item.payment.amount)}` : 'Pagamento bancário não identificado'}</small>}</div></div>})}</section>}
            {filteredItems.some((item) => item.compositionStatus === 'MATCHED') && <section className="review-list"><PanelTitle title="Pagamentos de cartão conciliados" note="Uma saída bancária pode corresponder a vários lançamentos Crédito_Bradesco"/>{filteredItems.filter((item) => item.compositionStatus === 'MATCHED').map((item) => <CardPaymentCard key={item.bank.id} item={item} persisted={compositionWasSaved(item, null)} onConfirm={(ids) => confirmComposition(item, null, ids)} onUndo={() => void removeDecision('COMPOSITION_CONFIRMED', [bankIdentity(item.bank), savedCompositionIdentity(item)])} onIgnore={() => decide(item, 'ignore')}/>)}</section>}
          </>}
          {tab === 'review' && <div className="review-list">{shownReview.map((item) => item.bank.type === 'CARD_PAYMENT' ? <CardPaymentCard key={item.bank.id} item={item} persisted={compositionWasSaved(item, null)} onConfirm={(ids) => confirmComposition(item, null, ids)} onUndo={() => void removeDecision('COMPOSITION_CONFIRMED', [bankIdentity(item.bank), savedCompositionIdentity(item)])} onIgnore={() => decide(item, 'ignore')}/> : <ReviewCard key={item.bank.id} item={item} onConfirm={() => decide(item, 'confirm')} onReject={() => decide(item, 'reject')} onIgnore={() => decide(item, 'ignore')}/>)}{!shownReview.length && <EmptyState title="Nenhum item para revisar" copy="A conciliação não encontrou itens pendentes neste período."/>}</div>}
          {tab === 'missing' && <div className="review-list">{shownMissing.map((item) => <MissingCard key={item.bank.id} item={item} onIgnore={() => decide(item, 'ignore')} onAddToSheet={() => openBankMissing(item)} canAddToSheet={bankAddEligibility(item).eligible} />)}{!shownMissing.length && <EmptyState title="Nenhuma despesa ausente" copy="Não há saídas classificadas como despesa sem correspondente neste período."/>}</div>}
          {tab === 'card' && <div className="review-list">{shownCardDivergences.map((item) => <CardPaymentCard key={item.bank.id} item={item} persisted={compositionWasSaved(item, null)} onConfirm={(ids) => confirmComposition(item, null, ids)} onUndo={() => void removeDecision('COMPOSITION_CONFIRMED', [bankIdentity(item.bank), savedCompositionIdentity(item)])} onIgnore={() => decide(item, 'ignore')}/>)}{!shownCardDivergences.length && <EmptyState title="Nenhuma divergência de cartão" copy="Todas as faturas têm uma composição confirmada ou não há pagamentos de cartão neste período."/>}</div>}
          {tab === 'statement' && statementResults.map((item) => <CardStatementResults key={item.entry.key} statement={item.statement} payment={item.payment} matches={item.matches} extractedTotal={item.extractedTotal} matchedTotal={item.matchedTotal} difference={item.difference} confirmations={item.confirmations} confirmedMissing={item.confirmedMissing} onConfirm={(transactionId, sheetId) => confirmStatementMatch(item.statement, transactionId, sheetId)} onConfirmMissing={(transactionId) => confirmCardMissing(item.statement, transactionId)} onAddMissing={(match) => openCardMissing(item.statement, match)} onUndo={(kind, identities) => { void undoStatementDecision(kind, item.statement, identities) }}/>)}
          {tab === 'outofscope' && <div className="issue-columns"><section className="panel"><PanelTitle title="Movimentações fora da conciliação de despesas" note="Entradas, investimentos, transferências e tipos sem natureza confirmada"/>{shownOutOfScope.length ? <>{investFacilYields.length > 0 && <details className="investment-yield-group"><summary><strong>Rendimentos Invest Fácil</strong><span>{investFacilYields.length} créditos · total {formatCents(investFacilYields.reduce((sum, item) => sum + item.bank.amount, 0))}</span><small>Créditos de rendimento agrupados; não são lançados em CUSTOS ANO.</small></summary><div>{investFacilYields.map((item) => <p key={item.bank.id}>{dateLabel(item.bank.date)} · {item.bank.originalDescription} · {formatCents(item.bank.amount)}</p>)}</div></details>}{otherOutOfScope.map((item) => <div className="issue-row" key={item.bank.id}><span className="status-icon blue">ℹ</span><div><strong>{item.bank.originalDescription}</strong><p>{dateLabel(item.bank.date)} · {item.bank.directionKnown === false ? 'Direção não identificada' : item.bank.direction === 'DEBIT' ? 'Saída' : 'Entrada'} · {formatCents(item.bank.amount)}</p><small>{item.sheet ? `Correspondência de investimento: ${item.sheet.originalDescription} · ${formatCents(item.sheet.amount)}` : outOfScopeReason(item.bank.type)}</small></div></div>)}</> : <EmptyState title="Nenhuma movimentação fora do escopo" copy="Todas as movimentações deste período estão em outras seções."/>}</section></div>}
          {tab === 'duplicates' && <section className="panel"><PanelTitle title="Possíveis duplicidades na CUSTOS ANO" note="Sugestões baseadas em lançamentos da planilha; nada é removido automaticamente"/>{filteredDuplicates.length ? filteredDuplicates.map((group, index) => <div className="issue-row duplicate-group" key={`${group.source}-${index}`}><span className="status-icon orange">Ⅱ</span><div><strong>Confira este grupo · {group.transactionIds.length} lançamentos</strong>{group.transactionIds.map((id) => { const sheet = data.sheet.find((entry) => entry.id === id); return sheet ? <p className="duplicate-entry" key={id}>{dateLabel(sheet.date)} · {sheet.originalDescription} · {formatCents(sheet.amount)}{sheet.paymentMethod ? ` · ${sheet.paymentMethod}` : ''}</p> : null })}<small>Possíveis duplicidades precisam de confirmação manual.</small></div></div>) : <EmptyState title="Nenhuma duplicidade sugerida" copy="Nenhuma linha da CUSTOS ANO com data, valor e descrição parecida foi encontrada."/>}</section>}
          {tab === 'flags' && <section className="panel"><PanelTitle title="Lançamentos da planilha não encontrados no extrato" note="Podem pertencer a outra conta, período ou meio de pagamento"/>{unmatchedFilteredSheet.filter((item) => !ignoredSheetIds.has(sheetIdentity(item))).length ? unmatchedFilteredSheet.filter((item) => !ignoredSheetIds.has(sheetIdentity(item))).map((sheet) => <div className="issue-row" key={sheet.id}><span className="status-icon blue">↗</span><div><strong>{sheet.originalDescription}</strong><p>{dateLabel(sheet.date)} · {formatCents(sheet.amount)} · {sheet.category || 'Sem categoria'}</p><small>Não encontrado no extrato importado.</small><button className="text-button" onClick={() => ignoreSheet(sheet.id)}>Ignorar este lançamento</button></div></div>) : <EmptyState title="Sem sinalizações" copy="Não há lançamentos da planilha pendentes neste período."/>}</section>}
          <ExportBar result={{ ...result, duplicateGroups: filteredDuplicates }} items={filteredItems} banks={data.bank} sheets={data.sheet}/>
          <footer className="results-footer"><span>▣ Confirmações salvas neste dispositivo{googleSheetLink ? ' e sincronizadas quando Google está conectado.' : '.'}</span><button className="text-button" onClick={clearSession}>Limpar dados desta sessão</button><button className="text-button" onClick={() => void clearSavedDecisions()}>Limpar confirmações salvas</button></footer>
        </>}
      </main>
      {screen === 'home' && showStickyReconcile && <div className="sticky-reconcile" aria-label="Ação de conciliação"><button className="button button-primary button-launch" aria-label="Conciliar agora" onClick={runReconciliation} disabled={!canReconcile || !decisionsReady}>Conciliar agora <span aria-hidden="true">↗</span></button></div>}
      <PwaUpdateNotice />
      {screen === 'results' && missingToAdd && <AddCostYearDialog transaction={missingToAdd.kind === 'BANK' ? missingToAdd.bank : undefined} initial={missingToAdd.kind === 'STATEMENT' ? { description: missingToAdd.transaction.installment != null && missingToAdd.transaction.totalInstallments != null ? '(' + missingToAdd.transaction.installment + '/' + missingToAdd.transaction.totalInstallments + ') ' + missingToAdd.transaction.originalDescription : missingToAdd.transaction.originalDescription, date: missingToAdd.transaction.date, amount: missingToAdd.transaction.amount, paymentSource: 'STATEMENT' } : undefined} categories={costCategories} connected={Boolean(googleSheetInfo?.connected && googleAccessToken.current)} saving={writingMissingId === (missingToAdd.kind === 'BANK' ? bankIdentity(missingToAdd.bank) : cardTransactionIdentity(missingToAdd.statement, missingToAdd.transaction)) || reconnectingForWrite} error={missingWriteError} onCancel={() => { if (!writingMissingId) { setMissingToAdd(null); setMissingWriteError('') } }} onReconnect={() => void reconnectGoogleForCostWrite()} onSubmit={(record) => void addMissingToCostYear(missingToAdd, record)} />}
      <footer className="site-footer"><span>Conciliador Financeiro <span>·</span> Extratos e PDFs permanecem no dispositivo.</span><span>Aplicação local · CSV, Google Sheets e fatura PDF</span><span>Build de teste PWA</span></footer>
    </div>
  )
}

function inPeriod(transaction: Transaction, year: string, month: string, fromDate: string, toDate: string) {
  return inDatePeriod(transaction.date, year, month, fromDate, toDate)
}

function inDatePeriod(date: string, year: string, month: string, fromDate: string, toDate: string) {
  if (year !== 'all' && date.slice(0, 4) !== year) return false
  if (month !== 'all' && date.slice(5, 7) !== month) return false
  if (fromDate && date < fromDate) return false
  if (toDate && date > toDate) return false
  return true
}

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed'; platform: string }>
}

function UploadCard({ title, subtitle, mode, status, upload, onSelect, onMapChange, onAccept, onClear }: {
  title: string; subtitle: string; mode: Mode; status: SourceStatus; upload: UploadState; onSelect: (mode: Mode, event: ChangeEvent<HTMLInputElement>) => void;
  onMapChange: (mode: Mode, key: keyof ColumnMap, value: string) => void; onAccept: () => void; onClear: () => void
}) {
  const [showAllIssues, setShowAllIssues] = useState(false)
  const accepted = status === 'ACCEPTED' && upload
  return <article className={`upload-card ${upload ? 'upload-card-loaded' : ''} ${accepted ? 'upload-card-accepted' : ''}`}><div className="upload-top"><span className={`upload-icon ${mode}`}>{mode === 'sheet' ? '▤' : '◈'}</span><span className="upload-state">{accepted ? '✓ Fonte aceita' : status === 'LOADED' ? 'Lendo arquivo…' : upload ? 'CSV validado' : 'CSV · Seleção local'}</span></div><h3>{title}</h3><p className="upload-subtitle">{subtitle}</p>
    {!upload && status === 'LOADED' ? <div className="file-drop" role="status">Lendo o arquivo neste dispositivo…</div> : !upload ? <label className="file-drop"><input type="file" aria-label="Selecionar arquivo CSV" accept=".csv,text/csv" onChange={(event) => onSelect(mode, event)}/><span className="file-plus">＋</span><strong>Selecionar arquivo CSV</strong><small>Separador vírgula ou ponto e vírgula · UTF-8</small></label> : accepted ? <>
      <div className="accepted-file"><span className="accepted-check" aria-hidden="true">✓</span><div><strong>{upload.fileName}</strong><small>{upload.valid.length} movimentações carregadas</small><small>{upload.issues.length === 1 ? '1 linha com problema não importada' : `${upload.issues.length} linhas com problemas não importadas`}</small></div></div>
      {upload.csv.metadataRowsIgnored > 0 && <small className="ignored-row-note">{upload.csv.metadataRowsIgnored} linha(s) de metadados antes do cabeçalho.</small>}
      {upload.issues.length > 0 && <div className="issue-preview"><div><span className="status-icon amber">!</span><span><strong>{upload.issues.length} problema(s) preservados para consulta</strong><small>Somente as linhas válidas foram aceitas.</small></span><button className="text-button" onClick={() => setShowAllIssues(!showAllIssues)}>{showAllIssues ? 'Recolher' : 'Detalhes'}</button></div>{showAllIssues && <ul>{upload.issues.slice(0, 8).map((issue, index) => <li key={index}>Linha {issue.row}: {issue.message}</li>)}</ul>}</div>}
      <div className="accepted-actions"><label className="button button-outline replace-file"><input type="file" aria-label="Selecionar arquivo CSV" accept=".csv,text/csv" onChange={(event) => onSelect(mode, event)}/>Substituir arquivo</label><button className="button button-quiet button-small" onClick={onClear}>Remover</button></div>
    </> : <>
      <div className="selected-file"><span>▤</span><div><strong>{upload.fileName}</strong><small>{upload.rowCount} linhas detectadas · delimitador {upload.csv.delimiter === ',' ? 'vírgula' : upload.csv.delimiter === ';' ? 'ponto e vírgula' : upload.csv.delimiter || 'automático'}</small>{upload.csv.metadataRowsIgnored > 0 && <small>{upload.csv.metadataRowsIgnored} linha(s) de metadados ignorada(s) antes do cabeçalho</small>}</div><button className="icon-button" aria-label="Remover arquivo" onClick={onClear}>×</button></div>
      <div className="mapping-grid"><strong className="mapping-heading">Confira o mapeamento das colunas</strong>{[...requiredFields[mode], ...optionalFields[mode]].map((key) => <label className="map-field" key={key}><span>{fieldTitles[key]}{requiredFields[mode].includes(key) && <i> · obrigatório</i>}</span><select value={upload.map[key] ?? ''} onChange={(event) => onMapChange(mode, key, event.target.value)}><option value="">{requiredFields[mode].includes(key) ? 'Selecione uma coluna' : 'Não disponível'}</option>{upload.csv.headers.map((header) => <option key={header} value={header}>{header}</option>)}</select></label>)}</div>
      <div className="preview-heading"><strong>Prévia</strong><span>{upload.valid.length} válidas · {upload.issues.length} problemas</span></div>
      {upload.ignoredRows > 0 && <small className="ignored-row-note">{upload.ignoredRows} linha(s) ignoradas por não conterem movimentação ou serem cabeçalho/rodapé.</small>}
      <div className="preview-table-wrap"><table className="preview-table"><thead><tr>{upload.csv.headers.slice(0, 6).map((header) => <th key={header}>{header}</th>)}</tr></thead><tbody>{upload.csv.rows.slice(0, 4).map((row, index) => <tr key={index}>{upload.csv.headers.slice(0, 6).map((header) => <td key={header}>{row[header]}</td>)}</tr>)}</tbody></table></div>
      {upload.issues.length > 0 && <div className="issue-preview"><div><span className="status-icon amber">!</span><span><strong>{upload.issues.length} problema(s) para conferir</strong><small>As linhas inválidas não serão descartadas sem aviso.</small></span><button className="text-button" onClick={() => setShowAllIssues(!showAllIssues)}>{showAllIssues ? 'Recolher' : 'Detalhes'}</button></div>{showAllIssues && <ul>{upload.issues.slice(0, 8).map((issue, index) => <li key={index}>Linha {issue.row}: {issue.message}</li>)}</ul>}</div>}
      <button className="button button-secondary full-button" disabled={!upload.valid.length} onClick={onAccept}>Usar {upload.valid.length} linha(s) válidas <span aria-hidden="true">→</span></button>
    </>}
  </article>
}

function CardStatementUpload({ entries, notice, onSelect, onRemove }: { entries: CardPdfEntry[]; notice: string; onSelect: (event: ChangeEvent<HTMLInputElement>) => void; onRemove: (key: string) => void }) {
  return <section className="card-pdf-import panel"><div className="panel-heading"><div><span className="step-label">03 / CARTÃO DE CRÉDITO</span><h2>Importar faturas PDF</h2><p>Cada fatura é lida separadamente neste navegador; os arquivos não são enviados nem guardados.</p></div></div>
    <label className="file-drop card-pdf-drop"><input type="file" aria-label="Selecionar fatura PDF" accept="application/pdf,.pdf" multiple onChange={onSelect}/><span className="file-plus">＋</span><strong>Adicionar faturas PDF</strong><small>Selecione um ou vários PDFs; você também pode adicionar mais depois.</small></label>
    {notice && <div className="alert alert-error" role="status">{notice}</div>}
    {entries.map((entry) => {
      const statement = entry.statement
      const purchases = statement?.transactions.filter((transaction) => transaction.type === 'PURCHASE') ?? []
      const refunds = statement?.transactions.filter((transaction) => transaction.type === 'REFUND') ?? []
      const status = entry.status === 'PROCESSING' ? 'Processando…' : entry.status === 'PROCESSED' ? '✓ Processado' : entry.status === 'DIVERGENCE' ? '⚠ Divergência' : '⚠ Erro de parsing'
      return <article className="card-pdf-entry" key={entry.key}>
        <div className="card-pdf-status"><div><strong>{entry.fileName}</strong><small>{status}{statement ? ` · PDF lido · ${statement.pageCount} páginas · ${new Set(statement.transactions.map((item) => item.cardIdentifier)).size} cartões · ${purchases.length} compras · ${refunds.length} crédito(s)/estorno(s)` : ''}</small></div><button className="button button-quiet button-small" aria-label={`Remover ${entry.fileName}`} onClick={() => onRemove(entry.key)}>Remover</button></div>
        {statement && <><div className="statement-totals"><AmountRow label="Compras/Débitos extraídos" amount={purchases.reduce((sum, transaction) => sum + transaction.amount, 0)}/><AmountRow label="Créditos/estornos extraídos" amount={-refunds.reduce((sum, item) => sum + item.amount, 0)}/><AmountRow label="Total informado pela fatura" amount={statement.reportedTotal ?? 0}/><strong className={statement.errors.length ? 'warning-text' : 'good-text'}>{statement.errors.length ? '⚠ Divergência encontrada' : '✓ Valores conferem'}</strong></div>{statement.errors.map((message) => <p className="statement-warning" key={message}>{message}</p>)}</>}
        {entry.error && <p className="statement-warning">{entry.error}</p>}
      </article>
    })}
  </section>
}

function CardStatementResults({ statement, payment, matches, extractedTotal, matchedTotal, difference, confirmations, confirmedMissing, onConfirm, onConfirmMissing, onAddMissing, onUndo }: { statement: CardStatement; payment: BankTransaction | null; matches: CardStatementMatch[]; extractedTotal: number; matchedTotal: number; difference: number; confirmations: Map<string, string>; confirmedMissing: Set<string>; onConfirm: (transactionId: string, sheetId: string) => void; onConfirmMissing: (transactionId: string) => void; onAddMissing: (match: CardStatementMatch) => void; onUndo: (kind: DecisionKind, identities: string[]) => void }) {
  const cardIds = [...new Set(statement.transactions.map((item) => item.cardIdentifier))]
  const refunds = statement.transactions.filter((item) => item.type === 'REFUND')
  const purchasesTotal = statement.transactions.filter((item) => item.type === 'PURCHASE').reduce((sum, item) => sum + item.amount, 0)
  return <div className="statement-results">
    <section className="panel"><PanelTitle title="Fatura PDF conferida" note={`${statement.fileName} · ${statement.pageCount} páginas · compras extraídas localmente`}/>
      <div className="statement-totals"><AmountRow label="Compras/Débitos extraídos" amount={purchasesTotal}/>{statement.previousBalance != null && <AmountRow label="Saldo anterior" amount={statement.previousBalance}/ >}{statement.creditsPaymentsTotal != null && <AmountRow label="Créditos/Pagamentos" amount={statement.creditsPaymentsTotal}/ >}{statement.reportedTotal != null && <AmountRow label="Total da fatura" amount={statement.reportedTotal}/ >}{statement.accountingDifference != null && <strong className={statement.accountingDifference === 0 ? 'good-text' : 'warning-text'}>{statement.accountingDifference === 0 ? '✓ Saldo anterior − créditos/pagamentos + compras/débitos = total da fatura' : '⚠ A relação matemática da fatura não fecha'}</strong>}<AmountRow label="Compras correspondentes confirmadas em Crédito_Bradesco" amount={matchedTotal} strong/><AmountRow label="Diferença ainda não conciliada" amount={difference} strong/><strong className={statement.errors.length ? 'warning-text' : statement.purchasesDebitsTotal === extractedTotal ? 'good-text' : 'warning-text'}>{statement.errors.length ? '⚠ Divergência de parsing' : statement.purchasesDebitsTotal === extractedTotal ? '✓ Compras extraídas conferem com Compras/Débitos' : '⚠ Compras extraídas divergem do total de Compras/Débitos'}</strong></div>
      {statement.errors.map((message) => <p className="statement-warning" key={message}>{message}</p>)}
      <p className="statement-caution">A diferença pode indicar uma compra ainda não registrada, uma correspondência pendente ou valores de outro período/encargos. Ela não é classificada automaticamente como despesa esquecida.</p>
      {statement.dueDate && <p>Vencimento: {dateLabel(statement.dueDate)}{statement.nextClosingDate ? ` · Próximo fechamento: ${dateLabel(statement.nextClosingDate)}` : ''}</p>}
      {statement.previousPayment != null && <p className="statement-payment-note">Pagamento anterior identificado: {formatCents(statement.previousPayment)} · excluído das compras da fatura.</p>}
      {payment ? <div className="match-reasons"><span><b>✓</b> Pagamento da fatura identificado: {dateLabel(payment.date)} · {payment.originalDescription} · {formatCents(payment.amount)}</span><small>O vínculo é com o total agregado da fatura. A conciliação das compras individuais continua separada abaixo.</small></div> : <p className="statement-payment-note">Nenhum pagamento bancário com o total da fatura foi identificado perto do vencimento. As compras individuais continuam sendo conciliadas separadamente.</p>}
      {statement.cardSubtotals.length > 0 && <AmountRow label="Soma dos subtotais dos cartões" amount={statement.cardSubtotals.reduce((sum, item) => sum + item.amount, 0)} strong/>}
    </section>
      {cardIds.map((cardIdentifier) => {
        const subtotal = statement.cardSubtotals.find((item) => item.cardIdentifier === cardIdentifier)?.amount
        return <section className="panel statement-card-group" key={cardIdentifier}><PanelTitle title={`Cartão final ${cardIdentifier.slice(-4)}`} note={cardIdentifier}/>{matches.filter((match) => match.transaction.cardIdentifier === cardIdentifier).map((match) => <CardStatementRow key={match.transaction.id} match={match} statementIdentity={statement.statementIdentity} confirmedPreviously={confirmations.has(match.transaction.id)} missingConfirmed={confirmedMissing.has(cardTransactionIdentity(statement, match.transaction))} onConfirm={onConfirm} onConfirmMissing={onConfirmMissing} onAddMissing={onAddMissing} onUndo={onUndo}/>)}<div className="amount-row amount-strong"><span>Subtotal informado</span><strong>{subtotal == null ? 'Não disponível' : formatCents(subtotal)}</strong></div></section>
      })}
      {refunds.length > 0 && <section className="panel statement-card-group"><PanelTitle title="Créditos/estornos" note="Itens informativos; não entram na lista de compras do cartão ausentes."/>{refunds.map((transaction) => <article className="statement-transaction" key={transaction.id}><span className="status-icon green">↩</span><div className="statement-transaction-main"><strong>{dateLabel(transaction.date)} · {transaction.originalDescription}</strong><span className="statement-status green">CRÉDITO/ESTORNO</span></div><strong className="activity-amount">{formatCents(-transaction.amount)}</strong></article>)}</section>}
  </div>
}

function CardStatementRow({ match, statementIdentity, confirmedPreviously, missingConfirmed, onConfirm, onConfirmMissing, onAddMissing, onUndo }: { match: CardStatementMatch; statementIdentity: string; confirmedPreviously: boolean; missingConfirmed: boolean; onConfirm: (transactionId: string, sheetId: string) => void; onConfirmMissing: (transactionId: string) => void; onAddMissing: (match: CardStatementMatch) => void; onUndo: (kind: DecisionKind, identities: string[]) => void }) {
  const { transaction, status, candidates } = match
  const identity = cardTransactionIdentity(statementIdentity, transaction)
  const label = status === 'CARD_REFUNDED' ? 'ESTORNADA · NÃO É COMPRA AUSENTE' : status === 'CARD_MATCHED' ? confirmedPreviously ? 'CONCILIADO ANTERIORMENTE' : 'MATCHED · Crédito_Bradesco' : status === 'CARD_MISSING' && missingConfirmed ? 'AUSÊNCIA CONFIRMADA' : status === 'CARD_MISSING' ? 'COMPRA DE CARTÃO NÃO REGISTRADA' : 'REVISAR CORRESPONDÊNCIA'
  const tone = status === 'CARD_MATCHED' || status === 'CARD_REFUNDED' ? 'green' : status === 'CARD_MISSING' ? 'red' : 'amber'
  const addDecision = canAddMissingToCostYear({ source: 'STATEMENT', status, direction: transaction.direction, type: transaction.type })
  return <article className="statement-transaction"><span className={`status-icon ${tone}`}>{status === 'CARD_MATCHED' || status === 'CARD_REFUNDED' ? '✓' : status === 'CARD_MISSING' ? '⌕' : '!'}</span><div className="statement-transaction-main"><strong>{dateLabel(transaction.date)} · {transaction.originalDescription}</strong><p>{transaction.city || 'Cidade não informada'}{transaction.installment != null ? ` · Parcela ${transaction.installment}/${transaction.totalInstallments}` : ''}</p>{status === 'CARD_MATCHED' && match.sheet && <small>Planilha: {dateLabel(match.sheet.date)} · {match.sheet.originalDescription} · {formatCents(match.sheet.amount)}</small>}{status === 'CARD_REVIEW' && candidates.map((candidate) => <div className="statement-candidate" key={candidate.id}><small>CUSTOS ANO: {dateLabel(candidate.date)} · {candidate.originalDescription} · {formatCents(candidate.amount)}</small><button className="text-button" onClick={() => onConfirm(transaction.id, candidate.id)}>Confirmar este lançamento</button></div>)}{match.evidence && <div className="statement-match-evidence" aria-label="Evidências do matching">{match.evidence.map((item) => <small key={item}>✓ {item}</small>)}</div>}<span className={`statement-status ${tone}`}>{label}</span>{addDecision.eligible && <button className="text-button" onClick={() => onAddMissing(match)}>Adicionar à CUSTOS ANO</button>}{status === 'CARD_MISSING' && !missingConfirmed && <button className="text-button" onClick={() => onConfirmMissing(transaction.id)}>Confirmar ausência</button>}{confirmedPreviously && match.sheet && <button className="text-button" onClick={() => onUndo('STATEMENT_MATCH_CONFIRMED', [identity])}>Desfazer confirmação</button>}{missingConfirmed && <button className="text-button" onClick={() => onUndo('CARD_MISSING_CONFIRMED', [identity])}>Desfazer decisão</button>}</div><strong className="activity-amount">{formatCents(transaction.direction === 'CREDIT' ? -transaction.amount : transaction.amount)}</strong></article>
}

function HowCard({ number, title, copy }: { number: string; title: string; copy: string }) { return <article className="how-card"><span>{number}</span><div><strong>{title}</strong><p>{copy}</p></div></article> }
function Metric({ label, value, tone, icon, onClick }: { label: string; value: number; tone: string; icon: string; onClick: () => void }) { return <button type="button" className={`metric metric-${tone}`} onClick={onClick}><span className="metric-icon">{icon}</span><span className="metric-value">{value}</span><span className="metric-label">{label}</span></button> }
function PanelTitle({ title, note, action }: { title: string; note?: string; action?: ReactNode }) { return <div className="panel-heading"><div><h2>{title}</h2>{note && <p>{note}</p>}</div>{action}</div> }
function AmountRow({ label, amount, strong = false }: { label: string; amount: number; strong?: boolean }) { return <div className={`amount-row ${strong ? 'amount-strong' : ''}`}><span>{label}</span><strong>{formatCents(amount)}</strong></div> }
function FileLine({ icon, title, detail }: { icon: string; title: string; detail: string }) { return <div className="file-line"><span>{icon}</span><div><strong>{title}</strong><small>{detail}</small></div><span className="check-mark">✓</span></div> }
function Tab({ active, onClick, children }: { active: boolean; onClick: () => void; children: ReactNode }) { return <button role="tab" aria-selected={active} className={`tab-button ${active ? 'active' : ''}`} onClick={onClick}>{children}</button> }
function EmptyState({ title, copy }: { title: string; copy: string }) { return <div className="empty-state"><span aria-hidden="true">✓</span><strong>{title}</strong><p>{copy}</p></div> }
function ActivityItem({ item }: { item: ReconciliationItem }) { return <div className="activity-item"><span className={`status-icon ${item.status === 'REVIEW' ? 'amber' : 'red'}`}>{item.status === 'REVIEW' ? '!' : '⌕'}</span><div><strong>{item.status === 'REVIEW' ? 'Possível correspondência' : 'Possível lançamento ausente'}</strong><small>{dateLabel(item.bank.date)} · {item.bank.originalDescription}{item.sheet ? ` ↔ ${item.sheet.originalDescription}` : ''}</small></div><strong className="activity-amount">{formatCents(item.bank.amount)}</strong></div> }
function MatchReason({ reason }: { reason: string }) { const caution = /genérica|baixa similaridade|não confirmada|dia.*diferença|descrição diferente|mais de uma candidata/i.test(reason); return <span><b>{caution ? '△' : '✓'}</b> {reason}</span> }
function MatchedDetail({ item, confirmedPreviously, onUndo }: { item: ReconciliationItem; confirmedPreviously: boolean; onUndo: () => void }) { return <article className="matched-detail"><div><strong>{dateLabel(item.bank.date)} · {item.bank.originalDescription}</strong><p>{formatCents(item.bank.amount)} · {item.bank.direction === 'DEBIT' ? 'Saída' : 'Entrada'} ↔ {item.sheet?.originalDescription ?? 'Planilha'}</p></div><span className="confidence">{item.candidate?.confidence ?? 96}% de confiança</span><div className="match-reasons">{item.candidate?.reasons.map((reason) => <MatchReason key={reason} reason={reason}/>)}</div><small>{confirmedPreviously ? '✓ Conciliado anteriormente; decisão salva neste dispositivo.' : item.candidate?.matchMethod === 'STRUCTURAL' ? 'Match automático: valor, data, direção e solução global 1:1.' : item.candidate?.matchMethod === 'MANUAL' ? 'Correspondência confirmada por você.' : 'Pontuação combinada de valor, data e descrição.'}</small>{confirmedPreviously && <button className="text-button" onClick={onUndo}>Desfazer confirmação</button>}</article> }
function ReviewCard({ item, onConfirm, onReject, onIgnore }: { item: ReconciliationItem; onConfirm: () => void; onReject: () => void; onIgnore: () => void }) {
  return <article className="review-card"><div className="review-card-title"><span className="status-icon amber">!</span><div><span className="step-label">{item.sheet ? 'POSSÍVEL CORRESPONDÊNCIA' : 'MOVIMENTAÇÃO PARA CLASSIFICAR'}</span><h2>{item.sheet ? 'Confira este par de lançamentos' : item.bank.direction === 'CREDIT' ? 'Entrada bancária fora da conciliação de despesas' : 'Movimentação para revisar'}</h2></div><span className="confidence">{item.candidate?.confidence ?? 0}% de confiança</span></div><div className="comparison-grid"><TransactionBox label="BANCO / CARTÃO" transaction={item.bank} /><span className="compare-arrow">↔</span><TransactionBox label="CUSTOS ANO" transaction={item.sheet}/></div><div className="match-reasons">{item.candidate?.reasons.map((reason) => <MatchReason key={reason} reason={reason}/>)}{!item.sheet && item.bank.direction === 'CREDIT' && <span>ℹ Entrada não tratada como despesa ausente</span>}</div><div className="review-actions">{item.sheet && <><button className="button button-primary" onClick={onConfirm}>✓ Confirmar</button><button className="button button-outline" onClick={onReject}>Não é a mesma</button></>}<button className="text-button" onClick={onIgnore}>Ignorar</button></div></article>
}
function CardPaymentCard({ item, persisted, onConfirm, onIgnore, onUndo }: { item: ReconciliationItem; persisted: boolean; onConfirm: (sheetIds: string[]) => void; onIgnore: () => void; onUndo: () => void }) {
  const options = item.composition.length ? [{ items: item.composition, score: 100, reasons: ['Composição confirmada pelo usuário'] }] : item.compositionOptions
  const [selected, setSelected] = useState<number | null>(options.length === 1 ? 0 : null)
  const selectedIndex = selected != null && selected < options.length ? selected : options.length === 1 ? 0 : null
  const displayed = selectedIndex == null ? null : options[selectedIndex]
  const summary = item.cardSummary
  return <article className="review-card card-payment-card">
    <div className="review-card-title"><span className="status-icon blue">◈</span><div><span className="step-label">{item.compositionStatus === 'MATCHED' ? 'PAGAMENTO DE CARTÃO CONCILIADO' : 'DIVERGÊNCIA DE FATURA'}</span><h2>{item.compositionStatus === 'MATCHED' ? 'Liquidação da fatura' : item.compositionStatus === 'NO_MATCH' ? 'Nenhuma composição exata encontrada' : item.compositionStatus === 'LIMITED' ? 'Busca de composição incompleta' : 'Revisão de fatura'}</h2></div><span className="confidence">{item.compositionStatus === 'MATCHED' ? 'Composição confirmada' : item.compositionStatus === 'LIMITED' ? 'Busca incompleta' : item.compositionStatus === 'NO_MATCH' ? 'Diferença de fatura' : 'Revisão necessária'}</span></div>
    <div className="comparison-grid"><TransactionBox label="BANCO" transaction={item.bank}/><span className="compare-arrow">→</span><div className="transaction-box"><span className="step-label">COMPOSIÇÃO Crédito_Bradesco</span>{displayed?.items.length ? <><div className="card-composition-list">{displayed.items.map((sheet) => <div className="card-composition-row" key={sheet.id}><span>{dateLabel(sheet.date)} · {sheet.originalDescription}<small>{sheet.paymentMethod}</small></span><strong>{formatCents(sheet.amount)}</strong></div>)}</div><div className="card-composition-total"><span>TOTAL DA COMPOSIÇÃO</span><strong>{formatCents(displayed.items.reduce((sum, sheet) => sum + sheet.amount, 0))}</strong></div></> : <span className="no-candidate">Nenhuma composição exata está pronta para confirmação.</span>}</div></div>
    {summary && <CardSummaryNotice item={item}/>}
    {options.length > 1 && <fieldset className="composition-options"><legend>Alternativas exatas, ordenadas por plausibilidade. Escolha uma para confirmar:</legend>{options.map((option, index) => <label className="composition-option" key={canonicalCompositionKey(option.items)}><input type="radio" name={`composition-${item.bank.id}`} checked={selectedIndex === index} onChange={() => setSelected(index)}/><span><strong>Opção {index + 1} · {option.items.length} lançamentos · {formatCents(option.items.reduce((sum, sheet) => sum + sheet.amount, 0))}</strong><small>Plausibilidade {option.score}/100 · {option.reasons.join(' · ')}</small></span></label>)}</fieldset>}
    {item.compositionStatus === 'MATCHED' && <div className="match-reasons"><span><b>✓</b> Soma exata em centavos</span><span><b>✓</b> Vínculo confirmado; itens bloqueados para outras faturas</span>{persisted && <span><b>✓</b> Decisão salva neste dispositivo</span>}</div>}
    {item.compositionStatus === 'LIMITED' && <div className="match-reasons"><span>ℹ A busca atingiu um limite de complexidade. As sugestões são parciais e a composição não pôde ser determinada com segurança.</span></div>}
    <div className="review-actions">{item.compositionStatus === 'MATCHED' ? <button className="button button-outline" onClick={onUndo}>Desfazer confirmação</button> : <button className="button button-primary" disabled={!displayed} onClick={() => displayed && onConfirm(displayed.items.map((sheet) => sheet.sheetRecordId || sheet.id))}>✓ Confirmar composição</button>}<button className="button button-outline" onClick={onIgnore}>Ignorar</button></div>
  </article>
}
function CardSummaryNotice({ item }: { item: ReconciliationItem }) {
  const summary = item.cardSummary
  if (!summary) return null
  const difference = summary.difference
  const differenceLabel = difference > 0 ? `Diferença em relação às compras elegíveis: ${formatCents(difference)}` : difference < 0 ? `Excedente de compras elegíveis: ${formatCents(Math.abs(difference))}` : 'Diferença entre os totais: R$ 0,00'
  return <section className={`card-difference ${difference < 0 ? 'card-difference-surplus' : ''}`}>
    <strong>Compras Crédito_Bradesco consideradas: {formatCents(summary.eligiblePurchaseTotal)}</strong>
    <small>{summary.eligiblePurchaseCount} lançamento(s) no conjunto elegível dos até {summary.searchHorizonDays} dias anteriores à fatura. Esse total não é uma composição confirmada.</small>
    <strong>{differenceLabel}</strong>
    {item.compositionStatus === 'NO_MATCH' && <p>Não foi encontrada uma composição exata para este pagamento de fatura. A diferença pode indicar uma compra não registrada na CUSTOS ANO ou um encargo/outro valor que não esteja representado como compra individual. O extrato não identifica sozinho a causa.</p>}
    {difference < 0 && <p>O total elegível excede o pagamento. Algumas compras podem pertencer a outro ciclo, ou pode haver crédito, estorno ou diferença de datas; isso não é classificado automaticamente como erro.</p>}
  </section>
}
function outOfScopeReason(type: BankTransaction['type']) { return ({ INCOME: 'Entrada identificada; não é uma despesa ausente.', INVESTMENT: 'Movimentação de investimento, como aplicação ou resgate.', INVESTMENT_INCOME: 'Rendimento de investimento; não é uma despesa ausente.', TRANSFER: 'Transferência entre contas.', OTHER: 'Natureza não confirmada; não foi presumida como despesa.', EXPENSE: 'Despesa fora da lista principal.', CARD_PAYMENT: 'Pagamento de fatura, tratado pela composição do cartão.' } as const)[type] }
function TransactionBox({ label, transaction }: { label: string; transaction: BankTransaction | LedgerTransaction | null }) { return <div className="transaction-box"><span className="step-label">{label}</span>{transaction ? <><strong className="transaction-date">{dateLabel(transaction.date)}</strong><strong className="transaction-description">{transaction.originalDescription}</strong><strong className="transaction-amount">{formatCents(transaction.amount)}</strong><span className="transaction-meta">{transaction.source === 'BANK' && transaction.directionKnown === false ? 'Direção não identificada no arquivo' : transaction.direction === 'DEBIT' ? 'Saída' : 'Entrada'}{transaction.paymentMethod ? ` · Forma de pagamento: ${transaction.paymentMethod}` : ''}{transaction.source === 'SHEET' && transaction.category ? ` · ${transaction.category}` : ''}</span></> : <span className="no-candidate">Nenhum lançamento sugerido para comparar.</span>}</div> }
function MissingCard({ item, onIgnore, onAddToSheet, canAddToSheet }: { item: ReconciliationItem; onIgnore: () => void; onAddToSheet: () => void; canAddToSheet: boolean }) { return <article className="missing-card"><span className="status-icon red">⌕</span><div className="missing-content"><span className="step-label">POSSÍVEL LANÇAMENTO AUSENTE</span><h2>{item.bank.originalDescription}</h2><p>{dateLabel(item.bank.date)} · Saída{item.bank.paymentMethod ? ` · Forma de pagamento: ${item.bank.paymentMethod}` : ''}</p><strong className="transaction-amount">{formatCents(item.bank.amount)}</strong><small>Nenhum lançamento correspondente foi encontrado na CUSTOS ANO.</small></div>{canAddToSheet && <button className="button button-primary" onClick={onAddToSheet}>Adicionar à CUSTOS ANO</button>}<button className="button button-outline" onClick={onIgnore}>Ignorar</button></article> }
function FilterBar({ years, year, month, fromDate, toDate, onYear, onMonth, onFrom, onTo }: { years: string[]; year: string; month: string; fromDate: string; toDate: string; onYear: (value: string) => void; onMonth: (value: string) => void; onFrom: (value: string) => void; onTo: (value: string) => void }) {
  return <section className="filter-bar"><div className="filter-heading"><span>⌕</span><strong>Filtrar período</strong></div><label>Ano<select value={year} onChange={(event) => onYear(event.target.value)}><option value="all">Todos os anos</option>{years.map((item) => <option key={item}>{item}</option>)}</select></label><label>Mês<select value={month} onChange={(event) => onMonth(event.target.value)}><option value="all">Todos os meses</option>{Array.from({ length: 12 }, (_, index) => <option key={index + 1} value={String(index + 1).padStart(2, '0')}>{String(index + 1).padStart(2, '0')} - {new Intl.DateTimeFormat('pt-BR', { month: 'long', timeZone: 'UTC' }).format(new Date(Date.UTC(2026, index, 1)))}</option>)}</select></label><label>De<input type="date" value={fromDate} onChange={(event) => onFrom(event.target.value)}/></label><label>Até<input type="date" value={toDate} onChange={(event) => onTo(event.target.value)}/></label></section>
}
function ExportBar({ result, items, banks, sheets }: { result: ReturnType<typeof reconcile>; items: ReconciliationItem[]; banks: BankTransaction[]; sheets: LedgerTransaction[] }) { return <section className="export-bar"><div><strong>Exportar resultados</strong><small>Os arquivos são gerados neste dispositivo.</small></div><div className="export-actions"><button className="button button-quiet" onClick={() => exportMissing(items)}>↓ Ausências</button><button className="button button-quiet" onClick={() => exportReviews(items)}>↓ Revisão</button><button className="button button-quiet" onClick={() => exportCardPayments(items)}>↓ Faturas de cartão</button><button className="button button-quiet" onClick={() => exportOutOfScope(items)}>↓ Fora do escopo</button><button className="button button-quiet" onClick={() => exportDuplicates(result, banks, sheets)}>↓ Duplicidades</button><button className="button button-quiet" onClick={() => exportSummary(result, items)}>↓ Resumo</button></div></section> }
