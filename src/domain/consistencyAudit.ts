import type { BankRefundGroup, BankTransaction, CardStatement, CardStatementMatch, CardStatementTransaction, LedgerTransaction, ReconciliationItem } from './types'
import type { PersistedDecision } from './localDecisions'
import { auditPersistedDecisions, type DecisionAudit } from './decisionAudit'
import { bankIdentity, cardReviewCandidateIdentity, cardTransactionIdentity, cardTransactionIdentityVariants, sheetIdentity, stableFingerprint } from './identity'
import { deriveCardPurchaseStatus, explainCostYearCandidateRejection, findExistingCostYearCandidates, reconcileCardStatement } from '../importers/cardStatement'
import { canAddMissingToCostYear } from '../features/missingEligibility'
import { classifySheetRecord, normalizeDescription, transactionType } from '../importers/normalize'
import { diagnoseMissingCounterDivergence } from './sourceLifecycle'
import { AUDIT_CODE_LIFECYCLE, describeAuditFinding } from './auditFindingPresentation'
import { findPlausibleLedgerCandidates, pairKey, reconcile } from '../matching/reconcile'
import { conflictingStatementAssignments, resolveStatementMatchAssignments } from './statementMatchAssignments'
import type { AuditInputSnapshot } from './auditInputSnapshot'
import { deriveExpectedReconciliationState, type ExpectedStateExplanationStep } from './expectedReconciliationState'

export type AuditCode = 'MISSING_COM_CANDIDATO' | 'MISSING_WITH_STRONG_CANDIDATE' | 'EXPECTED_MANUAL_REJECTION' | 'CARD_MISSING_NO_CANDIDATE' | 'DERIVED_STATE_MISMATCH' | 'EXPECTED_OVERRIDE' | 'EXPECTED_GROUP_RESOLUTION' | 'EXPECTED_MANUAL_RESERVATION' | 'PREWRITE_MATCH_MISMATCH' | 'STALE_MISSING_DECISION' | 'ORPHANED_SHEET_REFERENCE' | 'EDITED_SHEET_REFERENCE' | 'MISSING_ADDED_TO_SHEET_ORPHAN' | 'DOUBLE_CLAIM' | 'DOUBLE_CLAIM_AFTER_CONFIRMATION' | 'MULTIPLE_INCOMPATIBLE_ACTIVE_DECISIONS' | 'RESERVED_SHEET_ROW_REUSED' | 'VALID_MANUAL_MATCH_NOT_APPLIED' | 'VALID_BANK_MANUAL_MATCH_NOT_APPLIED' | 'PAIR_CONFIRMED_ASSIGNMENT_CONFLICT' | 'INVALID_DECISION_APPLIED' | 'STALE_DECISION_RESULT' | 'AUDIT_INPUT_REVISION_MISMATCH' | 'AUDITOR_INTERNAL_INCONSISTENCY' | 'MISSING_ACTION_INCONSISTENCY' | 'CARD_PAYMENT_AS_EXPENSE_MISSING' | 'UNUSED_STRONG_CANDIDATE' | 'LEGACY_FINGERPRINT_MATCH' | 'LOCAL_REMOTE_DECISION_DIVERGENCE' | 'NEWER_TOMBSTONE_EXISTS' | 'WRONG_DECISION_DOMAIN' | 'REVIEW_ONLY_WRONG_CYCLE_CANDIDATES' | 'IGNORED_DECISION_REVIEW' | 'CURRENT_SOURCE_DIVERGENCE' | 'REJECTED_CANDIDATE_FILTERED' | 'SYNC_PENDING' | 'REVIEW_WITHOUT_CANDIDATES' | 'ASSIGNMENT_CONFLICT' | 'REFUNDED_BUT_MISSING' | 'DUPLICATE_BANK_TRANSACTION_ACROSS_STATEMENTS' | 'STALE_ACTIVE_SOURCE' | 'MISSING_COUNT_DIVERGENCE' | 'DUPLICATE_PRESENT_BUT_MARKED_MISSING' | 'INVOICE_TOTAL_MISMATCH' | 'CARD_SUBTOTAL_MISMATCH' | 'REFUND_NET_MISMATCH' | 'RESOLVED_SOURCE_OVERLAP' | 'MATCHED_WITHOUT_LINK' | 'ACTIVE_ENTITY_WITHOUT_SOURCE' | 'SOURCE_POINTS_TO_MISSING_ENTITY' | 'SOURCE_CONFLICT'
export type AuditSeverity = 'CRITICAL' | 'REVIEW' | 'INFO'
export type AuditMode = 'RAPIDA' | 'PROFUNDA'
export type AuditCategory = 'SOURCE' | 'IDENTITY' | 'STATE' | 'DECISION' | 'FINANCIAL'
export type AuditExplanationSource = 'NONE' | 'MANUAL_DECISION' | 'GROUP_MATCHING' | 'REFUND' | 'SOURCE_LIFECYCLE' | 'IGNORE' | 'TOMBSTONE' | 'SYNC' | 'ASSIGNMENT' | 'OTHER'
export type DiagnosticConfidence = 'HIGH' | 'MEDIUM' | 'LOW'
export type ConfidenceEvidence = { identityQuality: 'CANONICAL' | 'HEURISTIC' | 'INCOMPLETE'; sourceCoverage: string; revisionComparable: boolean; evidenceCount: number; validDecision: boolean; targetCanonical: boolean }
export type DecisionDomain = 'bank-reconciliation' | 'sheet-bank-reconciliation' | 'card-payment-composition' | 'pdf-card-purchase' | 'bank-missing-sheet-record'
export const DECISION_DOMAIN: Record<PersistedDecision['kind'], DecisionDomain> = {
  PAIR_CONFIRMED: 'bank-reconciliation', PAIR_REJECTED: 'bank-reconciliation', BANK_IGNORED: 'bank-reconciliation',
  SHEET_IGNORED: 'sheet-bank-reconciliation', COMPOSITION_CONFIRMED: 'card-payment-composition',
  STATEMENT_MATCH_CONFIRMED: 'pdf-card-purchase', CARD_MISSING_CONFIRMED: 'pdf-card-purchase',
  CARD_PURCHASE_IGNORED: 'pdf-card-purchase', CARD_REVIEW_REJECTED_CANDIDATES: 'pdf-card-purchase',
  MISSING_ADDED_TO_SHEET: 'bank-missing-sheet-record',
}
export type AuditDecisionStatus = DecisionAudit['status'] | 'CONFLICTING' | 'LEGACY_BUT_RESOLVABLE'
export type DecisionValidity = 'VALID_STRUCTURALLY' | 'VALID_GLOBALLY' | 'INVALID_TARGET' | 'TOMBSTONED' | 'CONFLICTING_ACTIVE_DECISION' | 'RESERVED_TARGET_CONFLICT' | 'NEEDS_REVIEW'
export type AuditDecision = { decision: PersistedDecision; status: AuditDecisionStatus; source: 'LOCAL' | 'REMOTE' | 'TOMBSTONE'; explanation: string; structurallyValid: boolean; validity: DecisionValidity }
export type AuditedCardItem = {
  statement: CardStatement
  transaction: CardStatementTransaction
  pure: CardStatementMatch
  current: CardStatementMatch | null
  expectedState: CardStatementMatch | null
  explanationChain: ExpectedStateExplanationStep[]
  candidates: LedgerTransaction[]
  fingerprint: string
  aliases: string[]
  decisions: AuditDecision[]
  discarded: { row: LedgerTransaction; reason: string }[]
  evaluatedCandidates: { row: LedgerTransaction; source: 'FONTE DA ANÁLISE' | 'CACHE DA SESSÃO'; accepted: boolean; reason: string | null }[]
  claimedBy: string[]
  diagnosis: string
}
export type AppliedDecision = { decisionKey: string; subjectFingerprint: string; appliedDomain: DecisionDomain }
export type AuditFinding = {
  id: string; code: AuditCode; severity: AuditSeverity; category: AuditCategory; invariantId: string
  title: string; detail: string; diagnosis: string; whyItMatters: string; recommendedAction: string
  diagnosticConfidence: DiagnosticConfidence; safeAutomaticAction: boolean; automaticActionType?: string
  status: 'ACTIVE' | 'EXPECTED' | 'MAINTENANCE' | 'LEGACY'; currentState?: string; expectedState?: string; pureState?: string
  explanationSource: AuditExplanationSource; item?: AuditedCardItem; technical?: Record<string, unknown>
  role?: 'PRIMARY' | 'RELATED' | 'EXPECTED' | 'INFO'
  rootCauseCode?: string
  rootCauseKey?: string
  primaryFindingId?: string
  impact?: string
  confidenceEvidence?: ConfidenceEvidence
  explanationChain?: ExpectedStateExplanationStep[]
  relatedFindings?: { id?: string; code: AuditCode; title: string; detail: string; impact?: string; technical?: Record<string, unknown>; role?: 'RELATED' | 'EXPECTED' | 'INFO'; rootCauseKey?: string }[]
}
type RawAuditFinding = Omit<AuditFinding, 'category' | 'invariantId' | 'diagnosis' | 'whyItMatters' | 'recommendedAction' | 'diagnosticConfidence' | 'safeAutomaticAction' | 'status' | 'explanationSource' | 'role' | 'rootCauseCode' | 'rootCauseKey' | 'impact' | 'confidenceEvidence'> & Partial<Pick<AuditFinding, 'category' | 'invariantId' | 'diagnosis' | 'whyItMatters' | 'recommendedAction' | 'diagnosticConfidence' | 'safeAutomaticAction' | 'automaticActionType' | 'status' | 'currentState' | 'expectedState' | 'pureState' | 'explanationSource' | 'role' | 'rootCauseCode' | 'rootCauseKey' | 'primaryFindingId' | 'impact' | 'confidenceEvidence'>>
export type ConsistencyAuditInput = {
  mode?: AuditMode
  banks: BankTransaction[]
  /** Original parsed rows by source, used only to detect contradictory representations of one movement. */
  bankSourceRows?: { sourceId: string; sourceName?: string; transactions: BankTransaction[] }[]
  sheets: LedgerTransaction[]
  statements: { statement: CardStatement; legacyStatementIdentity?: string }[]
  currentCardMatches: { statementIdentity: string; transactionId: string; match: CardStatementMatch }[]
  currentSheets?: LedgerTransaction[]
  localDecisions: PersistedDecision[]
  remoteDecisions?: PersistedDecision[]
  remoteTombstones?: PersistedDecision[]
  localTombstones?: Record<string, { updatedAt: string; decision: PersistedDecision }>
  appliedDecisions?: AppliedDecision[]
  onlySubjectFingerprints?: string[]
  currentBankItems?: ReconciliationItem[]
  currentDecisionRevision?: string
  derivedDecisionRevision?: string
  missingActionVisibility?: Record<string, boolean>
  bankRefundGroups?: BankRefundGroup[]
  missingCounterCollections?: { source: string; items: ReconciliationItem[] }[]
  activeDriveSourceIds?: string[]
  currentDriveSourceIds?: string[]
  missingDriveSourceIds?: string[]
  duplicateInvoiceSources?: { identity: string; sourceIds: string[] }[]
  sourceProvenance?: { sourceId: string; entityIds: string[] }[]
  auditInputSnapshot?: AuditInputSnapshot
}
export type InvariantExecutionStatus = 'EXECUTED_PASS' | 'EXECUTED_FAIL' | 'NOT_APPLICABLE' | 'UNAVAILABLE' | 'SKIPPED_DUE_TO_REVISION'
export type InvariantExecution = { invariantId: string; status: InvariantExecutionStatus; subjectsEvaluated: number; sourcesRequired: string[]; sourcesAvailable: string[]; reason?: string; findingIds: string[] }
export type AuditSelfCheck = { checkId: string; status: 'PASS' | 'FAIL' | 'NOT_APPLICABLE'; findingIds: string[]; detail?: string }
export type AuditSummary = { critical: number; review: number; maintenance: number; legacy: number; informational: number; attention: number; evaluatedPurchases: number; validatedInvariants: number }
export type ConsistencyAuditResult = { mode: AuditMode; recomputation: { performed: boolean; readOnly: true; persistedDecisionsApplied: false }; findings: AuditFinding[]; items: AuditedCardItem[]; decisionAudit: AuditDecision[]; auditedAt: string; pureStates: Record<string, string>; currentStates: Record<string, string>; expectedStates: Record<string, ReturnType<typeof deriveExpectedReconciliationState>>; summary: AuditSummary; invariantExecutions: InvariantExecution[]; auditSelfChecks: AuditSelfCheck[]; performance: { totalMs: number; expectedStateDerivationMs: number; invariantChecksMs: number }; auditInputSnapshot?: AuditInputSnapshot }

export function calculateDiagnosticConfidence(evidence: ConfidenceEvidence): DiagnosticConfidence {
  if (!evidence.revisionComparable || evidence.sourceCoverage === 'PARTIAL' || evidence.identityQuality === 'INCOMPLETE') return 'LOW'
  if (evidence.identityQuality === 'CANONICAL' && evidence.evidenceCount >= 2 && (evidence.validDecision || evidence.targetCanonical || evidence.evidenceCount >= 4)) return 'HIGH'
  return evidence.evidenceCount > 0 ? 'MEDIUM' : 'LOW'
}

export function derivedMismatchSeverity(pure: CardStatementMatch['status'], current: CardStatementMatch['status'], canAppend: boolean): AuditSeverity {
  if ((pure === 'CARD_MATCHED' || pure === 'CARD_GROUP_MATCHED') && current === 'CARD_MISSING') return 'CRITICAL'
  if (pure === 'CARD_MISSING' && (current === 'CARD_MATCHED' || current === 'CARD_GROUP_MATCHED')) return 'CRITICAL'
  if (pure === 'CARD_REVIEW' && current === 'CARD_MISSING' && canAppend) return 'CRITICAL'
  if (pure === 'CARD_REVIEW' && current === 'CARD_GROUP_MATCHED') return 'INFO'
  if (pure === 'CARD_MATCHED' && current === 'CARD_REVIEW') return 'REVIEW'
  return 'REVIEW'
}

const statusName = (status: CardStatementMatch['status'] | undefined) => status ?? 'UNAVAILABLE'
const isCardPurchaseDecision = (decision: PersistedDecision) => ['STATEMENT_MATCH_CONFIRMED', 'CARD_MISSING_CONFIRMED', 'CARD_PURCHASE_IGNORED', 'CARD_REVIEW_REJECTED_CANDIDATES', 'MISSING_ADDED_TO_SHEET'].includes(decision.kind)
const sheetReference = (decision: PersistedDecision) => decision.selected[0] ?? (decision.kind === 'CARD_REVIEW_REJECTED_CANDIDATES' ? decision.selected[0] : undefined)

type DecisionSnapshot = { decision: PersistedDecision; state: 'ACTIVE' | 'DELETED'; source: 'LOCAL' | 'REMOTE' }
type DecisionMergeAudit = { effective: DecisionSnapshot[]; conflicts: { key: string; local: DecisionSnapshot; remote: DecisionSnapshot; reason: string }[]; pendingLocalUpdate: string[]; pendingRemoteUpdate: string[] }

const decisionPayload = ({ decision, state }: DecisionSnapshot) => JSON.stringify({ kind: decision.kind, identities: decision.identities, selected: decision.selected, state })
const validDecisionSnapshot = ({ decision }: DecisionSnapshot) => decision.key === `${decision.kind}:${JSON.stringify(decision.identities)}`

/** Mirrors deterministic sync precedence: newest timestamp wins; remote wins ties; tombstone is a versioned state. */
export function auditDecisionMerge(input: Pick<ConsistencyAuditInput, 'localDecisions' | 'remoteDecisions' | 'remoteTombstones' | 'localTombstones'>): DecisionMergeAudit {
  const local = new Map<string, DecisionSnapshot>()
  const remote = new Map<string, DecisionSnapshot>()
  input.localDecisions.forEach((decision) => local.set(decision.key, { decision, state: 'ACTIVE', source: 'LOCAL' }))
  Object.entries(input.localTombstones ?? {}).forEach(([key, entry]) => local.set(key, { decision: { ...entry.decision, updatedAt: entry.updatedAt }, state: 'DELETED', source: 'LOCAL' }))
  ;(input.remoteDecisions ?? []).forEach((decision) => remote.set(decision.key, { decision, state: 'ACTIVE', source: 'REMOTE' }))
  ;(input.remoteTombstones ?? []).forEach((decision) => remote.set(decision.key, { decision, state: 'DELETED', source: 'REMOTE' }))
  const conflicts: DecisionMergeAudit['conflicts'] = [], pendingLocalUpdate: string[] = [], pendingRemoteUpdate: string[] = [], effective: DecisionSnapshot[] = []
  for (const key of new Set([...local.keys(), ...remote.keys()])) {
    const left = local.get(key), right = remote.get(key)
    if (!left || !right) { const only = left ?? right; if (only) effective.push(only); continue }
    if (!validDecisionSnapshot(left) || !validDecisionSnapshot(right)) {
      conflicts.push({ key, local: left, remote: right, reason: 'decisionId/key não corresponde ao payload de decisão' })
      continue
    }
    const leftTime = Date.parse(left.decision.updatedAt), rightTime = Date.parse(right.decision.updatedAt)
    const samePayload = decisionPayload(left) === decisionPayload(right)
    if ((!Number.isFinite(leftTime) || !Number.isFinite(rightTime)) && !samePayload) {
      conflicts.push({ key, local: left, remote: right, reason: 'timestamps inválidos impedem escolher com segurança entre payloads diferentes' })
      continue
    }
    const winner = !Number.isFinite(leftTime) ? right : !Number.isFinite(rightTime) ? left : leftTime > rightTime ? left : rightTime > leftTime ? right : right
    effective.push(winner)
    if (winner.source === 'REMOTE' && (!samePayload || left.decision.updatedAt !== right.decision.updatedAt)) pendingLocalUpdate.push(key)
    if (winner.source === 'LOCAL' && (!samePayload || left.decision.updatedAt !== right.decision.updatedAt)) pendingRemoteUpdate.push(key)
  }
  return { effective, conflicts, pendingLocalUpdate, pendingRemoteUpdate }
}

