import { describe, expect, it } from 'vitest'
import type { BankTransaction, CardStatement, LedgerTransaction } from './types'
import type { PersistedDecision } from './localDecisions'
import { auditPersistedDecision } from './decisionAudit'
import { bankIdentity, cardTransactionIdentity, sheetIdentity } from './identity'
import { reconcileCardStatement } from '../importers/cardStatement'

function sheet(overrides: Partial<LedgerTransaction> = {}): LedgerTransaction {
  return { id: 'sheet-row', source: 'SHEET', sheetRecordId: 'sheet-row', bankTransactionId: null, date: '2026-03-12', description: 'Assinatura Kindle unlimited (2 meses)', originalDescription: 'Assinatura Kindle unlimited (2 meses)', amount: 299, direction: 'DEBIT', type: 'OTHER', paymentMethod: 'Crédito_Bradesco', category: 'Assinaturas', month: '03 - Março', year: '2026', isFixed: false, isEssential: false, installment: null, totalInstallments: null, balanceAfter: null, original: {}, ...overrides }
}
function cardStatement(): CardStatement {
  return { fileName: 'fatura-sintetica.pdf', pageCount: 1, statementIdentity: 'fatura-2026-03', transactions: [{ id: 'kindle-tx', purchaseDate: '2026-02-02', date: '2026-02-02', invoiceDueDate: '2026-03-12', statementDueDate: '2026-03-12', description: 'Amazon Kindle Unltd', originalDescription: 'Amazon Kindle Unltd', amount: 299, direction: 'DEBIT', type: 'PURCHASE', financialStatus: 'ACTIVE', cardIdentifier: '4321 XXXX XXXX 1234', installment: null, totalInstallments: null, city: '', currency: 'BRL', exchangeRate: null, statementTotal: 299 }], cardSubtotals: [{ cardIdentifier: '4321 XXXX XXXX 1234', amount: 299 }], reportedTotal: 299, purchasesDebitsTotal: 299, creditsPaymentsTotal: null, previousBalance: null, previousPayment: null, accountingDifference: null, dueDate: '2026-03-12', nextClosingDate: null, errors: [] }
}
function decision(kind: PersistedDecision['kind'], identities: string[], selected: string[]): PersistedDecision { return { key: `${kind}:${JSON.stringify(identities)}`, kind, identities, selected, schemaVersion: 1, updatedAt: '2026-06-01T00:00:00.000Z' } }

describe('auditoria resiliente das decisões vinculadas à CUSTOS ANO', () => {
  it('mantém vínculo por ID quando a linha é reordenada ou outra coluna não relacionada muda', () => {
    const row = sheet({ category: 'Bem-estar' })
    const stmt = cardStatement()
    const record = decision('STATEMENT_MATCH_CONFIRMED', [cardTransactionIdentity(stmt, stmt.transactions[0])], [sheetIdentity(row)])
    expect(auditPersistedDecision(record, { banks: [], sheets: [sheet({ id: 'other', sheetRecordId: 'other' }), row], statements: [{ statement: stmt }] }).status).toBe('VALID')
  })

  it('mantém uma compra de PDF recriada e renomeada quando valor, vencimento e pagamento ainda batem', () => {
    const stmt = cardStatement()
    const renamed = sheet({ description: 'Assinatura Kindle unlimited', originalDescription: 'Assinatura Kindle unlimited' })
    const record = decision('STATEMENT_MATCH_CONFIRMED', [cardTransactionIdentity(stmt, stmt.transactions[0])], [sheetIdentity(renamed)])
    expect(auditPersistedDecision(record, { banks: [], sheets: [renamed], statements: [{ statement: stmt }] }).status).toBe('VALID')
    expect(reconcileCardStatement(stmt, [renamed]).matches[0].status).toBe('CARD_MATCHED')
  })

  it('reclassifica decisão com mesma estrutura mas data editada para revisão, sem forçar match', () => {
    const stmt = cardStatement()
    const editedDate = sheet({ date: '2026-04-12' })
    const record = decision('STATEMENT_MATCH_CONFIRMED', [cardTransactionIdentity(stmt, stmt.transactions[0])], [sheetIdentity(editedDate)])
    expect(auditPersistedDecision(record, { banks: [], sheets: [editedDate], statements: [{ statement: stmt }] }).status).toBe('NEEDS_REVIEW')
    expect(reconcileCardStatement(stmt, [editedDate]).matches[0].status).toBe('CARD_MISSING')
  })

  it('marca vínculo excluído como órfão e permite novo matching com outro ID equivalente', () => {
    const stmt = cardStatement()
    const recreated = sheet({ id: 'new-row', sheetRecordId: 'new-row' })
    const record = decision('STATEMENT_MATCH_CONFIRMED', [cardTransactionIdentity(stmt, stmt.transactions[0])], ['sheet:deleted-row'])
    expect(auditPersistedDecision(record, { banks: [], sheets: [recreated], statements: [{ statement: stmt }] }).status).toBe('ORPHANED')
    expect(reconcileCardStatement(stmt, [recreated]).matches[0]).toMatchObject({ status: 'CARD_MATCHED', sheet: recreated })
  })

  it('marca MISSING_ADDED_TO_SHEET órfão quando a linha é apagada', () => {
    const bank: BankTransaction = { id: 'bank-1', source: 'BANK', sheetRecordId: null, bankTransactionId: 'bank-1', date: '2026-01-08', description: 'PIX ENVIADO MERCADO', originalDescription: 'PIX ENVIADO MERCADO', amount: 4500, direction: 'DEBIT', directionKnown: true, type: 'EXPENSE', paymentMethod: 'Pix', category: '', month: '', year: '2026', isFixed: null, isEssential: null, installment: null, totalInstallments: null, balanceAfter: null, original: {} }
    const record = decision('MISSING_ADDED_TO_SHEET', [bankIdentity(bank)], ['sheet:deleted-row'])
    expect(auditPersistedDecision(record, { banks: [bank], sheets: [], statements: [] }).status).toBe('ORPHANED')
  })
})
