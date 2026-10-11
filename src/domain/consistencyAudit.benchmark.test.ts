import { describe, expect, it } from 'vitest'
import { auditConsistency } from './consistencyAudit'
import type { BankTransaction, CardStatement, CardStatementMatch, LedgerTransaction } from './types'

describe('benchmark opcional da auditoria profunda', () => {
  it('mede um conjunto sintético ampliado sem crescimento grosseiro de duração', () => {
    const sheets: LedgerTransaction[] = Array.from({ length: 250 }, (_, index) => ({
      id: `sheet-${index}`, sheetRecordId: `sheet-${index}`, source: 'SHEET', bankTransactionId: null,
      date: `2026-09-${String(index % 28 + 1).padStart(2, '0')}`, description: `Despesa teste ${index}`, originalDescription: `Despesa teste ${index}`,
      amount: 1000 + index, direction: 'DEBIT', type: 'EXPENSE', paymentMethod: index % 2 ? 'Pix' : 'Crédito_Bradesco', category: 'Teste', month: '09 - setembro', year: '2026',
      isFixed: false, isEssential: false, installment: index % 4 ? null : index % 5 + 1, totalInstallments: index % 4 ? null : 6, balanceAfter: null, original: {},
    }))
    const banks: BankTransaction[] = Array.from({ length: 100 }, (_, index) => ({
      id: `bank-${index}`, bankTransactionId: `bank-${index}`, sheetRecordId: null, source: 'BANK', date: `2026-09-${String(index % 28 + 1).padStart(2, '0')}`,
      description: `Pagamento teste ${index}`, originalDescription: `Pagamento teste ${index}`, amount: 5000 + index, direction: 'DEBIT', directionKnown: true, type: 'EXPENSE',
      paymentMethod: 'Pix', category: '', month: '', year: '', isFixed: null, isEssential: null, installment: null, totalInstallments: null, balanceAfter: null, original: {},
    }))
    const statements = Array.from({ length: 60 }, (_, index) => {
      const transaction: CardStatement['transactions'][number] = { id: `card-${index}`, purchaseDate: `2026-09-${String(index % 28 + 1).padStart(2, '0')}`, date: `2026-09-${String(index % 28 + 1).padStart(2, '0')}`, invoiceDueDate: '2026-10-12', description: `Compra parcelada teste ${index}`, originalDescription: `Compra parcelada teste ${index}`, amount: 2000 + index, direction: 'DEBIT', type: 'PURCHASE', cardIdentifier: '0000', installment: index % 3 ? null : 3, totalInstallments: index % 3 ? null : 6, city: '', currency: 'BRL', exchangeRate: null, statementDueDate: '2026-10-12', statementTotal: 2000 + index }
      const statement: CardStatement = { fileName: `synthetic-${index}.pdf`, pageCount: 1, statementIdentity: `invoice-${index}`, transactions: [transaction], cardSubtotals: [], reportedTotal: transaction.amount, purchasesDebitsTotal: transaction.amount, creditsPaymentsTotal: 0, previousBalance: 0, previousPayment: 0, accountingDifference: 0, dueDate: '2026-10-12', nextClosingDate: null, errors: [] }
      const match: CardStatementMatch = { transaction, status: 'CARD_MISSING', sheet: null, candidates: [] }
      return { statement, legacyStatementIdentity: undefined, current: { statementIdentity: statement.statementIdentity!, transactionId: transaction.id, match } }
    })
    const startedAt = performance.now()
    const result = auditConsistency({ banks, sheets, statements: statements.map(({ statement, legacyStatementIdentity }) => ({ statement, legacyStatementIdentity })), currentCardMatches: statements.map(({ current }) => current), localDecisions: [] })
    const elapsedMs = performance.now() - startedAt
    console.info(`Benchmark Auditor: ${banks.length} bancos, ${sheets.length} linhas, ${statements.length} compras, ${result.findings.length} findings · total ${elapsedMs.toFixed(1)} ms · expected ${result.performance.expectedStateDerivationMs.toFixed(1)} ms · invariants ${result.performance.invariantChecksMs.toFixed(1)} ms`)
    expect(result.items).toHaveLength(60)
    expect(elapsedMs).toBeLessThan(60_000)
  })
})