export function summarizeAudit(findings: AuditFinding[], items: AuditedCardItem[], evaluatedPurchases = items.length, _mode: AuditMode = 'PROFUNDA', invariantExecutions: InvariantExecution[] = []): AuditSummary {
  const topLevel = findings.filter((finding) => finding.role !== 'RELATED')
  const rootKey = (finding: AuditFinding) => finding.rootCauseKey ?? finding.id
  const uniqueCount = (severities: AuditSeverity[]) => new Set(topLevel.filter((finding) => severities.includes(finding.severity)).map(rootKey)).size
  const critical = uniqueCount(['CRITICAL']), review = uniqueCount(['REVIEW'])
  const uniqueStatus = (status: AuditFinding['status']) => new Set(topLevel.filter((finding) => finding.status === status).map(rootKey)).size
  return { critical, review, maintenance: uniqueStatus('MAINTENANCE'), legacy: uniqueStatus('LEGACY'), informational: uniqueCount(['INFO']), attention: new Set(topLevel.filter((finding) => finding.severity === 'CRITICAL' || finding.severity === 'REVIEW').map(rootKey)).size, evaluatedPurchases, validatedInvariants: invariantExecutions.filter((execution) => execution.status === 'EXECUTED_PASS').length }
}

const invariantSources: Record<string, string[]> = {
  'INV-01': ['bank', 'custosAno', 'cardStatements', 'currentBankResults', 'currentCardResults'], 'INV-02': ['bank', 'custosAno', 'cardStatements', 'currentBankResults', 'currentCardResults'],
  'INV-03': ['bank', 'custosAno', 'currentBankResults'], 'INV-04': ['cardStatements', 'custosAno', 'currentCardResults'], 'INV-05': ['bank', 'cardStatements', 'currentBankResults'],
  'INV-06': ['cardStatements', 'currentCardResults'], 'INV-07': ['drive'], 'INV-08': ['decisions', 'bank', 'custosAno', 'cardStatements', 'currentBankResults', 'currentCardResults'],
  'INV-09': ['bank', 'currentBankResults'], 'INV-10': ['bank', 'drive'], 'INV-11': ['decisions', 'cardStatements', 'bank', 'currentBankResults', 'currentCardResults'],
  'INV-12': ['cardStatements', 'custosAno', 'currentCardResults'], 'INV-13': ['cardStatements', 'currentCardResults'], 'INV-14': ['drive'],
}
const unavailableAliases: Record<string, string[]> = {
  bank: ['bank', 'bank-source', 'bank-statements'], custosAno: ['custosAno', 'costs-year', 'google-current-ledger'],
  cardStatements: ['cardStatements', 'statements', 'pdf-statements'], decisions: ['decisions', 'remote-decisions', 'decision-snapshot'], drive: ['drive', 'drive-live-listing'],
  currentBankResults: ['currentBankResults', 'current-bank-results', 'bank-derived-result'], currentCardResults: ['currentCardResults', 'current-card-results', 'statement-derived-result'],
}
const invariantApplicable = (id: string, input: ConsistencyAuditInput, mode: AuditMode) => {
  if (mode === 'RAPIDA' && ['INV-04', 'INV-05', 'INV-06', 'INV-12', 'INV-13'].includes(id)) return false
  switch (id) {
    case 'INV-01': case 'INV-02': return input.banks.length + input.statements.reduce((n, entry) => n + entry.statement.transactions.length, 0) > 0
    case 'INV-03': case 'INV-09': return input.banks.length > 0
    case 'INV-04': case 'INV-05': case 'INV-06': case 'INV-12': case 'INV-13': return input.statements.length > 0
    case 'INV-07': case 'INV-14': return Boolean(input.activeDriveSourceIds?.length || input.currentDriveSourceIds?.length || input.sourceProvenance?.length || input.duplicateInvoiceSources?.length)
    case 'INV-08': return Boolean(input.localDecisions.length + (input.remoteDecisions?.length ?? 0) + Object.keys(input.localTombstones ?? {}).length > 0 || input.currentBankItems?.length || input.currentCardMatches.length > 0)
    case 'INV-10': return Boolean(input.bankSourceRows?.length || input.sourceProvenance?.length)
    case 'INV-11': return Boolean(input.currentCardMatches.length || input.currentBankItems?.length || input.localDecisions.length || input.remoteDecisions?.length)
    default: return false
  }
}
export function evaluateInvariantExecutions(input: ConsistencyAuditInput, findings: AuditFinding[], mode = input.mode ?? 'PROFUNDA'): InvariantExecution[] {
  const ids = ['INV-01', 'INV-02', 'INV-03', 'INV-04', 'INV-05', 'INV-06', 'INV-07', ...(mode === 'PROFUNDA' ? ['INV-08'] : []), 'INV-09', 'INV-10', 'INV-11', 'INV-12', 'INV-13', 'INV-14']
  return ids.map((invariantId) => {
    const sourcesRequired = invariantSources[invariantId] ?? []
    const unavailable = input.auditInputSnapshot?.unavailableSources ?? []
    const cardSubjects = input.statements.reduce((count, entry) => count + entry.statement.transactions.filter((transaction) => transaction.type === 'PURCHASE' && transaction.financialStatus !== 'REFUNDED').length, 0)
    const observedUnavailable: string[] = []
    if (input.banks.length > 0 && input.currentBankItems == null) observedUnavailable.push('currentBankResults')
    if (cardSubjects > 0 && input.currentCardMatches.length < cardSubjects) observedUnavailable.push('currentCardResults')
    const missingSources = sourcesRequired.filter((source) => observedUnavailable.includes(source) || unavailableAliases[source].some((alias) => unavailable.includes(alias)))
    const mixed = input.auditInputSnapshot?.mixedRevisionSources ?? []
    const revisionConflict = mixed.length > 0 && (mixed.some((source) => source.includes('decision') && sourcesRequired.includes('decisions') || source.includes('source') && (sourcesRequired.includes('bank') || sourcesRequired.includes('custosAno') || sourcesRequired.includes('cardStatements'))))
    const available = sourcesRequired.filter((source) => !missingSources.includes(source))
    const relatedFindings = findings.filter((finding) => finding.invariantId === invariantId)
    const subjectsEvaluated = invariantId === 'INV-03' || invariantId === 'INV-09'
      ? input.banks.length
      : ['INV-04', 'INV-05', 'INV-06', 'INV-12', 'INV-13'].includes(invariantId)
        ? input.statements.reduce((n, entry) => n + entry.statement.transactions.length, 0)
        : invariantId === 'INV-07' || invariantId === 'INV-10' || invariantId === 'INV-14'
          ? input.sourceProvenance?.length ?? input.activeDriveSourceIds?.length ?? 0
          : input.currentBankItems?.length ?? input.currentCardMatches.length
    const applicable = invariantApplicable(invariantId, input, mode)
    const status: InvariantExecutionStatus = !applicable ? 'NOT_APPLICABLE'
      : revisionConflict ? 'SKIPPED_DUE_TO_REVISION'
        : missingSources.length ? 'UNAVAILABLE'
          : relatedFindings.some((finding) => finding.severity === 'CRITICAL' || finding.severity === 'REVIEW') ? 'EXECUTED_FAIL'
            : 'EXECUTED_PASS'
    const reason = status === 'NOT_APPLICABLE' ? 'Não há subjects/fontes para executar esta verificação.'
      : status === 'SKIPPED_DUE_TO_REVISION' ? `Fontes não comparáveis nesta execução: ${mixed.join(', ')}.`
        : status === 'UNAVAILABLE' ? `Fonte(s) necessária(s) indisponível(is): ${missingSources.join(', ')}.` : undefined
    return { invariantId, status, subjectsEvaluated, sourcesRequired, sourcesAvailable: available, ...(reason ? { reason } : {}), findingIds: relatedFindings.map((finding) => finding.id) }
  })
}

const invariantByCode: Partial<Record<AuditCode, string>> = {
  DOUBLE_CLAIM: 'INV-01', DOUBLE_CLAIM_AFTER_CONFIRMATION: 'INV-02', ORPHANED_SHEET_REFERENCE: 'INV-02', EDITED_SHEET_REFERENCE: 'INV-02',
  MISSING_COM_CANDIDATO: 'INV-03', MISSING_WITH_STRONG_CANDIDATE: 'INV-03', ASSIGNMENT_CONFLICT: 'INV-03', REVIEW_WITHOUT_CANDIDATES: 'INV-03', EXPECTED_MANUAL_RESERVATION: 'INV-08', MULTIPLE_INCOMPATIBLE_ACTIVE_DECISIONS: 'INV-08', RESERVED_SHEET_ROW_REUSED: 'INV-08',
  MISSING_ACTION_INCONSISTENCY: 'INV-04', CARD_PAYMENT_AS_EXPENSE_MISSING: 'INV-05', REFUNDED_BUT_MISSING: 'INV-06', STALE_ACTIVE_SOURCE: 'INV-07',
  DERIVED_STATE_MISMATCH: 'INV-08', MATCHED_WITHOUT_LINK: 'INV-08', VALID_MANUAL_MATCH_NOT_APPLIED: 'INV-11', VALID_BANK_MANUAL_MATCH_NOT_APPLIED: 'INV-11', PAIR_CONFIRMED_ASSIGNMENT_CONFLICT: 'INV-08', INVALID_DECISION_APPLIED: 'INV-08', STALE_DECISION_RESULT: 'INV-11', MISSING_COUNT_DIVERGENCE: 'INV-09', DUPLICATE_BANK_TRANSACTION_ACROSS_STATEMENTS: 'INV-10',
  INVOICE_TOTAL_MISMATCH: 'INV-13', CARD_SUBTOTAL_MISMATCH: 'INV-13', REFUND_NET_MISMATCH: 'INV-06', RESOLVED_SOURCE_OVERLAP: 'INV-10',
  CARD_MISSING_NO_CANDIDATE: 'INV-12', DUPLICATE_PRESENT_BUT_MARKED_MISSING: 'INV-14',
  ACTIVE_ENTITY_WITHOUT_SOURCE: 'INV-07', SOURCE_POINTS_TO_MISSING_ENTITY: 'INV-07',
  SOURCE_CONFLICT: 'INV-07',
}
const categoryForCode = (code: AuditCode): AuditCategory => {
  if (/SOURCE|DRIVE|INVOICE_SOURCE/.test(code)) return 'SOURCE'
  if (/DUPLICATE|FITID|OVERLAP|DEDUP/.test(code)) return 'IDENTITY'
  if (/DECISION|TOMBSTONE|FINGERPRINT|SYNC|DOUBLE_CLAIM|WRONG_DECISION_DOMAIN|RESERVED_SHEET_ROW_REUSED|EXPECTED_MANUAL_RESERVATION/.test(code)) return 'DECISION'
  if (/REFUND|INVOICE|SUBTOTAL|BALANCE|PAYMENT|COUNT/.test(code)) return 'FINANCIAL'
  return 'STATE'
}
const explanationFor = (finding: RawAuditFinding): AuditExplanationSource => {
  if (finding.technical?.pipeline) return 'GROUP_MATCHING'
  if (finding.technical?.validManualConfirmation) return 'MANUAL_DECISION'
  if (/REFUND/.test(finding.code)) return 'REFUND'
  if (/STALE_ACTIVE_SOURCE|DUPLICATE_PRESENT_BUT_MARKED_MISSING/.test(finding.code)) return 'SOURCE_LIFECYCLE'
  if (/IGNORED/.test(finding.code)) return 'IGNORE'
  if (/TOMBSTONE/.test(finding.code)) return 'TOMBSTONE'
  if (/SYNC|DECISION/.test(finding.code)) return 'SYNC'
  if (/ASSIGNMENT_CONFLICT/.test(finding.code)) return 'ASSIGNMENT'
  return 'NONE'
}
function enrichFinding(finding: RawAuditFinding): AuditFinding {
  const message = describeAuditFinding(finding as AuditFinding)
  const explanationSource = finding.explanationSource ?? explanationFor(finding)
  const status: AuditFinding['status'] = finding.status ?? (AUDIT_CODE_LIFECYCLE[finding.code] === 'legacy' || finding.code === 'LEGACY_FINGERPRINT_MATCH' ? 'LEGACY' : finding.code === 'ORPHANED_SHEET_REFERENCE' && finding.severity === 'INFO' || finding.code === 'EDITED_SHEET_REFERENCE' && finding.severity === 'INFO' ? 'MAINTENANCE' : explanationSource !== 'NONE' && finding.severity === 'INFO' ? 'EXPECTED' : 'ACTIVE')
  const category = finding.category ?? categoryForCode(finding.code)
  const invariantId = finding.invariantId ?? invariantByCode[finding.code] ?? (category === 'SOURCE' ? 'INV-07' : category === 'IDENTITY' ? 'INV-14' : category === 'FINANCIAL' ? 'INV-13' : category === 'DECISION' ? 'INV-08' : 'INV-03')
  const technical = finding.technical ?? {}
  const currentState = finding.currentState ?? (finding.item?.current?.status ?? (typeof technical.currentStatus === 'string' ? technical.currentStatus : typeof technical.status === 'string' ? technical.status : undefined))
  const pureState = finding.pureState ?? (finding.item?.pure?.status ?? (typeof technical.pure === 'string' ? technical.pure : undefined))
  const expectedState = finding.expectedState ?? finding.item?.expectedState?.status ?? (finding.code.includes('REFUND') && finding.code.includes('MISSING') ? 'REFUNDED' : typeof technical.expectedState === 'string' ? technical.expectedState : typeof technical.expectedStatus === 'string' ? technical.expectedStatus : currentState)
  const subject = finding.item?.fingerprint ?? String(technical.subjectFingerprint ?? technical.transactionId ?? technical.bankTransactionId ?? technical.decisionKey ?? finding.id)
  const target = String((technical.row as Record<string, unknown> | undefined)?.sheetIdentity ?? (technical.row as Record<string, unknown> | undefined)?.id ?? (technical.sheet as Record<string, unknown> | undefined)?.sheetRecordId ?? '')
  const rootCauseCode = finding.rootCauseCode ?? (['ASSIGNMENT_CONFLICT', 'UNUSED_STRONG_CANDIDATE', 'MISSING_COM_CANDIDATO', 'MISSING_WITH_STRONG_CANDIDATE', 'MISSING_ACTION_INCONSISTENCY'].includes(finding.code) ? 'RECONCILIATION_ASSIGNMENT' : ['DOUBLE_CLAIM', 'DOUBLE_CLAIM_AFTER_CONFIRMATION', 'RESERVED_SHEET_ROW_REUSED'].includes(finding.code) ? 'SHEET_ROW_MULTIPLE_OWNERS' : finding.code)
  const rootCauseKey = finding.rootCauseKey ?? `${rootCauseCode}:${target || subject}`
  const role = finding.role ?? (status === 'EXPECTED' ? 'EXPECTED' : finding.severity === 'INFO' ? 'INFO' : finding.code === 'ASSIGNMENT_CONFLICT' || finding.code === 'UNUSED_STRONG_CANDIDATE' ? 'RELATED' : 'PRIMARY')
  const validDecision = technical.validManualConfirmation === true || technical.validity === 'VALID_GLOBALLY' || String(technical.decisionStatus ?? '').startsWith('VALID')
  const evidenceCount = Object.keys(technical).filter((key) => !['message', 'reason', 'status'].includes(key)).length
  const revisionComparable = !['STALE', 'MIXED_REVISION'].includes(finding.item?.statement ? String((technical.auditSnapshot as Record<string, unknown> | undefined)?.state ?? '') : '')
    && !['STALE', 'MIXED_REVISION'].includes(String((technical.auditSnapshot as Record<string, unknown> | undefined)?.state ?? ''))
  const sourceCoverage = String((technical.auditSnapshot as Record<string, unknown> | undefined)?.state ?? 'SNAPSHOT_NOT_ATTACHED')
  const confidenceEvidence: AuditFinding['confidenceEvidence'] = finding.confidenceEvidence ?? {
    identityQuality: finding.item || target || technical.decision ? 'CANONICAL' : Object.keys(technical).length ? 'HEURISTIC' : 'INCOMPLETE',
    sourceCoverage, revisionComparable, evidenceCount, validDecision,
    targetCanonical: Boolean(target || (finding.item?.current?.sheet?.sheetRecordId ?? finding.item?.current?.sheet?.id)),
  }
  const confidence = calculateDiagnosticConfidence(confidenceEvidence)
  const impact = finding.impact ?? finding.whyItMatters ?? message.impact
  const explanationChain = finding.explanationChain ?? finding.item?.explanationChain ?? (() => {
    if (!expectedState && !pureState) return undefined
    const chain: ExpectedStateExplanationStep[] = []
    if (pureState) chain.push({ stage: 'PURE_MATCHING', outcome: pureState })
    const decision = technical.decision as PersistedDecision | undefined
    if (decision || technical.validManualConfirmation === true || finding.code === 'EXPECTED_MANUAL_REJECTION') chain.push({ stage: 'DECISION', outcome: finding.code === 'EXPECTED_MANUAL_REJECTION' ? 'rejeição manual válida aplicada' : 'decisão considerada', ...(decision ? { decisionId: stableFingerprint([decision.key]) } : {}) })
    if (finding.code === 'EXPECTED_MANUAL_RESERVATION' || finding.code === 'ASSIGNMENT_CONFLICT' || finding.code === 'RESERVED_SHEET_ROW_REUSED') chain.push({ stage: 'RESERVATION', outcome: 'linha reservada por outro owner' })
    if (finding.code === 'EXPECTED_GROUP_RESOLUTION' || technical.pipeline) chain.push({ stage: 'GROUP_MATCHING', outcome: String(expectedState ?? 'resolvido em grupo') })
    if (finding.code.includes('REFUND')) chain.push({ stage: 'REFUND', outcome: 'crédito/estorno aplicado uma vez' })
    if (expectedState) chain.push({ stage: 'FINAL_ASSIGNMENT', outcome: expectedState })
    return chain
  })()
  return { ...finding, category, invariantId, diagnosis: finding.diagnosis ?? finding.detail, whyItMatters: impact, impact, recommendedAction: finding.recommendedAction ?? message.recommendedAction, diagnosticConfidence: confidence, confidenceEvidence, role, rootCauseCode, rootCauseKey, ...(explanationChain ? { explanationChain } : {}), safeAutomaticAction: finding.safeAutomaticAction ?? (finding.code === 'REVIEW_WITHOUT_CANDIDATES'), ...(finding.automaticActionType ? { automaticActionType: finding.automaticActionType } : finding.code === 'REVIEW_WITHOUT_CANDIDATES' ? { automaticActionType: 'RECALCULATE_ITEM' } : {}), status, ...(currentState ? { currentState } : {}), ...(expectedState ? { expectedState } : {}), ...(pureState ? { pureState } : {}), explanationSource }
}

