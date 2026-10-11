import type { BankTransaction, CardStatement, LedgerTransaction } from './types'
import type { PersistedDecision } from './localDecisions'
import { bankIdentity, cardTransactionIdentity, sheetIdentity, stableFingerprint } from './identity'

export type AuditSnapshotState = 'COMPLETE' | 'PARTIAL' | 'STALE' | 'MIXED_REVISION'
export type AuditSnapshotRevisions = {
  bankSourceRevision: string
  cardStatementRevision: string
  custosAnoRevision: string
  decisionRevision: string
  driveSourceRevision: string
}
export type AuditInputSnapshot = {
  capturedAt: string
  capturedAtBySource: Partial<Record<keyof AuditSnapshotRevisions, string>>
  revisions: AuditSnapshotRevisions
  sourceIdentities: { bank: string[]; cardStatements: string[]; custosAno: string[]; decisions: string[]; drive: string[]; files: string[] }
  state: AuditSnapshotState
  staleSources: string[]
  mixedRevisionSources: string[]
  unavailableSources: string[]
  /** Compact reason when Drive was configured but its live listing was not refreshed. */
  driveListing: 'NOT_CONFIGURED' | 'SESSION_ONLY' | 'REFRESHED'
}

const hash = (value: unknown) => stableFingerprint([JSON.stringify(value)])
const sorted = (values: string[]) => [...new Set(values)].sort()

export function revisionForBanks(banks: BankTransaction[]) {
  return hash(banks.map((bank) => [bankIdentity(bank), bank.date, bank.originalDescription, bank.amount, bank.direction, bank.type, bank.paymentMethod, bank.counterpartyName, bank.balanceAfter, bank.statementSourceIds ?? (bank.statementSourceId ? [bank.statementSourceId] : [])]).sort((a, b) => String(a[0]).localeCompare(String(b[0]))))
}

export function revisionForStatements(statements: CardStatement[]) {
  return hash(statements.map((statement) => [statement.statementIdentity, statement.dueDate, statement.nextClosingDate, statement.reportedTotal, [...statement.cardSubtotals].sort((a, b) => a.cardIdentifier.localeCompare(b.cardIdentifier)), statement.purchasesDebitsTotal, statement.creditsPaymentsTotal, statement.previousBalance, statement.previousPayment, statement.accountingDifference, statement.invoicePaymentMethod, [...statement.errors].sort(), statement.transactions.map((transaction) => [cardTransactionIdentity(statement, transaction), transaction.date, transaction.originalDescription, transaction.type, transaction.direction, transaction.amount, transaction.financialStatus]).sort((a, b) => String(a[0]).localeCompare(String(b[0])))]).sort((a, b) => String(a[0]).localeCompare(String(b[0]))))
}

export function revisionForLedger(rows: LedgerTransaction[]) {
  return hash(rows.map((row) => [sheetIdentity(row), row.date, row.originalDescription, row.amount, row.direction, row.paymentMethod, row.category, row.month, row.year, row.isFixed, row.isEssential, row.installment, row.totalInstallments]).sort((a, b) => String(a[0]).localeCompare(String(b[0]))))
}

export function revisionForDecisions(decisions: PersistedDecision[], tombstones: Record<string, { updatedAt: string; decision: PersistedDecision }> = {}) {
  const entries = [
    ...decisions.map((decision) => [decision.key, decision.schemaVersion, decision.updatedAt, 'ACTIVE', decision.kind, decision.identities, decision.selected]),
    ...Object.entries(tombstones).map(([key, entry]) => [key, entry.updatedAt, 'DELETED', entry.decision.kind, entry.decision.identities, entry.decision.selected]),
  ].map((entry) => JSON.stringify(entry)).sort()
  return hash(entries)
}

export function revisionForDrive(sourceIds: string[], sourceEntityIds: { sourceId: string; entityIds: string[] }[] = [], sourceFileIds: string[] = []) {
  return hash({ sourceIds: sorted(sourceIds), files: sorted(sourceFileIds), provenance: sourceEntityIds.map(({ sourceId, entityIds }) => [sourceId, sorted(entityIds)]).sort((a, b) => String(a[0]).localeCompare(String(b[0]))) })
}

