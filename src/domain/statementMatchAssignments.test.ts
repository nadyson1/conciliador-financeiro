import { describe, expect, it } from 'vitest'
import type { CardStatement, CardStatementTransaction, LedgerTransaction } from './types'
import type { PersistedDecision } from './localDecisions'
import { cardTransactionIdentity, cardTransactionIdentityVariants, sheetIdentity } from './identity'
import { conflictingDecisionsForStatementRow, conflictingStatementAssignments, resolveStatementMatchAssignments } from './statementMatchAssignments'

const row = { id: 'ledger-row', sheetRecordId: 'shared-row', source: 'SHEET', date: '2026-06-12', originalDescription: 'Mensalidade Selfit', description: 'Mensalidade Selfit', amount: 12990, direction: 'DEBIT', type: 'EXPENSE', paymentMethod: 'Crédito_Bradesco', original: {} } as unknown as LedgerTransaction
const purchase = (id: string, purchaseDate: string, dueDate: string): CardStatement => {
  const transaction = { id, purchaseDate, invoiceDueDate: dueDate, statementDueDate: dueDate, date: purchaseDate, originalDescription: 'SELFITHOMEROCASTELOBRA', description: 'SELFITHOMEROCASTELOBRA', amount: 12990, direction: 'DEBIT', type: 'PURCHASE', cardIdentifier: 'card-1', installment: null, totalInstallments: null, financialStatus: 'ACTIVE' } as unknown as CardStatementTransaction
  return { statementIdentity: `invoice-${id}`, dueDate, transactions: [transaction] } as unknown as CardStatement
}
const activeDecision = (statement: CardStatement): PersistedDecision => {
  const transaction = statement.transactions[0]
  const identity = cardTransactionIdentity(statement, transaction)
  return { key: `STATEMENT_MATCH_CONFIRMED:${JSON.stringify([identity])}`, schemaVersion: 1, kind: 'STATEMENT_MATCH_CONFIRMED', identities: [identity], selected: [sheetIdentity(row)], updatedAt: '2026-10-07T20:00:00.000Z' }
}

describe('atribuições manuais de compras PDF', () => {
  it('encontra dois owners incompatíveis para a mesma linha e preserva ambos os detalhes para auditoria', () => {
    const june = purchase('june', '2026-05-08', '2026-06-12')
    const july = purchase('july', '2026-06-08', '2026-07-12')
    const decisions = [activeDecision(june), activeDecision(july)]
    const assignments = resolveStatementMatchAssignments(decisions, [{ statement: june }, { statement: july }], [row])
    expect(assignments).toHaveLength(2)
    const conflicts = conflictingStatementAssignments(assignments)
    expect(conflicts.get(sheetIdentity(row))?.map((assignment) => assignment.decision.key)).toEqual(decisions.map((decision) => decision.key))
  })

  it('não conta aliases da mesma compra como owners diferentes', () => {
    const statement = purchase('same', '2026-05-08', '2026-06-12')
    const decision = activeDecision(statement)
    const legacyIdentity = cardTransactionIdentity('legacy-invoice', statement.transactions[0])
    const alias = { ...decision, key: 'legacy-alias', identities: [legacyIdentity] }
    const assignments = resolveStatementMatchAssignments([decision, alias], [{ statement, legacyStatementIdentity: 'legacy-invoice' }], [row])
    expect(assignments).toHaveLength(2)
    expect(conflictingStatementAssignments(assignments).size).toBe(0)
  })

  it('não reidrata automaticamente uma decisão cuja linha saiu da tolerância e precisa de revisão', () => {
    const statement = purchase('needs-review', '2026-05-08', '2026-06-12')
    const editedRow = { ...row, date: '2026-04-12' }
    const decision = { ...activeDecision(statement), selected: [sheetIdentity(editedRow)] }
    expect(resolveStatementMatchAssignments([decision], [{ statement }], [editedRow])).toEqual([])
  })

  it('seleciona para supersessão somente decisão incompatível vinculada ao alvo exato', () => {
    const first = purchase('first', '2026-05-08', '2026-06-12')
    const second = purchase('second', '2026-06-08', '2026-07-12')
    const oldDecision = activeDecision(first)
    const unrelatedDecision = { ...activeDecision(second), selected: ['another-row'] }
    const oldAlias = cardTransactionIdentity('legacy-invoice', first.transactions[0])
    const samePurchaseAlias = { ...oldDecision, key: 'same-purchase-alias', identities: [oldAlias] }
    expect(conflictingDecisionsForStatementRow([oldDecision, unrelatedDecision, samePurchaseAlias], cardTransactionIdentityVariants(first, first.transactions[0], 'legacy-invoice'), sheetIdentity(row))).toEqual([])
    const secondDecision = activeDecision(second)
    expect(conflictingDecisionsForStatementRow([oldDecision, secondDecision], cardTransactionIdentityVariants(second, second.transactions[0]), sheetIdentity(row))).toEqual([oldDecision])
  })
})