const cardStateCodes = new Set<AuditCode>(['MISSING_COM_CANDIDATO', 'CARD_MISSING_NO_CANDIDATE', 'DERIVED_STATE_MISMATCH', 'PREWRITE_MATCH_MISMATCH', 'STALE_MISSING_DECISION', 'ORPHANED_SHEET_REFERENCE', 'EDITED_SHEET_REFERENCE', 'CURRENT_SOURCE_DIVERGENCE', 'REJECTED_CANDIDATE_FILTERED'])
export function deduplicateAuditFindings(findings: RawAuditFinding[]): RawAuditFinding[] {
  const output = new Map<string, RawAuditFinding>()
  for (const finding of findings) {
    const key = finding.item && cardStateCodes.has(finding.code) ? `${finding.item.fingerprint}:card-state` : finding.id
    const previous = output.get(key)
    if (!previous) { output.set(key, finding); continue }
    const priority: Record<AuditSeverity, number> = { CRITICAL: 5, REVIEW: 4, INFO: 1 }
    const primary = priority[finding.severity] > priority[previous.severity] ? finding : previous
    const related = [
      ...(previous.relatedFindings ?? []), { code: previous.code, title: previous.title, detail: previous.detail, impact: previous.impact ?? previous.whyItMatters, ...(previous.technical ? { technical: previous.technical } : {}) },
      ...(finding.relatedFindings ?? []), { code: finding.code, title: finding.title, detail: finding.detail, impact: finding.impact ?? finding.whyItMatters, ...(finding.technical ? { technical: finding.technical } : {}) },
    ].filter((entry, index, all) => all.findIndex((candidate) => candidate.code === entry.code && candidate.detail === entry.detail) === index)
    output.set(key, { ...primary, relatedFindings: related })
  }
  return [...output.values()]
}

function groupPrimaryFindings(findings: AuditFinding[]): AuditFinding[] {
  const grouped = new Map<string, AuditFinding>()
  const passthrough: AuditFinding[] = []
  const relatedItems: AuditFinding[] = []
  for (const finding of findings) {
    if (finding.role === 'RELATED') { relatedItems.push(finding); continue }
    if (finding.role !== 'PRIMARY') { passthrough.push(finding); continue }
    const rootKey = finding.rootCauseKey ?? `${finding.code}:${finding.id}`
    const previous = grouped.get(rootKey)
    if (!previous) { grouped.set(rootKey, finding); continue }
    const priority: Record<AuditSeverity, number> = { CRITICAL: 3, REVIEW: 2, INFO: 1 }
    const primary = priority[finding.severity] > priority[previous.severity] ? finding : previous
    const sibling = primary.id === finding.id ? previous : finding
    const related = [...(primary.relatedFindings ?? []), ...(sibling.relatedFindings ?? []), { id: sibling.id, code: sibling.code, title: sibling.title, detail: sibling.detail, impact: sibling.impact ?? sibling.whyItMatters, technical: sibling.technical, role: 'RELATED' as const, rootCauseKey: sibling.rootCauseKey }]
      .filter((entry, index, all) => all.findIndex((candidate) => candidate.id === entry.id || candidate.code === entry.code && candidate.detail === entry.detail) === index)
    grouped.set(rootKey, { ...primary, relatedFindings: related })
  }
  for (const relatedFinding of relatedItems) {
    const primary = grouped.get(relatedFinding.rootCauseKey ?? '')
    if (!primary) { passthrough.push(relatedFinding); continue }
    const related = [...(primary.relatedFindings ?? []), { id: relatedFinding.id, code: relatedFinding.code, title: relatedFinding.title, detail: relatedFinding.detail, impact: relatedFinding.impact ?? relatedFinding.whyItMatters, technical: relatedFinding.technical, role: 'RELATED' as const, rootCauseKey: relatedFinding.rootCauseKey }]
      .filter((entry, index, all) => all.findIndex((candidate) => candidate.id === entry.id) === index)
    grouped.set(relatedFinding.rootCauseKey!, { ...primary, relatedFindings: related })
  }
  return [...grouped.values(), ...passthrough]
}

export function runAuditSelfChecks(input: { items: AuditedCardItem[]; expectedStates?: Record<string, ReturnType<typeof deriveExpectedReconciliationState>>; findings: AuditFinding[]; decisions: PersistedDecision[]; snapshot?: AuditInputSnapshot }): AuditSelfCheck[] {
  const checks: AuditSelfCheck[] = []
  const candidateMismatches = input.findings.filter((finding) => {
    const technical = finding.technical ?? {}
    const evaluations = Array.isArray(technical.candidateEvaluations) ? technical.candidateEvaluations : null
    const relevant = typeof technical.candidateCountRelevant === 'number' ? technical.candidateCountRelevant : null
    return evaluations && relevant != null && evaluations.length < relevant && !evaluations.some((entry) => (entry as Record<string, unknown>).disposition === 'SOURCE_ROW_CHANGED' || (entry as Record<string, unknown>).disposition === 'NOT_IN_CURRENT_MATCHING_PIPELINE')
  })
  checks.push({ checkId: 'CANDIDATE_COUNT_TRACE', status: candidateMismatches.length ? 'FAIL' : 'PASS', findingIds: candidateMismatches.map((finding) => finding.id), ...(candidateMismatches.length ? { detail: 'candidateCountRelevant excede as avaliações e não há motivo de divergência registrado.' } : {}) })
  const hasSubstantiveEvidence = (technical: Record<string, unknown> | undefined) => Object.entries(technical ?? {}).some(([key, value]) => !['message', 'reason', 'status'].includes(key) && value != null && value !== '' && (!Array.isArray(value) || value.length > 0) && (typeof value !== 'object' || Array.isArray(value) || Object.keys(value as object).length > 0))
  const weakCritical = input.findings.filter((finding) => finding.severity === 'CRITICAL' && !finding.item && !hasSubstantiveEvidence(finding.technical))
  checks.push({ checkId: 'CRITICAL_EVIDENCE', status: weakCritical.length ? 'FAIL' : 'PASS', findingIds: weakCritical.map((finding) => finding.id), ...(weakCritical.length ? { detail: 'Finding crítico sem item ou evidência técnica.' } : {}) })
  const knownDecisionRefs = new Set(input.decisions.flatMap((decision) => [decision.key, stableFingerprint([decision.key])]))
  const snapshotKeys = input.snapshot?.sourceIdentities.decisions ?? []
  snapshotKeys.forEach((key) => { knownDecisionRefs.add(key); if (!key.endsWith(':DELETED')) knownDecisionRefs.add(stableFingerprint([key])) })
  const collectDecisionRefs = (value: unknown, path: string[] = []): string[] => {
    if (Array.isArray(value)) return value.flatMap((nested) => collectDecisionRefs(nested, path))
    if (!value || typeof value !== 'object') return []
    const record = value as Record<string, unknown>
    const refs = [record.decisionKey, record.decisionId, record.kind && record.key || path.includes('decision') && record.key ? record.key : null].filter((item): item is string => typeof item === 'string')
    return [...refs, ...Object.entries(record).filter(([key]) => key !== 'decisionKey' && key !== 'decisionId').flatMap(([key, nested]) => collectDecisionRefs(nested, [...path, key.toLocaleLowerCase('en-US')]))]
  }
  const unknownDecisionRefs = input.findings.filter((finding) => collectDecisionRefs(finding.technical).some((key) => !knownDecisionRefs.has(key)))
  checks.push({ checkId: 'DECISION_REFERENCE_IN_SNAPSHOT', status: unknownDecisionRefs.length ? 'FAIL' : 'PASS', findingIds: unknownDecisionRefs.map((finding) => finding.id), ...(unknownDecisionRefs.length ? { detail: 'Finding referencia decisão ausente do snapshot congelado.' } : {}) })
  const chainMismatches = [
    ...input.items.filter((item) => item.explanationChain.length > 0 && item.explanationChain[item.explanationChain.length - 1].outcome !== item.expectedState?.status).map((item) => item.fingerprint),
    ...Object.values(input.expectedStates ?? {}).filter((subject) => subject.explanationChain.length > 0 && subject.explanationChain[subject.explanationChain.length - 1].outcome !== subject.expectedState).map((subject) => subject.subjectId),
  ]
  checks.push({ checkId: 'EXPECTED_STATE_EXPLANATION', status: chainMismatches.length ? 'FAIL' : 'PASS', findingIds: chainMismatches, ...(chainMismatches.length ? { detail: 'O último passo da explanationChain não deriva o estado esperado do subject.' } : {}) })
  const primaryKeys = input.findings.filter((finding) => finding.role === 'PRIMARY').map((finding) => finding.rootCauseKey ?? `${finding.code}:${finding.id}`)
  const duplicateRoots = primaryKeys.filter((key, index) => primaryKeys.indexOf(key) !== index)
  checks.push({ checkId: 'UNIQUE_PRIMARY_ROOT_CAUSE', status: duplicateRoots.length ? 'FAIL' : 'PASS', findingIds: input.findings.filter((finding) => duplicateRoots.includes(finding.rootCauseKey ?? `${finding.code}:${finding.id}`)).map((finding) => finding.id), ...(duplicateRoots.length ? { detail: 'A mesma causa raiz foi apresentada em mais de um finding primário.' } : {}) })
  const orphanRelated = input.findings.filter((finding) => finding.role === 'RELATED' && !finding.primaryFindingId && !input.findings.some((primary) => primary.role === 'PRIMARY' && primary.rootCauseKey === finding.rootCauseKey))
  checks.push({ checkId: 'RELATED_FINDING_HAS_PRIMARY', status: orphanRelated.length ? 'FAIL' : 'PASS', findingIds: orphanRelated.map((finding) => finding.id), ...(orphanRelated.length ? { detail: 'Finding relacionado não possui finding primário para sua causa raiz.' } : {}) })
  return checks
}

export type AuditFilter = 'ALL' | 'CRITICAL' | 'REVIEW' | 'LEGACY' | 'HIDDEN'
export function filterAuditFindings(findings: AuditFinding[], filter: AuditFilter): AuditFinding[] {
  if (filter === 'HIDDEN') return [] // Visibility state is intentionally managed outside the financial audit model.
  if (filter === 'ALL') return findings
  if (filter === 'CRITICAL') return findings.filter((finding) => finding.severity === 'CRITICAL')
  if (filter === 'REVIEW') return findings.filter((finding) => finding.severity === 'REVIEW')
  return findings.filter((finding) => finding.status === 'LEGACY' || finding.status === 'MAINTENANCE')
}

function classifyDecisions(decisions: PersistedDecision[], source: AuditDecision['source'], aliases: string[], sheets: LedgerTransaction[], auditRows: DecisionAudit[], globalValidity: ReadonlyMap<string, DecisionValidity> = new Map()): AuditDecision[] {
  return decisions.map((decision) => {
    const validation = auditRows.find((row) => row.decision.key === decision.key)
    const relatedByAlias = aliases.includes(decision.identities[0])
    const selected = sheetReference(decision)
    const referenced = selected ? sheets.find((row) => sheetIdentity(row) === selected || row.id === selected) : undefined
    const status: AuditDecisionStatus = globalValidity.has(decision.key) ? 'CONFLICTING'
      : validation?.status === 'ORPHANED' ? 'ORPHANED'
      : relatedByAlias && decision.identities[0] !== aliases[0] ? 'LEGACY_BUT_RESOLVABLE'
        : decision.kind === 'CARD_PURCHASE_IGNORED' && relatedByAlias ? 'VALID'
        : validation?.status === 'STALE' ? 'STALE'
          : validation?.status === 'NEEDS_REVIEW' && referenced ? 'CONFLICTING'
          : validation?.status ?? (relatedByAlias || referenced ? 'NEEDS_REVIEW' : 'NEEDS_REVIEW')
    const explanation = status === 'CONFLICTING' ? 'A decisão participa de um conflito global de atribuição da linha CUSTOS ANO.'
      : status === 'ORPHANED' ? 'A identidade de linha salva não existe nas linhas atuais.'
      : status === 'STALE' ? 'A decisão deixou de ser compatível com as fontes atuais.'
        : status === 'LEGACY_BUT_RESOLVABLE' ? 'Fingerprint antigo reconhecido por uma variante histórica da compra.'
          : decision.kind === 'CARD_PURCHASE_IGNORED' ? 'Decisão humana de ignorar; mantida e sinalizada para revisão.'
            : status === 'VALID' ? 'A decisão continua compatível com as fontes atuais.' : 'A decisão precisa de verificação sem alteração automática.'
    const validity: DecisionValidity = globalValidity.get(decision.key) ?? (status === 'VALID' ? 'VALID_GLOBALLY'
        : status === 'ORPHANED' || status === 'STALE' ? 'INVALID_TARGET'
          : 'NEEDS_REVIEW')
    return { decision, status, source, explanation, structurallyValid: validation?.status === 'VALID', validity }
  })
}

function rejectedReasons(statement: CardStatement, transaction: CardStatementTransaction, rows: LedgerTransaction[]) {
  return rows.map((row) => ({ row, reason: explainCostYearCandidateRejection(statement, transaction, row, rows) })).filter((item): item is { row: LedgerTransaction; reason: string } => item.reason !== null)
}

/** Recomputes card purchase state using the production matcher with all persisted choices omitted. It performs no I/O. */
export function recomputeWithoutPersistedDecisions(input: Pick<ConsistencyAuditInput, 'sheets' | 'statements'>) {
  const consumed = new Set<string>()
  const statements = [...input.statements].sort((a, b) => (a.statement.dueDate ?? '').localeCompare(b.statement.dueDate ?? '') || a.statement.statementIdentity.localeCompare(b.statement.statementIdentity))
  const result = new Map<string, CardStatementMatch>()
  for (const entry of statements) {
    const pure = reconcileCardStatement(entry.statement, input.sheets)
    for (const match of pure.matches) {
      const derived = deriveCardPurchaseStatus(match, { consumedSheetIds: consumed })
      result.set(`${entry.statement.statementIdentity}\u001f${match.transaction.id}`, derived)
      if (derived.status === 'CARD_MATCHED' && derived.sheet) consumed.add(derived.sheet.id)
      if (derived.status === 'CARD_GROUP_MATCHED') derived.candidates.forEach((row) => consumed.add(row.id))
    }
  }
  return result
}

