import { useEffect, useMemo, useRef, useState } from 'react'
import type { ChangeEvent, ReactNode } from 'react'
import type { BankTransaction, CardStatement, CardStatementMatch, CardStatementTransaction, ColumnMap, CsvDocument, ExcludedBankRow, LedgerTransaction, ReconciliationItem, Transaction } from './domain/types'
import { readCsvFile, initialColumnMap } from './importers/csv'
import { parseBankRows, parseLedgerRows } from './importers/transactions'
import { deriveCardPurchaseStatus, findExistingCostYearCandidates, identifyStatementPayments, readCardStatementPdf, reconcileCardStatement } from './importers/cardStatement'
import { normalizeDate } from './importers/normalize'
import { canonicalCompositionKey, findPlausibleLedgerCandidates, pairKey, reconcile } from './matching/reconcile'
import { exportCardPayments, exportDuplicates, exportMissing, exportOutOfScope, exportReviews, exportSummary } from './features/export'
import { bankIdentity, cardReviewCandidateIdentity, cardTransactionIdentity, cardTransactionIdentityVariants, sheetIdentity } from './domain/identity'
import { auditPersistedDecisions } from './domain/decisionAudit'
import { auditConsistency, filterAuditFindings, summarizeAudit, type AuditFilter, type ConsistencyAuditResult } from './domain/consistencyAudit'
import { dismissAuditFinding, isAuditFindingDismissed, loadAuditFindingVisibility, restoreAuditFinding, saveAuditFindingVisibility } from './domain/auditFindingVisibility'
import { AuditFindingCard } from './components/AuditFindingCard'
import { clearPersistedDecisions, decisionKey, deletePersistedDecision, listPersistedDecisions, savePersistedDecision } from './domain/localDecisions'
import type { DecisionKind, PersistedDecision } from './domain/localDecisions'
import { GoogleSheetsPanel } from './components/GoogleSheetsPanel'
import type { GoogleSheetsConnectionInfo } from './components/GoogleSheetsPanel'
import { PwaUpdateNotice } from './components/PwaUpdateNotice'
import { AddCostYearDialog } from './components/AddCostYearDialog'
import { BankCsvUploadCard, bankCsvRequiresManualMapping } from './components/BankCsvUploadCard'
import { BalanceAuditPanel } from './components/BalanceAuditPanel'
import { MissingSummary } from './components/MissingSummary'
import { auditBankBalance } from './domain/bankBalanceAudit'
import { canAddMissingToCostYear } from './features/missingEligibility'
import { GoogleSheetsError, appendCostYearRecord, readGoogleSheetLedger, requestGoogleSheetsAccessToken, revokeGoogleSheetsAccessToken } from './integrations/googleSheets'
import { addDecisionTombstone, listDecisionTombstones, readGoogleSheetDecisionsReadOnly, removeDecisionTombstone, syncGoogleSheetDecisions, syncOneGoogleSheetDecision, syncOneGoogleSheetDeletion } from './integrations/googleSheetDecisions'
import { forgetGoogleSheetLink, GOOGLE_SHEET_TAB_NAME, loadGoogleSheetLink, saveGoogleSheetLink } from './integrations/googleSheetLinkStorage'
import type { SavedGoogleSheetLink } from './integrations/googleSheetLinkStorage'

