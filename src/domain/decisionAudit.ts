import type { BankTransaction, CardStatement, LedgerTransaction } from './types'
import type { PersistedDecision } from './localDecisions'
import { bankIdentity, cardReviewCandidateIdentity, cardTransactionIdentityVariants, sheetIdentity } from './identity'
import { findExistingCostYearCandidates } from '../importers/cardStatement'
import { findPlausibleLedgerCandidates } from '../matching/reconcile'

export type DecisionAuditStatus = 'VALID' | 'STALE' | 'ORPHANED' | 'NEEDS_REVIEW'
export type AuditableStatement = { statement: CardStatement; legacyStatementIdentity?: string }
export type DecisionAuditContext = { banks: BankTransaction[]; sheets: LedgerTransaction[]; statements: AuditableStatement[] }
export type DecisionAudit = { decision: PersistedDecision; status: DecisionAuditStatus; resolved: boolean }

const selectedSheet = (context: DecisionAuditContext, identity?: string) => identity ? context.sheets.find((row) => sheetIdentity(row) === identity || row.id === identity) : undefined

/** Re-check persisted links against today's rows; never treats a stable ID as semantic proof. */
export function auditPersistedDecision(decision: PersistedDecision, context: DecisionAuditContext): DecisionAudit {
  const selected = selectedSheet(context, decision.kind === 'PAIR_REJECTED' ? decision.identities[1] : decision.selected[0])
  if (decision.kind === 'SHEET_IGNORED') {
    const exists = context.sheets.some((row) => sheetIdentity(row) === decision.identities[0])
    return { decision, status: exists ? 'VALID' : 'ORPHANED', resolved: true }
  }
  if (decision.kind === 'PAIR_CONFIRMED' || decision.kind === 'PAIR_REJECTED' || decision.kind === 'MISSING_ADDED_TO_SHEET') {
    if (!selected) return { decision, status: 'ORPHANED', resolved: true }
    const bank = context.banks.find((row) => bankIdentity(row) === decision.identities[0])
    if (!bank) return { decision, status: 'NEEDS_REVIEW', resolved: false }
    if (decision.kind === 'PAIR_REJECTED') return { decision, status: 'VALID', resolved: true }
    const plausible = findPlausibleLedgerCandidates(bank, [selected]).length > 0
    return { decision, status: plausible ? 'VALID' : selected.amount === bank.amount && selected.direction === bank.direction ? 'NEEDS_REVIEW' : 'STALE', resolved: true }
  }
  if (decision.kind === 'COMPOSITION_CONFIRMED') {
    const bank = context.banks.find((row) => bankIdentity(row) === decision.identities[0])
    if (!bank || bank.type !== 'CARD_PAYMENT') return { decision, status: 'NEEDS_REVIEW', resolved: false }
    const rows = decision.selected.map((identity) => selectedSheet(context, identity))
    if (rows.some((row) => !row)) return { decision, status: 'ORPHANED', resolved: true }
    const total = (rows as LedgerTransaction[]).reduce((sum, row) => sum + row.amount, 0)
    const compatible = total === bank.amount && (rows as LedgerTransaction[]).every((row) => row.direction === 'DEBIT' && row.paymentMethod.toLocaleLowerCase('pt-BR').replaceAll('_', ' ') === 'crédito bradesco' && row.date <= bank.date)
    return { decision, status: compatible ? 'VALID' : total === bank.amount ? 'NEEDS_REVIEW' : 'STALE', resolved: true }
  }
  if (decision.kind === 'STATEMENT_MATCH_CONFIRMED') {
    if (!selected) return { decision, status: 'ORPHANED', resolved: true }
    const resolved = context.statements.flatMap((entry) => entry.statement.transactions.map((transaction) => ({ entry, transaction })))
      .find(({ entry, transaction }) => cardTransactionIdentityVariants(entry.statement, transaction, entry.legacyStatementIdentity).includes(decision.identities[0]))
    if (!resolved) return { decision, status: 'NEEDS_REVIEW', resolved: false }
    const candidates = findExistingCostYearCandidates(resolved.entry.statement, resolved.transaction, [selected])
    if (candidates.length) return { decision, status: 'VALID', resolved: true }
    const sameStructure = selected.amount === resolved.transaction.amount && selected.direction === 'DEBIT' && selected.paymentMethod.toLocaleLowerCase('pt-BR').replaceAll('_', ' ') === 'crédito bradesco'
    return { decision, status: sameStructure ? 'NEEDS_REVIEW' : 'STALE', resolved: true }
  }
  if (decision.kind === 'CARD_REVIEW_REJECTED_CANDIDATES') {
    const resolved = context.statements.flatMap((entry) => entry.statement.transactions.map((transaction) => ({ entry, transaction })))
      .find(({ entry, transaction }) => cardTransactionIdentityVariants(entry.statement, transaction, entry.legacyStatementIdentity).includes(decision.identities[0]))
    if (!resolved) return { decision, status: 'NEEDS_REVIEW', resolved: false }
    const rejectedKeys = new Set(decision.selected)
    const candidates = findExistingCostYearCandidates(resolved.entry.statement, resolved.transaction, context.sheets)
    if (candidates.some((row) => !rejectedKeys.has(cardReviewCandidateIdentity(row)))) return { decision, status: 'STALE', resolved: true }
    if (candidates.some((row) => rejectedKeys.has(cardReviewCandidateIdentity(row)))) return { decision, status: 'VALID', resolved: true }
    const rejectedRowsStillExist = decision.selected.some((key) => selectedSheet(context, key))
    return { decision, status: rejectedRowsStillExist ? 'STALE' : 'ORPHANED', resolved: true }
  }
  if (decision.kind === 'CARD_MISSING_CONFIRMED') {
    const exists = context.statements.some((entry) => entry.statement.transactions.some((transaction) => cardTransactionIdentityVariants(entry.statement, transaction, entry.legacyStatementIdentity).includes(decision.identities[0])))
    return { decision, status: exists ? 'STALE' : 'NEEDS_REVIEW', resolved: exists }
  }
  return { decision, status: 'NEEDS_REVIEW', resolved: false }
}

export function auditPersistedDecisions(decisions: PersistedDecision[], context: DecisionAuditContext): DecisionAudit[] {
  return decisions.map((decision) => auditPersistedDecision(decision, context))
}