export function revisionForDerivedSources(banks: BankTransaction[], sheets: LedgerTransaction[], statements: CardStatement[]) {
  return hash([revisionForBanks(banks), revisionForLedger(sheets), revisionForStatements(statements)])
}

export function createAuditInputSnapshot(input: {
  banks: BankTransaction[]; statements: CardStatement[]; sheets: LedgerTransaction[]; decisions: PersistedDecision[];
  tombstones?: Record<string, { updatedAt: string; decision: PersistedDecision }>; driveSourceIds?: string[];
  sourceFileIds?: string[];
  sourceProvenance?: { sourceId: string; entityIds: string[] }[]; capturedAt?: string;
  capturedAtBySource?: Partial<Record<keyof AuditSnapshotRevisions, string>>;
  unavailableSources?: string[]; driveListing?: AuditInputSnapshot['driveListing']; mixedRevisionSources?: string[];
}): AuditInputSnapshot {
  const sourceIdentities = {
    bank: sorted(input.banks.map(bankIdentity)),
    cardStatements: sorted(input.statements.map((statement) => statement.statementIdentity)),
    custosAno: sorted(input.sheets.map(sheetIdentity)),
    decisions: sorted([...input.decisions.map((decision) => decision.key), ...Object.keys(input.tombstones ?? {}).map((key) => `${key}:DELETED`)]),
    drive: sorted(input.driveSourceIds ?? []),
    files: sorted(input.sourceFileIds ?? []),
  }
  const unavailableSources = sorted(input.unavailableSources ?? [])
  const mixedRevisionSources = sorted(input.mixedRevisionSources ?? [])
  const driveListing = input.driveListing ?? 'NOT_CONFIGURED'
  if (driveListing === 'SESSION_ONLY') unavailableSources.push('drive-live-listing')
  const unavailable = sorted(unavailableSources)
  const state: AuditSnapshotState = mixedRevisionSources.length ? 'MIXED_REVISION' : unavailable.length ? 'PARTIAL' : 'COMPLETE'
  return {
    capturedAt: input.capturedAt ?? new Date().toISOString(),
    capturedAtBySource: input.capturedAtBySource ?? {},
    revisions: {
      bankSourceRevision: revisionForBanks(input.banks),
      cardStatementRevision: revisionForStatements(input.statements),
      custosAnoRevision: revisionForLedger(input.sheets),
      decisionRevision: revisionForDecisions(input.decisions, input.tombstones),
      driveSourceRevision: revisionForDrive(input.driveSourceIds ?? [], input.sourceProvenance, input.sourceFileIds ?? []),
    },
    sourceIdentities, state, staleSources: [], mixedRevisionSources, unavailableSources: unavailable, driveListing,
  }
}

export function compareAuditInputSnapshots(captured: AuditInputSnapshot, current: AuditInputSnapshot): AuditInputSnapshot {
  const revisionKeys = Object.keys(captured.revisions) as (keyof AuditSnapshotRevisions)[]
  const staleSources = sorted(revisionKeys.filter((key) => captured.revisions[key] !== current.revisions[key]).map(String))
  const mixedRevisionSources = sorted([...captured.mixedRevisionSources, ...current.mixedRevisionSources])
  const unavailableSources = sorted([...captured.unavailableSources, ...current.unavailableSources])
  const state: AuditSnapshotState = staleSources.length ? 'STALE' : mixedRevisionSources.length ? 'MIXED_REVISION' : unavailableSources.length ? 'PARTIAL' : 'COMPLETE'
  return { ...captured, state, staleSources, mixedRevisionSources, unavailableSources }
}

export function cloneAuditInput<T>(value: T): T {
  const cloned = typeof structuredClone === 'function' ? structuredClone(value) : JSON.parse(JSON.stringify(value)) as T
  return deepFreeze(cloned)
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value)
    Object.values(value as Record<string, unknown>).forEach(deepFreeze)
  }
  return value
}
