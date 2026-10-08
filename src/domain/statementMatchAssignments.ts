import type { CardStatement, LedgerTransaction } from './types'
import type { PersistedDecision } from './localDecisions'
import { cardTransactionIdentity, cardTransactionIdentityVariants, sheetIdentity } from './identity'
import { findExistingCostYearCandidates } from '../importers/cardStatement'

export type StatementMatchAssignment = {
  decision: PersistedDecision
  subjectId: string
  ownerKey: string
  statement: CardStatement
  transactionId: string
  row: LedgerTransaction
}

/** Resolves active PDF confirmation decisions to their canonical purchase and CUSTOS ANO row. */
export function resolveStatementMatchAssignments(decisions: PersistedDecision[], statements: { statement: CardStatement; legacyStatementIdentity?: string }[], sheets: LedgerTransaction[]): StatementMatchAssignment[] {
  const resolved: StatementMatchAssignment[] = []
  for (const decision of decisions) {
    if (decision.kind !== 'STATEMENT_MATCH_CONFIRMED' || !decision.selected.length) continue
    const match = statements.flatMap((entry) => entry.statement.transactions.map((transaction) => ({ entry, transaction })))
      .find(({ entry, transaction }) => cardTransactionIdentityVariants(entry.statement, transaction, entry.legacyStatementIdentity).includes(decision.identities[0]))
    const row = sheets.find((candidate) => sheetIdentity(candidate) === decision.selected[0] || candidate.id === decision.selected[0] || candidate.sheetRecordId === decision.selected[0])
    if (!match || !row || !findExistingCostYearCandidates(match.entry.statement, match.transaction, [row]).length) continue
    resolved.push({ decision, subjectId: cardTransactionIdentity(match.entry.statement, match.transaction), ownerKey: `${match.entry.statement.statementIdentity}\u001f${match.transaction.id}`, statement: match.entry.statement, transactionId: match.transaction.id, row })
  }
  return resolved
}

/** A row with more than one canonical active owner is a decision conflict, not a valid assignment. */
export function conflictingStatementAssignments(assignments: StatementMatchAssignment[]) {
  const byRow = new Map<string, StatementMatchAssignment[]>()
  for (const assignment of assignments) {
    const key = sheetIdentity(assignment.row)
    const rows = byRow.get(key) ?? []
    rows.push(assignment)
    byRow.set(key, rows)
  }
  return new Map([...byRow].filter(([, rows]) => new Set(rows.map((row) => row.subjectId)).size > 1))
}

/** Finds incompatible manual owners of one exact row, excluding aliases for the same purchase. */
export function conflictingDecisionsForStatementRow(decisions: PersistedDecision[], identities: string[], selectedSheetIdentity: string) {
  const aliases = new Set(identities)
  return decisions.filter((decision) => decision.kind === 'STATEMENT_MATCH_CONFIRMED'
    && decision.selected.some((selected) => selected === selectedSheetIdentity)
    && !aliases.has(decision.identities[0]))
}
