import { describe, expect, it } from 'vitest'
import type { CardStatement, CardStatementTransaction } from './types'
import { cardTransactionIdentity, cardTransactionIdentityVariants, stableFingerprint } from './identity'

const transaction: CardStatementTransaction = {
  id: 'kindle', cardIdentifier: '4321 XXXX XXXX 1234', date: '2026-02-02', purchaseDate: '2026-02-02',
  invoiceDueDate: '2026-03-12', statementDueDate: '2026-03-12', description: 'Amazon Kindle Unltd',
  originalDescription: 'Amazon Kindle Unltd', amount: 299, direction: 'DEBIT', type: 'PURCHASE',
  financialStatus: 'ACTIVE', installment: null, totalInstallments: null, city: '', currency: 'BRL',
  exchangeRate: null, statementTotal: 299,
}
const statement = { statementIdentity: 'statement-current' } as CardStatement

describe('identidade de compras em faturas', () => {
  it('reconhece fingerprints legados com data de vencimento e sem identificador do cartão', () => {
    const oldFingerprint = stableFingerprint(['2026-03-12', transaction.originalDescription, transaction.amount, transaction.direction, null, null])
    const oldIdentity = `statement-current:${oldFingerprint}`
    expect(cardTransactionIdentityVariants(statement, transaction)).toContain(oldIdentity)
    expect(cardTransactionIdentityVariants(statement, transaction, 'statement-legacy')).toContain(`statement-legacy:${oldFingerprint}`)
  })

  it('mantém a identidade atual entre as variantes de compatibilidade', () => {
    expect(cardTransactionIdentityVariants(statement, transaction)).toContain(cardTransactionIdentity(statement, transaction))
  })
})