export function auditConsistency(input: ConsistencyAuditInput): ConsistencyAuditResult {
  const auditStartedAt = performance.now()
  let expectedStateDerivationMs = 0
  const mode = input.mode ?? 'PROFUNDA'
  const pure = mode === 'PROFUNDA' ? recomputeWithoutPersistedDecisions(input) : new Map<string, CardStatementMatch>()
  const decisionContext = { banks: input.banks, sheets: input.sheets, statements: input.statements }
  const mergeAudit = auditDecisionMerge(input)
  const effectiveDecisions = mergeAudit.effective.filter((item) => item.state === 'ACTIVE')
  const allDecisions = effectiveDecisions.map((item) => item.decision)
  const validated = auditPersistedDecisions(allDecisions, decisionContext)
  const validRejectedDecisions = new Map(validated
    .filter((item) => item.decision.kind === 'PAIR_REJECTED' && item.status === 'VALID' && !mergeAudit.conflicts.some((conflict) => conflict.key === item.decision.key))
    .map((item) => [item.decision.key, item.decision]))
  const statementAssignments = resolveStatementMatchAssignments(allDecisions, input.statements, input.sheets)
  const manualAssignmentConflicts = conflictingStatementAssignments(statementAssignments)
  const validManualReservations = statementAssignments.filter((assignment) =>
    validated.find((item) => item.decision.key === assignment.decision.key)?.status === 'VALID'
      && !manualAssignmentConflicts.has(sheetIdentity(assignment.row)))
  const globalDecisionValidity = new Map<string, DecisionValidity>([...manualAssignmentConflicts.values()].flatMap((assignments) => assignments.map((assignment) => [assignment.decision.key, 'CONFLICTING_ACTIVE_DECISION'] as const)))
  const currentMap = new Map(input.currentCardMatches.map(({ statementIdentity, transactionId, match }) => [`${statementIdentity}\u001f${transactionId}`, match]))
  const items: AuditedCardItem[] = []
  const findings: RawAuditFinding[] = []
  if (input.currentDecisionRevision != null && input.derivedDecisionRevision != null && input.currentDecisionRevision !== input.derivedDecisionRevision) findings.push({
    id: `STALE_DECISION_RESULT:${input.derivedDecisionRevision}`, code: 'STALE_DECISION_RESULT', severity: 'CRITICAL', category: 'STATE', invariantId: 'INV-11',
    title: 'O estado derivado está atrasado em relação às decisões', detail: 'Os resultados exibidos foram calculados com uma revisão diferente do conjunto efetivo de decisões.',
    technical: { currentDecisionRevision: input.currentDecisionRevision, derivedDecisionRevision: input.derivedDecisionRevision },
  })
  for (const [rowKey, assignments] of manualAssignmentConflicts) {
    const row = assignments[0].row
    findings.push({
      id: `MULTIPLE_INCOMPATIBLE_ACTIVE_DECISIONS:${rowKey}`, code: 'MULTIPLE_INCOMPATIBLE_ACTIVE_DECISIONS', severity: 'CRITICAL', category: 'DECISION', invariantId: 'INV-08',
      title: 'Duas confirmações manuais diferentes usam a mesma linha da CUSTOS ANO',
      detail: `A linha ${row.sheetRecordId || row.id} · ${row.originalDescription} · ${row.date} · ${row.amount} centavos está vinculada a ${new Set(assignments.map((assignment) => assignment.subjectId)).size} compras diferentes.`,
      diagnosis: 'Duas confirmações manuais diferentes estão usando a mesma linha da CUSTOS ANO.',
      whyItMatters: 'Uma linha só pode ser atribuída a uma compra por vez; a disputa altera o estado derivado dos dois subjects.',
      recommendedAction: 'Revise as compras relacionadas e mantenha apenas a confirmação correta para esta linha.',
      diagnosticConfidence: 'HIGH', safeAutomaticAction: false, status: 'ACTIVE', explanationSource: 'ASSIGNMENT',
      technical: {
        validity: 'CONFLICTING_ACTIVE_DECISION', row: { id: row.sheetRecordId || row.id, sheetIdentity: rowKey, description: row.originalDescription, date: row.date, amount: row.amount, paymentMethod: row.paymentMethod },
        assignments: assignments.map(({ decision, subjectId, statement, transactionId }) => {
          const transaction = statement.transactions.find((item) => item.id === transactionId)!
          return { subjectId, description: transaction.originalDescription, date: transaction.purchaseDate || transaction.date, amount: transaction.amount, decisionId: stableFingerprint([decision.key]), decisionKey: decision.key, createdAt: null, updatedAt: decision.updatedAt, selected: decision.selected }
        }),
        relatedInvariantViolations: ['INV-01', 'INV-03', 'INV-08', 'INV-11'],
      },
    })
  }
  for (const assignment of statementAssignments) {
    const rowKey = sheetIdentity(assignment.row)
    if (manualAssignmentConflicts.has(rowKey)) continue
    for (const current of input.currentCardMatches) {
      const currentRows = current.match.status === 'CARD_MATCHED' && current.match.sheet ? [current.match.sheet] : current.match.status === 'CARD_GROUP_MATCHED' ? current.match.candidates : []
      if (!currentRows.some((row) => sheetIdentity(row) === rowKey)) continue
      const subjectId = cardTransactionIdentity(current.statementIdentity, current.match.transaction)
      if (subjectId === assignment.subjectId) continue
      const owner = input.statements.flatMap((entry) => entry.statement.transactions.map((transaction) => ({ entry, transaction })))
        .find(({ entry, transaction }) => cardTransactionIdentity(entry.statement, transaction) === assignment.subjectId)
      const ownerCurrent = owner && currentMap.get(`${owner.entry.statement.statementIdentity}\u001f${owner.transaction.id}`)
      const ownerHasExactSeparateMatch = Boolean(ownerCurrent?.status === 'CARD_MATCHED' && ownerCurrent.sheet
        && sheetIdentity(ownerCurrent.sheet) !== rowKey
        && findExistingCostYearCandidates(owner!.entry.statement, owner!.transaction, [ownerCurrent.sheet]).some((candidate) => sheetIdentity(candidate) === sheetIdentity(ownerCurrent!.sheet!))
        && ownerCurrent.sheet.amount === owner!.transaction.amount
        && ownerCurrent.sheet.direction === 'DEBIT'
        && normalizeDescription(ownerCurrent.sheet.paymentMethod) === 'credito bradesco'
        && (ownerCurrent.sheet.date === (owner!.transaction.invoiceDueDate ?? owner!.transaction.statementDueDate ?? owner!.entry.statement.dueDate)
          || (owner!.transaction.installment != null && ownerCurrent.sheet.installment === owner!.transaction.installment && ownerCurrent.sheet.totalInstallments === owner!.transaction.totalInstallments)))
      // Este é o caso de vínculo histórico obsoleto com match atual exato em outra linha;
      // o DOUBLE_CLAIM abaixo oferece a invalidação contextual segura, sem duplicar o alerta.
      if (ownerHasExactSeparateMatch) continue
      globalDecisionValidity.set(assignment.decision.key, 'RESERVED_TARGET_CONFLICT')
      findings.push({
        id: `RESERVED_SHEET_ROW_REUSED:${rowKey}:${subjectId}`, code: 'RESERVED_SHEET_ROW_REUSED', severity: 'CRITICAL', category: 'DECISION', invariantId: 'INV-08',
        title: 'O matching atual reutilizou uma linha reservada por confirmação manual',
        detail: `A linha ${assignment.row.sheetRecordId || assignment.row.id} está confirmada para ${owner?.transaction.originalDescription ?? assignment.subjectId}, mas também foi atribuída a ${current.match.transaction.originalDescription}.`,
        diagnosis: 'Uma linha reservada por confirmação manual foi reutilizada por outro vínculo atual.', whyItMatters: 'O mesmo lançamento da CUSTOS ANO não pode atender a duas compras diferentes.', recommendedAction: 'Revise a atribuição automática e preserve a confirmação manual somente se ela continuar correta.',
        diagnosticConfidence: 'HIGH', safeAutomaticAction: false, status: 'ACTIVE', explanationSource: 'ASSIGNMENT',
        technical: { validity: 'RESERVED_TARGET_CONFLICT', row: { id: assignment.row.sheetRecordId || assignment.row.id, sheetIdentity: rowKey, description: assignment.row.originalDescription, date: assignment.row.date, amount: assignment.row.amount }, manualDecision: assignment.decision, manualSubjectId: assignment.subjectId, automaticSubjectId: subjectId, automaticStatus: current.match.status },
      })
    }
  }
  for (const entry of input.statements) for (const transaction of entry.statement.transactions.filter((item) => item.financialStatus === 'REFUNDED')) {
    const current = currentMap.get(`${entry.statement.statementIdentity}\u001f${transaction.id}`)
    if (current?.status === 'CARD_MISSING' || current?.status === 'CARD_MISSING_CONFIRMED') findings.push({ id: `REFUNDED_BUT_MISSING:${entry.statement.statementIdentity}:${transaction.id}`, code: 'REFUNDED_BUT_MISSING', severity: 'CRITICAL', title: 'Compra integralmente estornada ainda aparece como ausente', detail: 'O par de compra e estorno foi marcado como financeiramente anulado, mas o estado atual ainda apresenta a compra como ausente.', technical: { statementIdentity: entry.statement.statementIdentity, transaction, currentStatus: current.status } })
  }
  for (const snapshot of effectiveDecisions.filter((item) => item.state === 'ACTIVE' && item.decision.kind === 'STATEMENT_MATCH_CONFIRMED')) {
    const hasConflictingManualOwner = [...manualAssignmentConflicts.values()].some((assignments) => assignments.some((assignment) => assignment.decision.key === snapshot.decision.key))
    if (validated.find((item) => item.decision.key === snapshot.decision.key)?.status !== 'VALID' || hasConflictingManualOwner) continue
    const assignment = statementAssignments.find((item) => item.decision.key === snapshot.decision.key)
    if (!assignment) continue
    for (const entry of input.statements) {
      const transaction = entry.statement.transactions.find((item) => cardTransactionIdentityVariants(entry.statement, item, entry.legacyStatementIdentity).includes(snapshot.decision.identities[0]))
      if (!transaction) continue
      const match = currentMap.get(`${entry.statement.statementIdentity}\u001f${transaction.id}`)
      const correctlyApplied = match?.status === 'CARD_MATCHED' && match.sheet != null && sheetIdentity(match.sheet) === sheetIdentity(assignment.row)
      if (!correctlyApplied) findings.push({
        id: `VALID_MANUAL_MATCH_NOT_APPLIED:${snapshot.decision.key}`, code: 'VALID_MANUAL_MATCH_NOT_APPLIED', severity: 'CRITICAL', title: 'Confirmação manual válida não foi aplicada', detail: 'Existe uma confirmação manual globalmente válida, mas o estado final não aplicou o lançamento selecionado.', technical: { decision: snapshot.decision, validity: 'VALID_GLOBALLY', selected: snapshot.decision.selected[0], resolvedSheetRecordId: assignment.row.sheetRecordId, resolvedSheetId: assignment.row.id, currentStatus: match?.status ?? 'UNAVAILABLE', currentSheetRecordId: match?.sheet?.sheetRecordId ?? null, transaction },
      })
      break
    }
  }
  const validBankAssignments = allDecisions.filter((decision) => decision.kind === 'PAIR_CONFIRMED'
    && validated.find((item) => item.decision.key === decision.key)?.status === 'VALID'
    && !mergeAudit.conflicts.some((conflict) => conflict.key === decision.key))
    .flatMap((decision) => {
      const bank = input.banks.find((item) => bankIdentity(item) === decision.identities[0])
      const row = input.sheets.find((item) => sheetIdentity(item) === decision.selected[0])
      return bank && row ? [{ decision, bank, row }] : []
    })
  const bankAssignmentsByRow = new Map<string, typeof validBankAssignments>()
  for (const assignment of validBankAssignments) {
    const key = sheetIdentity(assignment.row), records = bankAssignmentsByRow.get(key) ?? []
    records.push(assignment); bankAssignmentsByRow.set(key, records)
  }
  const conflictingBankRows = new Set<string>()
  for (const [rowKey, assignments] of bankAssignmentsByRow) {
    const owners = [...new Set(assignments.map(({ bank }) => bank.id))]
    if (owners.length < 2) continue
    conflictingBankRows.add(rowKey)
    findings.push({
      id: `PAIR_CONFIRMED_ASSIGNMENT_CONFLICT:${rowKey}`, code: 'PAIR_CONFIRMED_ASSIGNMENT_CONFLICT', severity: 'CRITICAL', category: 'DECISION', invariantId: 'INV-08',
      title: 'Confirmações bancárias incompatíveis usam a mesma linha',
      detail: `${assignments[0].row.originalDescription} (${assignments[0].row.date}) foi confirmada para ${owners.length} movimentações bancárias diferentes. Nenhuma foi escolhida pela ordem de leitura.`,
      diagnosis: 'Mais de uma confirmação bancária ativa reivindica a mesma linha da CUSTOS ANO.',
      whyItMatters: 'Uma linha não pode ter dois owners bancários incompatíveis.', recommendedAction: 'Revise as confirmações e mantenha somente o vínculo correto.',
      diagnosticConfidence: 'HIGH', safeAutomaticAction: false, status: 'ACTIVE', explanationSource: 'ASSIGNMENT',
      technical: { sheetRecordId: assignments[0].row.sheetRecordId, rowIdentity: rowKey, row: { id: assignments[0].row.sheetRecordId || assignments[0].row.id, description: assignments[0].row.originalDescription, date: assignments[0].row.date, amount: assignments[0].row.amount, paymentMethod: assignments[0].row.paymentMethod }, assignments: assignments.map(({ decision, bank }) => ({ decisionId: stableFingerprint([decision.key]), decisionKey: decision.key, bankId: bank.id, bankIdentity: bankIdentity(bank), bankTransactionId: bank.bankTransactionId, counterpartyName: bank.counterpartyName, description: bank.originalDescription, date: bank.date, amount: bank.amount, updatedAt: decision.updatedAt, selected: decision.selected })) },
    })
  }
  const validPairRejections = allDecisions.filter((decision) => decision.kind === 'PAIR_REJECTED' && validated.find((item) => item.decision.key === decision.key)?.status === 'VALID' && !mergeAudit.conflicts.some((conflict) => conflict.key === decision.key))
  const rejectedPairKeys = new Set<string>(), rejectedPairDecisionKeys = new Map<string, string>()
  for (const decision of validPairRejections) {
    const bank = input.banks.find((item) => bankIdentity(item) === decision.identities[0] || item.id === decision.identities[0])
    const row = input.sheets.find((item) => sheetIdentity(item) === decision.identities[1] || item.id === decision.identities[1] || item.sheetRecordId === decision.identities[1])
    if (bank && row) { const key = pairKey(bank.id, row.id); rejectedPairKeys.add(key); rejectedPairDecisionKeys.set(key, decision.key) }
  }
  const ignoredBankIds = new Set(allDecisions.filter((decision) => decision.kind === 'BANK_IGNORED' && validated.find((item) => item.decision.key === decision.key)?.status === 'VALID').flatMap((decision) => {
    const bank = input.banks.find((item) => bankIdentity(item) === decision.identities[0] || item.id === decision.identities[0])
    return bank ? [bank.id] : []
  }))
  const confirmedPairs = new Map(validBankAssignments.filter((assignment) => !conflictingBankRows.has(sheetIdentity(assignment.row))).map(({ bank, row }) => [bank.id, row.id]))
  for (const decision of allDecisions.filter((item) => item.kind === 'MISSING_ADDED_TO_SHEET' && validated.find((audit) => audit.decision.key === item.key)?.status === 'VALID')) {
    const bank = input.banks.find((item) => bankIdentity(item) === decision.identities[0])
    const row = input.sheets.find((item) => sheetIdentity(item) === decision.selected[0])
    if (bank && row) confirmedPairs.set(bank.id, row.id)
  }
  const confirmedCompositions = new Map(allDecisions.filter((decision) => decision.kind === 'COMPOSITION_CONFIRMED' && validated.find((item) => item.decision.key === decision.key)?.status === 'VALID').flatMap((decision) => {
    const bank = input.banks.find((item) => bankIdentity(item) === decision.identities[0])
    const rows = decision.selected.map((identity) => input.sheets.find((item) => sheetIdentity(item) === identity)).filter((row): row is LedgerTransaction => Boolean(row))
    return bank && rows.length === decision.selected.length ? [[bank.id, rows.map((row) => row.id)] as const] : []
  }))
  const identifiedCardPaymentIds = new Set(input.banks.filter((bank) => bank.type === 'CARD_PAYMENT' || input.currentBankItems?.some((item) => item.bank.id === bank.id && item.status === 'CARD_PAYMENT_IDENTIFIED')).map((bank) => bank.id))
  const pureBankStates = new Map(reconcile(input.banks, input.sheets).items.map((item) => [item.bank.id, item]))
  const canonicalBankResult = reconcile(input.banks, input.sheets, {
    rejectedPairKeys, rejectedPairDecisionKeys, ignoredBankIds,
    confirmedPairs, confirmedCompositions, identifiedCardPaymentIds,
    conflictingConfirmedSheetIds: new Set([...conflictingBankRows].flatMap((rowKey) => input.sheets.filter((row) => sheetIdentity(row) === rowKey).map((row) => row.id))),
  })
  const expectedBankStartedAt = performance.now()
  const expectedBankStates = Object.fromEntries(input.banks.map((bank) => {
    const pureItem = pureBankStates.get(bank.id), expectedItem = canonicalBankResult.items.find((item) => item.bank.id === bank.id)
    const currentItem = input.currentBankItems?.find((item) => item.bank.id === bank.id)
    const manual = validBankAssignments.find((assignment) => assignment.bank.id === bank.id && !conflictingBankRows.has(sheetIdentity(assignment.row)))
    const rejected = validPairRejections.find((decision) => decision.identities[0] === bankIdentity(bank) || decision.identities[0] === bank.id)
    const reservation = expectedItem?.status === 'REVIEW' && expectedItem.reviewReason === 'ASSIGNMENT_CONFLICT' && expectedItem.assignmentConflictOwnerBankId
      ? { subjectId: expectedItem.assignmentConflictOwnerBankId, targetId: expectedItem.sheet?.sheetRecordId || expectedItem.sheet?.id || '', decisionId: stableFingerprint([expectedItem.assignmentConflictOwnerBankId]) }
      : undefined
    return [bankIdentity(bank), deriveExpectedReconciliationState({
      subjectId: bankIdentity(bank), pureState: pureItem?.status ?? 'UNAVAILABLE', currentState: currentItem?.status ?? 'UNAVAILABLE',
      canonicalExpectedState: expectedItem?.status ?? 'UNAVAILABLE',
      canonicalEvidence: expectedItem?.sheet ? [expectedItem.sheet.sheetRecordId || expectedItem.sheet.id] : expectedItem?.candidateSheets?.map((row) => row.sheetRecordId || row.id),
      ...(manual ? { validManualAssignment: { decisionId: stableFingerprint([manual.decision.key]), targetId: manual.row.sheetRecordId || manual.row.id, outcome: 'MATCHED' } } : {}),
      ...(rejected && expectedItem ? { validRejection: { decisionId: stableFingerprint([rejected.key]), outcome: expectedItem.status } } : {}),
      ...(reservation ? { reservationOwner: reservation } : {}),
    })]
  }))
  expectedStateDerivationMs += performance.now() - expectedBankStartedAt
  for (const { decision, bank, row } of validBankAssignments) {
    const rowKey = sheetIdentity(row)
    if (conflictingBankRows.has(rowKey)) continue
    const current = input.currentBankItems?.find((item) => item.bank.id === bank.id)
    const applied = current?.status === 'MATCHED' && current.sheet != null && sheetIdentity(current.sheet) === rowKey
    if (!applied) findings.push({
      id: `VALID_BANK_MANUAL_MATCH_NOT_APPLIED:${decision.key}`, code: 'VALID_BANK_MANUAL_MATCH_NOT_APPLIED', severity: 'CRITICAL',
      title: 'Confirmação bancária válida não foi aplicada', detail: 'Existe um PAIR_CONFIRMED válido, mas o resultado atual não mostra o vínculo confirmado.',
      technical: { decision, bank, selected: decision.selected[0], sheetRecordId: row.sheetRecordId, currentStatus: current?.status ?? 'UNAVAILABLE', currentSheetRecordId: current?.sheet ? sheetIdentity(current.sheet) : null },
    })
  }
  for (const application of input.appliedDecisions ?? []) {
    const audit = validated.find((item) => item.decision.key === application.decisionKey)
    if (!audit || audit.status === 'VALID') continue
    findings.push({ id: `INVALID_DECISION_APPLIED:${application.decisionKey}`, code: 'INVALID_DECISION_APPLIED', severity: 'CRITICAL', title: 'Decisão inválida influenciou o resultado', detail: `Uma decisão classificada como ${audit.status} foi aplicada ao domínio ${application.appliedDomain}.`, technical: { decision: audit.decision, decisionStatus: audit.status, appliedDomain: application.appliedDomain } })
  }
  for (const item of input.currentBankItems ?? []) {
    if (item.status === 'MATCHED' && !item.sheet && !item.candidate && !item.composition?.length) findings.push({ id: `MATCHED_WITHOUT_LINK:${item.bank.id}`, code: 'MATCHED_WITHOUT_LINK', severity: 'CRITICAL', title: 'Movimentação conciliada sem vínculo visível', detail: 'O estado está como MATCHED, mas não há lançamento, candidata ou composição associados.', technical: { bank: item.bank, status: item.status } })
    if (item.status === 'REVIEW' && !item.candidate && !item.candidateSheets?.length) findings.push({ id: `REVIEW_WITHOUT_CANDIDATES:${item.bank.id}`, code: 'REVIEW_WITHOUT_CANDIDATES', severity: 'REVIEW', title: 'Movimentação em revisão sem candidato da planilha', detail: 'O resultado atual não apresenta um candidato de CUSTOS ANO para esta movimentação. O motivo técnico explica se existe outro conflito que justifique a revisão.', technical: { bank: item.bank, status: item.status, candidateCount: 0, reviewReason: item.reviewReason ?? null } })
    if (item.status === 'REVIEW' && item.reviewReason === 'ASSIGNMENT_CONFLICT' && item.candidate) findings.push({ id: `ASSIGNMENT_CONFLICT:${item.bank.id}`, code: 'ASSIGNMENT_CONFLICT', severity: 'REVIEW', title: 'Candidata reservada por outra movimentação', detail: `Há uma candidata concreta da CUSTOS ANO${item.sheet ? ` (${item.sheet.originalDescription}, ${item.sheet.date}, ${item.sheet.amount} centavos)` : ''}${item.assignmentConflictOwnerBankId ? `, atribuída na solução global à movimentação ${item.assignmentConflictOwnerBankId}` : ''}.`, technical: { bank: item.bank, status: item.status, candidateCount: 1, candidate: item.candidate, sheet: item.sheet, assignmentOwnerBankId: item.assignmentConflictOwnerBankId ?? null, reviewReason: item.reviewReason } })
    const semanticType = transactionType(item.bank.originalDescription, item.bank.paymentMethod)
    if (item.status === 'MISSING' && item.bank.direction === 'DEBIT' && item.bank.type === 'EXPENSE') {
      const candidates = findPlausibleLedgerCandidates(item.bank, input.sheets)
      if (candidates.length) {
        const pipeline = item.candidatePipeline ?? []
        const evaluatedCandidates = candidates.map((row) => {
          const evaluation = pipeline.find((entry) => sheetIdentity(entry.sheet) === sheetIdentity(row))
          const sourceRowChanged = evaluation && (evaluation.sheet.date !== row.date || evaluation.sheet.amount !== row.amount
            || evaluation.sheet.originalDescription !== row.originalDescription || evaluation.sheet.paymentMethod !== row.paymentMethod)
          const rejection = evaluation?.decisionKey ? validRejectedDecisions.get(evaluation.decisionKey) : undefined
          const pairHasConflictingConfirmation = rejection && allDecisions.some((decision) => decision.kind === 'PAIR_CONFIRMED'
            && decision.identities[0] === rejection.identities[0]
            && (decision.selected[0] === rejection.identities[1] || decision.selected[0] === row.id || decision.selected[0] === row.sheetRecordId))
          return evaluation ? {
            row: { id: row.id, sheetRecordId: row.sheetRecordId, date: row.date, description: row.originalDescription, amount: row.amount },
            disposition: sourceRowChanged ? 'SOURCE_ROW_CHANGED' : evaluation.disposition,
            reason: sourceRowChanged ? 'A linha mudou entre a fonte usada pelo conciliador e a releitura da auditoria; o resultado atual foi calculado com outra versão desta linha.' : evaluation.reason,
            decisionKey: evaluation.decisionKey ?? null,
            ownerBankId: evaluation.ownerBankId ?? null,
            decisionValidity: rejection && !pairHasConflictingConfirmation ? 'VALID' : evaluation.disposition === 'REJECTED_BY_DECISION' ? 'INVALID_OR_UNVERIFIED' : null,
            decision: rejection && !pairHasConflictingConfirmation ? rejection : null,
          } : {
            row: { id: row.id, sheetRecordId: row.sheetRecordId, date: row.date, description: row.originalDescription, amount: row.amount },
            disposition: 'NOT_IN_CURRENT_MATCHING_PIPELINE',
            reason: input.currentSheets?.some((currentRow) => sheetIdentity(currentRow) === sheetIdentity(row))
              ? 'A linha existe nas fontes atual e auditada, mas não há avaliação anexada ao resultado atual; a trilha de matching está indisponível.'
              : 'A candidata existe na fonte lida pela auditoria, mas não na cópia de CUSTOS ANO usada para calcular o resultado atual.',
            decisionKey: null,
            ownerBankId: null,
            decisionValidity: null,
            decision: null,
          }
        })
        const rejected = evaluatedCandidates.filter((entry) => entry.disposition === 'REJECTED_BY_DECISION')
        const expectedManualRejection = candidates.length > 0 && rejected.length === candidates.length
          && evaluatedCandidates.every((entry) => entry.decisionValidity === 'VALID')
        const reserved = evaluatedCandidates.filter((entry) => entry.disposition === 'RESERVED')
        const sourceDivergence = evaluatedCandidates.filter((entry) => entry.disposition === 'NOT_IN_CURRENT_MATCHING_PIPELINE' || entry.disposition === 'SOURCE_ROW_CHANGED')
        const pipelineStage = rejected.length === candidates.length ? 'DECISION_FILTERING / PAIR_REJECTED' : reserved.length ? 'RESERVATION / GLOBAL_ASSIGNMENT' : sourceDivergence.length ? 'SOURCE_OR_TRACE_DIVERGENCE' : 'FINAL_CANDIDATE_SET'
        const technical = {
            bank: item.bank,
            candidateRows: candidates.map((row) => ({ id: row.id, sheetRecordId: row.sheetRecordId, date: row.date, description: row.originalDescription, amount: row.amount })),
            candidateCountRelevant: candidates.length,
            candidateCountEvaluated: evaluatedCandidates.filter((entry) => entry.disposition !== 'NOT_IN_CURRENT_MATCHING_PIPELINE' && entry.disposition !== 'SOURCE_ROW_CHANGED').length,
            candidateEvaluations: evaluatedCandidates,
            pipelineStage,
            decisions: rejected.map((entry) => ({ kind: 'PAIR_REJECTED', key: entry.decisionKey, decision: entry.decision, validity: entry.decisionValidity })),
          }
        if (expectedManualRejection) {
          findings.push({
            id: `EXPECTED_MANUAL_REJECTION:${item.bank.id}`, code: 'EXPECTED_MANUAL_REJECTION', severity: 'INFO', category: 'STATE', invariantId: 'INV-03',
            title: 'Candidatas rejeitadas anteriormente pelo usuário',
            detail: `As ${candidates.length} candidata(s) plausíveis foram rejeitadas por decisões ativas, válidas e sem conflito. A movimentação permanece ausente conforme a escolha anterior.`,
            diagnosis: `As candidatas plausíveis foram rejeitadas anteriormente pelo usuário; por isso a movimentação permanece ausente.${candidates.length > 1 ? ` ${candidates.length} candidatas foram rejeitadas.` : ''}`,
            whyItMatters: 'O estado Ausente respeita as rejeições salvas e pode ser revisto se uma rejeição tiver sido feita por engano.',
            recommendedAction: 'Nenhuma ação necessária, a menos que queira reconsiderar uma correspondência rejeitada.',
            diagnosticConfidence: 'HIGH', safeAutomaticAction: false, status: 'EXPECTED', explanationSource: 'MANUAL_DECISION', currentState: 'MISSING', expectedState: 'MISSING', pureState: 'CANDIDATE_REJECTED', technical,
          })
        } else {
          const detail = rejected.length === candidates.length
            ? 'A movimentação está ausente e suas candidatas têm registros de rejeição, mas ao menos uma decisão não pôde ser validada com segurança nas fontes atuais.'
            : reserved.length
              ? 'O estado atual é MISSING, mas há candidata(s) reservada(s) na atribuição global. O resultado deveria mantê-las em REVIEW; a trilha identifica o owner.'
              : sourceDivergence.length
                ? `O estado atual é MISSING e a auditoria encontrou ${candidates.length} candidata(s), mas a fonte/trilha atual difere da usada no matching. A diferença está detalhada por linha.`
                : `O estado atual é MISSING, mas ${candidates.length} linha(s) da CUSTOS ANO passam pelos critérios mínimos de matching. A trilha abaixo identifica a etapa alcançada por cada uma.`
          findings.push({
            id: `MISSING_WITH_STRONG_CANDIDATE:${item.bank.id}`, code: 'MISSING_WITH_STRONG_CANDIDATE', severity: 'CRITICAL', title: 'Movimentação ausente possui candidato plausível', detail,
            explanationSource: rejected.length === candidates.length ? 'MANUAL_DECISION' : reserved.length ? 'ASSIGNMENT' : sourceDivergence.length ? 'SOURCE_LIFECYCLE' : 'NONE',
            technical,
          })
        }
      }
    }
    if (item.status === 'MISSING' && (item.bank.type === 'CARD_PAYMENT' || semanticType === 'CARD_PAYMENT')) findings.push({ id: `CARD_PAYMENT_AS_EXPENSE_MISSING:${item.bank.id}`, code: 'CARD_PAYMENT_AS_EXPENSE_MISSING', severity: 'CRITICAL', title: 'Pagamento da fatura classificado como despesa ausente', detail: 'Esta movimentação representa o pagamento agregado de uma fatura e não deve aparecer como despesa individual em Ausentes.', technical: { bank: item.bank, storedType: item.bank.type, semanticType, status: item.status } })
    if (item.status === 'MISSING' && item.bank.direction === 'DEBIT' && (item.bank.type === 'EXPENSE' || semanticType === 'EXPENSE')
      && input.missingActionVisibility?.[item.bank.id] === false) {
      const eligibility = canAddMissingToCostYear({ source: 'BANK', status: item.status, direction: item.bank.direction, type: item.bank.type, hasRequiredFields: Boolean(item.bank.date && item.bank.originalDescription && item.bank.amount > 0) })
      if (eligibility.eligible) findings.push({ id: `MISSING_ACTION_INCONSISTENCY:${item.bank.id}`, code: 'MISSING_ACTION_INCONSISTENCY', severity: 'CRITICAL', title: 'Despesa ausente sem ação para adicionar', detail: 'A movimentação está classificada como despesa ausente e atende aos critérios de escrita, mas a ação Adicionar à CUSTOS ANO não foi exibida.', technical: { bank: item.bank, eligibility, actionVisible: false } })
    }
  }
  for (const entry of input.statements) {
    const statement = entry.statement
    if (statement.accountingDifference != null && statement.accountingDifference !== 0) findings.push({ id: `INVOICE_TOTAL_MISMATCH:${statement.statementIdentity}`, code: 'INVOICE_TOTAL_MISMATCH', severity: 'REVIEW', title: 'A validação matemática da fatura encontrou diferença', detail: `A diferença calculada da fatura é de ${statement.accountingDifference} centavos.`, technical: { statementIdentity: statement.statementIdentity, reportedTotal: statement.reportedTotal, purchasesDebitsTotal: statement.purchasesDebitsTotal, creditsPaymentsTotal: statement.creditsPaymentsTotal, previousBalance: statement.previousBalance, accountingDifference: statement.accountingDifference } })
    if (statement.reportedTotal != null && statement.cardSubtotals.length > 0) {
      const subtotal = statement.cardSubtotals.reduce((sum, item) => sum + item.amount, 0)
      if (subtotal !== statement.reportedTotal) findings.push({ id: `CARD_SUBTOTAL_MISMATCH:${statement.statementIdentity}`, code: 'CARD_SUBTOTAL_MISMATCH', severity: 'REVIEW', title: 'Subtotais dos cartões diferem do total da fatura', detail: `A soma dos subtotais é ${subtotal} centavos e o total informado é ${statement.reportedTotal} centavos.`, technical: { statementIdentity: statement.statementIdentity, cardSubtotals: statement.cardSubtotals, subtotal, reportedTotal: statement.reportedTotal } })
    }
    for (const group of statement.refundGroups ?? []) if (group.purchaseGroupAmount - group.refundAmount !== group.netAmount) findings.push({ id: `REFUND_NET_MISMATCH:${statement.statementIdentity}:${group.id}`, code: 'REFUND_NET_MISMATCH', severity: 'CRITICAL', title: 'Grupo de compras e estorno com líquido inconsistente', detail: 'O valor líquido registrado não corresponde à compra agrupada menos o crédito.', technical: { statementIdentity: statement.statementIdentity, refundGroup: group } })
  }
  if (input.missingCounterCollections && input.missingCounterCollections.length > 1) {
    const [reference, ...others] = input.missingCounterCollections
    for (const other of others) {
      const diff = diagnoseMissingCounterDivergence(reference.items, other.items)
      if (diff.presentInSummaryOnly.length || diff.presentInMissingListOnly.length) findings.push({
        id: `MISSING_COUNT_DIVERGENCE:${reference.source}:${other.source}`, code: 'MISSING_COUNT_DIVERGENCE', severity: 'REVIEW', title: 'Os contadores de Ausentes usam coleções diferentes', detail: `As coleções “${reference.source}” e “${other.source}” não contêm os mesmos lançamentos.`,
        technical: { referenceSource: reference.source, comparedSource: other.source, presentInSummaryOnly: diff.presentInSummaryOnly, presentInMissingListOnly: diff.presentInMissingListOnly },
      })
    }
  }
  if (input.activeDriveSourceIds) {
    const active = new Set(input.activeDriveSourceIds)
    for (const item of input.currentBankItems ?? []) {
      const sourceIds = item.bank.statementSourceIds ?? (item.bank.statementSourceId ? [item.bank.statementSourceId] : [])
      const stale = sourceIds.filter((id) => id !== 'manual' && !active.has(id))
      if (stale.length) findings.push({ id: `STALE_ACTIVE_SOURCE:${item.bank.id}`, code: 'STALE_ACTIVE_SOURCE', severity: 'REVIEW', title: 'Movimentação mantida sem uma fonte ativa', detail: 'Uma movimentação ainda participa da conciliação, mas sua origem não está na listagem atual do Drive.', technical: { bankTransaction: item.bank, staleSourceIds: stale, activeSourceIds: [...active] } })
    }
  }
  const currentDrive = new Set(input.currentDriveSourceIds ?? [])
  const missingDrive = new Set(input.missingDriveSourceIds ?? [])
  if (input.sourceProvenance) {
    const entityIds = new Set([...input.banks.map((bank) => bank.id), ...input.statements.flatMap(({ statement }) => [statement.statementIdentity, ...statement.transactions.map((transaction) => transaction.id)])])
    const sourcesByEntity = new Map<string, Set<string>>()
    for (const source of input.sourceProvenance) for (const entityId of source.entityIds) {
      const sources = sourcesByEntity.get(entityId) ?? new Set<string>()
      sources.add(source.sourceId)
      sourcesByEntity.set(entityId, sources)
      if (!entityIds.has(entityId)) findings.push({ id: `SOURCE_POINTS_TO_MISSING_ENTITY:${source.sourceId}:${entityId}`, code: 'SOURCE_POINTS_TO_MISSING_ENTITY', severity: 'REVIEW', title: 'Uma origem aponta para entidade ausente', detail: `A origem ${source.sourceId} referencia ${entityId}, que não está entre as entidades ativas desta sessão.`, technical: { sourceId: source.sourceId, entityId } })
    }
    for (const entityId of entityIds) if (!sourcesByEntity.has(entityId)) findings.push({ id: `ACTIVE_ENTITY_WITHOUT_SOURCE:${entityId}`, code: 'ACTIVE_ENTITY_WITHOUT_SOURCE', severity: 'REVIEW', title: 'Entidade ativa sem origem registrada', detail: 'A entidade financeira atual não possui arquivo de origem nem indicação de inclusão manual na provenance recebida.', technical: { entityId } })
  }
  for (const group of input.duplicateInvoiceSources ?? []) {
    const present = group.sourceIds.filter((id) => currentDrive.has(id))
    const markedMissing = present.filter((id) => missingDrive.has(id))
    if (present.length > 1 && markedMissing.length) findings.push({ id: `DUPLICATE_PRESENT_BUT_MARKED_MISSING:${group.identity}`, code: 'DUPLICATE_PRESENT_BUT_MARKED_MISSING', severity: 'CRITICAL', title: 'Um PDF duplicado presente foi contado como ausente', detail: 'A mesma fatura possui mais de um arquivo presente, mas um deles também foi marcado como ausente.', technical: { financialIdentity: group.identity, currentSourceIds: present, missingSourceIds: markedMissing } })
  }
  for (const group of input.bankRefundGroups ?? []) if (group.status === 'REFUNDED') {
    for (const transactionId of group.originalTransactionIds) {
      const item = input.currentBankItems?.find((candidate) => candidate.bank.id === transactionId)
      if (item?.status === 'MISSING') findings.push({ id: `REFUNDED_BUT_MISSING:${group.id}:${transactionId}`, code: 'REFUNDED_BUT_MISSING', severity: 'CRITICAL', title: 'Saída devolvida ainda aparece como ausente', detail: 'Uma movimentação que foi integralmente devolvida continua listada como despesa ausente.', technical: { refundGroup: group, item } })
    }
  }
  const normalizeBankDescription = (value: string) => value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().replace(/\s+/g, ' ')
  const bankSources = (bank: BankTransaction) => [...new Set(bank.statementSourceIds ?? (bank.statementSourceId ? [bank.statementSourceId] : []))]
  const bySemantic = new Map<string, BankTransaction[]>()
  for (const bank of input.banks.filter((item) => bankSources(item).length > 0)) {
    const key = JSON.stringify([bank.date, normalizeBankDescription(bank.originalDescription), bank.direction, bank.amount])
    bySemantic.set(key, [...(bySemantic.get(key) ?? []), bank])
  }
  // Provenance on one merged entity is evidence that the overlap was already resolved.
  // Only flag separate surviving entities whose source sets are disjoint.
  for (const [key, group] of bySemantic) {
    const unresolvedPairs: [BankTransaction, BankTransaction][] = []
    for (let left = 0; left < group.length; left += 1) for (let right = left + 1; right < group.length; right += 1) {
      const leftSources = new Set(bankSources(group[left]))
      if (bankSources(group[right]).every((source) => !leftSources.has(source))) unresolvedPairs.push([group[left], group[right]])
    }
    if (!unresolvedPairs.length) continue
    const entities = [...new Map(unresolvedPairs.flatMap(([left, right]) => [left, right]).map((item) => [item.id, item])).values()]
    const sources = [...new Set(entities.flatMap(bankSources))]
    findings.push({ id: `DUPLICATE_BANK_TRANSACTION_ACROSS_STATEMENTS:${key}`, code: 'DUPLICATE_BANK_TRANSACTION_ACROSS_STATEMENTS', severity: 'REVIEW', title: 'Possível duplicidade entre extratos não resolvida', detail: `${unresolvedPairs.length} par(es) de movimentações equivalentes permaneceram como lançamentos separados após a consolidação.`, technical: { sources: sources.map((id) => ({ id, name: entities.find((item) => item.statementSourceId === id || item.statementSourceIds?.includes(id))?.statementFileName })), bankTransactionIds: entities.map((item) => item.id), date: group[0].date, amount: group[0].amount } })
  }
  // The merged bank model keeps one canonical value per entity. Inspect parsed source rows
  // separately so a contradictory amount/direction can be reviewed without changing merge behavior.
  const bankDocumentReference = (bank: BankTransaction) => {
    const entry = Object.entries(bank.original).find(([header]) => {
      const normalized = normalizeBankDescription(header)
      return /(^| )(docto|documento|numero documento|num documento|numero doc|num doc|fitid|fit id|id transacao|identificador transacao)( |$)/.test(normalized)
    })
    const value = entry?.[1]?.trim()
    return value && value !== '0' && value !== '-' ? value.toLowerCase() : null
  }
  const sourceOverlap = new Map<string, Map<string, BankTransaction[]>>()
  for (const source of input.bankSourceRows ?? []) for (const transaction of source.transactions) {
    const description = normalizeBankDescription(transaction.originalDescription)
    if (!description) continue
    const document = bankDocumentReference(transaction)
    const key = document ? JSON.stringify(['document', document]) : JSON.stringify(['date-description', transaction.date, description])
    const bySource = sourceOverlap.get(key) ?? new Map<string, BankTransaction[]>()
    bySource.set(source.sourceId, [...(bySource.get(source.sourceId) ?? []), transaction])
    sourceOverlap.set(key, bySource)
  }
  let resolvedOverlapPairs = 0
  for (const [key, bySource] of sourceOverlap) {
    const sources = [...bySource.entries()]
    for (let left = 0; left < sources.length; left += 1) for (let right = left + 1; right < sources.length; right += 1) {
      const [leftId, leftRows] = sources[left], [rightId, rightRows] = sources[right]
      // Require a unique row on each side; repeated same-day merchant entries are ambiguous.
      if (leftRows.length !== 1 || rightRows.length !== 1) continue
      const a = leftRows[0], b = rightRows[0]
      const conflicts = [
        ...(a.date !== b.date ? ['data'] : []),
        ...(a.amount !== b.amount ? ['valor'] : []),
        ...(a.direction !== b.direction ? ['direção'] : []),
        ...(normalizeBankDescription(a.originalDescription) !== normalizeBankDescription(b.originalDescription) ? ['descrição'] : []),
      ]
      if (!conflicts.length) { resolvedOverlapPairs += 1; continue }
      findings.push({ id: `SOURCE_CONFLICT:${key}:${leftId}:${rightId}`, code: 'SOURCE_CONFLICT', severity: 'REVIEW', title: 'Os extratos divergem sobre a mesma movimentação', detail: `As fontes apontam para o mesmo documento, mas divergem em: ${conflicts.join(', ')}.`, technical: { sources: [{ id: leftId, name: input.bankSourceRows?.find((source) => source.sourceId === leftId)?.sourceName }, { id: rightId, name: input.bankSourceRows?.find((source) => source.sourceId === rightId)?.sourceName }], conflicts, documentReference: bankDocumentReference(a), left: { date: a.date, amount: a.amount, direction: a.direction, description: a.originalDescription }, right: { date: b.date, amount: b.amount, direction: b.direction, description: b.originalDescription } } })
    }
  }
  if (resolvedOverlapPairs) findings.push({ id: 'RESOLVED_SOURCE_OVERLAP', code: 'RESOLVED_SOURCE_OVERLAP', severity: 'INFO', status: 'EXPECTED', title: 'Sobreposições entre extratos consolidadas', detail: `${resolvedOverlapPairs} sobreposição(ões) idêntica(s) foram reconhecidas entre fontes e não representam duplicidade pendente.`, technical: { count: resolvedOverlapPairs } })
  const pureStates: Record<string, string> = {}, currentStates: Record<string, string> = Object.fromEntries(input.currentCardMatches.map(({ statementIdentity, transactionId, match }) => {
    const statement = input.statements.find((entry) => entry.statement.statementIdentity === statementIdentity)?.statement
    const transaction = statement?.transactions.find((item) => item.id === transactionId)
    return [transaction && statement ? cardTransactionIdentity(statement, transaction) : `${statementIdentity}\u001f${transactionId}`, statusName(match.status)]
  }))
  const onlySubjectFingerprints = input.onlySubjectFingerprints ? new Set(input.onlySubjectFingerprints) : null
  if (mode === 'PROFUNDA') for (const entry of input.statements) for (const transaction of entry.statement.transactions.filter((tx) => tx.type === 'PURCHASE' && tx.financialStatus !== 'REFUNDED')) {
    const key = `${entry.statement.statementIdentity}\u001f${transaction.id}`
    const identity = cardTransactionIdentity(entry.statement, transaction)
    if (onlySubjectFingerprints && !onlySubjectFingerprints.has(identity)) continue
    const aliases = cardTransactionIdentityVariants(entry.statement, transaction, entry.legacyStatementIdentity)
    const pureMatch = pure.get(key) ?? { transaction, status: 'CARD_MISSING' as const, sheet: null, candidates: [] }
    const current = currentMap.get(key) ?? null
    pureStates[identity] = statusName(pureMatch.status)
    currentStates[identity] = statusName(current?.status)
    const candidates = findExistingCostYearCandidates(entry.statement, transaction, input.sheets)
    const manualReservations = candidates.flatMap((row) => validManualReservations
      .filter((assignment) => sheetIdentity(assignment.row) === sheetIdentity(row) && assignment.subjectId !== identity)
      .map((assignment) => ({ assignment, row })))
    const contestedCandidate = candidates.some((row) => manualAssignmentConflicts.has(sheetIdentity(row))) || manualReservations.length > 0
    const correctedRows = input.sheets.map((row) => {
      const correctedType = classifySheetRecord({ description: row.originalDescription, paymentMethod: row.paymentMethod })
      return correctedType !== row.type ? { ...row, type: correctedType } : row
    })
    const correctedCandidates = findExistingCostYearCandidates(entry.statement, transaction, correctedRows)
    const wronglyClassifiedCandidates = correctedCandidates.filter((candidate) => {
      const original = input.sheets.find((row) => row.id === candidate.id)
      return Boolean(original && original.type !== candidate.type && !candidates.some((row) => row.id === candidate.id))
    })
    const evaluateRows = (rows: LedgerTransaction[], source: 'FONTE DA ANÁLISE' | 'CACHE DA SESSÃO') => {
      const rowCandidates = findExistingCostYearCandidates(entry.statement, transaction, rows)
      return rows.map((row) => {
        const reason = explainCostYearCandidateRejection(entry.statement, transaction, row, rows)
        const accepted = reason === null && rowCandidates.some((candidate) => candidate.id === row.id)
        return { row, source, accepted, reason: reason ?? (accepted ? null : 'passou pelos critérios locais, mas foi removida por regra de seleção do conjunto de candidatos') }
      })
    }
    const currentRows = input.currentSheets ?? input.sheets
    const rowKey = (row: LedgerTransaction) => JSON.stringify([row.id, row.date, row.amount, row.originalDescription, row.paymentMethod, row.direction, row.type, row.installment, row.totalInstallments])
    const currentRowKeys = new Set(input.sheets.map(rowKey))
    const evaluatedCandidates = [...evaluateRows(input.sheets, 'FONTE DA ANÁLISE'), ...evaluateRows(currentRows.filter((row) => !currentRowKeys.has(rowKey(row))), 'CACHE DA SESSÃO')]
    const relatedLocal = effectiveDecisions.filter((item) => item.source === 'LOCAL' && isCardPurchaseDecision(item.decision) && aliases.includes(item.decision.identities[0])).map((item) => item.decision)
    const relatedRemote = effectiveDecisions.filter((item) => item.source === 'REMOTE' && isCardPurchaseDecision(item.decision) && aliases.includes(item.decision.identities[0])).map((item) => item.decision)
    const audits = classifyDecisions(relatedLocal, 'LOCAL', aliases, input.sheets, validated, globalDecisionValidity)
      .concat(classifyDecisions(relatedRemote, 'REMOTE', aliases, input.sheets, validated, globalDecisionValidity))
    const localCandidates = findExistingCostYearCandidates(entry.statement, transaction, input.currentSheets ?? input.sheets)
    const contestedAssignments = candidates.flatMap((row) => manualAssignmentConflicts.get(sheetIdentity(row)) ?? [])
    const claimedBy = [...pure.entries()].flatMap(([otherKey, match]) => {
      if (otherKey === key) return []
      const claimsCandidate = match.status === 'CARD_MATCHED' && match.sheet && candidates.some((candidate) => candidate.id === match.sheet!.id)
        || match.status === 'CARD_GROUP_MATCHED' && match.candidates.some((candidate) => candidates.some((item) => item.id === candidate.id))
      return claimsCandidate ? [otherKey] : []
    })
    const staleDecision = audits.find((audit) => ['STALE', 'ORPHANED', 'LEGACY_BUT_RESOLVABLE'].includes(audit.status))
    const rejectedCandidateDecision = relatedLocal.find((decision) => decision.kind === 'CARD_REVIEW_REJECTED_CANDIDATES' && candidates.some((row) => decision.selected.includes(cardReviewCandidateIdentity(row))))
    const manualAssignment = validManualReservations.find((assignment) => assignment.subjectId === identity)
    const validCardRejection = audits.find((audit) => audit.decision.kind === 'CARD_REVIEW_REJECTED_CANDIDATES' && audit.status === 'VALID')
    const expectedStartedAt = performance.now()
    const expected = deriveExpectedReconciliationState({
      subjectId: identity,
      pureState: pureMatch.status,
      currentState: current?.status ?? 'UNAVAILABLE',
      currentTargetId: current?.sheet?.sheetRecordId || current?.sheet?.id,
      ...(manualAssignment ? { validManualAssignment: { decisionId: stableFingerprint([manualAssignment.decision.key]), targetId: manualAssignment.row.sheetRecordId || manualAssignment.row.id } } : {}),
      ...(validCardRejection ? { validRejection: { decisionId: stableFingerprint([validCardRejection.decision.key]), outcome: 'CARD_MISSING' } } : {}),
      ...(manualReservations[0] ? { reservationOwner: {
        subjectId: manualReservations[0].assignment.subjectId,
        targetId: manualReservations[0].row.sheetRecordId || manualReservations[0].row.id,
        decisionId: stableFingerprint([manualReservations[0].assignment.decision.key]),
      } } : {}),
      ...(current?.status === 'CARD_GROUP_MATCHED' ? { groupResolution: { outcome: current.status, evidence: current.candidates.map((row) => row.sheetRecordId || row.id) } } : {}),
    })
    expectedStateDerivationMs += performance.now() - expectedStartedAt
    const expectedMatch: CardStatementMatch | null = current
      ? { ...current, status: expected.expectedState as CardStatementMatch['status'], ...(manualAssignment ? { sheet: manualAssignment.row, candidates: [] } : {}) }
      : null
    const diagnosis = manualReservations.length
      ? `O matcher puro encontrou ${pureMatch.status}, mas ${manualReservations.map(({ assignment }) => {
        const ownerTransaction = assignment.statement.transactions.find((item) => item.id === assignment.transactionId)!
        return `${assignment.row.sheetRecordId || assignment.row.id} está reservada por uma confirmação manual válida para ${ownerTransaction.originalDescription} (${ownerTransaction.purchaseDate || ownerTransaction.date})`
      }).join('; ')}. A reserva é mantida para essa compra e evita que esta movimentação reutilize a mesma linha.`
      : contestedAssignments.length
      ? `O matcher puro encontrou ${pureMatch.status}; o resultado mudou na etapa de reserva/conflito após a aplicação de decisões manuais. ${contestedAssignments.map((assignment) => `${assignment.decision.key} reserva ${assignment.row.sheetRecordId || assignment.row.id} para ${assignment.subjectId}`).join('; ')}. A linha não pode ser atribuída automaticamente enquanto as confirmações incompatíveis estiverem ativas.`
      : current?.status === 'CARD_MISSING' && rejectedCandidateDecision
      ? `A decisão persistida CARD_REVIEW_REJECTED_CANDIDATES removeu o(s) candidato(s) ${candidates.filter((row) => rejectedCandidateDecision.selected.includes(cardReviewCandidateIdentity(row))).map((row) => row.sheetRecordId || row.id).join(', ')} na etapa de filtragem pós-geração. Com a decisão ignorada, o matcher puro retorna ${pureMatch.status}.`
      : current?.status === 'CARD_MISSING' && pureMatch.status !== 'CARD_MISSING'
      ? staleDecision ? `O estado muda no estágio de aplicação das decisões: ${staleDecision.decision.kind} (${staleDecision.status}). O matcher puro encontra ${pureMatch.status}.` : localCandidates.length === 0 && candidates.length > 0 ? 'A tela foi calculada com uma cópia anterior de CUSTOS ANO; a releitura encontrou candidato e o matching puro encontra correspondência.' : 'A divergência surge entre o matching calculado para a tela e o recálculo sem decisões; nenhuma decisão persistida relacionada foi identificada.'
      : current?.status === 'CARD_MISSING' && candidates.length === 0 && localCandidates.length > 0 ? 'A sessão tinha candidato(s) em seu cache local, mas a releitura atual da CUSTOS ANO não os contém; os dados usados pela tela e a fonte atual divergem.'
      : current?.status === 'CARD_MISSING' && pureMatch.status === 'CARD_MISSING' && candidates.length === 0 ? 'A compra continua MISSING no matcher puro: nenhum candidato passou pelos critérios compartilhados. Os descartes abaixo mostram linhas avaliadas e o motivo.'
        : current?.status === 'CARD_MISSING' && candidates.length > 0 ? 'O estado MISSING atual contradiz a busca compartilhada de candidatos; confira a etapa de aplicação global/multiplicidade e os IDs consumidos.'
          : pureMatch.status === 'CARD_MATCHED' ? 'A busca de candidatos e o matching global selecionam uma linha atual; o caminho puro não produz MISSING.'
            : `O matcher puro retornou ${pureMatch.status}; os candidatos e evidências mostram o estágio alcançado.`
    const item: AuditedCardItem = { statement: entry.statement, transaction, pure: pureMatch, current, expectedState: expectedMatch, explanationChain: expected.explanationChain, candidates, fingerprint: identity, aliases, decisions: audits, discarded: rejectedReasons(entry.statement, transaction, input.sheets), evaluatedCandidates, claimedBy, diagnosis }
    items.push(item)
    const add = (code: AuditCode, severity: AuditSeverity, title: string, detail: string, technical?: Record<string, unknown>) => findings.push({ id: `${code}:${identity}`, code, severity, title, detail, item,
      ...(technical ? { technical } : {}),
      ...(code === 'EXPECTED_MANUAL_RESERVATION' ? { status: 'EXPECTED' as const, explanationSource: 'ASSIGNMENT' as const, currentState: String(technical?.current ?? ''), expectedState: String(technical?.expectedState ?? ''), pureState: String(technical?.pure ?? '') } : {}),
    })
    if (manualReservations.length && (current?.status === 'CARD_MISSING' || current?.status === 'CARD_REVIEW')) {
      add('EXPECTED_MANUAL_RESERVATION', 'INFO', 'Candidata reservada por outra compra', 'O matcher puro encontrou uma linha compatível, mas uma confirmação manual válida a reservou para outra compra. O estado atual desta compra respeita essa reserva.', {
        pure: pureMatch.status, current: current.status, expectedState: current.status, reservationIsExpected: true,
        reservations: manualReservations.map(({ assignment, row }) => {
          const ownerTransaction = assignment.statement.transactions.find((item) => item.id === assignment.transactionId)!
          return {
          row: { id: row.sheetRecordId || row.id, sheetIdentity: sheetIdentity(row), description: row.originalDescription, date: row.date, amount: row.amount },
          owner: { subjectId: assignment.subjectId, description: ownerTransaction.originalDescription, purchaseDate: ownerTransaction.purchaseDate || ownerTransaction.date, invoiceDueDate: ownerTransaction.invoiceDueDate ?? assignment.statement.dueDate, statementIdentity: assignment.statement.statementIdentity },
          decision: { id: stableFingerprint([assignment.decision.key]), key: assignment.decision.key, kind: assignment.decision.kind, selected: assignment.decision.selected },
          }
        }),
      })
    }
    if (current?.status === 'CARD_MISSING' && candidates.length && !contestedCandidate) add('MISSING_COM_CANDIDATO', 'CRITICAL', 'Compra marcada como ausente, mas há candidato', `O matching atual mostra MISSING; a busca compartilhada do pré-check encontrou ${candidates.length} candidato(s).`, { candidates: candidates.map((row) => ({ id: row.id, date: row.date, description: row.originalDescription, amount: row.amount })) })
    if (pureMatch.status === 'CARD_MISSING' && candidates.length === 0 && wronglyClassifiedCandidates.length > 0) {
      const canAppend = canAddMissingToCostYear({ source: 'STATEMENT', status: current?.status ?? pureMatch.status, direction: transaction.direction, type: transaction.type }).eligible
      const severity: AuditSeverity = canAppend && current?.status === 'CARD_MISSING' ? 'CRITICAL' : 'REVIEW'
      add('CARD_MISSING_NO_CANDIDATE', severity, severity === 'CRITICAL' ? 'Linha de despesa descartada pode gerar duplicidade' : 'Linha plausível foi descartada pela classificação', `A busca atual excluiu ${wronglyClassifiedCandidates.length} linha(s) pela natureza registrada, mas a classificação centralizada as reconhece como ${wronglyClassifiedCandidates[0].type}.${severity === 'CRITICAL' ? ' A compra está marcada como ausente e a ação de adicionar está disponível, com risco de duplicar o lançamento.' : ' A compra não está liberada para inclusão como ausente.'}`, { rejectedRows: wronglyClassifiedCandidates.map((row) => ({ id: row.id, sheetRecordId: row.sheetRecordId, typeBefore: input.sheets.find((source) => source.id === row.id)?.type, typeAfter: row.type, date: row.date, description: row.originalDescription, amount: row.amount, paymentMethod: row.paymentMethod, reason: 'natureza incompatível antes da classificação centralizada' })), canAppend })
    }
    if (current?.status === 'CARD_MISSING' && rejectedCandidateDecision) add('REJECTED_CANDIDATE_FILTERED', 'CRITICAL', 'Decisão anterior removeu um candidato válido', 'A rejeição salva corresponde exatamente a uma linha que a busca atual considera candidata; a filtragem dessa decisão transforma o resultado em MISSING.', { decision: rejectedCandidateDecision, candidateIds: candidates.map((row) => row.id) })
    if (current && current.status !== pureMatch.status && !contestedCandidate) {
      const canAppend = canAddMissingToCostYear({ source: 'STATEMENT', status: current.status, direction: transaction.direction, type: transaction.type }).eligible
      const severity = derivedMismatchSeverity(pureMatch.status, current.status, canAppend)
      const stage = pureMatch.status === 'CARD_REVIEW' && current.status === 'CARD_GROUP_MATCHED' ? { base: 'CARD_REVIEW', later: 'GROUP_MATCHING / multiplicidade', final: 'CARD_GROUP_MATCHED', conclusion: 'comportamento esperado após atribuição global' } : null
      const manuallyConfirmed = current.status === 'CARD_MATCHED' && current.sheet != null && audits.some((audit) => audit.decision.kind === 'STATEMENT_MATCH_CONFIRMED'
        && audit.status === 'VALID' && audit.decision.selected.some((identity) => identity === sheetIdentity(current.sheet!) || identity === current.sheet!.id || identity === current.sheet!.sheetRecordId))
      if (manuallyConfirmed) add('EXPECTED_OVERRIDE', 'INFO', 'Confirmação manual explica o resultado', 'O resultado atual difere do matcher puro porque existe uma confirmação manual válida para este lançamento.', { pure: pureMatch.status, current: current.status, expectedState: current.status, validManualConfirmation: true, decisionKinds: audits.filter((audit) => audit.decision.kind === 'STATEMENT_MATCH_CONFIRMED' && audit.status === 'VALID').map((audit) => audit.decision.kind) })
      else if (stage) add('EXPECTED_GROUP_RESOLUTION', 'INFO', 'Correspondência explicada pela análise em grupo', 'A etapa de group matching resolveu a ambiguidade encontrada na análise individual.', { pure: pureMatch.status, current: current.status, expectedState: current.status, pipeline: stage })
      else add('DERIVED_STATE_MISMATCH', severity, 'Estado exibido difere do recálculo puro', `Estado base sem decisões: ${pureMatch.status}. Estado final da interface: ${current.status}.${severity === 'CRITICAL' ? ' Esta diferença pode ocultar despesa ou liberar inclusão duplicada.' : ' A divergência requer revisão, mas não foi classificada como risco crítico.'}`, { pure: pureMatch.status, current: current.status, canAppend })
    }
    if (current?.status === 'CARD_MISSING' && candidates.length && localCandidates.length === 0 && !contestedCandidate) add('CURRENT_SOURCE_DIVERGENCE', input.auditInputSnapshot?.mixedRevisionSources.length ? 'REVIEW' : 'CRITICAL', 'Fonte da tela desatualizada', `A cópia de CUSTOS ANO usada pela tela não contém o candidato. A leitura feita pela auditoria encontrou ${candidates.length} candidato(s).`, { currentCandidateIds: [], refreshedCandidateIds: candidates.map((row) => row.id), classification: input.auditInputSnapshot?.mixedRevisionSources.length ? 'DERIVED_RESULT_FROM_DIFFERENT_REVISION' : 'CURRENT_SOURCE_DIVERGENCE' })
    if (current?.status === 'CARD_MISSING' && candidates.length === 0 && localCandidates.length > 0) add('CURRENT_SOURCE_DIVERGENCE', 'REVIEW', 'Linha do cache não apareceu na fonte atual', 'Uma linha que passava pelo matching na cópia desta sessão não veio na leitura atual de CUSTOS ANO. A fonte atual foi preservada como referência.', { cachedCandidateIds: localCandidates.map((row) => row.id), refreshedCandidateIds: [], classification: 'SESSION_SNAPSHOT_DIFFERS_FROM_AUDIT_SOURCE' })
    if (pureMatch.status === 'CARD_MISSING' && candidates.length) add('PREWRITE_MATCH_MISMATCH', 'CRITICAL', 'Pré-check e matching divergem', `O matching puro retornou MISSING, mas findExistingCostYearCandidates — também usado antes de escrever — encontrou ${candidates.length} linha(s).`, { candidateIds: candidates.map((row) => row.id) })
    const missingDecision = audits.find((decision) => decision.decision.kind === 'CARD_MISSING_CONFIRMED')
    if (missingDecision && candidates.length) add('STALE_MISSING_DECISION', 'REVIEW', 'Decisão antiga de ausência com candidato atual', `${missingDecision.source}: CARD_MISSING_CONFIRMED foi associada à compra, mas existe candidato atual.`)
    for (const audit of audits) {
      if (audit.status === 'ORPHANED') findings.push({ id: `ORPHANED_SHEET_REFERENCE:${identity}:${audit.decision.key}`, code: 'ORPHANED_SHEET_REFERENCE', severity: current?.status === 'CARD_MATCHED' || current?.status === 'CARD_GROUP_MATCHED' ? 'INFO' : 'REVIEW', status: current?.status === 'CARD_MATCHED' || current?.status === 'CARD_GROUP_MATCHED' ? 'MAINTENANCE' : 'ACTIVE', title: 'Decisão aponta para linha inexistente', detail: `${audit.decision.kind}: ${audit.explanation}`, item })
      else if (audit.status === 'STALE') findings.push({ id: `EDITED_SHEET_REFERENCE:${identity}:${audit.decision.key}`, code: 'EDITED_SHEET_REFERENCE', severity: current?.status === 'CARD_MATCHED' || current?.status === 'CARD_GROUP_MATCHED' ? 'INFO' : 'REVIEW', status: current?.status === 'CARD_MATCHED' || current?.status === 'CARD_GROUP_MATCHED' ? 'MAINTENANCE' : 'ACTIVE', title: 'Linha vinculada foi alterada', detail: `${audit.decision.kind}: a linha ainda existe, mas deixou de satisfazer a decisão.`, item })
      else if (audit.status === 'CONFLICTING') add('EDITED_SHEET_REFERENCE', 'REVIEW', 'Linha vinculada exige revisão', `${audit.decision.kind}: ${audit.explanation}`)
      else if (audit.status === 'LEGACY_BUT_RESOLVABLE') findings.push({ id: `LEGACY_FINGERPRINT_MATCH:${identity}:${audit.decision.key}`, code: 'LEGACY_FINGERPRINT_MATCH', severity: 'INFO', status: 'LEGACY', title: 'Fingerprint legado reconhecido', detail: `${audit.decision.kind}: decisão antiga corresponde a uma variante histórica.`, item })
      if (audit.decision.kind === 'MISSING_ADDED_TO_SHEET' && audit.status === 'ORPHANED') add('MISSING_ADDED_TO_SHEET_ORPHAN', 'REVIEW', 'Linha adicionada não existe mais', 'A decisão de adição está salva, mas o ID referenciado não aparece na CUSTOS ANO atual.')
      if (audit.decision.kind === 'CARD_PURCHASE_IGNORED' && candidates.length) add('IGNORED_DECISION_REVIEW', 'REVIEW', 'Decisão ignorada merece revisão', 'Há candidato atual; a decisão humana de ignorar foi preservada.')
    }
    if (pureMatch.status === 'CARD_REVIEW' && candidates.length && entry.statement.dueDate) {
      const due = Date.parse(`${entry.statement.dueDate}T00:00:00Z`)
      const priorOnly = candidates.every((row) => {
        const candidateDate = Date.parse(`${row.date}T00:00:00Z`)
        return Number.isFinite(due) && Number.isFinite(candidateDate) && due - candidateDate > 45 * 86400000
      })
      if (priorOnly) add('REVIEW_ONLY_WRONG_CYCLE_CANDIDATES', 'REVIEW', 'Candidatos de revisão pertencem a ciclos anteriores', 'Todos os candidatos de cartão estão datados antes do vencimento desta fatura.', { candidateDates: candidates.map((row) => row.date) })
    }
    if ((current?.status === 'CARD_MISSING' || current?.status === 'CARD_REVIEW') && candidates.length && pureMatch.status !== 'CARD_MATCHED' && pureMatch.status !== 'CARD_GROUP_MATCHED') add('UNUSED_STRONG_CANDIDATE', 'REVIEW', 'Candidato forte não utilizado', 'Existe candidato aceito pela busca de cartão, mas a atribuição global não o consumiu nesta compra.', { candidateIds: candidates.map((row) => row.id), pure: pureMatch.status, current: current.status })
  }

  type ClaimDetail = { id: string; origin: string; type: string; description: string; date: string; amount: number | null }
  type ClaimSubject = ClaimDetail & { sources: Set<string>; decisionTypes: Set<string>; decisions: PersistedDecision[]; groupMembers: Map<string, ClaimDetail & { sources: Set<string>; decisionTypes: Set<string> }> }
  type ClaimInput = ClaimDetail & { groupMembers?: Map<string, ClaimDetail & { sources: Set<string>; decisionTypes: Set<string> }> }
  const claims = new Map<string, { row: LedgerTransaction; subjects: Map<string, ClaimSubject> }>()
  const addClaim = (row: LedgerTransaction, subject: ClaimInput, source: string, decisionType?: string, decision?: PersistedDecision) => {
    const rowKey = sheetIdentity(row)
    const bucket = claims.get(rowKey) ?? { row, subjects: new Map<string, ClaimSubject>() }
    const current = bucket.subjects.get(subject.id) ?? { id: subject.id, origin: subject.origin, type: subject.type, description: subject.description, date: subject.date, amount: subject.amount, sources: new Set<string>(), decisionTypes: new Set<string>(), decisions: [], groupMembers: new Map<string, ClaimDetail & { sources: Set<string>; decisionTypes: Set<string> }>() }
    current.sources.add(source)
    if (decisionType) current.decisionTypes.add(decisionType)
    if (decision && !current.decisions.some((item) => item.key === decision.key)) current.decisions.push(decision)
    if (subject.groupMembers) for (const [key, member] of subject.groupMembers) current.groupMembers.set(key, member)
    bucket.subjects.set(subject.id, current)
    claims.set(rowKey, bucket)
  }
  const resolveStatementSubject = (identity: string) => {
    for (const entry of input.statements) {
      const transaction = entry.statement.transactions.find((item) => cardTransactionIdentityVariants(entry.statement, item, entry.legacyStatementIdentity).includes(identity))
      if (transaction) return { id: cardTransactionIdentity(entry.statement, transaction), origin: 'Fatura PDF', type: 'Compra de cartão', description: transaction.originalDescription, date: transaction.purchaseDate || transaction.date, amount: transaction.amount }
    }
    return { id: identity, origin: 'Decisão histórica', type: 'Compra de cartão', description: identity, date: '', amount: null }
  }
  for (const snapshot of effectiveDecisions.filter((item) => item.state === 'ACTIVE' && item.decision.kind === 'STATEMENT_MATCH_CONFIRMED')) {
    const audit = validated.find((item) => item.decision.key === snapshot.decision.key)
    const hasConflictingManualOwner = [...manualAssignmentConflicts.values()].some((assignments) => assignments.some((assignment) => assignment.decision.key === snapshot.decision.key))
    if (audit?.status !== 'VALID' || hasConflictingManualOwner) continue
    const subject = resolveStatementSubject(snapshot.decision.identities[0] ?? snapshot.decision.key)
    for (const ref of snapshot.decision.selected) {
      const row = input.sheets.find((item) => sheetIdentity(item) === ref || item.sheetRecordId === ref || item.id === ref)
      if (row) addClaim(row, subject, `decisão ativa ${snapshot.source.toLocaleLowerCase('pt-BR')}`, snapshot.decision.kind, snapshot.decision)
    }
  }
  for (const current of input.currentCardMatches) {
    const rows = current.match.status === 'CARD_MATCHED' && current.match.sheet ? [current.match.sheet] : current.match.status === 'CARD_GROUP_MATCHED' ? current.match.candidates : []
    if (!rows.length) continue
    const subject = resolveStatementSubject(cardTransactionIdentity(current.statementIdentity, current.match.transaction))
    const source = current.match.status === 'CARD_GROUP_MATCHED' ? 'group matching / multiplicidade' : 'matching atual'
    const groupId = current.match.status === 'CARD_GROUP_MATCHED' ? `group:${current.statementIdentity}:${rows.map(sheetIdentity).sort().join('|')}` : subject.id
    const groupMember = { id: subject.id, origin: subject.origin, type: subject.type, description: subject.description, date: subject.date, amount: subject.amount, sources: new Set([source]), decisionTypes: new Set<string>() }
    for (const row of rows) addClaim(row, { ...subject, id: groupId, groupMembers: current.match.status === 'CARD_GROUP_MATCHED' ? new Map([[subject.id, groupMember]]) : new Map() }, source)
  }
  for (const [rowKey, bucket] of claims) {
    const subjects = [...bucket.subjects.values()]
    if (subjects.length <= 1) continue
    const resolvedSubjects = subjects.filter((subject) => [...subject.sources].some((source) => source === 'matching atual' || source.startsWith('decisão ativa')))
    const severity: AuditSeverity = resolvedSubjects.length > 1 ? 'CRITICAL' : 'INFO'
    const row = bucket.row
    const renderedSubjects = subjects.flatMap((subject) => subject.groupMembers.size ? [...subject.groupMembers.values()] : [subject])
    const origins = [...new Set(subjects.flatMap((subject) => [...subject.sources]))]
    const currentFor = (subjectId: string) => {
      for (const entry of input.statements) {
        const transaction = entry.statement.transactions.find((item) => cardTransactionIdentity(entry.statement, item) === subjectId)
        if (!transaction) continue
        const match = input.currentCardMatches.find((item) => item.statementIdentity === entry.statement.statementIdentity && item.transactionId === transaction.id)?.match
        return match ? { entry, transaction, match } : null
      }
      return null
    }
    const exactCycleMatch = (subjectId: string, candidate: LedgerTransaction) => {
      const resolved = currentFor(subjectId)
      if (!resolved || resolved.match.status !== 'CARD_MATCHED' || !resolved.match.sheet || sheetIdentity(resolved.match.sheet) !== sheetIdentity(candidate)) return false
      const dueDate = resolved.transaction.invoiceDueDate ?? resolved.transaction.statementDueDate ?? resolved.entry.statement.dueDate
      const passesCandidateRules = findExistingCostYearCandidates(resolved.entry.statement, resolved.transaction, [candidate]).some((item) => sheetIdentity(item) === sheetIdentity(candidate))
      const installmentMatch = resolved.transaction.installment != null
        && candidate.installment === resolved.transaction.installment
        && candidate.totalInstallments === resolved.transaction.totalInstallments
      return passesCandidateRules && candidate.amount === resolved.transaction.amount && candidate.direction === 'DEBIT'
        && normalizeDescription(candidate.paymentMethod) === 'credito bradesco'
        && (candidate.date === dueDate || installmentMatch)
    }
    const decisionSubjects = subjects.filter((subject) => subject.decisions.length > 0 && !subject.groupMembers.size)
    let safeInvalidation: Record<string, unknown> | undefined
    if (subjects.length === 2 && decisionSubjects.length === 1) {
      const obsoleteSubject = decisionSubjects[0]
      const decision = obsoleteSubject.decisions[0]
      const winner = subjects.find((subject) => subject.id !== obsoleteSubject.id && subject.sources.has('matching atual') && !subject.groupMembers.size)
      const activeClaimsForRow = effectiveDecisions.filter((snapshot) => snapshot.state === 'ACTIVE'
        && snapshot.decision.kind === 'STATEMENT_MATCH_CONFIRMED'
        && snapshot.decision.selected.some((ref) => ref === rowKey || ref === row.sheetRecordId || ref === row.id))
      const obsoleteAudit = validated.find((item) => item.decision.key === decision.key)
      const oldCurrent = currentFor(obsoleteSubject.id)
      const oldHasSeparateCurrentMatch = Boolean(oldCurrent?.match.status === 'CARD_MATCHED' && oldCurrent.match.sheet
        && sheetIdentity(oldCurrent.match.sheet) !== rowKey && exactCycleMatch(obsoleteSubject.id, oldCurrent.match.sheet))
      const decisionIsIncompatible = obsoleteAudit?.status === 'STALE'
      if (winner && decision.kind === 'STATEMENT_MATCH_CONFIRMED' && activeClaimsForRow.length === 1
        && (oldHasSeparateCurrentMatch || decisionIsIncompatible)
        && exactCycleMatch(winner.id, row)) {
        safeInvalidation = {
          decision,
          decisionId: stableFingerprint([decision.key]),
          decisionKey: decision.key,
          obsoleteSubject: { description: obsoleteSubject.description, date: obsoleteSubject.date, amount: obsoleteSubject.amount, fingerprint: obsoleteSubject.id },
          winningSubject: { description: winner.description, date: winner.date, amount: winner.amount, fingerprint: winner.id },
          row: { id: row.sheetRecordId || row.id, sheetIdentity: rowKey, description: row.originalDescription, date: row.date, amount: row.amount, paymentMethod: row.paymentMethod },
          separateMatch: oldHasSeparateCurrentMatch && oldCurrent?.match.sheet ? { description: oldCurrent.match.sheet.originalDescription, date: oldCurrent.match.sheet.date, amount: oldCurrent.match.sheet.amount, id: oldCurrent.match.sheet.sheetRecordId || oldCurrent.match.sheet.id } : null,
          proof: { winningSubjectHasExactCycleMatch: true, obsoleteSubjectHasSeparateCurrentMatch: oldHasSeparateCurrentMatch, obsoleteDecisionStatus: obsoleteAudit?.status ?? 'UNAVAILABLE', onlyTwoSubjectsClaimThisRow: true },
        }
      }
    }
    findings.push({
      id: `DOUBLE_CLAIM:${rowKey}`, code: 'DOUBLE_CLAIM', severity,
      title: severity === 'CRITICAL' ? 'Uma linha da CUSTOS ANO está atribuída a mais de uma compra' : 'Compartilhamento explicado por group matching',
      detail: `CUSTOS ANO ${row.sheetRecordId || row.id} · ${row.originalDescription} · ${row.date} · ${row.amount} centavos · ${row.paymentMethod}. Há ${renderedSubjects.length} subject(s) relacionado(s); origem: ${origins.join(', ')}.`,
      ...((decisionSubjects.length > 0 || effectiveDecisions.some((entry) => entry.state === 'ACTIVE' && entry.decision.kind === 'STATEMENT_MATCH_CONFIRMED' && entry.decision.selected.some((ref) => ref === rowKey || ref === row.id || ref === row.sheetRecordId))) && renderedSubjects.length > 1 ? { relatedFindings: [{ code: 'DOUBLE_CLAIM_AFTER_CONFIRMATION' as const, title: 'A escolha manual deixou outro vínculo ativo', detail: 'Mais de uma compra continua reivindicando a linha depois de existir uma confirmação manual ativa. A linha deve ter somente um vínculo.', technical: { decisionKeys: decisionSubjects.flatMap((subject) => subject.decisions.map((decision) => decision.key)), sheetIdentity: rowKey }, role: 'RELATED' as const, rootCauseKey: `SHEET_ROW_MULTIPLE_OWNERS:${rowKey}` }] } : {}),
      technical: {
        row: { id: row.sheetRecordId || row.id, sheetIdentity: rowKey, description: row.originalDescription, date: row.date, amount: row.amount, paymentMethod: row.paymentMethod },
        subjects: renderedSubjects.map((subject) => ({ origin: subject.origin, type: subject.type, description: subject.description, date: subject.date, amount: subject.amount, sources: [...subject.sources], decisions: [...subject.decisionTypes], fingerprint: subject.id })),
        claimSources: origins,
        ...(safeInvalidation ? { safeInvalidation } : {}),
      },
    })
  }
  const decisionIndex = new Map(allDecisions.map((decision) => [decision.key, decision]))
  for (const application of input.appliedDecisions ?? []) {
    const decision = decisionIndex.get(application.decisionKey)
    if (!decision) continue
    const expected = DECISION_DOMAIN[decision.kind]
    if (application.appliedDomain !== expected) findings.push({ id: `WRONG_DECISION_DOMAIN:${application.subjectFingerprint}:${decision.key}`, code: 'WRONG_DECISION_DOMAIN', severity: 'CRITICAL', title: 'Decisão aplicada no domínio errado', detail: `${decision.kind} pertence a ${expected}, mas foi observada aplicada em ${application.appliedDomain}.`, technical: { decision, subjectFingerprint: application.subjectFingerprint, expectedDomain: expected, appliedDomain: application.appliedDomain } })
  }
  for (const conflict of mergeAudit.conflicts) findings.push({ id: `LOCAL_REMOTE_DECISION_DIVERGENCE:${conflict.key}`, code: 'LOCAL_REMOTE_DECISION_DIVERGENCE', severity: 'REVIEW', title: 'Conflito real entre decisão local e remota', detail: conflict.reason, technical: { local: conflict.local, remote: conflict.remote } })
  const pendingCount = mergeAudit.pendingLocalUpdate.length + mergeAudit.pendingRemoteUpdate.length
  if (pendingCount) findings.push({ id: 'SYNC_PENDING:decisions', code: 'SYNC_PENDING', severity: 'INFO', title: `${pendingCount} decisão(ões) aguardam sincronização`, detail: 'A diferença local/remota é resolvível pelas regras normais: versão mais nova vence e o remoto vence empates. Nenhuma revisão financeira é necessária.', technical: { localUpdates: mergeAudit.pendingLocalUpdate, remoteUpdates: mergeAudit.pendingRemoteUpdate, count: pendingCount } })
  for (const audit of validated) if (audit.decision.kind === 'MISSING_ADDED_TO_SHEET' && audit.status === 'ORPHANED') findings.push({ id: `MISSING_ADDED_TO_SHEET_ORPHAN:${audit.decision.key}`, code: 'MISSING_ADDED_TO_SHEET_ORPHAN', severity: 'INFO', status: 'MAINTENANCE', title: 'Linha adicionada não existe mais', detail: 'A decisão de adição está salva, mas o ID referenciado não aparece na CUSTOS ANO atual.', technical: { decision: audit.decision } })
  const expectedStates = Object.fromEntries([
    ...Object.entries(expectedBankStates),
    ...items.map((item) => [item.fingerprint, { subjectId: item.fingerprint, pureState: item.pure.status, expectedState: item.expectedState?.status ?? 'UNAVAILABLE', currentState: item.current?.status ?? 'UNAVAILABLE', explanationChain: item.explanationChain, ...(item.expectedState?.sheet ? { expectedTargetId: item.expectedState.sheet.sheetRecordId || item.expectedState.sheet.id } : {}) }]),
  ])
  let deduplicated = groupPrimaryFindings(deduplicateAuditFindings(findings.filter((finding) => finding.code !== 'DOUBLE_CLAIM_AFTER_CONFIRMATION')).map(enrichFinding))
  const auditSelfChecks = runAuditSelfChecks({ items, expectedStates, findings: deduplicated, decisions: allDecisions, snapshot: input.auditInputSnapshot })
  const failedSelfChecks = auditSelfChecks.filter((check) => check.status === 'FAIL')
  if (failedSelfChecks.length) {
    const internal = enrichFinding({
      id: 'AUDITOR_INTERNAL_INCONSISTENCY:result', code: 'AUDITOR_INTERNAL_INCONSISTENCY', severity: 'REVIEW', category: 'STATE', invariantId: 'INV-14',
      title: 'O relatório precisa de revisão técnica', detail: `${failedSelfChecks.length} autocheck(s) do Auditor não passaram: ${failedSelfChecks.map((check) => check.checkId).join(', ')}.`,
      technical: { selfChecks: failedSelfChecks }, role: 'PRIMARY', rootCauseCode: 'AUDITOR_INTERNAL_INCONSISTENCY', rootCauseKey: 'AUDITOR_INTERNAL_INCONSISTENCY:result',
    })
    deduplicated = [...deduplicated, internal]
  }
  const invariantStartedAt = performance.now()
  const invariantExecutions = evaluateInvariantExecutions(input, deduplicated, mode)
  const invariantChecksMs = performance.now() - invariantStartedAt
  const finalSelfChecks = failedSelfChecks.length ? auditSelfChecks : runAuditSelfChecks({ items, expectedStates, findings: deduplicated, decisions: allDecisions, snapshot: input.auditInputSnapshot })
  const evaluatedPurchases = input.statements.reduce((count, entry) => count + entry.statement.transactions.filter((tx) => tx.type === 'PURCHASE' && tx.financialStatus !== 'REFUNDED').length, 0)
  return { mode, recomputation: { performed: mode === 'PROFUNDA', readOnly: true, persistedDecisionsApplied: false }, findings: deduplicated, items, decisionAudit: validated.map((audit) => {
    const validity = globalDecisionValidity.get(audit.decision.key) ?? (audit.status === 'VALID' ? 'VALID_GLOBALLY' : audit.status === 'ORPHANED' || audit.status === 'STALE' ? 'INVALID_TARGET' : 'NEEDS_REVIEW')
    return { decision: audit.decision, status: globalDecisionValidity.has(audit.decision.key) ? 'CONFLICTING' as const : audit.status, source: 'LOCAL' as const, explanation: globalDecisionValidity.has(audit.decision.key) ? 'A decisão participa de um conflito global de atribuição da linha CUSTOS ANO.' : audit.status, structurallyValid: audit.status === 'VALID', validity }
  }), auditedAt: new Date().toISOString(), pureStates, currentStates, expectedStates, invariantExecutions, auditSelfChecks: finalSelfChecks, performance: { totalMs: performance.now() - auditStartedAt, expectedStateDerivationMs, invariantChecksMs }, summary: summarizeAudit(deduplicated, items, evaluatedPurchases, mode, invariantExecutions), auditInputSnapshot: input.auditInputSnapshot }
}

