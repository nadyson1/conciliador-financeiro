import { describe, expect, it } from 'vitest'
import type { BankTransaction } from './types'
import { auditBankBalance, selectMissingExpenses, summarizeMissingExpenses } from './bankBalanceAudit'

const bank = (overrides: Partial<BankTransaction> = {}): BankTransaction => ({
  id: 'bank-1', source: 'BANK', sheetRecordId: null, bankTransactionId: 'tx-1', date: '2026-01-01',
  description: 'Movimentação', originalDescription: 'Movimentação', amount: 0, direction: 'CREDIT',
  type: 'OTHER', paymentMethod: '', category: '', month: '', year: '2026', isFixed: null,
  isEssential: null, installment: null, totalInstallments: null, balanceAfter: null, original: {}, ...overrides,
})

describe('conferência aritmética do saldo bancário', () => {
  it('calcula saldo inicial + créditos − débitos e confere quando chega ao saldo informado', () => {
    const result = auditBankBalance([
      bank({ id: 'opening', date: '2026-01-01', balanceAfter: 10000 }),
      bank({ id: 'credit', date: '2026-01-02', amount: 3000, direction: 'CREDIT', balanceAfter: 13000 }),
      bank({ id: 'debit', date: '2026-01-03', amount: 5000, direction: 'DEBIT', balanceAfter: 8000 }),
    ])
    expect(result).toMatchObject({ initialBalance: 10000, totalCredits: 3000, totalDebits: 5000, calculatedBalance: 8000, reportedBalance: 8000, difference: 0, isBalanced: true, movementCount: 3 })
  })

  it('retorna diferença com sinal informado menos calculado e identifica descontinuidade de período', () => {
    const result = auditBankBalance([
      bank({ id: 'opening', date: '2026-01-01', balanceAfter: 10000 }),
      bank({ id: 'later', date: '2026-03-01', amount: 1000, direction: 'DEBIT', balanceAfter: 7500 }),
    ], [{ row: 20, reason: 'NO_MOVEMENT', date: '2026-02-28', description: 'Saldo sem movimento', balanceAfter: 8000, amount: 0, direction: 'DEBIT' }])
    expect(result).toMatchObject({ calculatedBalance: 9000, reportedBalance: 7500, difference: -1500, isBalanced: false })
    expect(result.discontinuities).toEqual(expect.arrayContaining([
      expect.objectContaining({ date: '2026-02-28', previousDate: '2026-01-01', expectedBalance: 10000, reportedBalance: 8000, difference: -2000, gapDays: 58 }),
      expect.objectContaining({ date: '2026-03-01', previousDate: '2026-02-28', expectedBalance: 7000, reportedBalance: 7500, difference: 500, gapDays: 1 }),
    ]))
    expect(result.excludedRows[0]).toMatchObject({ row: 20, reason: 'NO_MOVEMENT', balanceAfter: 8000 })
  })

  it('usa a última linha de origem entre saldos da mesma data, não o ID aleatório', () => {
    const result = auditBankBalance([
      bank({ id: 'later-tx', date: '2026-02-01', amount: 1000, direction: 'CREDIT', balanceAfter: 12000 }),
      bank({ id: 'earlier-tx', date: '2026-02-01', amount: 2000, direction: 'DEBIT', balanceAfter: 10000 }),
    ])
    expect(result.reportedBalance).toBe(10000)
  })

  it('não aplica tolerância automática para diferença de três centavos', () => {
    const result = auditBankBalance([
      bank({ id: 'opening', date: '2026-01-01', amount: 0, balanceAfter: 10000 }),
      bank({ id: 'credit', date: '2026-01-02', amount: 10000, direction: 'CREDIT', balanceAfter: 19997 }),
    ])
    expect(result).toMatchObject({ calculatedBalance: 20000, reportedBalance: 19997, difference: -3, isBalanced: false })
  })
})

describe('resumo de despesas ausentes', () => {
  it('soma apenas saídas MISSING elegíveis e evita entradas, fora de escopo, cartão agregado e REVIEW', () => {
    const items = [
      { status: 'MISSING', bank: bank({ amount: 1000, direction: 'DEBIT', type: 'EXPENSE' }) },
      { status: 'MISSING', bank: bank({ amount: 2500, direction: 'DEBIT', type: 'OTHER' }) },
      { status: 'MISSING', bank: bank({ amount: 5000, direction: 'CREDIT', type: 'INCOME' }) },
      { status: 'MISSING', bank: bank({ amount: 6000, direction: 'DEBIT', type: 'INVESTMENT' }) },
      { status: 'MISSING', bank: bank({ amount: 7000, direction: 'DEBIT', type: 'TRANSFER' }) },
      { status: 'CARD_DIVERGENCE', bank: bank({ amount: 8000, direction: 'DEBIT', type: 'CARD_PAYMENT' }) },
      { status: 'REVIEW', bank: bank({ amount: 9000, direction: 'DEBIT', type: 'EXPENSE' }) },
      { status: 'MATCHED', bank: bank({ amount: 10000, direction: 'DEBIT', type: 'EXPENSE' }) },
    ]
    const visible = selectMissingExpenses(items)
    expect(visible).toHaveLength(2)
    expect(summarizeMissingExpenses(visible)).toEqual({ count: 2, total: 3500 })
  })

  it('acompanha o subconjunto visível após aplicar o filtro de período', () => {
    const march = { status: 'MISSING', bank: bank({ date: '2026-03-10', amount: 1200, direction: 'DEBIT', type: 'EXPENSE' }) }
    const april = { status: 'MISSING', bank: bank({ date: '2026-04-10', amount: 2400, direction: 'DEBIT', type: 'EXPENSE' }) }
    const all = [march, april]
    const filtered = all.filter((item) => item.bank.date.startsWith('2026-03'))
    expect(summarizeMissingExpenses(selectMissingExpenses(all))).toEqual({ count: 2, total: 3600 })
    expect(summarizeMissingExpenses(selectMissingExpenses(filtered))).toEqual({ count: 1, total: 1200 })
  })

  it('usa a mesma seleção para contagem e total e exclui uma saída REFUNDED', () => {
    const items = [
      { status: 'MISSING', bank: bank({ id: 'missing', direction: 'DEBIT', type: 'EXPENSE', amount: 67770 }) },
      { status: 'REFUNDED', bank: bank({ id: 'refunded', direction: 'DEBIT', type: 'EXPENSE', amount: 67770 }) },
    ]
    const visible = selectMissingExpenses(items)
    expect(visible.map(({ bank: transaction }) => transaction.id)).toEqual(['missing'])
    expect(summarizeMissingExpenses(visible)).toEqual({ count: 1, total: 67770 })
  })
})
