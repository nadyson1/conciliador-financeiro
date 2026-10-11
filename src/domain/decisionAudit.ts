import type { BankTransaction, CardStatement, LedgerTransaction } from './types'
import type { PersistedDecision } from './localDecisions'
import { bankIdentity, cardReviewCandidateIdentity, cardTransactionIdentityVariants, sheetIdentity } from './identity'
import { findExistingCostYearCandidates } from '../importers/cardStatement'
import { findPlausibleLedgerCandidates } from '../matching/reconcile'

export type DecisionAuditStatus = 'VALID' | 'STALE' | 'ORPHANED' | 'NEEDS_REVIEW' | 'INVALID'
export type AuditableStatement = { statement: CardStatement; legacyStatementIdentity?: string }
export type DecisionAuditContext = { banks: BankTransaction[]; sheets: LedgerTransaction[]; statements: AuditableStatement[] }
export type DecisionAudit = { decision: PersistedDecision; status: DecisionAuditStatus; resolved: boolean }

const selectedSheet = (context: DecisionAuditContext, identity?: string) => identity ? context.sheets.find((row) => sheetIdentity(row) === identity || row.id === identity) : undefined

const decisionKinds = ['PAIR_CONFIRMED', 'PAIR_REJECTED', 'BANK_IGNORED', 'SHEET_IGNORED', 'COMPOSITION_CONFIRMED', 'STATEMENT_MATCH_CONFIRMED', 'CARD_MISSING_CONFIRMED', 'CARD_PURCHASE_IGNORED', 'CARD_REVIEW_REJECTED_CANDIDATES', 'MISSING_ADDED_TO_SHEET'] as const
const oneIdentityKinds = new Set(['BANK_IGNORED', 'SHEET_IGNORED', 'CARD_MISSING_CONFIRMED', 'CARD_PURCHASE_IGNORED', 'CARD_REVIEW_REJECTED_CANDIDATES', 'STATEMENT_MATCH_CONFIRMED'])

/** Common runtime/schema validation, run before any decision is allowed into a matcher. */
export function isDecisionStructurallyValid(value: unknown): value is PersistedDecision {
  if (!value || typeof value !== 'object') return false
  const decision = value as Partial<PersistedDecision>
  if (decision.schemaVersion !== 1 || !decisionKinds.includes(decision.kind as typeof decisionKinds[number])) return false
  if (!Array.isArray(decision.identities) || decision.identities.some((item) => typeof item !== 'string' || !item.trim())) return false
  if (!Array.isArray(decision.selected) || decision.selected.some((item) => typeof item !== 'string' || !item.trim())) return false
  if (typeof decision.updatedAt !== 'string' || Number.isNaN(Date.parse(decision.updatedAt))) return false
  if (typeof decision.key !== 'string' || decision.key !== `${decision.kind}:${JSON.stringify(decision.identities)}`) return false
  const kind = decision.kind as string
  if (oneIdentityKinds.has(kind) && decision.identities.length !== 1) return false
  if (kind === 'PAIR_REJECTED' && decision.identities.length !== 2) return false
  if (['PAIR_CONFIRMED', 'MISSING_ADDED_TO_SHEET'].includes(kind) && (decision.identities.length !== 1 || decision.selected.length !== 1)) return false
  if (kind === 'PAIR_REJECTED' && decision.selected.length !== 0) return false
  if (['BANK_IGNORED', 'SHEET_IGNORED', 'CARD_MISSING_CONFIRMED', 'CARD_PURCHASE_IGNORED'].includes(kind) && decision.selected.length !== 0) return false
  if (kind === 'STATEMENT_MATCH_CONFIRMED' && (decision.selected.length !== 1 || !decision.identities[0])) return false
  if (kind === 'COMPOSITION_CONFIRMED' && (decision.identities.length !== 2 || decision.selected.length === 0)) return false
  if (kind === 'CARD_REVIEW_REJECTED_CANDIDATES' && (decision.selected.length === 0 || decision.identities.length !== 1)) return false
  return true
}

/** Re-check persisted links against today's rows; never treats a stable ID as semantic proof. */
export function auditPersistedDecision(decision: PersistedDecision, context: DecisionAuditContext): DecisionAudit {
  if (!isDecisionStructurallyValid(decision)) return { decision, status: 'INVALID', resolved: true }
  const selected = selectedSheet(context, decision.kind === 'PAIR_REJECTED' ? decision.identities[1] : decision.selected[0])
  if (decision.kind === 'SHEET_IGNORED') {
    const exists = context.sheets.some((row) => sheetIdentity(row) === decision.identities[0])
    return { decision, status: exists ? 'VALID' : 'ORPHANED', resolved: true }
  }
  if (decision.kind === 'BANK_IGNORED') {
    const exists = context.banks.some((row) => bankIdentity(row) === decision.identities[0])
    return { decision, status: exists ? 'VALID' : 'ORPHANED', resolved: true }
  }
  if (decision.kind === 'CARD_PURCHASE_IGNORED') {
    const exists = context.statements.some((entry) => entry.statement.transactions.some((transaction) => cardTransactionIdentityVariants(entry.statement, transaction, entry.legacyStatementIdentity).includes(decision.identities[0])))
    return { decision, status: exists ? 'VALID' : 'ORPHANED', resolved: true }
  }
  if (decision.kind === 'PAIR_CONFIRMED' || decision.kind === 'PAIR_REJECTED' || decision.kind === 'MISSING_ADDED_TO_SHEET') {
    if (!selected) return { decision, status: 'ORPHANED', resolved: true }
    const bank = context.banks.find((row) => bankIdentity(row) === decision.identities[0])
    if (!bank) return { decision, status: 'NEEDS_REVIEW', resolved: false }
    if (decision.kind === 'PAIR_REJECTED') {
      const structurallyValid = decision.key === `PAIR_REJECTED:${JSON.stringify(decision.identities)}`
        && decision.identities.length === 2
      if (!structurallyValid) return { decision, status: 'NEEDS_REVIEW', resolved: false }
      const plausible = findPlausibleLedgerCandidates(bank!, [selected]).length > 0
      return { decision, status: plausible ? 'VALID' : 'STALE', resolved: true }
    }
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
    const resolved = context.statements.flatMap((entry) => entry.statement.transactions.map((transaction) => ({ entry, transaction })))
      .find(({ entry, transaction }) => cardTransactionIdentityVariants(entry.statement, transaction, entry.legacyStatementIdentity).includes(decision.identities[0]))
    if (!resolved) return { decision, status: 'ORPHANED', resolved: true }
    const candidates = findExistingCostYearCandidates(resolved.entry.statement, resolved.transaction, context.sheets)
    return { decision, status: candidates.length ? 'STALE' : 'VALID', resolved: true }
  }
  return { decision, status: 'NEEDS_REVIEW', resolved: false }
}

export function auditPersistedDecisions(decisions: PersistedDecision[], context: DecisionAuditContext): DecisionAudit[] {
  return decisions.map((decision) => auditPersistedDecision(decision, context))
}