/** Adds the end-of-run revision comparison without changing the frozen audit inputs. */
export function finalizeAuditInputSnapshot(result: ConsistencyAuditResult, snapshot: AuditInputSnapshot): ConsistencyAuditResult {
  const uncertain = snapshot.state === 'STALE' || snapshot.state === 'MIXED_REVISION'
  const dependentCodes = new Set<AuditCode>(['CURRENT_SOURCE_DIVERGENCE', 'STALE_DECISION_RESULT', 'VALID_BANK_MANUAL_MATCH_NOT_APPLIED', 'VALID_MANUAL_MATCH_NOT_APPLIED', 'REJECTED_CANDIDATE_FILTERED', 'MISSING_COM_CANDIDATO', 'MISSING_WITH_STRONG_CANDIDATE', 'DERIVED_STATE_MISMATCH', 'MISSING_ACTION_INCONSISTENCY', 'CARD_PAYMENT_AS_EXPENSE_MISSING', 'REVIEW_WITHOUT_CANDIDATES', 'ASSIGNMENT_CONFLICT', 'UNUSED_STRONG_CANDIDATE'])
  const findings: AuditFinding[] = result.findings.map((finding) => {
    const confidenceEvidence = { ...(finding.confidenceEvidence ?? { identityQuality: 'INCOMPLETE' as const, sourceCoverage: snapshot.state, revisionComparable: true, evidenceCount: 0, validDecision: false, targetCanonical: false }), sourceCoverage: snapshot.state, revisionComparable: !uncertain }
    const confidence: DiagnosticConfidence = uncertain ? 'LOW' : snapshot.state === 'PARTIAL' ? 'MEDIUM' : finding.diagnosticConfidence
    return uncertain && dependentCodes.has(finding.code)
      ? { ...finding, severity: 'REVIEW' as const, diagnosticConfidence: confidence, confidenceEvidence, technical: { ...finding.technical, auditSnapshotUncertain: true, snapshotState: snapshot.state } }
      : { ...finding, diagnosticConfidence: confidence, confidenceEvidence }
  })
  if (uncertain) {
    const stateText = snapshot.state === 'STALE'
      ? `As fontes mudaram após a captura (${snapshot.staleSources.join(', ')}). Esta execução usou integralmente as entradas capturadas no início; execute novamente para avaliar o estado atual.`
      : `O resultado derivado foi calculado com revisão diferente da usada pela auditoria (${snapshot.mixedRevisionSources.join(', ')}). Sintomas dependentes dessa comparação foram rebaixados para revisão.`
    findings.push(enrichFinding({
      id: `AUDIT_INPUT_REVISION_MISMATCH:${snapshot.capturedAt}:${snapshot.state}`, code: 'AUDIT_INPUT_REVISION_MISMATCH', severity: 'REVIEW', category: 'SOURCE', invariantId: 'INV-12',
      title: snapshot.state === 'PARTIAL' ? 'Auditoria parcial' : 'Revisões das entradas da auditoria não são comparáveis', detail: stateText,
      technical: { snapshotState: snapshot.state, revisions: snapshot.revisions, staleSources: snapshot.staleSources, mixedRevisionSources: snapshot.mixedRevisionSources, unavailableSources: snapshot.unavailableSources },
    }))
  }
  const deduplicated = groupPrimaryFindings(deduplicateAuditFindings(findings).map(enrichFinding)).map((finding) => {
    const evidence = { ...(finding.confidenceEvidence ?? { identityQuality: 'INCOMPLETE' as const, sourceCoverage: snapshot.state, revisionComparable: !uncertain, evidenceCount: 0, validDecision: false, targetCanonical: false }), sourceCoverage: snapshot.state, revisionComparable: !uncertain }
    return { ...finding, confidenceEvidence: evidence, diagnosticConfidence: uncertain ? 'LOW' as const : snapshot.state === 'PARTIAL' ? 'MEDIUM' as const : finding.diagnosticConfidence }
  })
  const invariantExecutions = result.invariantExecutions.map((execution) => {
    const findingsForInvariant = deduplicated.filter((finding) => finding.invariantId === execution.invariantId)
    const staleSkipped = (snapshot.state === 'STALE' && execution.sourcesRequired.length > 0) || snapshot.state === 'MIXED_REVISION' && execution.sourcesRequired.some((source) => source === 'decisions' ? snapshot.mixedRevisionSources.some((item) => item.includes('decision')) : snapshot.mixedRevisionSources.some((item) => item.includes('source')))
    return { ...execution, status: staleSkipped ? 'SKIPPED_DUE_TO_REVISION' as const : findingsForInvariant.some((finding) => finding.severity === 'CRITICAL' || finding.severity === 'REVIEW') ? 'EXECUTED_FAIL' as const : execution.status === 'EXECUTED_PASS' ? 'EXECUTED_PASS' as const : execution.status, findingIds: findingsForInvariant.map((finding) => finding.id) }
  })
  return { ...result, findings: deduplicated, invariantExecutions, auditInputSnapshot: snapshot, summary: summarizeAudit(deduplicated, result.items, result.summary.evaluatedPurchases, result.mode, invariantExecutions) }
}