type Mode = 'sheet' | 'bank'
type SourceStatus = 'EMPTY' | 'LOADED' | 'VALIDATED' | 'ACCEPTED'
type Dataset = { sheet: LedgerTransaction[]; bank: BankTransaction[] }
type UploadState = { fileName: string; csv: CsvDocument; map: ColumnMap; valid: Transaction[]; issues: { row: number; message: string }[]; rowCount: number; ignoredRows: number; excludedRows: ExcludedBankRow[]; auxiliaryTransactionCount: number } | null
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
  const [cardReviewOverrides, setCardReviewOverrides] = useState<Record<string, LedgerTransaction[]>>({})
  const [statementOnlyIssues, setStatementOnlyIssues] = useState(false)
  const [consistencyAudit, setConsistencyAudit] = useState<ConsistencyAuditResult | null>(null)
  const [consistencyAuditBusy, setConsistencyAuditBusy] = useState(false)
  const [consistencyAuditError, setConsistencyAuditError] = useState('')
  const [consistencyAuditFilter, setConsistencyAuditFilter] = useState<AuditFilter>('ALL')
  const [consistencyAuditSourceNote, setConsistencyAuditSourceNote] = useState('')
  const [dismissedAuditFindings, setDismissedAuditFindings] = useState(loadAuditFindingVisibility)
  const [pendingDoubleClaimRefresh, setPendingDoubleClaimRefresh] = useState<{ id: number; fingerprints: string[]; rowIdentity: string } | null>(null)
  const handledDoubleClaimRefresh = useRef(0)
  const pdfEntryTokens = useRef(new Map<string, object>())
  const [auditFocusTransactionId, setAuditFocusTransactionId] = useState('')
  const [auditFocusStatementIdentity, setAuditFocusStatementIdentity] = useState('')
  const staleMissingDecisionCleanup = useRef(new Set<string>())
  const seenPdfFingerprints = useRef(new Set<string>())
  const pdfSessionGeneration = useRef(0)
  const [cardPdfNotice, setCardPdfNotice] = useState('')
  const [savedDecisions, setSavedDecisions] = useState<PersistedDecision[]>([])
  const [pendingDecisionIds, setPendingDecisionIds] = useState<Set<string>>(() => new Set())
  const [decisionsReady, setDecisionsReady] = useState(false)
  const decisionStateRevision = useRef(0)
  const [screen, setScreen] = useState<'home' | 'results'>('home')
  const [tab, setTab] = useState<'overview' | 'review' | 'missing' | 'card' | 'statement' | 'duplicates' | 'outofscope' | 'flags' | 'auditor'>('overview')
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

  const orphanDecisionCleanup = useRef(new Set<string>())
  useEffect(() => {
    if (!decisionsReady || sourceStatus.sheet !== 'ACCEPTED' || (sheetSource !== 'google' && googleSheetRows === null)) return
    const truthRows = googleSheetRows ?? data.sheet
    const liveSheetIdentities = new Set(truthRows.map(sheetIdentity))
    const liveBankIdentities = new Set(data.bank.map(bankIdentity))
    const orphans = savedDecisions.filter((decision) => decision.kind === 'MISSING_ADDED_TO_SHEET'
      && decision.selected[0]
      && !liveSheetIdentities.has(decision.selected[0])
      && !orphanDecisionCleanup.current.has(decision.key))
    for (const decision of orphans) {
      orphanDecisionCleanup.current.add(decision.key)
      void removeDecision('MISSING_ADDED_TO_SHEET', decision.identities).finally(() => orphanDecisionCleanup.current.delete(decision.key))
    }
    setLocallyAddedMissingPairs((current) => Object.fromEntries(Object.entries(current).filter(([bankKey, sheetKey]) =>
      liveBankIdentities.has(bankKey) && liveSheetIdentities.has(sheetKey))))
  }, [decisionsReady, sourceStatus.sheet, sheetSource, googleSheetRows, data, savedDecisions])

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
    pdfSessionGeneration.current += 1; seenPdfFingerprints.current.clear(); pdfEntryTokens.current.clear()
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
    const ignoredBankIds = new Set<string>(), rejectedPairKeys = new Set<string>(), confirmedPairs = new Map<string, string>(), confirmedCompositions = new Map<string, string[]>(), ignoredSheetIdentities = new Set<string>()
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
      }
      if (record.kind === 'COMPOSITION_CONFIRMED' && (record.identities[1] === 'no-statement' || cardPdfs.some((entry) => entry.statement && (entry.statement.statementIdentity === record.identities[1] || entry.legacyStatementIdentity === record.identities[1])))) {
        const bank = data.bank.find((item) => bankIdentity(item) === record.identities[0])
        if (bank && record.selected.every((identity) => data.sheet.some((item) => sheetIdentity(item) === identity))) confirmedCompositions.set(bank.id, record.selected)
      }
    }
    for (const [bankKey, sheetKey] of Object.entries(locallyAddedMissingPairs)) {
      const bank = data.bank.find((item) => bankIdentity(item) === bankKey)
      const sheet = data.sheet.find((item) => sheetIdentity(item) === sheetKey)
      if (bank && sheet) confirmedPairs.set(bank.id, sheet.id)
    }
    return { ignoredBankIds, ignoredSheetIdentities, rejectedPairKeys, confirmedPairs, confirmedCompositions }
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
      const editedConfirmationRows = new Map<string, LedgerTransaction>()
      for (const record of savedDecisions.filter((item) => item.kind === 'STATEMENT_MATCH_CONFIRMED')) {
        const transaction = entry.statement.transactions.find((item) => cardTransactionIdentityVariants(entry.statement, item, entry.legacyStatementIdentity).includes(record.identities[0]))
        const sheet = data.sheet.find((item) => sheetIdentity(item) === record.selected[0])
        if (transaction && sheet) {
          if (findExistingCostYearCandidates(entry.statement, transaction, [sheet]).length) confirmations.set(transaction.id, sheet.id)
          else if (sheet.amount === transaction.amount && sheet.direction === 'DEBIT' && sheet.paymentMethod.toLocaleLowerCase('pt-BR').replaceAll('_', ' ') === 'crédito bradesco'
            && (transaction.installment == null || sheet.installment === transaction.installment && sheet.totalInstallments === transaction.totalInstallments)) editedConfirmationRows.set(transaction.id, sheet)
        }
      }
      const ignored = new Set<string>()
      const rejectedCandidates = new Map<string, ReadonlySet<string>>()
      for (const record of savedDecisions.filter((item) => item.kind === 'CARD_PURCHASE_IGNORED')) {
        const transaction = entry.statement.transactions.find((item) => cardTransactionIdentityVariants(entry.statement, item, entry.legacyStatementIdentity).includes(record.identities[0]))
        if (transaction) ignored.add(transaction.id)
      }
      for (const record of savedDecisions.filter((item) => item.kind === 'CARD_REVIEW_REJECTED_CANDIDATES')) {
        const transaction = entry.statement.transactions.find((item) => cardTransactionIdentityVariants(entry.statement, item, entry.legacyStatementIdentity).includes(record.identities[0]))
        if (!transaction) continue
        const rejectedIds = new Set(record.selected.flatMap((identity) => {
          const row = data.sheet.find((item) => cardReviewCandidateIdentity(item) === identity)
          return row ? [row.id] : []
        }))
        rejectedCandidates.set(transaction.id, rejectedIds)
      }
      const result = reconcileCardStatement(entry.statement, data.sheet, confirmations, rejectedCandidates)
      const matches = result.matches.map((match) => {
        let derived = deriveCardPurchaseStatus(match, { ignored: ignored.has(match.transaction.id), consumedSheetIds: usedSheetIds })
        const editedCandidate = editedConfirmationRows.get(match.transaction.id)
        if (editedCandidate && (derived.status === 'CARD_MISSING' || derived.status === 'CARD_REVIEW')) derived = { ...derived, status: 'CARD_REVIEW', sheet: null, candidates: [editedCandidate], evidence: ['Vínculo anterior reavaliado após alteração da linha', 'Valor exato', 'Crédito_Bradesco', 'A data ou descrição editada exige confirmação'] }
        const candidates = cardReviewOverrides[cardTransactionIdentity(entry.statement, match.transaction)]
        return candidates?.length && !confirmations.has(match.transaction.id) && ['CARD_MISSING', 'CARD_REVIEW', 'CARD_MATCHED'].includes(derived.status)
          ? { ...derived, status: 'CARD_REVIEW' as const, sheet: null, candidates }
          : derived
      })
      matches.filter((match) => match.status === 'CARD_MATCHED' && match.sheet).forEach((match) => usedSheetIds.add(match.sheet!.id))
      matches.filter((match) => match.status === 'CARD_GROUP_MATCHED').flatMap((match) => match.candidates).forEach((row) => usedSheetIds.add(row.id))
      const matchedRowIds = new Set(matches.flatMap((match) => match.status === 'CARD_MATCHED' && match.sheet ? [match.sheet.id] : match.status === 'CARD_GROUP_MATCHED' ? match.candidates.map((row) => row.id) : []))
      const matchedTotal = data.sheet.filter((row) => matchedRowIds.has(row.id)).reduce((sum, row) => sum + row.amount, 0)
      const extractedTotal = entry.statement.purchasesDebitsTotal ?? entry.statement.transactions.filter((transaction) => transaction.type === 'PURCHASE').reduce((sum, transaction) => sum + transaction.amount, 0)
      return { entry, statement: entry.statement, payment: statementPayments.get(entry.statement) ?? null, matches, confirmations, extractedTotal, matchedTotal, difference: extractedTotal - matchedTotal }
    })
  }, [cardPdfs, data.sheet, savedDecisions, statementPayments, cardReviewOverrides])
  const visibleStatementResults = useMemo(() => statementOnlyIssues
    ? statementResults.filter((item) => item.matches.some((match) => match.status === 'CARD_MISSING' || match.status === 'CARD_REVIEW')
      || item.statement.errors.length > 0 || item.payment == null || item.statement.accountingDifference != null && item.statement.accountingDifference !== 0)
    : statementResults, [statementResults, statementOnlyIssues])
  const persistedDecisionAudit = useMemo(() => sourceStatus.sheet === 'ACCEPTED'
    ? auditPersistedDecisions(savedDecisions, { banks: data.bank, sheets: data.sheet, statements: cardPdfs.flatMap((entry) => entry.statement ? [{ statement: entry.statement, legacyStatementIdentity: entry.legacyStatementIdentity }] : []) })
    : [], [sourceStatus.sheet, savedDecisions, data.bank, data.sheet, cardPdfs])
  useEffect(() => {
    if (!decisionsReady || sourceStatus.sheet !== 'ACCEPTED') return
    for (const audit of persistedDecisionAudit) {
      if (audit.status === 'VALID' || audit.status === 'NEEDS_REVIEW' || !audit.resolved || audit.decision.kind === 'MISSING_ADDED_TO_SHEET' && audit.status === 'ORPHANED' || staleMissingDecisionCleanup.current.has(audit.decision.key)) continue
      staleMissingDecisionCleanup.current.add(audit.decision.key)
      void removeDecision(audit.decision.kind, audit.decision.identities).finally(() => staleMissingDecisionCleanup.current.delete(audit.decision.key))
    }
  }, [decisionsReady, sourceStatus.sheet, persistedDecisionAudit])
  const years = useMemo(() => [...new Set([...data.bank.map((item) => item.year), ...data.sheet.map((item) => item.year)].filter(Boolean))].sort().reverse(), [data])
  const filteredItems = useMemo(() => result.items.filter(({ bank }) => inPeriod(bank, filterYear, filterMonth, fromDate, toDate)), [result.items, filterYear, filterMonth, fromDate, toDate])
  const filteredDuplicates = useMemo(() => result.duplicateGroups.filter((group) => inDatePeriod(group.date, filterYear, filterMonth, fromDate, toDate)), [result.duplicateGroups, filterYear, filterMonth, fromDate, toDate])
  const filteredSheet = useMemo(() => data.sheet.filter((sheet) => inPeriod(sheet, filterYear, filterMonth, fromDate, toDate)), [data.sheet, filterYear, filterMonth, fromDate, toDate])
  const shownReview = filteredItems.filter((item) => item.status === 'REVIEW')
  const shownCardDivergences = filteredItems.filter((item) => item.status === 'CARD_DIVERGENCE')
  const shownMissing = filteredItems.filter((item) => item.status === 'MISSING')
  const bankBalanceAudit = useMemo(() => auditBankBalance(data.bank, uploads.bank?.excludedRows ?? []), [data.bank, uploads.bank?.excludedRows])
  const shownOutOfScope = filteredItems.filter((item) => item.status === 'OUT_OF_SCOPE')
  const shownMatched = filteredItems.filter((item) => item.status === 'MATCHED' && item.bank.type !== 'CARD_PAYMENT')
  const costCategories = [...new Set((googleSheetRows ?? []).map((item) => item.category.trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'pt-BR'))
  const investFacilYields = shownOutOfScope.filter((item) => item.bank.outOfScopeSubtype === 'INVEST_FACIL_YIELD')
  const otherOutOfScope = shownOutOfScope.filter((item) => item.bank.outOfScopeSubtype !== 'INVEST_FACIL_YIELD')
  const statementMatchedSheetIds = new Set(statementResults.flatMap((result) => result.matches.flatMap((match) => match.status === 'CARD_MATCHED' && match.sheet ? [match.sheet.id] : match.status === 'CARD_GROUP_MATCHED' ? match.candidates.map((row) => row.id) : [])))
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
      const period = csv.statementPeriodStart && csv.statementPeriodEnd ? { start: csv.statementPeriodStart, end: csv.statementPeriodEnd } : undefined
      const parsed = mode === 'sheet' ? parseLedgerRows(csv.rows, map) : parseBankRows(csv.rows, map, csv.metadataRowsIgnored, period)
      const auxiliaryTransactions = mode === 'bank' ? parseBankRows(csv.auxiliaryRows, map).transactions.length : 0
      setUploads((current) => ({ ...current, [mode]: { fileName: file.name, csv, map, valid: parsed.transactions, issues: [...csv.parseErrors.map((message, index) => ({ row: index + 2, message })), ...parsed.issues], rowCount: parsed.rowCount, ignoredRows: parsed.ignoredRows, excludedRows: mode === 'bank' ? parsed.excludedRows ?? [] : [], auxiliaryTransactionCount: auxiliaryTransactions } }))
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
    let unreadable = 0
    for (const file of files) {
      try {
        const fingerprint = await fingerprintFile(file)
        if (generation !== pdfSessionGeneration.current) return
        if (seenPdfFingerprints.current.has(fingerprint)) { duplicates += 1; continue }
        seenPdfFingerprints.current.add(fingerprint)
        const key = `pdf-${fingerprint}`
        const entryToken = {}
        pdfEntryTokens.current.set(key, entryToken)
        setCardPdfs((current) => [...current, { key, fingerprint, fileName: file.name, status: 'PROCESSING', statement: null }])
        try {
          const parsedStatement = await readCardStatementPdf(file)
          if (generation !== pdfSessionGeneration.current) return
          if (pdfEntryTokens.current.get(key) !== entryToken) continue
          const statement: CardStatement = { ...parsedStatement, statementIdentity: `${parsedStatement.statementIdentity}-${fingerprint}`, transactions: parsedStatement.transactions.map((transaction) => ({ ...transaction, id: `${transaction.id}-${fingerprint}` })) }
          setCardPdfs((current) => current.map((entry) => entry.key === key ? { ...entry, statement, legacyStatementIdentity: parsedStatement.statementIdentity, status: statement.errors.length ? 'DIVERGENCE' : 'PROCESSED' } : entry))
          pdfEntryTokens.current.delete(key)
        } catch {
          if (generation !== pdfSessionGeneration.current) return
          if (pdfEntryTokens.current.get(key) !== entryToken) continue
          unreadable += 1
          setCardPdfs((current) => current.map((entry) => entry.key === key ? { ...entry, status: 'ERROR', error: 'Não foi possível interpretar este PDF. Os demais arquivos seguem disponíveis.' } : entry))
          pdfEntryTokens.current.delete(key)
        }
      } catch {
        unreadable += 1
      }
    }
    if (duplicates || unreadable) {
      const parts = [
        duplicates ? `${duplicates} PDF${duplicates === 1 ? '' : 's'} duplicado${duplicates === 1 ? '' : 's'} ${duplicates === 1 ? 'foi ignorado' : 'foram ignorados'}` : '',
        unreadable ? `${unreadable} PDF${unreadable === 1 ? '' : 's'} ${unreadable === 1 ? 'não pôde ser lido' : 'não puderam ser lidos'}` : '',
      ].filter(Boolean)
      setCardPdfNotice(`${parts.join(' e ')}.`)
    }
  }

  function removeCardPdf(key: string) {
    const fingerprint = key.startsWith('pdf-') ? key.slice(4) : ''
    if (fingerprint) seenPdfFingerprints.current.delete(fingerprint)
    pdfEntryTokens.current.delete(key)
    const removed = cardPdfs.find((entry) => entry.key === key)
    if (removed?.statement) {
      const transactionIdentities = new Set(removed.statement.transactions.map((transaction) => cardTransactionIdentity(removed.statement!, transaction)))
      setCardReviewOverrides((current) => Object.fromEntries(Object.entries(current).filter(([identity]) => !transactionIdentities.has(identity))))
      if (auditFocusStatementIdentity === removed.statement.statementIdentity) {
        setAuditFocusStatementIdentity('')
        setAuditFocusTransactionId('')
      }
    }
    setCardPdfs((current) => current.filter((entry) => entry.key !== key))
  }

  function changeMap(mode: Mode, key: keyof ColumnMap, value: string) {
    setUploads((current) => {
      const entry = current[mode]
      if (!entry) return current
      const map = { ...entry.map, [key]: value }
      const period = entry.csv.statementPeriodStart && entry.csv.statementPeriodEnd ? { start: entry.csv.statementPeriodStart, end: entry.csv.statementPeriodEnd } : undefined
      const parsed = mode === 'sheet' ? parseLedgerRows(entry.csv.rows, map) : parseBankRows(entry.csv.rows, map, entry.csv.metadataRowsIgnored, period)
      const auxiliaryTransactions = mode === 'bank' ? parseBankRows(entry.csv.auxiliaryRows, map).transactions.length : 0
      return { ...current, [mode]: { ...entry, map, valid: parsed.transactions, issues: [...entry.csv.parseErrors.map((message, index) => ({ row: index + 2, message })), ...parsed.issues], rowCount: parsed.rowCount, ignoredRows: parsed.ignoredRows, excludedRows: mode === 'bank' ? parsed.excludedRows ?? [] : [], auxiliaryTransactionCount: auxiliaryTransactions } }
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
    if (!eligible.eligible) { setMissingWriteNotice('Esta compra já não está marcada como ausente. A conciliação foi atualizada; confira o vínculo ou a revisão exibidos no item.'); return }
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
      if (target.kind === 'STATEMENT') {
        const latest = await readGoogleSheetLedger(googleSheetLink.spreadsheetId, googleAccessToken.current)
        const confirmedStatementMatches = savedDecisions.filter((decision) => decision.kind === 'STATEMENT_MATCH_CONFIRMED')
        const orderedEntries = cardPdfs.filter((entry): entry is CardPdfEntry & { statement: CardStatement } => entry.statement != null)
          .sort((a, b) => (a.statement.dueDate ?? '').localeCompare(b.statement.dueDate ?? '') || a.key.localeCompare(b.key))
        const usedSheetIds = new Set<string>()
        let latestTargetMatch: CardStatementMatch | undefined
        let latestTargetCandidates: LedgerTransaction[] = []
        for (const entry of orderedEntries) {
          const confirmations = new Map<string, string>()
          for (const decision of confirmedStatementMatches) {
            const transaction = entry.statement.transactions.find((item) => cardTransactionIdentityVariants(entry.statement!, item, entry.legacyStatementIdentity).includes(decision.identities[0]))
            const row = latest.transactions.find((item) => sheetIdentity(item) === decision.selected[0])
            if (transaction && row) confirmations.set(transaction.id, row.id)
          }
          const rejectedCandidates = new Map<string, ReadonlySet<string>>()
          for (const decision of savedDecisions.filter((item) => item.kind === 'CARD_REVIEW_REJECTED_CANDIDATES')) {
            const transaction = entry.statement.transactions.find((item) => cardTransactionIdentityVariants(entry.statement!, item, entry.legacyStatementIdentity).includes(decision.identities[0]))
            if (!transaction) continue
            const rejectedIds = new Set(decision.selected.flatMap((identity) => {
              const row = latest.transactions.find((item) => cardReviewCandidateIdentity(item) === identity)
              return row ? [row.id] : []
            }))
            rejectedCandidates.set(transaction.id, rejectedIds)
          }
          const freshResult = reconcileCardStatement(entry.statement, latest.transactions, confirmations, rejectedCandidates)
          const freshMatches = freshResult.matches.map((match) => deriveCardPurchaseStatus(match, { consumedSheetIds: usedSheetIds }))
          freshMatches.filter((match) => match.status === 'CARD_MATCHED' && match.sheet).forEach((match) => usedSheetIds.add(match.sheet!.id))
          freshMatches.filter((match) => match.status === 'CARD_GROUP_MATCHED').flatMap((match) => match.candidates).forEach((row) => usedSheetIds.add(row.id))
          if (entry.statement.statementIdentity === target.statement.statementIdentity) {
            latestTargetMatch = freshMatches.find((match) => match.transaction.id === target.transaction.id)
            const rejectedIds = rejectedCandidates.get(target.transaction.id)
            latestTargetCandidates = findExistingCostYearCandidates(entry.statement, target.transaction, latest.transactions).filter((row) => !rejectedIds?.has(row.id))
          }
        }
        if (latestTargetMatch && (['CARD_MATCHED', 'CARD_GROUP_MATCHED', 'CARD_REVIEW'].includes(latestTargetMatch.status) || latestTargetCandidates.length > 0)) {
          const candidateRows = latestTargetMatch.sheet ? [latestTargetMatch.sheet] : latestTargetMatch.candidates
          const rowsToReview = latestTargetMatch.status === 'CARD_GROUP_MATCHED' ? [] : candidateRows.length ? candidateRows : latestTargetCandidates
          if (latestTargetMatch.status !== 'CARD_GROUP_MATCHED' && rowsToReview.length) setCardReviewOverrides((current) => ({ ...current, [targetKey]: rowsToReview }))
          setGoogleSheetRows(latest.transactions)
          setData((currentData) => ({ ...currentData, sheet: latest.transactions }))
          setSourceStatus((currentStatus) => ({ ...currentStatus, sheet: 'ACCEPTED' }))
          setMissingWriteNotice('Já existe um lançamento provável na CUSTOS ANO. A inclusão foi bloqueada; revise os candidatos abaixo e use o lançamento correto.')
          setMissingToAdd(null)
          return
        }
      }
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

  async function confirmStatementMatch(statement: CardStatement, transactionId: string, sheetId: string) {
    const transaction = statement.transactions.find((item) => item.id === transactionId), sheet = data.sheet.find((item) => item.id === sheetId)
    if (transaction && sheet) {
      const identity = cardTransactionIdentity(statement, transaction)
      const rejectedDecision = savedDecisions.find((record) => record.kind === 'CARD_REVIEW_REJECTED_CANDIDATES'
        && cardTransactionIdentityVariants(statement, transaction, cardPdfs.find((entry) => entry.statement === statement)?.legacyStatementIdentity).includes(record.identities[0]))
      if (rejectedDecision) await removeDecision(rejectedDecision.kind, rejectedDecision.identities)
      setCardReviewOverrides((current) => { const next = { ...current }; delete next[identity]; return next })
      await persistDecision('STATEMENT_MATCH_CONFIRMED', [identity], [sheetIdentity(sheet)])
    }
  }

  function rejectCardReviewCandidates(statement: CardStatement, transactionId: string, sheetIds: string[]) {
    const transaction = statement.transactions.find((item) => item.id === transactionId)
    if (!transaction || !sheetIds.length) return
    const selected = sheetIds.flatMap((id) => {
      const row = data.sheet.find((item) => item.id === id || sheetIdentity(item) === id)
      return row ? [cardReviewCandidateIdentity(row)] : []
    })
    if (selected.length) void persistDecision('CARD_REVIEW_REJECTED_CANDIDATES', [cardTransactionIdentity(statement, transaction)], selected)
  }

  function ignoreCardPurchase(statement: CardStatement, transactionId: string) {
    const transaction = statement.transactions.find((item) => item.id === transactionId)
    if (transaction) void persistDecision('CARD_PURCHASE_IGNORED', [cardTransactionIdentity(statement, transaction)])
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

  async function auditInvalidateDecision(decision: PersistedDecision, reason: string) {
    if (!window.confirm(`Esta ação invalidará somente ${decision.kind} desta compra e registrará uma exclusão nas decisões locais${googleAccessToken.current ? ' e sincronizadas' : ''}. Motivo: ${reason}\n\nContinuar?`)) return
    await removeDecision(decision.kind, decision.identities)
    setConsistencyAuditError('Decisão invalidada para este item. Execute a auditoria novamente para atualizar o relatório.')
  }

  async function auditDiscardObsoleteDoubleClaim(finding: NonNullable<ConsistencyAuditResult['findings'][number]>) {
    const safe = finding.technical?.safeInvalidation as {
      decision: PersistedDecision
      decisionId: string
      decisionKey: string
      obsoleteSubject: { description: string; date: string; fingerprint: string }
      winningSubject: { description: string; date: string; fingerprint: string }
      row: { id: string; sheetIdentity: string; description: string; date: string }
      separateMatch: { description: string; date: string; amount: number; id: string } | null
    } | undefined
    if (!safe || safe.decision.key !== safe.decisionKey) return
    const separateMatch = safe.separateMatch
      ? `O matching atual associa esse lançamento à compra de ${dateLabel(safe.winningSubject.date)} e encontrou outro lançamento válido (${safe.separateMatch.description}, ${dateLabel(safe.separateMatch.date)}, ${formatCents(safe.separateMatch.amount)}) para a compra de ${dateLabel(safe.obsoleteSubject.date)}.`
      : `O matching atual associa esse lançamento à compra de ${dateLabel(safe.winningSubject.date)}; o vínculo antigo está incompatível com as fontes atuais.`
    const confirmation = `Uma decisão antiga associa a compra ${safe.obsoleteSubject.description} de ${dateLabel(safe.obsoleteSubject.date)} ao lançamento ${safe.row.description} de ${dateLabel(safe.row.date)}.\n\n${separateMatch}\n\nEsta ação removerá apenas o vínculo histórico obsoleto.\n\nNenhuma linha da CUSTOS ANO será alterada.\n\nDescartar vínculo antigo?`
    if (!window.confirm(confirmation)) return
    const decision = safe.decision
    const affectedFingerprints = [safe.obsoleteSubject.fingerprint, safe.winningSubject.fingerprint]
    try {
      addDecisionTombstone(decision)
      await deletePersistedDecision(decision.key)
      decisionStateRevision.current += 1
      setSavedDecisions(await listPersistedDecisions())
      setCardReviewOverrides((current) => {
        const next = { ...current }
        affectedFingerprints.forEach((fingerprint) => delete next[fingerprint])
        return next
      })
      const spreadsheetId = googleSheetLink?.spreadsheetId
      if (spreadsheetId) {
        markDecisionPending(decision.key, true)
        if (googleAccessToken.current) {
          try {
            await syncOneGoogleSheetDeletion(spreadsheetId, googleAccessToken.current, decision, listDecisionTombstones()[decision.key].updatedAt)
            removeDecisionTombstone(decision.key)
            markDecisionPending(decision.key, false)
            setGoogleDecisionStatus('Decisão antiga descartada e sincronizada.')
          } catch {
            setGoogleDecisionStatus('Decisão descartada neste dispositivo; sincronização pendente.')
          }
        }
      }
      setPendingDoubleClaimRefresh({ id: decisionStateRevision.current, fingerprints: affectedFingerprints, rowIdentity: safe.row.sheetIdentity })
      setConsistencyAuditError('Vínculo antigo descartado. Recalculando os subjects relacionados; nenhuma linha da CUSTOS ANO foi alterada.')
    } catch (error) {
      setConsistencyAuditError(error instanceof Error ? error.message : 'Não foi possível descartar o vínculo antigo.')
    }
  }

  async function auditUseCandidate(item: NonNullable<ReturnType<typeof auditConsistency>['items'][number]>) {
    const candidate = item.candidates[0]
    if (!candidate) return
    if (!window.confirm(`Salvar vínculo desta compra com “${candidate.originalDescription}” (${dateLabel(candidate.date)}, ${formatCents(candidate.amount)})? Isso altera somente a decisão de conciliação; CUSTOS ANO não será editada.`)) return
    const rejectedDecision = savedDecisions.find((record) => record.kind === 'CARD_REVIEW_REJECTED_CANDIDATES' && item.aliases.includes(record.identities[0]))
    if (rejectedDecision) await removeDecision(rejectedDecision.kind, rejectedDecision.identities)
    setCardReviewOverrides((current) => { const next = { ...current }; delete next[item.fingerprint]; return next })
    await persistDecision('STATEMENT_MATCH_CONFIRMED', [item.fingerprint], [sheetIdentity(candidate)])
    setConsistencyAuditError('Vínculo salvo para este item. Execute a auditoria novamente para atualizar o relatório.')
  }

  async function auditRecalculateItem(item: NonNullable<ReturnType<typeof auditConsistency>['items'][number]>) {
    if (!window.confirm('Reanalisar somente esta compra com os documentos e a CUSTOS ANO carregados? Nenhuma decisão será apagada e nenhuma linha será criada ou excluída.')) return
    try {
      const localDecisions = await listPersistedDecisions()
      let auditSheets = data.sheet
      let remoteDecisions: PersistedDecision[] = []
      let remoteTombstones: PersistedDecision[] = []
      if (sheetSource === 'google' && googleSheetLink?.spreadsheetId && googleAccessToken.current) {
        const [ledger, decisions] = await Promise.all([
          readGoogleSheetLedger(googleSheetLink.spreadsheetId, googleAccessToken.current),
          readGoogleSheetDecisionsReadOnly(googleSheetLink.spreadsheetId, googleAccessToken.current),
        ])
        auditSheets = ledger.transactions
        remoteDecisions = decisions.active
        remoteTombstones = decisions.tombstones
      }
      const refreshed = auditConsistency({
        banks: data.bank,
        sheets: auditSheets,
        statements: [{ statement: { ...item.statement, transactions: [item.transaction] } }],
        currentCardMatches: statementResults.flatMap((entry) => entry.matches.filter((match) => match.transaction.id === item.transaction.id && entry.statement.statementIdentity === item.statement.statementIdentity).map((match) => ({ statementIdentity: entry.statement.statementIdentity, transactionId: match.transaction.id, match }))),
        currentSheets: data.sheet,
        localDecisions,
        remoteDecisions,
        remoteTombstones,
        localTombstones: listDecisionTombstones(),
      })
      setConsistencyAudit((previous) => {
        if (!previous) return previous
        const items = [...previous.items.filter((existing) => existing.fingerprint !== item.fingerprint), ...refreshed.items]
        const findings = [...previous.findings.filter((finding) => finding.item?.fingerprint !== item.fingerprint), ...refreshed.findings]
        const pureStates = { ...previous.pureStates, ...refreshed.pureStates }
        const currentStates = { ...previous.currentStates, ...refreshed.currentStates }
        return { ...previous, auditedAt: refreshed.auditedAt, items, findings, pureStates, currentStates, summary: summarizeAudit(findings, items) }
      })
      setConsistencyAuditError(refreshed.items[0]?.diagnosis ?? 'Reanálise concluída. Nenhuma decisão ou lançamento foi alterado.')
    } catch (error) { setConsistencyAuditError(error instanceof Error ? error.message : 'Não foi possível reanalisar esta compra.') }
  }

  async function runConsistencyAudit() {
    setConsistencyAuditBusy(true)
    setConsistencyAuditError('')
    setConsistencyAuditSourceNote('')
    try {
      let auditSheets = data.sheet
      let remoteDecisions: PersistedDecision[] = []
      let remoteTombstones: PersistedDecision[] = []
      if (sheetSource === 'google' && googleSheetLink?.spreadsheetId && googleAccessToken.current) {
        try {
          const [ledger, decisions] = await Promise.all([
            readGoogleSheetLedger(googleSheetLink.spreadsheetId, googleAccessToken.current),
            readGoogleSheetDecisionsReadOnly(googleSheetLink.spreadsheetId, googleAccessToken.current),
          ])
          auditSheets = ledger.transactions
          remoteDecisions = decisions.active
          remoteTombstones = decisions.tombstones
          setConsistencyAuditSourceNote(`Leitura atualizada de CUSTOS ANO e _CONCILIADOR · ${ledger.rowCount} linhas. Nenhuma alteração foi feita.`)
        } catch (remoteError) {
          setConsistencyAuditSourceNote(`Não foi possível reler as fontes remotas (${remoteError instanceof Error ? remoteError.message : 'erro de leitura'}). Relatório parcial usando fontes atuais carregadas e decisões locais; nenhuma alteração foi feita.`)
        }
      } else if (sheetSource === 'google' && googleSheetLink?.spreadsheetId) {
        setConsistencyAuditSourceNote('Google precisa ser reconectado para reler as fontes remotas. Auditoria parcial usando os dados já carregados nesta sessão; nenhuma alteração foi feita.')
      } else {
        setConsistencyAuditSourceNote('Auditoria das fontes carregadas nesta sessão e das decisões locais; nenhuma alteração foi feita.')
      }
      const localDecisions = await listPersistedDecisions()
      const result = auditConsistency({
        banks: data.bank,
        sheets: auditSheets,
        statements: cardPdfs.flatMap((entry) => entry.statement ? [{ statement: entry.statement, legacyStatementIdentity: entry.legacyStatementIdentity }] : []),
        currentCardMatches: statementResults.flatMap((entry) => entry.matches.map((match) => ({ statementIdentity: entry.statement.statementIdentity, transactionId: match.transaction.id, match }))),
        currentSheets: data.sheet,
        localDecisions,
        remoteDecisions,
        remoteTombstones,
        localTombstones: listDecisionTombstones(),
      })
      setConsistencyAudit(result)
      setConsistencyAuditFilter('ALL')
      setTab('auditor')
    } catch (auditError) {
      setConsistencyAuditError(auditError instanceof Error ? auditError.message : 'Não foi possível concluir a auditoria.')
    } finally { setConsistencyAuditBusy(false) }
  }

  const activeAuditFindings = consistencyAudit?.findings.filter((finding) => !isAuditFindingDismissed(finding, dismissedAuditFindings)) ?? []
  const hiddenAuditFindings = consistencyAudit?.findings.filter((finding) => isAuditFindingDismissed(finding, dismissedAuditFindings)) ?? []
  const activeAuditSummary = consistencyAudit ? summarizeAudit(activeAuditFindings, consistencyAudit.items) : null
  const auditDisplayedFindings = consistencyAudit
    ? consistencyAuditFilter === 'HIDDEN'
      ? hiddenAuditFindings
      : filterAuditFindings(activeAuditFindings, consistencyAuditFilter)
    : []

  function hideAuditFinding(finding: import('./domain/consistencyAudit').AuditFinding) {
    if (!window.confirm('Ocultar este aviso?\n\nEste diagnóstico deixará de aparecer entre os problemas ativos nas próximas auditorias enquanto continuar essencialmente igual. Você poderá encontrá-lo novamente na aba Ocultos. Se o problema mudar ou ficar mais grave, ele poderá aparecer novamente.')) return
    const next = dismissAuditFinding(finding, dismissedAuditFindings)
    saveAuditFindingVisibility(next)
    setDismissedAuditFindings(next)
  }

  function restoreHiddenAuditFinding(finding: import('./domain/consistencyAudit').AuditFinding) {
    const next = restoreAuditFinding(finding, dismissedAuditFindings)
    saveAuditFindingVisibility(next)
    setDismissedAuditFindings(next)
    setConsistencyAuditFilter(finding.severity === 'CRITICAL' ? 'CRITICAL' : finding.severity === 'REVIEW' ? 'REVIEW' : finding.severity === 'LEGACY' || finding.severity === 'MAINTENANCE' ? 'LEGACY' : 'ALL')
  }

  useEffect(() => {
    const pending = pendingDoubleClaimRefresh
    if (!pending || !consistencyAudit || handledDoubleClaimRefresh.current === pending.id) return
    handledDoubleClaimRefresh.current = pending.id
    let active = true
    void (async () => {
      try {
        const localDecisions = await listPersistedDecisions()
        let auditSheets = data.sheet
        let remoteDecisions: PersistedDecision[] = []
        let remoteTombstones: PersistedDecision[] = []
        if (sheetSource === 'google' && googleSheetLink?.spreadsheetId && googleAccessToken.current) {
          try {
            const [ledger, decisionRows] = await Promise.all([
              readGoogleSheetLedger(googleSheetLink.spreadsheetId, googleAccessToken.current),
              readGoogleSheetDecisionsReadOnly(googleSheetLink.spreadsheetId, googleAccessToken.current),
            ])
            auditSheets = ledger.transactions
            remoteDecisions = decisionRows.active
            remoteTombstones = decisionRows.tombstones
          } catch { /* preserve current data and the local tombstone if a refresh is unavailable */ }
        }
        const refreshed = auditConsistency({
          banks: data.bank,
          sheets: auditSheets,
          statements: cardPdfs.flatMap((entry) => entry.statement ? [{ statement: entry.statement, legacyStatementIdentity: entry.legacyStatementIdentity }] : []),
          currentCardMatches: statementResults.flatMap((entry) => entry.matches.map((match) => ({ statementIdentity: entry.statement.statementIdentity, transactionId: match.transaction.id, match }))),
          currentSheets: data.sheet,
          localDecisions,
          remoteDecisions,
          remoteTombstones,
          localTombstones: listDecisionTombstones(),
          onlySubjectFingerprints: pending.fingerprints,
        })
        if (!active) return
        const affected = new Set(pending.fingerprints)
        const relatedFindings = refreshed.findings.filter((finding) => affected.has(finding.item?.fingerprint ?? '')
          || finding.code === 'DOUBLE_CLAIM' && (finding.technical?.row as Record<string, unknown> | undefined)?.sheetIdentity === pending.rowIdentity)
        setConsistencyAudit((previous) => {
          if (!previous) return previous
          const items = [...previous.items.filter((item) => !affected.has(item.fingerprint)), ...refreshed.items.filter((item) => affected.has(item.fingerprint))]
          const findings = [...previous.findings.filter((finding) => !affected.has(finding.item?.fingerprint ?? '')
            && !(finding.code === 'DOUBLE_CLAIM' && (finding.technical?.row as Record<string, unknown> | undefined)?.sheetIdentity === pending.rowIdentity)), ...relatedFindings]
          return { ...previous, auditedAt: refreshed.auditedAt, items, findings, decisionAudit: refreshed.decisionAudit, pureStates: { ...previous.pureStates, ...refreshed.pureStates }, currentStates: { ...previous.currentStates, ...refreshed.currentStates }, summary: summarizeAudit(findings, items) }
        })
        setConsistencyAuditError('Reanálise dos subjects relacionados concluída. A decisão foi tombstonada; nenhuma linha da CUSTOS ANO foi alterada.')
      } catch (error) {
        if (active) setConsistencyAuditError(error instanceof Error ? error.message : 'Não foi possível recalcular os subjects relacionados.')
      } finally {
        if (active) setPendingDoubleClaimRefresh((current) => current?.id === pending.id ? null : current)
      }
    })()
    return () => { active = false }
  }, [pendingDoubleClaimRefresh, consistencyAudit, savedDecisions, statementResults, data, sheetSource, googleSheetLink, cardPdfs])

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
            <CardStatementUpload entries={cardPdfs} notice={cardPdfNotice} onSelect={selectCardPdfs} onRemove={removeCardPdf} onRemoveAll={() => { if (window.confirm('Remover todas as faturas PDF desta sessão? As confirmações salvas serão mantidas.')) cardPdfs.forEach((entry) => removeCardPdf(entry.key)) }}/>
            <div className="launch-row"><div className="privacy-detail"><span className="lock-icon">⌑</span><span><strong>Processamento local</strong><small>PDF e CSV são processados neste dispositivo. As decisões ficam salvas localmente e podem sincronizar entre dispositivos.</small></span></div><div className="launch-action"><small>{!decisionsReady ? 'Carregando decisões locais…' : canReconcile ? 'Arquivos aceitos; conciliação pronta.' : sourceStatus.sheet === 'ACCEPTED' ? 'Falta aceitar as linhas válidas do extrato bancário.' : sourceStatus.bank === 'ACCEPTED' ? 'Falta aceitar as linhas válidas da CUSTOS ANO.' : 'Aceite a CUSTOS ANO e o extrato, ou importe a fatura PDF.'}</small><button ref={reconcileButtonRef} className="button button-primary button-launch" aria-hidden={showStickyReconcile} tabIndex={showStickyReconcile ? -1 : undefined} onClick={runReconciliation} disabled={!canReconcile || !decisionsReady}>Conciliar agora <span aria-hidden="true">↗</span></button></div></div>
          </section>
          <section className="how-section"><span className="step-label">02 / O QUE ACONTECE</span><div className="how-grid"><HowCard number="01" title="Validar" copy="Confira cabeçalhos, linhas válidas e possíveis problemas."/><HowCard number="02" title="Comparar" copy="Valores, datas e descrições formam candidatos explicáveis."/><HowCard number="03" title="Revisar" copy="Você confirma ou ignora cada caso incerto."/></div></section>
        </> : <>
          <section className="results-heading"><div><span className="eyebrow">CONCILIAÇÃO LOCAL</span><h1>Visão geral</h1><p>Compare o resultado, refine o período e revise os casos sinalizados.</p></div><div className="audit-global-actions"><button className="button button-outline" onClick={() => void runConsistencyAudit()} disabled={consistencyAuditBusy}>{consistencyAuditBusy ? 'Auditando…' : 'Auditar consistência'}</button><button className="button button-outline" onClick={() => setScreen('home')}>← Voltar aos arquivos</button></div></section>
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
          <div className="tab-row" role="tablist" aria-label="Seções da conciliação"><Tab active={tab === 'overview'} onClick={() => setTab('overview')}>Resumo</Tab><Tab active={tab === 'review'} onClick={() => setTab('review')}>Revisão <span className="tab-count">{shownReview.length}</span></Tab><Tab active={tab === 'missing'} onClick={() => setTab('missing')}>Ausentes <span className="tab-count">{shownMissing.length}</span></Tab><Tab active={tab === 'card'} onClick={() => setTab('card')}>Faturas <span className="tab-count">{shownCardDivergences.length}</span></Tab>{statementResults.length > 0 && <Tab active={tab === 'statement'} onClick={() => setTab('statement')}>Faturas PDF <span className="tab-count">{statementResults.reduce((sum, result) => sum + result.matches.filter((match) => match.status === 'CARD_MISSING').length, 0)}</span></Tab>}{consistencyAudit && <Tab active={tab === 'auditor'} onClick={() => setTab('auditor')}>Auditoria <span className="tab-count">{activeAuditSummary?.attention ?? 0}</span></Tab>}<Tab active={tab === 'duplicates'} onClick={() => setTab('duplicates')}>Duplicidades <span className="tab-count">{filteredDuplicates.length}</span></Tab><Tab active={tab === 'outofscope'} onClick={() => setTab('outofscope')}>Fora do escopo <span className="tab-count">{shownOutOfScope.length}</span></Tab><Tab active={tab === 'flags'} onClick={() => setTab('flags')}>Sinalizações</Tab></div>
          {tab === 'auditor' && consistencyAudit && <section className="consistency-audit"><header className="panel audit-summary"><div><span className="eyebrow">SOMENTE LEITURA</span><h2>Auditoria de consistência</h2><small>Executada em {new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short', timeStyle: 'short' }).format(new Date(consistencyAudit.auditedAt))}</small></div><button className="button button-outline" onClick={() => void runConsistencyAudit()} disabled={consistencyAuditBusy}>{consistencyAuditBusy ? 'Auditando…' : 'Executar novamente'}</button><p>{consistencyAuditSourceNote}</p></header>{consistencyAuditError && <p className="cost-write-notice" role="status">{consistencyAuditError}</p>}<div className="audit-counts"><strong>⚠ {activeAuditSummary?.attention ?? 0} problemas que exigem atenção</strong><strong>{activeAuditSummary?.critical ?? 0} críticos</strong><strong>{activeAuditSummary?.review ?? 0} para revisão</strong><strong>{activeAuditSummary?.maintenance ?? 0} manutenções</strong><strong>{activeAuditSummary?.legacy ?? 0} legados</strong><strong>{hiddenAuditFindings.length} avisos ocultos</strong><strong>{consistencyAudit.summary.evaluatedPurchases} compras avaliadas</strong><strong>{activeAuditSummary?.informational ?? 0} informativos</strong></div><details className="panel audit-inventory"><summary>Compras avaliadas · {consistencyAudit.items.length}</summary>{consistencyAudit.items.map((item) => <div className="audit-transaction" key={item.fingerprint}><strong>{item.transaction.originalDescription}</strong><span>{dateLabel(item.transaction.purchaseDate)} · {formatCents(item.transaction.amount)}</span><details><summary>Detalhes técnicos da avaliação</summary><pre>{JSON.stringify({ diagnostico: item.diagnosis, estadoPuro: item.pure.status, estadoAtual: item.current?.status ?? null, fingerprint: item.fingerprint }, null, 2)}</pre></details></div>)}</details><div className="audit-filter"><button className="button button-quiet" onClick={() => setConsistencyAuditFilter('ALL')}>Todos ({activeAuditFindings.length})</button><button className="button button-quiet" onClick={() => setConsistencyAuditFilter('CRITICAL')}>Críticos ({activeAuditSummary?.critical ?? 0})</button><button className="button button-quiet" onClick={() => setConsistencyAuditFilter('REVIEW')}>Revisão ({activeAuditSummary?.review ?? 0})</button><button className="button button-quiet" onClick={() => setConsistencyAuditFilter('LEGACY')}>Legado/Manutenção ({(activeAuditSummary?.maintenance ?? 0) + (activeAuditSummary?.legacy ?? 0)})</button><button className="button button-quiet" onClick={() => setConsistencyAuditFilter('HIDDEN')}>Ocultos ({hiddenAuditFindings.length})</button></div>{auditDisplayedFindings.length ? auditDisplayedFindings.map((finding) => <AuditFindingCard key={finding.id} finding={finding} visibility={dismissedAuditFindings} hiddenView={consistencyAuditFilter === 'HIDDEN'} onDismiss={hideAuditFinding} onRestore={restoreHiddenAuditFinding} onDiscardObsolete={(item) => void auditDiscardObsoleteDoubleClaim(item)} onViewPurchase={(item) => { if (!item.item) return; setAuditFocusTransactionId(item.item.transaction.id); setAuditFocusStatementIdentity(item.item.statement.statementIdentity); setTab('statement'); setStatementOnlyIssues(false) }} onUseCandidate={(item) => { if (item.item) void auditUseCandidate(item.item) }} onInvalidateDecision={(_item, decision, explanation) => void auditInvalidateDecision(decision, explanation)} onReanalyze={(item) => { if (item.item) void auditRecalculateItem(item.item) }}/>) : <div className="panel"><EmptyState title={consistencyAuditFilter === 'HIDDEN' ? 'Nenhum aviso oculto' : 'Nenhuma inconsistência neste filtro'} copy={consistencyAuditFilter === 'HIDDEN' ? 'Os avisos ocultados aparecerão aqui.' : 'O relatório não encontrou problemas para mostrar nesta categoria.'}/></div>}</section>}
          {tab === 'overview' && <>
            <div className="summary-grid"><section className="panel"><PanelTitle title="Movimentação no período" note="Valores apresentados em reais"/><div className="totals-list"><AmountRow label="Total de movimentações do banco" amount={filteredItems.filter((item) => item.bank.direction === 'DEBIT' || item.bank.direction === 'CREDIT').reduce((sum, item) => sum + item.bank.amount, 0)} /><AmountRow label="Saídas" amount={filteredItems.filter((item) => item.bank.direction === 'DEBIT').reduce((sum, item) => sum + item.bank.amount, 0)}/><AmountRow label="Entradas" amount={filteredItems.filter((item) => item.bank.direction === 'CREDIT').reduce((sum, item) => sum + item.bank.amount, 0)}/><AmountRow label="Lançamentos da planilha" amount={filteredSheet.reduce((sum, item) => sum + item.amount, 0)} strong/></div></section>
              <section className="panel"><PanelTitle title="Arquivos usados" note="Dados temporários nesta sessão"/><div className="file-summary"><FileLine icon="▤" title="Tabela CUSTOS ANO" detail={`${data.sheet.length} linhas válidas`} /><FileLine icon="◈" title="Extrato bancário" detail={`${data.bank.length} movimentações válidas${uploads.bank?.csv.statementPeriodStart && uploads.bank.csv.statementPeriodEnd ? ` · ${dateLabel(uploads.bank.csv.statementPeriodStart)} a ${dateLabel(uploads.bank.csv.statementPeriodEnd)}` : ''}`} />{uploads.bank?.auxiliaryTransactionCount ? <small className="auxiliary-import-note">{uploads.bank.auxiliaryTransactionCount} lançamentos recentes fora do período foram ignorados.</small> : null}</div>{result.totals.finalBalance != null && <BalanceAuditPanel audit={bankBalanceAudit}/>}</section></div>
            <section className="panel recent-panel"><PanelTitle title="Atividade para acompanhar" note="Os itens abaixo precisam da sua atenção" action={<button className="text-button" onClick={() => setTab('review')}>Ver revisão →</button>}/>{shownReview.length + shownMissing.length ? <div className="activity-list">{[...shownReview, ...shownMissing].slice(0, 5).map((item) => <ActivityItem key={item.bank.id} item={item}/>)}</div> : <EmptyState title="Tudo em dia por aqui" copy="Nenhuma ausência ou correspondência pendente para o período selecionado."/>}</section>
            {shownMatched.length > 0 && <details className="panel matched-details" open={shownMatched.some((item) => item.candidate?.reasons.includes('Correspondência 1:1 escolhida globalmente'))}><summary><span><strong>Correspondências encontradas · {shownMatched.length}</strong><small>Abra para ver evidências, descrição e confiança</small></span><span aria-hidden="true">⌄</span></summary><div className="matched-list">{shownMatched.map((item) => <MatchedDetail key={item.bank.id} item={item} confirmedPreviously={savedDecisions.some((record) => record.kind === 'PAIR_CONFIRMED' && record.identities[0] === bankIdentity(item.bank))} onUndo={() => { if (item.sheet) void removeDecision('PAIR_CONFIRMED', [bankIdentity(item.bank)]) }}/>)}</div></details>}
            {cardPdfs.length > 0 && <section className="panel"><PanelTitle title="Faturas PDF desta conciliação" note="Totais agregados; cada arquivo mantém sua análise independente."/>{cardPdfs.map((entry) => { const item = statementResults.find((result) => result.entry.key === entry.key); const status = entry.status === 'PROCESSING' ? 'Processando…' : entry.status === 'PROCESSED' ? '✓ Processado' : entry.status === 'DIVERGENCE' ? '⚠ Divergência' : '⚠ Erro de parsing'; return <div className="card-pdf-status" key={entry.key}><div><strong>{entry.fileName}</strong><small>{status}{item ? ` · Vencimento ${item.statement.dueDate ? dateLabel(item.statement.dueDate) : 'não identificado'} · Total ${item.statement.reportedTotal == null ? 'indisponível' : formatCents(item.statement.reportedTotal)} · ${item.matches.filter((match) => match.status === 'CARD_MISSING').length} compra(s) ausente(s)` : entry.error ? ` · ${entry.error}` : ''}</small>{item && <small>{item.payment ? `Pagamento identificado: ${dateLabel(item.payment.date)} · ${formatCents(item.payment.amount)}` : 'Pagamento bancário não identificado'}</small>}</div></div>})}</section>}
            {filteredItems.some((item) => item.compositionStatus === 'MATCHED') && <section className="review-list"><PanelTitle title="Pagamentos de cartão conciliados" note="Uma saída bancária pode corresponder a vários lançamentos Crédito_Bradesco"/>{filteredItems.filter((item) => item.compositionStatus === 'MATCHED').map((item) => <CardPaymentCard key={item.bank.id} item={item} persisted={compositionWasSaved(item, null)} onConfirm={(ids) => confirmComposition(item, null, ids)} onUndo={() => void removeDecision('COMPOSITION_CONFIRMED', [bankIdentity(item.bank), savedCompositionIdentity(item)])} onIgnore={() => decide(item, 'ignore')}/>)}</section>}
          </>}
          {tab === 'review' && <div className="review-list">{shownReview.map((item) => item.bank.type === 'CARD_PAYMENT' ? <CardPaymentCard key={item.bank.id} item={item} persisted={compositionWasSaved(item, null)} onConfirm={(ids) => confirmComposition(item, null, ids)} onUndo={() => void removeDecision('COMPOSITION_CONFIRMED', [bankIdentity(item.bank), savedCompositionIdentity(item)])} onIgnore={() => decide(item, 'ignore')}/> : <ReviewCard key={item.bank.id} item={item} onConfirm={() => decide(item, 'confirm')} onReject={() => decide(item, 'reject')} onIgnore={() => decide(item, 'ignore')}/>)}{!shownReview.length && <EmptyState title="Nenhum item para revisar" copy="A conciliação não encontrou itens pendentes neste período."/>}</div>}
          {tab === 'missing' && <div className="review-list"><MissingSummary items={shownMissing}/>{shownMissing.map((item) => <MissingCard key={item.bank.id} item={item} onIgnore={() => decide(item, 'ignore')} onAddToSheet={() => openBankMissing(item)} canAddToSheet={bankAddEligibility(item).eligible} />)}{!shownMissing.length && <EmptyState title="Nenhuma despesa ausente" copy="Não há saídas classificadas como despesa sem correspondente neste período."/>}</div>}
          {tab === 'card' && <div className="review-list">{shownCardDivergences.map((item) => <CardPaymentCard key={item.bank.id} item={item} persisted={compositionWasSaved(item, null)} onConfirm={(ids) => confirmComposition(item, null, ids)} onUndo={() => void removeDecision('COMPOSITION_CONFIRMED', [bankIdentity(item.bank), savedCompositionIdentity(item)])} onIgnore={() => decide(item, 'ignore')}/>)}{!shownCardDivergences.length && <EmptyState title="Nenhuma divergência de cartão" copy="Todas as faturas têm uma composição confirmada ou não há pagamentos de cartão neste período."/>}</div>}
          {tab === 'statement' && <><section className="statement-filter panel" aria-label="Filtro das faturas"><strong>Exibição</strong><button className={`button ${statementOnlyIssues ? 'button-outline' : 'button-primary'}`} onClick={() => setStatementOnlyIssues(false)}>Todas</button><button className={`button ${statementOnlyIssues ? 'button-primary' : 'button-outline'}`} onClick={() => setStatementOnlyIssues(true)}>Só pendências</button></section>{visibleStatementResults.map((item) => <CardStatementResults key={item.entry.key} statement={item.statement} payment={item.payment} matches={item.matches} matchedTotal={item.matchedTotal} difference={item.difference} confirmations={item.confirmations} onlyIssues={statementOnlyIssues} focusTransactionId={item.statement.statementIdentity === auditFocusStatementIdentity ? auditFocusTransactionId : ''} onConfirm={(transactionId, sheetId) => confirmStatementMatch(item.statement, transactionId, sheetId)} onRejectCandidates={(transactionId, sheetIds) => rejectCardReviewCandidates(item.statement, transactionId, sheetIds)} onIgnore={(transactionId) => ignoreCardPurchase(item.statement, transactionId)} onAddMissing={(match) => openCardMissing(item.statement, match)} onUndo={(kind, identities) => { void undoStatementDecision(kind, item.statement, identities) }}/>) }{!visibleStatementResults.length && <EmptyState title="Nenhuma pendência nas faturas" copy="As faturas conciliadas foram ocultadas pelo filtro Só pendências."/>}</>}
          {tab === 'outofscope' && <div className="issue-columns"><section className="panel"><PanelTitle title="Movimentações fora da conciliação de despesas" note="Entradas, investimentos, transferências e tipos sem natureza confirmada"/>{shownOutOfScope.length ? <>{investFacilYields.length > 0 && <details className="investment-yield-group"><summary><strong>Rendimentos Invest Fácil</strong><span>{investFacilYields.length} créditos · total {formatCents(investFacilYields.reduce((sum, item) => sum + item.bank.amount, 0))}</span><small>Créditos de rendimento agrupados; não são lançados em CUSTOS ANO.</small></summary><div>{investFacilYields.map((item) => <p key={item.bank.id}>{dateLabel(item.bank.date)} · {item.bank.originalDescription} · {formatCents(item.bank.amount)}</p>)}</div></details>}{otherOutOfScope.map((item) => <div className="issue-row" key={item.bank.id}><span className="status-icon blue">ℹ</span><div><strong>{item.bank.originalDescription}</strong><p>{dateLabel(item.bank.date)} · {item.bank.directionKnown === false ? 'Direção não identificada' : item.bank.direction === 'DEBIT' ? 'Saída' : 'Entrada'} · {formatCents(item.bank.amount)}</p><small>{item.sheet ? `Correspondência de investimento: ${item.sheet.originalDescription} · ${formatCents(item.sheet.amount)}` : outOfScopeReason(item.bank.type)}</small></div></div>)}</> : <EmptyState title="Nenhuma movimentação fora do escopo" copy="Todas as movimentações deste período estão em outras seções."/>}</section></div>}
          {tab === 'duplicates' && <section className="panel"><PanelTitle title="Possíveis duplicidades na CUSTOS ANO" note="Sugestões baseadas em lançamentos da planilha; nada é removido automaticamente"/>{filteredDuplicates.length ? filteredDuplicates.map((group, index) => <div className="issue-row duplicate-group" key={`${group.source}-${index}`}><span className="status-icon orange">Ⅱ</span><div><strong>Confira este grupo · {group.transactionIds.length} lançamentos</strong>{group.transactionIds.map((id) => { const sheet = data.sheet.find((entry) => entry.id === id); return sheet ? <p className="duplicate-entry" key={id}>{dateLabel(sheet.date)} · {sheet.originalDescription} · {formatCents(sheet.amount)}{sheet.paymentMethod ? ` · ${sheet.paymentMethod}` : ''}</p> : null })}<small>Possíveis duplicidades precisam de confirmação manual.</small></div></div>) : <EmptyState title="Nenhuma duplicidade sugerida" copy="Nenhuma linha da CUSTOS ANO com data, valor e descrição parecida foi encontrada."/>}</section>}
          {tab === 'flags' && <section className="panel"><PanelTitle title="Lançamentos da planilha não encontrados no extrato" note="Podem pertencer a outra conta, período ou meio de pagamento"/>{unmatchedFilteredSheet.filter((item) => !ignoredSheetIds.has(sheetIdentity(item))).length ? unmatchedFilteredSheet.filter((item) => !ignoredSheetIds.has(sheetIdentity(item))).map((sheet) => <div className="issue-row" key={sheet.id}><span className="status-icon blue">↗</span><div><strong>{sheet.originalDescription}</strong><p>{dateLabel(sheet.date)} · {formatCents(sheet.amount)} · {sheet.category || 'Sem categoria'}</p><small>Não encontrado no extrato importado.</small><button className="text-button" onClick={() => ignoreSheet(sheet.id)}>Ignorar este lançamento</button></div></div>) : <EmptyState title="Sem sinalizações" copy="Não há lançamentos da planilha pendentes neste período."/>}</section>}
          <ExportBar result={{ ...result, duplicateGroups: filteredDuplicates }} items={filteredItems} banks={data.bank} sheets={data.sheet}/>
          <footer className="results-footer"><span>▣ Confirmações salvas neste dispositivo{googleSheetLink ? ' e sincronizadas quando Google está conectado.' : '.'}</span><button className="text-button" onClick={clearSession}>Limpar dados desta sessão</button><button className="text-button" onClick={() => void clearSavedDecisions()}>Limpar confirmações salvas</button></footer>
        </>}
      </main>
      {screen === 'home' && showStickyReconcile && <div className="sticky-reconcile" aria-label="Ação de conciliação"><button className="button button-primary button-launch" aria-label="Conciliar agora" onClick={runReconciliation} disabled={!canReconcile || !decisionsReady}>Conciliar agora <span aria-hidden="true">↗</span></button></div>}
      <PwaUpdateNotice />
      {screen === 'results' && missingToAdd && <AddCostYearDialog transaction={missingToAdd.kind === 'BANK' ? missingToAdd.bank : undefined} initial={missingToAdd.kind === 'STATEMENT' ? { description: missingToAdd.transaction.installment != null && missingToAdd.transaction.totalInstallments != null ? '(' + missingToAdd.transaction.installment + '/' + missingToAdd.transaction.totalInstallments + ') ' + missingToAdd.transaction.originalDescription : missingToAdd.transaction.originalDescription, sheetDate: missingToAdd.transaction.invoiceDueDate ?? missingToAdd.transaction.statementDueDate ?? missingToAdd.statement.dueDate ?? missingToAdd.transaction.purchaseDate, purchaseDate: missingToAdd.transaction.purchaseDate, invoiceDueDate: missingToAdd.transaction.invoiceDueDate ?? missingToAdd.transaction.statementDueDate ?? missingToAdd.statement.dueDate, amount: missingToAdd.transaction.amount, paymentSource: 'STATEMENT' } : undefined} categories={costCategories} connected={Boolean(googleSheetInfo?.connected && googleAccessToken.current)} saving={writingMissingId === (missingToAdd.kind === 'BANK' ? bankIdentity(missingToAdd.bank) : cardTransactionIdentity(missingToAdd.statement, missingToAdd.transaction)) || reconnectingForWrite} error={missingWriteError} onCancel={() => { if (!writingMissingId) { setMissingToAdd(null); setMissingWriteError('') } }} onReconnect={() => void reconnectGoogleForCostWrite()} onSubmit={(record) => void addMissingToCostYear(missingToAdd, record)} />}
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
  const [showBankPreview, setShowBankPreview] = useState(false)
  const accepted = status === 'ACCEPTED' && upload
  if (mode === 'bank' && upload && !bankCsvRequiresManualMapping(upload)) return <BankCsvUploadCard upload={upload} accepted={Boolean(accepted)} onMapChange={(key, value) => onMapChange(mode, key, value)} onAccept={onAccept} onClear={onClear} onSelect={(event) => onSelect(mode, event)} fieldTitles={fieldTitles} requiredFields={requiredFields[mode]} optionalFields={optionalFields[mode]}/>
  return <article className={`upload-card ${upload ? 'upload-card-loaded' : ''} ${accepted ? 'upload-card-accepted' : ''}`}><div className="upload-top"><span className={`upload-icon ${mode}`}>{mode === 'sheet' ? '▤' : '◈'}</span><span className="upload-state">{accepted ? '✓ Fonte aceita' : status === 'LOADED' ? 'Lendo arquivo…' : upload ? 'CSV validado' : 'CSV · Seleção local'}</span></div><h3>{title}</h3><p className="upload-subtitle">{subtitle}</p>
    {!upload && status === 'LOADED' ? <div className="file-drop" role="status">Lendo o arquivo neste dispositivo…</div> : !upload ? <label className="file-drop"><input type="file" aria-label="Selecionar arquivo CSV" accept=".csv,text/csv" onChange={(event) => onSelect(mode, event)}/><span className="file-plus">＋</span><strong>Selecionar arquivo CSV</strong><small>Separador vírgula ou ponto e vírgula · UTF-8</small></label> : accepted ? <>
      <div className="accepted-file"><span className="accepted-check" aria-hidden="true">✓</span><div><strong>{upload.fileName}</strong><small>{upload.valid.length} movimentações carregadas</small><small>{upload.issues.length === 1 ? '1 linha com problema não importada' : `${upload.issues.length} linhas com problemas não importadas`}</small></div></div>
      {upload.csv.metadataRowsIgnored > 0 && <small className="ignored-row-note">{upload.csv.metadataRowsIgnored} linha(s) de metadados antes do cabeçalho.</small>}
      {upload.issues.length > 0 && <div className="issue-preview"><div><span className="status-icon amber">!</span><span><strong>{upload.issues.length} problema(s) preservados para consulta</strong><small>Somente as linhas válidas foram aceitas.</small></span><button className="text-button" onClick={() => setShowAllIssues(!showAllIssues)}>{showAllIssues ? 'Recolher' : 'Detalhes'}</button></div>{showAllIssues && <ul>{upload.issues.slice(0, 8).map((issue, index) => <li key={index}>Linha {issue.row}: {issue.message}</li>)}</ul>}</div>}
      <div className="accepted-actions"><label className="button button-outline replace-file"><input type="file" aria-label="Selecionar arquivo CSV" accept=".csv,text/csv" onChange={(event) => onSelect(mode, event)}/>Substituir arquivo</label><button className="button button-quiet button-small" onClick={onClear}>Remover</button></div>
    </> : <>
      <div className="selected-file"><span>▤</span><div><strong>{upload.fileName}</strong><small>{upload.rowCount} linhas detectadas · delimitador {upload.csv.delimiter === ',' ? 'vírgula' : upload.csv.delimiter === ';' ? 'ponto e vírgula' : upload.csv.delimiter || 'automático'}</small></div><button className="icon-button" aria-label="Remover arquivo" onClick={onClear}>×</button></div>
      {mode === 'bank' && <p className="bank-needs-confirmation">Precisamos confirmar algumas colunas</p>}
      <div className="mapping-grid"><strong className="mapping-heading">Confira o mapeamento das colunas</strong>{[...requiredFields[mode], ...optionalFields[mode]].map((key) => <label className="map-field" key={key}><span>{fieldTitles[key]}{requiredFields[mode].includes(key) && <i> · obrigatório</i>}</span><select value={upload.map[key] ?? ''} onChange={(event) => onMapChange(mode, key, event.target.value)}><option value="">{requiredFields[mode].includes(key) ? 'Selecione uma coluna' : 'Não disponível'}</option>{upload.csv.headers.map((header) => <option key={header} value={header}>{header}</option>)}</select></label>)}</div>
      {mode === 'bank' ? <><details className="csv-preview" open={showBankPreview} onToggle={(event) => setShowBankPreview(event.currentTarget.open)}><summary>Ver prévia ▸ <span>{upload.valid.length} válidas · {upload.ignoredRows} ignoradas · {upload.issues.length} problemas</span></summary><div className="preview-table-wrap"><table className="preview-table"><thead><tr>{upload.csv.headers.slice(0, 6).map((header) => <th key={header}>{header}</th>)}</tr></thead><tbody>{upload.csv.rows.slice(0, 4).map((row, index) => <tr key={index}>{upload.csv.headers.slice(0, 6).map((header) => <td key={header}>{row[header]}</td>)}</tr>)}</tbody></table></div></details>{upload.csv.metadataRowsIgnored > 0 && <details className="csv-metadata"><summary>Detalhes do arquivo</summary><small>{upload.csv.metadataRowsIgnored} linha(s) de metadados ignoradas antes do cabeçalho.</small></details>}</> : <><div className="preview-heading"><strong>Prévia</strong><span>{upload.valid.length} válidas · {upload.issues.length} problemas</span></div>{upload.ignoredRows > 0 && <small className="ignored-row-note">{upload.ignoredRows} linha(s) ignoradas por não conterem movimentação ou serem cabeçalho/rodapé.</small>}<div className="preview-table-wrap"><table className="preview-table"><thead><tr>{upload.csv.headers.slice(0, 6).map((header) => <th key={header}>{header}</th>)}</tr></thead><tbody>{upload.csv.rows.slice(0, 4).map((row, index) => <tr key={index}>{upload.csv.headers.slice(0, 6).map((header) => <td key={header}>{row[header]}</td>)}</tr>)}</tbody></table></div></>}
      {upload.issues.length > 0 && <div className="issue-preview"><div><span className="status-icon amber">!</span><span><strong>{upload.issues.length} problema(s) para conferir</strong><small>As linhas inválidas não serão descartadas sem aviso.</small></span><button className="text-button" onClick={() => setShowAllIssues(!showAllIssues)}>{showAllIssues ? 'Recolher' : 'Detalhes'}</button></div>{showAllIssues && <ul>{upload.issues.slice(0, 8).map((issue, index) => <li key={index}>Linha {issue.row}: {issue.message}</li>)}</ul>}</div>}
      <button className="button button-secondary full-button" disabled={!upload.valid.length} onClick={onAccept}>Usar {upload.valid.length} linha(s) válidas <span aria-hidden="true">→</span></button>
    </>}
  </article>
}

function CardStatementUpload({ entries, notice, onSelect, onRemove, onRemoveAll }: { entries: CardPdfEntry[]; notice: string; onSelect: (event: ChangeEvent<HTMLInputElement>) => void; onRemove: (key: string) => void; onRemoveAll: () => void }) {
  const [expandedKeys, setExpandedKeys] = useState<Set<string>>(() => new Set())
  const manuallyChanged = useRef(new Set<string>())
  useEffect(() => {
    const needsAttention = entries.filter((entry) => entry.status === 'ERROR' || entry.status === 'DIVERGENCE'
      || Boolean(entry.statement && (!entry.statement.dueDate || entry.statement.reportedTotal == null || entry.statement.errors.length > 0 || entry.statement.accountingDifference != null && entry.statement.accountingDifference !== 0)))
    if (needsAttention.length) setExpandedKeys((current) => {
      const next = new Set(current)
      needsAttention.forEach((entry) => { if (!manuallyChanged.current.has(entry.key)) next.add(entry.key) })
      return next
    })
  }, [entries])

  const sortedEntries = [...entries].sort((a, b) => (a.statement?.dueDate ?? '9999-99-99').localeCompare(b.statement?.dueDate ?? '9999-99-99') || a.key.localeCompare(b.key))
  const statements = entries.flatMap((entry) => entry.statement ? [entry.statement] : [])
  const purchases = statements.flatMap((statement) => statement.transactions.filter((item) => item.type === 'PURCHASE'))
  const refunds = statements.flatMap((statement) => statement.transactions.filter((item) => item.type === 'REFUND'))
  const issueCount = entries.filter((entry) => entry.status === 'ERROR' || entry.status === 'DIVERGENCE'
    || Boolean(entry.statement && (!entry.statement.dueDate || entry.statement.reportedTotal == null || entry.statement.errors.length > 0 || entry.statement.accountingDifference != null && entry.statement.accountingDifference !== 0))).length
  const processingCount = entries.filter((entry) => entry.status === 'PROCESSING').length
  const netTotal = statements.reduce((sum, statement) => sum + (statement.reportedTotal ?? statement.transactions.reduce((net, item) => net + (item.direction === 'CREDIT' ? -item.amount : item.amount), 0)), 0)
  const formatShortMoney = (amount: number) => formatCents(amount)
  const toggleExpanded = (key: string) => {
    manuallyChanged.current.add(key)
    setExpandedKeys((current) => { const next = new Set(current); if (next.has(key)) next.delete(key); else next.add(key); return next })
  }
  const setAllExpanded = (expanded: boolean) => {
    manuallyChanged.current = new Set(entries.map((entry) => entry.key))
    setExpandedKeys(expanded ? new Set(entries.map((entry) => entry.key)) : new Set())
  }
  const statusFor = (entry: CardPdfEntry) => {
    if (entry.status === 'PROCESSING') return { text: 'Lendo PDF…', tone: 'amber' }
    if (entry.status === 'ERROR') return { text: '⚠ Erro de parsing', tone: 'red' }
    if (entry.statement && !entry.statement.dueDate) return { text: '⚠ Vencimento não identificado', tone: 'amber' }
    if (entry.statement && (entry.statement.errors.length > 0 || entry.statement.reportedTotal == null || entry.statement.accountingDifference != null && entry.statement.accountingDifference !== 0)) return { text: '⚠ Valores não conferem', tone: 'amber' }
    return { text: '✓ Valores conferem', tone: 'green' }
  }
  const titleFor = (statement: CardStatement) => {
    const cardIds = [...new Set(statement.transactions.map((item) => item.cardIdentifier))]
    const due = statement.dueDate ? dateLabel(statement.dueDate) : 'vencimento não identificado'
    const cards = cardIds.length === 1 ? `Cartão •••• ${cardIds[0].slice(-4)}` : `${cardIds.length} cartões`
    return `Fatura ${due} · ${cards}`
  }

  return <section className="card-pdf-import panel"><div className="panel-heading"><div><span className="step-label">03 / CARTÃO DE CRÉDITO</span><h2>Importar faturas PDF</h2><p>Cada fatura é lida separadamente neste navegador; os arquivos não são enviados nem guardados.</p></div></div>
    <label className={`file-drop card-pdf-drop ${entries.length ? 'card-pdf-drop-compact' : ''}`}><input type="file" aria-label="Selecionar fatura PDF" accept="application/pdf,.pdf" multiple onChange={onSelect}/><span className="file-plus">＋</span><strong>{entries.length ? 'Adicionar mais faturas' : 'Adicionar faturas PDF'}</strong><small>Selecione PDFs ou arraste-os aqui. Você pode adicionar mais depois.</small></label>
    {notice && <div className="alert alert-error" role="status">{notice}</div>}
    {entries.length > 1 && <section className="card-pdf-batch" aria-label="Resumo das faturas"><div><strong>{entries.length} faturas carregadas</strong><small>{purchases.length} compras{refunds.length ? ` · ${refunds.length} ${refunds.length === 1 ? 'estorno/crédito' : 'estornos/créditos'}` : ''}</small><strong>Total líquido: {formatShortMoney(netTotal)}</strong><small className={issueCount ? 'warning-text' : 'good-text'}>{issueCount ? `⚠ ${issueCount} ${issueCount === 1 ? 'fatura precisa' : 'faturas precisam'} de atenção${processingCount ? ` · ${processingCount} em processamento` : ''}` : processingCount ? `${processingCount} ${processingCount === 1 ? 'fatura sendo lida' : 'faturas sendo lidas'}…` : '✓ Todas as faturas foram lidas corretamente'}</small></div><div className="card-pdf-batch-actions"><button className="text-button" onClick={() => setAllExpanded(true)}>Expandir todas</button><button className="text-button" onClick={() => setAllExpanded(false)}>Recolher todas</button><button className="text-button card-pdf-remove-all" onClick={onRemoveAll}>Remover todas</button></div></section>}
    {sortedEntries.map((entry) => {
      const statement = entry.statement
      const purchasesInStatement = statement?.transactions.filter((item) => item.type === 'PURCHASE') ?? []
      const refundsInStatement = statement?.transactions.filter((item) => item.type === 'REFUND') ?? []
      const cards = statement ? [...new Set(statement.transactions.map((item) => item.cardIdentifier))] : []
      const status = statusFor(entry)
      const expanded = expandedKeys.has(entry.key)
      const total = statement?.reportedTotal ?? statement?.transactions.reduce((net, item) => net + (item.direction === 'CREDIT' ? -item.amount : item.amount), 0) ?? 0
      return <article className={`card-pdf-entry ${status.tone === 'red' || status.tone === 'amber' && status.text.startsWith('⚠') ? 'card-pdf-entry-issue' : ''}`} data-testid="card-pdf-entry" key={entry.key}>
        <header className="card-pdf-summary"><div className="card-pdf-summary-main"><strong>{statement ? titleFor(statement) : entry.status === 'ERROR' ? 'Fatura com erro de leitura' : 'Fatura sendo lida'}</strong>{statement && !statement.dueDate && <small>Vencimento não identificado</small>}{!statement && <small>{status.text}</small>}{statement && <><strong>{formatShortMoney(total)} · {purchasesInStatement.length} compras{refundsInStatement.length ? ` · ${refundsInStatement.length} ${refundsInStatement.length === 1 ? 'estorno/crédito' : 'estornos/créditos'}` : ''}</strong><span className={`statement-status ${status.tone}`}>{status.text}</span></>}</div><div className="card-pdf-entry-actions"><button className="button button-outline button-small" aria-expanded={expanded} onClick={() => toggleExpanded(entry.key)}>{expanded ? 'Recolher detalhes' : 'Ver detalhes'}</button><button className="button button-quiet button-small" aria-label={`Remover ${entry.fileName}`} onClick={() => onRemove(entry.key)}>Remover</button></div></header>
        {expanded && <div className="card-pdf-details"><small>Arquivo: {entry.fileName}</small>{statement && <><small>{statement.pageCount} páginas · {cards.length} cartões encontrados{cards.length ? ` · ${cards.map((card) => `final ${card.slice(-4)}`).join(', ')}` : ''}</small><div className="statement-totals"><AmountRow label="Compras/Débitos extraídos" amount={purchasesInStatement.reduce((sum, item) => sum + item.amount, 0)}/><AmountRow label="Créditos/estornos extraídos" amount={-refundsInStatement.reduce((sum, item) => sum + item.amount, 0)}/>{statement.cardSubtotals.map((subtotal) => <AmountRow key={subtotal.cardIdentifier} label={`Subtotal cartão final ${subtotal.cardIdentifier.slice(-4)}`} amount={subtotal.amount}/ >)}<AmountRow label="Total extraído / líquido" amount={statement.purchasesDebitsTotal != null ? statement.purchasesDebitsTotal - refundsInStatement.reduce((sum, item) => sum + item.amount, 0) : total}/>{statement.reportedTotal != null && <AmountRow label="Total informado pela fatura" amount={statement.reportedTotal}/ >}{statement.previousBalance != null && <AmountRow label="Saldo anterior" amount={statement.previousBalance}/ >}{statement.creditsPaymentsTotal != null && <AmountRow label="Créditos/Pagamentos" amount={statement.creditsPaymentsTotal}/ >}<strong className={status.tone === 'green' ? 'good-text' : 'warning-text'}>{status.text}</strong></div><div className="card-pdf-metadata"><small>Vencimento: {statement.dueDate ? dateLabel(statement.dueDate) : 'não identificado'}</small><small>Fechamento: {statement.nextClosingDate ? dateLabel(statement.nextClosingDate) : 'não informado'}</small>{statement.previousPayment != null && <small>Pagamento anterior: {formatShortMoney(statement.previousPayment)}</small>}{statement.accountingDifference != null && <small>Diferença matemática: {formatShortMoney(statement.accountingDifference)}</small>}</div><div className="card-pdf-transactions"><strong>Compras e créditos extraídos</strong>{statement.transactions.map((transaction) => <div className="card-pdf-transaction" key={transaction.id}><span>{dateLabel(transaction.purchaseDate || transaction.date)} · {transaction.originalDescription}<small>{transaction.type === 'REFUND' ? 'Crédito/estorno' : 'Compra'} · cartão final {transaction.cardIdentifier.slice(-4)}{transaction.installment != null ? ` · parcela ${transaction.installment}/${transaction.totalInstallments}` : ''}{transaction.city ? ` · ${transaction.city}` : ''}{transaction.currency !== 'BRL' ? ` · ${transaction.currency}` : ''}{transaction.exchangeRate != null ? ` · câmbio ${transaction.exchangeRate}` : ''}</small></span><strong>{formatShortMoney(transaction.direction === 'CREDIT' ? -transaction.amount : transaction.amount)}</strong></div>)}</div>{statement.errors.map((message) => <p className="statement-warning" key={message}>{message}</p>)}</>}{entry.error && <p className="statement-warning">{entry.error}</p>}</div>}
      </article>
    })}
  </section>
}

function CardStatementResults({ statement, payment, matches, matchedTotal, difference, confirmations, onlyIssues, focusTransactionId, onConfirm, onRejectCandidates, onIgnore, onAddMissing, onUndo }: { statement: CardStatement; payment: BankTransaction | null; matches: CardStatementMatch[]; matchedTotal: number; difference: number; confirmations: Map<string, string>; onlyIssues: boolean; focusTransactionId?: string; onConfirm: (transactionId: string, sheetId: string) => void; onRejectCandidates: (transactionId: string, sheetIds: string[]) => void; onIgnore: (transactionId: string) => void; onAddMissing: (match: CardStatementMatch) => void; onUndo: (kind: DecisionKind, identities: string[]) => void }) {
  const [expanded, setExpanded] = useState<boolean | null>(null)
  const [showMatched, setShowMatched] = useState(false)
  const [showIgnored, setShowIgnored] = useState(false)
  const [showAll, setShowAll] = useState(false)
  const [exceptionLimit, setExceptionLimit] = useState(5)
  useEffect(() => { if (focusTransactionId) { setExpanded(true); setShowAll(true); setShowMatched(true); setExceptionLimit(Number.MAX_SAFE_INTEGER) } }, [focusTransactionId])
  const purchases = matches.filter((match) => match.transaction.type === 'PURCHASE')
  const refunds = statement.transactions.filter((item) => item.type === 'REFUND')
  const purchasesTotal = purchases.reduce((sum, match) => sum + match.transaction.amount, 0)
  const matched = purchases.filter((match) => match.status === 'CARD_MATCHED' || match.status === 'CARD_GROUP_MATCHED')
  const review = purchases.filter((match) => match.status === 'CARD_REVIEW')
  const missing = purchases.filter((match) => match.status === 'CARD_MISSING')
  const ignored = purchases.filter((match) => match.status === 'CARD_IGNORED')
  const invoiceIssue = statement.errors.length > 0 || payment == null || statement.accountingDifference != null && statement.accountingDifference !== 0 || statement.purchasesDebitsTotal != null && statement.purchasesDebitsTotal !== purchasesTotal
  const hasIssues = missing.length > 0 || review.length > 0 || invoiceIssue
  const isFullyResolved = !hasIssues && ignored.length + matched.length === purchases.length
  const cardIds = [...new Set(statement.transactions.map((item) => item.cardIdentifier))]
  const title = cardIds.length === 1 ? `Cartão final ${cardIds[0].slice(-4)}` : `${cardIds.length} cartões`
  const renderGroup = (heading: string, entries: CardStatementMatch[]) => entries.length > 0 && <section className="statement-priority-group" key={heading}><h3>{heading} · {entries.length}</h3>{cardIds.map((cardIdentifier) => {
    const cardMatches = entries.filter((match) => match.transaction.cardIdentifier === cardIdentifier)
    if (!cardMatches.length) return null
    const subtotal = statement.cardSubtotals.find((item) => item.cardIdentifier === cardIdentifier)?.amount
    return <section className="statement-card-group" key={`${heading}-${cardIdentifier}`}><h4>Cartão final {cardIdentifier.slice(-4)}{cardIds.length > 1 && subtotal != null ? ` · subtotal ${formatCents(subtotal)}` : ''}</h4>{cardMatches.map((match) => <CardStatementRow key={match.transaction.id} match={match} statementIdentity={statement.statementIdentity} invoiceDueDate={statement.dueDate} nextClosingDate={statement.nextClosingDate} confirmedPreviously={confirmations.has(match.transaction.id)} auditFocus={focusTransactionId === match.transaction.id} onConfirm={onConfirm} onRejectCandidates={onRejectCandidates} onIgnore={onIgnore} onAddMissing={onAddMissing} onUndo={onUndo}/>)}</section>
  })}</section>
  const exceptionMatches = [...missing, ...review]
  const visibleExceptions = showAll ? exceptionMatches : exceptionMatches.slice(0, exceptionLimit)
  const showEveryPurchase = showAll || showMatched
  const allClear = isFullyResolved
  const isExpanded = expanded ?? hasIssues
  return <article className={`statement-results panel ${allClear ? 'statement-results-clear' : 'statement-results-issue'}`}>
    <header className="statement-invoice-summary"><span className={`status-icon ${allClear ? 'green' : hasIssues ? 'red' : 'amber'}`}>{allClear ? '✓' : hasIssues ? '!' : '↻'}</span><div className="statement-invoice-summary-main"><strong>{title}</strong><small>Vencimento: {statement.dueDate ? dateLabel(statement.dueDate) : 'não identificado'}{statement.nextClosingDate ? ` · Fechamento: ${dateLabel(statement.nextClosingDate)}` : ''}</small><small>{purchases.length} compras · {matched.length} conciliadas · {review.length} revisão · {missing.length} ausentes{ignored.length ? ` · ${ignored.length} ignoradas` : ''}</small><strong>{formatCents(statement.reportedTotal ?? purchasesTotal)}</strong><small>{payment ? `Pagamento identificado · ${dateLabel(payment.date)} · ${formatCents(payment.amount)}` : 'Pagamento da fatura não identificado'}</small></div><button className="button button-outline statement-expand-button" aria-expanded={isExpanded} onClick={() => { setExpanded(!isExpanded); if (isExpanded) { setShowAll(false); setShowMatched(false); setShowIgnored(false) } }}>{isExpanded ? 'Recolher' : allClear ? 'Mostrar tudo' : 'Mostrar detalhes'}</button></header>
    {isExpanded && <div className="statement-expanded-content">
      {statement.errors.map((message) => <p className="statement-warning" key={message}>{message}</p>)}
      {!payment && <p className="statement-payment-note">Nenhum pagamento bancário com o total da fatura foi identificado perto do vencimento. A conciliação das compras continua separada.</p>}
      {statement.accountingDifference != null && statement.accountingDifference !== 0 && <p className="statement-warning">A relação matemática da fatura apresenta divergência.</p>}
      {visibleExceptions.length > 0 && renderGroup('Ausentes', visibleExceptions.filter((match) => match.status === 'CARD_MISSING'))}
      {visibleExceptions.length > 0 && renderGroup('Revisar', visibleExceptions.filter((match) => match.status === 'CARD_REVIEW'))}
      {!showAll && exceptionMatches.length > exceptionLimit && <button className="button button-outline" onClick={() => setExceptionLimit((count) => count + 5)}>Mostrar mais ({exceptionMatches.length - exceptionLimit})</button>}
      {exceptionMatches.length === 0 && hasIssues && <p className="statement-caution">A fatura tem uma inconsistência de total ou pagamento; as compras individuais estão conciliadas.</p>}
      {!onlyIssues && matched.length > 0 && <section className="statement-collapsed-group"><strong>✓ {matched.length} compras conciliadas</strong><button className="button button-outline" onClick={() => setShowMatched((value) => !value)}>{showMatched ? 'Ocultar conciliadas' : 'Mostrar conciliadas'}</button>{showEveryPurchase && renderGroup('Conciliadas', matched)}</section>}
      {!onlyIssues && ignored.length > 0 && <section className="statement-collapsed-group"><strong>Itens ignorados · {ignored.length}</strong><button className="button button-outline" onClick={() => setShowIgnored((value) => !value)}> {showIgnored ? 'Ocultar ignorados' : 'Mostrar ignorados'}</button>{showIgnored && renderGroup('Ignoradas', ignored)}</section>}
      {!onlyIssues && showAll && refunds.length > 0 && <section className="statement-priority-group"><h3>Créditos/estornos · {refunds.length}</h3>{refunds.map((transaction) => <article className="statement-transaction" key={transaction.id}><span className="status-icon green">↩</span><div className="statement-transaction-main"><strong>{dateLabel(transaction.date)} · {transaction.originalDescription}</strong><small>Data real do crédito/estorno</small><span className="statement-status green">CRÉDITO/ESTORNO</span></div><strong className="activity-amount">{formatCents(-transaction.amount)}</strong></article>)}</section>}
      {showAll && <section className="statement-totals"><AmountRow label="Compras/Débitos extraídos" amount={purchasesTotal}/>{statement.previousBalance != null && <AmountRow label="Saldo anterior" amount={statement.previousBalance}/ >}{statement.creditsPaymentsTotal != null && <AmountRow label="Créditos/Pagamentos" amount={statement.creditsPaymentsTotal}/ >}{statement.reportedTotal != null && <AmountRow label="Total da fatura" amount={statement.reportedTotal}/ >}{statement.previousPayment != null && <p className="statement-payment-note">Pagamento anterior identificado: {formatCents(statement.previousPayment)} · excluído das compras da fatura.</p>}{statement.accountingDifference != null && <strong className={statement.accountingDifference === 0 ? 'good-text' : 'warning-text'}>{statement.accountingDifference === 0 ? '✓ Saldo anterior − créditos/pagamentos + compras/débitos = total da fatura' : '⚠ A relação matemática da fatura não fecha'}</strong>}{statement.cardSubtotals.map((subtotal) => <AmountRow key={subtotal.cardIdentifier} label={`Subtotal cartão final ${subtotal.cardIdentifier.slice(-4)}`} amount={subtotal.amount}/ >)}<AmountRow label="Compras correspondentes confirmadas em Crédito_Bradesco" amount={matchedTotal} strong/><AmountRow label="Diferença ainda não conciliada" amount={difference} strong/><p className="statement-caution">Os detalhes da fatura permanecem disponíveis para auditoria. A diferença não classifica automaticamente uma compra como esquecida.</p></section>}
      {isExpanded && !showAll && <button className="button button-outline" onClick={() => { setShowAll(true); setShowMatched(true); setShowIgnored(true); setExceptionLimit(Number.MAX_SAFE_INTEGER) }}>Mostrar tudo</button>}
    </div>}
  </article>
}
function CardStatementRow({ match, statementIdentity, invoiceDueDate, nextClosingDate, confirmedPreviously, auditFocus, onConfirm, onRejectCandidates, onIgnore, onAddMissing, onUndo }: { match: CardStatementMatch; statementIdentity: string; invoiceDueDate: string | null; nextClosingDate: string | null; confirmedPreviously: boolean; auditFocus?: boolean; onConfirm: (transactionId: string, sheetId: string) => void; onRejectCandidates: (transactionId: string, sheetIds: string[]) => void; onIgnore: (transactionId: string) => void; onAddMissing: (match: CardStatementMatch) => void; onUndo: (kind: DecisionKind, identities: string[]) => void }) {
  const rowRef = useRef<HTMLElement | null>(null)
  useEffect(() => { if (auditFocus && rowRef.current && typeof rowRef.current.scrollIntoView === 'function') rowRef.current.scrollIntoView({ behavior: 'smooth', block: 'center' }) }, [auditFocus])
  const { transaction, status, candidates } = match
  const purchaseDate = transaction.purchaseDate || transaction.date
  const dueDate = transaction.invoiceDueDate ?? transaction.statementDueDate ?? invoiceDueDate
  const identity = cardTransactionIdentity(statementIdentity, transaction)
  const label = status === 'CARD_REFUNDED' ? 'ESTORNADA · NÃO É COMPRA AUSENTE' : status === 'CARD_GROUP_MATCHED' ? `CONCILIADO POR MULTIPLICIDADE · GRUPO DE ${candidates.length}` : status === 'CARD_MATCHED' ? confirmedPreviously ? 'CONCILIADO ANTERIORMENTE' : 'MATCHED · Crédito_Bradesco' : status === 'CARD_MISSING' ? 'COMPRA DE CARTÃO NÃO REGISTRADA' : status === 'CARD_IGNORED' ? 'COMPRA IGNORADA' : 'REVISAR CORRESPONDÊNCIA'
  const tone = status === 'CARD_MATCHED' || status === 'CARD_GROUP_MATCHED' || status === 'CARD_REFUNDED' ? 'green' : status === 'CARD_MISSING' ? 'red' : 'amber'
  const addDecision = canAddMissingToCostYear({ source: 'STATEMENT', status, direction: transaction.direction, type: transaction.type })
  return <article ref={rowRef} className={`statement-transaction ${auditFocus ? 'audit-row-focus' : ''}`}><span className={`status-icon ${tone}`}>{status === 'CARD_MATCHED' || status === 'CARD_GROUP_MATCHED' || status === 'CARD_REFUNDED' ? '✓' : status === 'CARD_MISSING' ? '⌕' : '!'}</span><div className="statement-transaction-main"><strong>{dateLabel(purchaseDate)} · {transaction.originalDescription}</strong><p>Data real da compra · {transaction.city || 'Cidade não informada'}{transaction.installment != null ? ` · Parcela ${transaction.installment}/${transaction.totalInstallments}` : ''}</p><div className="statement-invoice-date-context"><small>{dueDate ? `Vencimento da fatura: ${dateLabel(dueDate)} · data sugerida para CUSTOS ANO` : 'Vencimento não identificado; a data da compra será usada como alternativa.'}</small><small>{nextClosingDate ? `Próximo fechamento previsto: ${dateLabel(nextClosingDate)}` : 'Fechamento não informado.'}</small></div>{status === 'CARD_MATCHED' && match.sheet && <small>Planilha: {dateLabel(match.sheet.date)} · {match.sheet.originalDescription} · {formatCents(match.sheet.amount)} · Forma de pagamento: {match.sheet.paymentMethod}</small>}{(status === 'CARD_REVIEW' || status === 'CARD_GROUP_MATCHED') && candidates.map((candidate) => <div className="statement-candidate" key={candidate.id}><small>CUSTOS ANO: {dateLabel(candidate.date)} · {candidate.originalDescription} · {formatCents(candidate.amount)} · Forma de pagamento: {candidate.paymentMethod}</small>{status === 'CARD_REVIEW' && <button className="text-button" onClick={() => onConfirm(transaction.id, candidate.id)}>Usar este lançamento</button>}</div>)}{status === 'CARD_REVIEW' && candidates.length > 0 && <div className="statement-reject-candidates"><button className="text-button" onClick={() => onRejectCandidates(transaction.id, candidates.map((candidate) => candidate.id))}>Nenhum desses — está ausente</button><small>Use esta opção se nenhum lançamento acima corresponder a esta compra.</small></div>}{match.evidence && <div className="statement-match-evidence" aria-label="Evidências do matching">{match.evidence.map((item) => <small key={item}>{auditFocus ? '★' : '✓'} {item}</small>)}</div>}<span className={`statement-status ${tone}`}>{label}</span>{addDecision.eligible && <button className="text-button" onClick={() => onAddMissing(match)}>Adicionar à CUSTOS ANO</button>}{status === 'CARD_MISSING' && <button className="text-button" onClick={() => onIgnore(transaction.id)}>Ignorar</button>}{confirmedPreviously && match.sheet && <button className="text-button" onClick={() => onUndo('STATEMENT_MATCH_CONFIRMED', [identity])}>Desfazer confirmação</button>}</div><strong className="activity-amount">{formatCents(transaction.direction === 'CREDIT' ? -transaction.amount : transaction.amount)}</strong></article>
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
  const [expanded, setExpanded] = useState(item.compositionStatus !== 'MATCHED')
  useEffect(() => setExpanded(item.compositionStatus !== 'MATCHED'), [item.compositionStatus])
  const selectedIndex = selected != null && selected < options.length ? selected : options.length === 1 ? 0 : null
  const displayed = selectedIndex == null ? null : options[selectedIndex]
  const summary = item.cardSummary
  const title = item.compositionStatus === 'MATCHED' ? 'Liquidação da fatura' : item.compositionStatus === 'NO_MATCH' ? 'Nenhuma composição exata encontrada' : item.compositionStatus === 'LIMITED' ? 'Busca de composição incompleta' : 'Revisão de fatura'
  const status = item.compositionStatus === 'MATCHED' ? 'Composição confirmada' : item.compositionStatus === 'LIMITED' ? 'Busca incompleta' : item.compositionStatus === 'NO_MATCH' ? 'Diferença de fatura' : 'Revisão necessária'
  return <article className="review-card card-payment-card">
    <div className="review-card-title"><span className="status-icon blue">◈</span><div><span className="step-label">{item.compositionStatus === 'MATCHED' ? 'PAGAMENTO DE CARTÃO CONCILIADO' : 'DIVERGÊNCIA DE FATURA'}</span><h2>{title}</h2></div><button className="button button-outline button-small card-payment-toggle" aria-expanded={expanded} onClick={() => setExpanded((value) => !value)}>{expanded ? 'Recolher detalhes' : 'Ver detalhes'}</button><span className="confidence">{status}</span></div>
    {expanded && <div className="card-payment-details"><div className="comparison-grid"><TransactionBox label="BANCO" transaction={item.bank}/><span className="compare-arrow">→</span><div className="transaction-box"><span className="step-label">COMPOSIÇÃO Crédito_Bradesco</span>{displayed?.items.length ? <><div className="card-composition-list">{displayed.items.map((sheet) => <div className="card-composition-row" key={sheet.id}><span>{dateLabel(sheet.date)} · {sheet.originalDescription}<small>{sheet.paymentMethod}</small></span><strong>{formatCents(sheet.amount)}</strong></div>)}</div><div className="card-composition-total"><span>TOTAL DA COMPOSIÇÃO</span><strong>{formatCents(displayed.items.reduce((sum, sheet) => sum + sheet.amount, 0))}</strong></div></> : <span className="no-candidate">Nenhuma composição exata está pronta para confirmação.</span>}</div></div>
      {summary && <CardSummaryNotice item={item}/>}
      {options.length > 1 && <fieldset className="composition-options"><legend>Alternativas exatas, ordenadas por plausibilidade. Escolha uma para confirmar:</legend>{options.map((option, index) => <label className="composition-option" key={canonicalCompositionKey(option.items)}><input type="radio" name={`composition-${item.bank.id}`} checked={selectedIndex === index} onChange={() => setSelected(index)}/><span><strong>Opção {index + 1} · {option.items.length} lançamentos · {formatCents(option.items.reduce((sum, sheet) => sum + sheet.amount, 0))}</strong><small>Plausibilidade {option.score}/100 · {option.reasons.join(' · ')}</small></span></label>)}</fieldset>}
      {item.compositionStatus === 'MATCHED' && <div className="match-reasons"><span><b>✓</b> Soma exata em centavos</span><span><b>✓</b> Vínculo confirmado; itens bloqueados para outras faturas</span>{persisted && <span><b>✓</b> Decisão salva neste dispositivo</span>}</div>}
      {item.compositionStatus === 'LIMITED' && <div className="match-reasons"><span>ℹ A busca atingiu um limite de complexidade. As sugestões são parciais e a composição não pôde ser determinada com segurança.</span></div>}
      <div className="review-actions">{item.compositionStatus === 'MATCHED' ? <button className="button button-outline" onClick={onUndo}>Desfazer confirmação</button> : <button className="button button-primary" disabled={!displayed} onClick={() => displayed && onConfirm(displayed.items.map((sheet) => sheet.sheetRecordId || sheet.id))}>✓ Confirmar composição</button>}<button className="button button-outline" onClick={onIgnore}>Ignorar</button></div>
    </div>}
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
