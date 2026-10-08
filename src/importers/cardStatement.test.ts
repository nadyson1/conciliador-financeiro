import { describe, expect, it } from 'vitest'
import type { BankTransaction, CardStatement, LedgerTransaction } from '../domain/types'
import { cardStatementFinancialIdentity, deriveCardPurchaseStatus, detectBradescoInvoiceLayout, findExistingCostYearCandidates, identifyAggregatedRefundGroups, identifyOneToOneRefundGroups, identifyStatementPayment, identifyStatementPayments, parseBrazilianMoney, parseCardStatementPages, reconcileCardStatement } from './cardStatement'
import { findDuplicateGroups, reconcile } from '../matching/reconcile'
import { parseLedgerRows } from './transactions'
import { summarizeCardPurchases } from '../features/cardStatementCounts'

const syntheticPages = [
  [
    'Fatura Mensal',
    'Total da fatura Vencimento',
    'Cliente Exemplo R$ 100,00 12/07/2025',
    'Previsão de fechamento da próxima fatura: 30/07/2025',
    'Resumo da fatura',
    '(+) Compras/Débitos R$ 100,00',
  ],
  [
    'Fatura Mensal',
    'Número do Cartão 4321 XXXX XXXX 1111',
    'Lançamentos',
    'Data | Histórico de Lançamentos | Cidade | US$ | Cotação do Dólar | R$',
    '02/06 | MERCADO EXEMPLO 02/02 | CIDADE A | | | 10,00',
    '06/06 | FARMACIA MODELO 02/04 | CIDADE B | | | 20,00',
    '12/06 | LIVRARIA TESTE | CIDADE C | | | 30,00',
    'Total para CLIENTE EXEMPLO 60,00',
    'CLIENTE EXEMPLO Cartão 4321 XXXX XXXX 2222',
    '10/06 | LOJA SINTETICA | CIDADE D | | | 15,00',
    '12/06 | SERVICO FICTICIO | CIDADE E | | | 25,00',
    'Total para CLIENTE EXEMPLO 40,00',
    'Total da fatura em real 100,00',
    'Limites',
  ],
]

const refundStatementPages = [
  [
    'Resumo da fatura',
    'Total da fatura Vencimento R$ 26,32 12/06/2025',
    'Saldo anterior R$ 60,00',
    '(-) Créditos/Pagamentos R$ 81,52',
    '(+) Compras/Débitos R$ 47,84',
  ],
  [
    'Lançamentos',
    'Número do Cartão 4321 XXXX XXXX 1111',
    '04/05 | LOJA DE TESTE | CIDADE A | | | 12,34',
    '04/05 | LOJA DE TESTE | CIDADE A | | | 12,34 | -',
    '08/05 | MERCADO SINTÉTICO | CIDADE B | | | 10,00',
    '27/04 | SERVIÇO MODELO | CIDADE C | | | 20,00',
    '14/05 | CAFÉ FICTÍCIO | CIDADE D | | | 5,50',
    '12/05 | PAGTO. POR DEB EM C/C | | | | 69,18',
    'Total para CLIENTE TESTE 35,50',
    'Total da fatura em real R$ 26,32',
    'Limites de compras e saques',
    '21/05 | OPÇÃO DE PAGAMENTO SIMULADA | | | | 999,99',
  ],
]

const internetBankingInvoicePages = [
  [
    'Fatura | Data 06/10/2026 - 10:26:53', 'Cartao selecionado', 'Data de vencimento: | 12/07/2026',
    '**** **** **** 1271', 'Total da fatura: | R$ 1.245,87', 'Forma de pagamento: | Débito em conta',
    'Melhor data de compra: | 30', 'Valor da fatura anterior: | R$ 827,67',
    'Data | Lançamentos | Moeda de Origem | Valor (US$) | Cotação (US$) | Valor (R$)',
    'Gastos referentes ao cartão: Final 1271 | TITULAR | Valor da fatura: | R$ 905,96',
    '26', 'SEGURO SUPERPROTEGIDO | 9,99', 'JUN',
    '12', 'SALDO ANTERIOR | 827,67', 'JUN', 'PAGTO. POR DEB EM C/C | -827,67',
    '06', 'ALCHYMIST BEACH CLUB | 260,00', 'JUN',
    '27', 'EDZIA PIRES COBDE ( 02/04 ) | 255,97', 'MAI',
    '23', 'AGROLESTE RACOES ( 02/02 ) | 380,00', 'MAI',
  ],
  [
    'Data | Lançamentos | Moeda de Origem | Valor (US$) | Cotação (US$) | Valor (R$)',
    'Gastos referentes ao cartão: Final 9833 | TITULAR | Valor da fatura: | R$ 339,91',
    '01', 'CONTA VIVO | 104,91', 'JUN', '28', 'FORMULA FARMACIA DE MA | 235,00', 'MAI',
    'Total da fatura (final 1271 + 9833): | R$ 1.245,87',
    'Resumo das Despesas | Real', 'Saldo anterior | 827,67', '(-)Pagamentos/Créditos: | 827,67',
    '(+)Despesas locais: | 1.245,87', '(=)Total da fatura: | 1.245,87',
  ],
]

// Sanitized structural reproductions of Internet Banking PDFs without card-specific sections.
const internetBankingSelectedCardOnlyMayPages = [[
  'Fatura | Data 07/10/2026 - 03:39:06', 'Cartao selecionado', '**** **** **** 1271',
  'Data de vencimento: | 12/05/2026', 'Total da fatura: | R$ 191,68',
  'Data | Lançamentos | Moeda de Origem | Valor (US$) | Cotação (US$) | Valor (R$)',
  '28', 'SEGURO SUPERPROTEGIDO | 9,99', 'ABR',
  '15', 'CRIAR CENTRO VETERINAR ( 01/02 ) | 181,69', 'ABR',
  'Total da fatura (final 1271): | R$ 191,68',
  'Resumo das Despesas | Real', 'Saldo anterior | 0,00', '(-)Pagamentos/Créditos: | 0,00',
  '(+)Despesas locais: | 191,68', '(=)Total da fatura: | 191,68',
]]

const internetBankingSelectedCardOnlyJunePages = [[
  'Fatura | Data 07/10/2026 - 03:39:14', 'Cartao selecionado', '**** **** **** 1271',
  'Data de vencimento: | 12/06/2026', 'Total da fatura: | R$ 827,67',
  'Data | Lançamentos | Moeda de Origem | Valor (US$) | Cotação (US$) | Valor (R$)',
  '27', 'EDZIA PIRES COBDE ( 01/04 ) | 255,99', 'MAI',
  'SEGURO SUPERPROTEGIDO | 9,99',
  '23', 'AGROLESTE RACOES ( 01/02 ) | 380,00', 'MAI',
  '12', 'SALDO ANTERIOR | 191,68', 'MAI', 'PAGTO. POR DEB EM C/C | -191,68',
  '15', 'CRIAR CENTRO VETERINAR ( 02/02 ) | 181,69', 'ABR',
  'Total da fatura (final 1271): | R$ 827,67',
  'Resumo das Despesas | Real', 'Saldo anterior | 191,68', '(-)Pagamentos/Créditos: | 191,68',
  '(+)Despesas locais: | 827,67', '(=)Total da fatura: | 827,67',
]]

// Sanitized table shapes derived from the two Internet Banking examples. No real statement data is stored here.
const internetBankingInheritedRefundPages = [
  [
    'Fatura | Data 07/10/2026 - 00:00:00', 'Cartao selecionado', 'Data de vencimento: | 12/10/2026',
    'Total da fatura: | R$ 160,00', 'Gastos referentes ao cartão: Final 1111 | TITULAR | Valor da fatura: | R$ 160,00',
    'Data | Lançamentos | Moeda de Origem | Valor (US$) | Cotação (US$) | Valor (R$)',
    '07/09 COMPRA SINTETICA 100,00', 'OUTRA COMPRA DEMO | 80,00',
    'CREDITO MODELO | -20,00', 'PAGTO. POR DEB EM C/C | -500,00',
    'Resumo das Despesas | Real', 'Saldo anterior | 500,00', '(-)Pagamentos/Créditos: | 520,00',
    '(+)Despesas locais: | 180,00', '(=)Total da fatura: | 160,00',
  ],
]

const internetBankingInstallmentRunPages = [
  [
    'Fatura | Data 07/10/2026 - 00:00:00', 'Cartao selecionado', 'Data de vencimento: | 12/10/2026',
    'Total da fatura: | R$ 120,00', 'Gastos referentes ao cartão: Final 5514 | TITULAR | Valor da fatura: | R$ 120,00',
    'Data | Lançamentos | Moeda de Origem | Valor (US$) | Cotação (US$) | Valor (R$)',
    '25', 'PROJETO PARCELADO (01/10) | 40,00', 'SET',
    '19', 'PROJETO PARCELADO (01/10) | 40,00', 'SET',
    'SERVICO DIGITAL | 30,00',
    ...Array.from({ length: 9 }, (_, index) => `PROJETO PARCELADO (${String(index + 2).padStart(2, '0')}/10) | 50,00`),
    'COMPRA SINTETICA | 140,00', 'PROJETO PARCELADO | -580,00',
    'SALDO ANTERIOR | 200,00', 'PAGTO. POR DEB EM C/C | -200,00',
    'Resumo das Despesas | Real', 'Saldo anterior | 200,00', '(-)Pagamentos/Créditos: | 780,00',
    '(+)Despesas locais: | 650,00', 'Despesas no exterior: | 50,00', '(=)Total da fatura: | 120,00',
  ],
]

const internetBankingAggregateRefundPages = [[
  'Fatura | Data 07/10/2026 - 00:00:00', 'Cartao selecionado', 'Data de vencimento: | 12/10/2026',
  'Total da fatura: | R$ 100,01',
  'Gastos referentes ao cartão: Final 5514 | TITULAR | Valor da fatura: | R$ 100,01',
  'Data | Lançamentos | Moeda de Origem | Valor (US$) | Cotação (US$) | Valor (R$)',
  '19',
  ...Array.from({ length: 10 }, (_, index) => `LOJA MODELO (${String(index + 1).padStart(2, '0')}/10) | 100,01`),
  'LOJA MODELO | -1.000,10', 'SET',
  '25', 'LOJA MODELO (01/10) | 100,01', 'SET',
  'Resumo das Despesas | Real', 'Saldo anterior | 0,00', '(-)Pagamentos/Créditos: | 1.000,10',
  '(+)Despesas locais: | 1.100,11', '(=)Total da fatura: | 100,01',
]]

const internetBankingFinancialClosePages = [[
  'Fatura | Data 07/10/2026 - 00:00:00', 'Cartao selecionado', 'Data de vencimento: | 12/10/2026',
  'Total da fatura: | R$ 764,02',
  'Gastos referentes ao cartão: Final 5514 | TITULAR | Valor da fatura: | R$ 600,00',
  '19', 'COMPRA DEMO | 700,00', 'CREDITO DEMO | -100,00', 'SET',
  'Gastos referentes ao cartão: Final 5875 | TITULAR | Valor da fatura: | R$ 164,02',
  '20', 'SERVICO MODELO | 160,00', 'IOF MODELO | 4,02', 'SET',
  'Resumo das Despesas | Real', 'Saldo anterior | 0,00', '(-)Pagamentos/Créditos: | 100,00',
  '(+)Despesas locais: | 864,02', '(=)Total da fatura: | 764,02',
]]

// Synthetic structural reproduction of the reference invoice's exact one-to-one refund.
const internetBankingFullPurchaseRefundPages = [[
  'Fatura | Data 07/10/2026 - 03:36:20', 'Cartao selecionado', 'Data de vencimento: | 12/06/2026',
  'Total da fatura: | R$ 312,75', 'Forma de pagamento: | Débito em conta', '**** **** **** 5875',
  'Valor da fatura anterior: | R$ 691,85',
  'Data | Lançamentos | Moeda de Origem | Valor (US$) | Cotação (US$) | Valor (R$)',
  'Gastos referentes ao cartão: Final 5875 | TITULAR | Valor da fatura: | R$ 129,90',
  '12', 'SALDO ANTERIOR | 691,85', 'PAGTO. POR DEB EM C/C | -691,85', 'MAI',
  '08', 'SELFITHOMEROCASTELOBRA | 129,90', 'MAI',
  '04', 'PETZ DIGITAL | 294,82', 'PETZ DIGITAL | -294,82', 'MAI',
  'Gastos referentes ao cartão: Final 5514 | TITULAR | Valor da fatura: | R$ 182,85',
  '14', 'IFD*iFood | 7,95', 'MAI', '27', 'EBN *BATTLE NET | 174,90', 'ABR',
  'Total da fatura (final 5875 + 5514): | R$ 312,75',
  'Resumo das Despesas | Real', 'Saldo anterior | 691,85', '(-)Pagamentos/Créditos: | 986,67',
  '(+)Despesas locais: | 607,57', '(=)Total da fatura: | 312,75',
]]

const internetBankingFinancialAdjustmentsPages = [[
  'Fatura | Data 07/10/2026 - 00:00:00', 'Cartao selecionado', 'Data de vencimento: | 12/10/2026',
  'Total da fatura: | R$ 222,00',
  'Gastos referentes ao cartão: Final 5875 | TITULAR | Valor da fatura: | R$ 122,00',
  '19', 'ASSINATURA DEMO | 120,00', 'SET', 'IOF S/ TRANSACAO DEMO | 2,00',
  'Gastos referentes ao cartão: Final 5514 | TITULAR | Valor da fatura: | R$ 100,00',
  '19', 'PROJETO PARCELADO | 700,00', 'SET', 'PROJETO PARCELADO | -600,00', 'PAGTO. POR DEB EM C/C | -40,00',
  'Resumo das Despesas | Real', 'Saldo anterior | 40,00', '(-)Pagamentos/Créditos: | 640,00',
  '(+)Despesas locais: | 822,00', '(=)Total da fatura: | 222,00',
]]

function ledger(id: string, date: string, description: string, amount: number, paymentMethod = 'Crédito_Bradesco'): LedgerTransaction {
  return { id, source: 'SHEET', sheetRecordId: id, bankTransactionId: null, date, description, originalDescription: description, amount, direction: 'DEBIT', type: 'EXPENSE', paymentMethod, category: '', month: '', year: date.slice(0, 4), isFixed: null, isEssential: null, installment: null, totalInstallments: null, balanceAfter: null, original: {} }
}
function installmentStatement(date = '2025-10-30', description = 'ASAAS*OFICINA CR', installment = 6, total = 6): CardStatement {
  const statement = parseCardStatementPages(syntheticPages)
  const transaction = { ...statement.transactions[0], purchaseDate: date, date, description, originalDescription: description, amount: 9450, installment, totalInstallments: total }
  return { ...statement, transactions: [transaction] }
}
function installmentLedger(id: string, date: string, installment: number, description = 'Oficina Criativa Renovação'): LedgerTransaction {
  return { ...ledger(id, date, `(${installment}/6) ${description}`, 9450), installment, totalInstallments: 6 }
}
function cardBank(id: string, date: string, amount: number): BankTransaction {
  return { id, source: 'BANK', sheetRecordId: null, bankTransactionId: id, date, description: 'GASTOS CARTAO DE CREDITO', originalDescription: 'GASTOS CARTAO DE CREDITO', amount, direction: 'DEBIT', directionKnown: true, type: 'CARD_PAYMENT', paymentMethod: '', category: '', month: '', year: date.slice(0, 4), isFixed: null, isEssential: null, installment: null, totalInstallments: null, balanceAfter: null, original: {} }
}

describe('PDF de fatura do cartão', () => {
  it('usa o cartão selecionado como fallback quando a tabela Internet Banking não tem blocos por cartão', () => {
    const statement = parseCardStatementPages(internetBankingSelectedCardOnlyMayPages)

    expect(statement.sourceLayout).toBe('INTERNET_BANKING')
    expect(statement).toMatchObject({ dueDate: '2026-05-12', reportedTotal: 19168, errors: [] })
    expect(statement.cardSubtotals).toEqual([{ cardIdentifier: 'XXXX XXXX XXXX 1271', amount: 19168 }])
    expect(statement.transactions.map((item) => [item.cardIdentifier, item.date, item.originalDescription, item.amount, item.installment, item.totalInstallments])).toEqual([
      ['XXXX XXXX XXXX 1271', '2026-04-28', 'SEGURO SUPERPROTEGIDO', 999, null, null],
      ['XXXX XXXX XXXX 1271', '2026-04-15', 'CRIAR CENTRO VETERINAR', 18169, 1, 2],
    ])
  })

  it('usa o cartão selecionado sem converter saldo anterior ou pagamento em compra', () => {
    const statement = parseCardStatementPages(internetBankingSelectedCardOnlyJunePages)

    expect(statement.sourceLayout).toBe('INTERNET_BANKING')
    expect(statement).toMatchObject({ dueDate: '2026-06-12', reportedTotal: 82767, previousBalance: 19168, previousPayment: 19168, creditsPaymentsTotal: 19168, purchasesDebitsTotal: 82767, accountingDifference: 0, errors: [] })
    expect(statement.cardSubtotals).toEqual([{ cardIdentifier: 'XXXX XXXX XXXX 1271', amount: 82767 }])
    expect(statement.transactions.map((item) => [item.originalDescription, item.amount, item.installment, item.totalInstallments])).toEqual([
      ['EDZIA PIRES COBDE', 25599, 1, 4],
      ['SEGURO SUPERPROTEGIDO', 999, null, null],
      ['AGROLESTE RACOES', 38000, 1, 2],
      ['CRIAR CENTRO VETERINAR', 18169, 2, 2],
    ])
    expect(statement.transactions.some((item) => /saldo anterior|pagto/i.test(item.originalDescription))).toBe(false)
  })

  it('não cria cartão de fallback sem tabela válida, vencimento e total identificados', () => {
    const missingTable = parseCardStatementPages([[
      'Fatura | Data 07/10/2026 - 03:39:06', 'Cartao selecionado', '**** **** **** 1271',
      'Data de vencimento: | 12/05/2026', 'Total da fatura: | R$ 191,68',
    ]])
    const missingSelectedCard = parseCardStatementPages([[
      'Fatura | Data 07/10/2026 - 03:39:06', 'Data de vencimento: | 12/05/2026',
      'Total da fatura: | R$ 191,68', 'Data | Lançamentos | Moeda de Origem | Valor (R$)',
      '28', 'LOJA MODELO | 191,68', 'ABR',
    ]])

    expect(missingTable.errors.length).toBeGreaterThan(0)
    expect(missingSelectedCard.sourceLayout).toBe('INTERNET_BANKING')
    expect(missingSelectedCard.errors).toContain('Nenhum cartão foi identificado na fatura.')
    expect(missingSelectedCard.transactions).toEqual([])
  })

  it('detecta e normaliza o layout Internet Banking sem misturar os cartões da mesma fatura', () => {
    expect(detectBradescoInvoiceLayout(internetBankingInvoicePages)).toBe('INTERNET_BANKING')
    const statement = parseCardStatementPages(internetBankingInvoicePages, 'nome-aleatorio.pdf')
    expect(statement).toMatchObject({ sourceLayout: 'INTERNET_BANKING', dueDate: '2026-07-12', reportedTotal: 124587, invoicePaymentMethod: 'Débito em conta', bestPurchaseDay: 30, previousBalance: 82767, previousPayment: 82767, creditsPaymentsTotal: 82767, purchasesDebitsTotal: 124587, accountingDifference: 0, errors: [] })
    expect(statement.cardSubtotals).toEqual([
      { cardIdentifier: 'XXXX XXXX XXXX 1271', amount: 90596 },
      { cardIdentifier: 'XXXX XXXX XXXX 9833', amount: 33991 },
    ])
    expect(statement.transactions).toHaveLength(6)
    expect(statement.transactions.map(({ cardIdentifier, date, originalDescription, amount, installment, totalInstallments }) => ({ card: cardIdentifier.slice(-4), date, description: originalDescription, amount, installment, totalInstallments }))).toEqual([
      { card: '1271', date: '2026-06-26', description: 'SEGURO SUPERPROTEGIDO', amount: 999, installment: null, totalInstallments: null },
      { card: '1271', date: '2026-06-06', description: 'ALCHYMIST BEACH CLUB', amount: 26000, installment: null, totalInstallments: null },
      { card: '1271', date: '2026-05-27', description: 'EDZIA PIRES COBDE', amount: 25597, installment: 2, totalInstallments: 4 },
      { card: '1271', date: '2026-05-23', description: 'AGROLESTE RACOES', amount: 38000, installment: 2, totalInstallments: 2 },
      { card: '9833', date: '2026-06-01', description: 'CONTA VIVO', amount: 10491, installment: null, totalInstallments: null },
      { card: '9833', date: '2026-05-28', description: 'FORMULA FARMACIA DE MA', amount: 23500, installment: null, totalInstallments: null },
    ])
    expect(statement.transactions.some((item) => /saldo anterior|pagto/i.test(item.originalDescription))).toBe(false)
    expect(cardStatementFinancialIdentity(statement)).toBeTruthy()
  })

  it('herda a última data do cartão para linhas positivas e créditos sem data impressa', () => {
    const statement = parseCardStatementPages(internetBankingInheritedRefundPages)
    const purchases = statement.transactions.filter((item) => item.type === 'PURCHASE')
    const refunds = statement.transactions.filter((item) => item.type === 'REFUND')

    expect(purchases).toHaveLength(2)
    expect(purchases.map((item) => item.originalDescription)).toEqual(['COMPRA SINTETICA', 'OUTRA COMPRA DEMO'])
    expect(refunds).toHaveLength(1)
    expect(refunds[0]).toMatchObject({
      originalDescription: 'CREDITO MODELO', purchaseDate: '2026-09-07', amount: 2000,
      direction: 'CREDIT', type: 'REFUND',
    })
    expect(purchases.every((item) => item.purchaseDate === '2026-09-07')).toBe(true)
    expect(statement.previousPayment).toBe(50000)
    expect(statement.transactions.some((item) => /saldo anterior|pagto/i.test(item.originalDescription))).toBe(false)
    expect(statement.purchasesDebitsTotal).toBe(18000)
    expect(statement.creditsPaymentsTotal).toBe(52000)
    expect(statement.reportedTotal).toBe(16000)
    expect(statement.previousBalance! - statement.creditsPaymentsTotal! + statement.purchasesDebitsTotal!).toBe(statement.reportedTotal)
    expect(statement.cardSubtotals).toEqual([{ cardIdentifier: 'XXXX XXXX XXXX 1111', amount: 16000 }])
    expect(statement.errors).toEqual([])
  })

  it('herda a data nas parcelas seguintes e classifica o crédito sem sinal como compra', () => {
    const statement = parseCardStatementPages(internetBankingInstallmentRunPages)
    const installments = statement.transactions.filter((item) => item.originalDescription.startsWith('PROJETO PARCELADO'))
    const sequence = installments.filter((item) => item.installment != null && item.installment !== 1)
    const refunds = statement.transactions.filter((item) => item.type === 'REFUND')
    const purchases = statement.transactions.filter((item) => item.type === 'PURCHASE')

    expect(sequence.map((item) => [item.installment, item.totalInstallments])).toEqual(
      Array.from({ length: 9 }, (_, index) => [index + 2, 10]),
    )
    expect(sequence.every((item) => item.purchaseDate === '2026-09-19')).toBe(true)
    expect(purchases.find((item) => item.originalDescription === 'SERVICO DIGITAL')).toMatchObject({
      amount: 3000, direction: 'DEBIT', type: 'PURCHASE', purchaseDate: '2026-09-19',
    })
    expect(refunds).toHaveLength(1)
    expect(refunds[0]).toMatchObject({
      originalDescription: 'PROJETO PARCELADO', amount: 58000, direction: 'CREDIT', type: 'REFUND',
      purchaseDate: '2026-09-19', installment: null,
    })
    expect(statement.transactions).toHaveLength(14)
    expect(statement.previousPayment).toBe(20000)
    expect(statement.purchasesDebitsTotal).toBe(70000)
    expect(statement.creditsPaymentsTotal).toBe(78000)
    expect(statement.reportedTotal).toBe(12000)
    expect(statement.previousBalance! - statement.creditsPaymentsTotal! + statement.purchasesDebitsTotal!).toBe(statement.reportedTotal)
    expect(statement.errors).toEqual([])
  })

  it('reconhece estorno agregado 1:N somente para sequência completa, mesmo cartão/data/descrição e soma exata', () => {
    const statement = parseCardStatementPages(internetBankingAggregateRefundPages)
    const group = statement.refundGroups?.[0]
    const installments = statement.transactions.filter((item) => item.type === 'PURCHASE' && item.date === '2026-09-19')
    const separatePurchase = statement.transactions.find((item) => item.type === 'PURCHASE' && item.date === '2026-09-25')
    const result = reconcileCardStatement(statement, [])

    expect(statement.sourceLayout).toBe('INTERNET_BANKING')
    expect(statement.errors).toEqual([])
    expect(statement.transactions).toHaveLength(12)
    expect(group).toMatchObject({ cardIdentifier: 'XXXX XXXX XXXX 5514', date: '2026-09-19', merchant: 'LOJA MODELO', purchaseGroupAmount: 100010, refundAmount: 100010, netAmount: 0, installmentCount: 10 })
    expect(group?.transactionIds).toHaveLength(10)
    expect(installments.map((item) => [item.installment, item.totalInstallments])).toEqual(Array.from({ length: 10 }, (_, index) => [index + 1, 10]))
    expect(installments.every((item) => item.financialStatus === 'REFUNDED' && item.refundGroupId === group?.id)).toBe(true)
    expect(statement.transactions.find((item) => item.id === group?.refundTransactionId)).toMatchObject({ direction: 'CREDIT', type: 'REFUND', amount: 100010 })
    expect(result.matches.filter((match) => match.status === 'CARD_REFUNDED')).toHaveLength(10)
    expect(result.matches.filter((match) => match.status === 'CARD_MISSING')).toHaveLength(1)
    expect(result.matches.find((match) => match.transaction.date === '2026-09-25')).toMatchObject({ status: 'CARD_MISSING', transaction: { financialStatus: 'ACTIVE', installment: 1, amount: 10001 } })
    expect(result.statementTotal).toBe(10001)
    expect(separatePurchase?.financialStatus).toBe('ACTIVE')
  })

  it('neutraliza purchase + refund integral 1:1 no mesmo cartão antes de classificar compras ausentes', () => {
    const statement = parseCardStatementPages(internetBankingFullPurchaseRefundPages)
    const petz = statement.transactions.find((item) => item.type === 'PURCHASE' && item.originalDescription === 'PETZ DIGITAL')!
    const refund = statement.transactions.find((item) => item.type === 'REFUND' && item.originalDescription === 'PETZ DIGITAL')!
    const reconciled = reconcileCardStatement(statement, [])
    const petzMatch = reconciled.matches.find((match) => match.transaction.id === petz.id)

    expect(statement.sourceLayout).toBe('INTERNET_BANKING')
    expect(statement.errors).toEqual([])
    expect(petz).toMatchObject({ amount: 29482, direction: 'DEBIT', financialStatus: 'REFUNDED' })
    expect(refund).toMatchObject({ amount: 29482, direction: 'CREDIT', type: 'REFUND', refundGroupId: petz.refundGroupId })
    expect(petz.refundGroupId).toBeTruthy()
    expect(statement.refundGroups).toContainEqual(expect.objectContaining({ transactionIds: [petz.id], refundTransactionId: refund.id, netAmount: 0, installmentCount: 1 }))
    expect(petzMatch?.status).toBe('CARD_REFUNDED')
    expect(reconciled.matches.some((match) => match.status === 'CARD_MISSING' && match.transaction.id === petz.id)).toBe(false)
    expect(summarizeCardPurchases(reconciled.matches)).toMatchObject({ eligible: 3, missing: 3, refunded: 1 })

    expect(statement.cardSubtotals).toEqual([
      { cardIdentifier: 'XXXX XXXX XXXX 5875', amount: 12990 },
      { cardIdentifier: 'XXXX XXXX XXXX 5514', amount: 18285 },
    ])
    expect(statement.cardSubtotals.reduce((sum, item) => sum + item.amount, 0)).toBe(31275)
    expect(statement.reportedTotal).toBe(31275)
    expect(statement.purchasesDebitsTotal).toBe(60757)
    expect(statement.creditsPaymentsTotal).toBe(98667)
    expect(statement.previousBalance! - statement.creditsPaymentsTotal! + statement.purchasesDebitsTotal!).toBe(statement.reportedTotal)
  })

  it('não neutraliza automaticamente crédito parcial nem correspondência ambígua', () => {
    const base = parseCardStatementPages(internetBankingFullPurchaseRefundPages)
    const petzPurchase = base.transactions.find((item) => item.originalDescription === 'PETZ DIGITAL' && item.type === 'PURCHASE')!
    const partialRefund = base.transactions.find((item) => item.originalDescription === 'PETZ DIGITAL' && item.type === 'REFUND')!
    const activePurchase = { ...petzPurchase, financialStatus: 'ACTIVE' as const, refundGroupId: undefined }
    const partial = identifyOneToOneRefundGroups([activePurchase, { ...partialRefund, amount: partialRefund.amount - 1, refundGroupId: undefined }])
    expect(partial).toEqual([])
    expect(activePurchase.financialStatus).toBe('ACTIVE')
    expect(identifyOneToOneRefundGroups([activePurchase, { ...partialRefund, date: '2026-05-05', refundGroupId: undefined }])).toEqual([])

    const ambiguousPurchases = [{ ...activePurchase, id: 'petz-one' }, { ...activePurchase, id: 'petz-two' }]
    const ambiguous = identifyOneToOneRefundGroups([...ambiguousPurchases, { ...partialRefund, refundGroupId: undefined }])
    expect(ambiguous).toEqual([])
    expect(ambiguousPurchases.every((item) => item.financialStatus === 'ACTIVE')).toBe(true)
  })

  it('não associa estorno parcial, de outro merchant ou de outro cartão ao grupo de parcelas', () => {
    const parsed = parseCardStatementPages(internetBankingAggregateRefundPages)
    const cleanTransactions = parsed.transactions.map((item) => ({ ...item, ...(item.type === 'PURCHASE' ? { financialStatus: 'ACTIVE' as const, refundGroupId: undefined } : {}) }))
    const testVariants = [
      cleanTransactions.map((item) => item.type === 'REFUND' ? { ...item, amount: item.amount - 1 } : { ...item }),
      cleanTransactions.map((item) => item.type === 'REFUND' ? { ...item, originalDescription: 'OUTRA LOJA' } : { ...item }),
      cleanTransactions.map((item) => item.type === 'REFUND' ? { ...item, cardIdentifier: 'XXXX XXXX XXXX 9999' } : { ...item }),
    ]
    for (const transactions of testVariants) {
      expect(identifyAggregatedRefundGroups(transactions)).toEqual([])
      expect(transactions.filter((item) => item.type === 'PURCHASE' && item.date === '2026-09-19').every((item) => item.financialStatus !== 'REFUNDED')).toBe(true)
    }
  })

  it('mantém uma fatura sintética de R$ 764,02 fechando com crédito e encargo sem dupla contabilização', () => {
    const statement = parseCardStatementPages(internetBankingFinancialClosePages)
    expect(statement).toMatchObject({ reportedTotal: 76402, previousBalance: 0, creditsPaymentsTotal: 10000, purchasesDebitsTotal: 86402, accountingDifference: 0, errors: [] })
    expect(statement.cardSubtotals.reduce((sum, subtotal) => sum + subtotal.amount, 0)).toBe(76402)
    expect(statement.transactions.filter((item) => item.type === 'PURCHASE').reduce((sum, item) => sum + item.amount, 0)).toBe(86000)
    expect(statement.transactions.filter((item) => item.type === 'REFUND').reduce((sum, item) => sum + item.amount, 0)).toBe(10000)
    expect((statement.financialAdjustments ?? []).reduce((sum, item) => sum + (item.direction === 'DEBIT' ? item.amount : -item.amount), 0)).toBe(402)
    expect(statement.previousBalance! - statement.creditsPaymentsTotal! + statement.purchasesDebitsTotal!).toBe(76402)
  })

  it('não propaga a última data através da fronteira entre cartões', () => {
    const pages = [[
      'Fatura | Data 07/10/2026 - 00:00:00', 'Cartao selecionado', 'Data de vencimento: | 12/10/2026',
      'Total da fatura: | R$ 20,00',
      'Gastos referentes ao cartão: Final 1111 | TITULAR | Valor da fatura: | R$ 10,00',
      '19', 'COMPRA CARTAO UM | 10,00', 'SET',
      'Gastos referentes ao cartão: Final 2222 | TITULAR | Valor da fatura: | R$ 10,00',
      'COMPRA SEM DATA NO NOVO CARTAO | 50,00',
      '22', 'COMPRA CARTAO DOIS | 10,00', 'SET',
      'Resumo das Despesas | Real', 'Saldo anterior | 0,00', '(-)Pagamentos/Créditos: | 0,00',
      '(+)Despesas locais: | 20,00', '(=)Total da fatura: | 20,00',
    ]]
    const statement = parseCardStatementPages(pages)

    expect(statement.transactions).toHaveLength(2)
    expect(statement.transactions.map((item) => [item.cardIdentifier.slice(-4), item.purchaseDate, item.originalDescription])).toEqual([
      ['1111', '2026-09-19', 'COMPRA CARTAO UM'],
      ['2222', '2026-09-22', 'COMPRA CARTAO DOIS'],
    ])
  })

  it('valida subtotais e despesas com taxas separadas das compras conciliáveis', () => {
    const statement = parseCardStatementPages(internetBankingFinancialAdjustmentsPages)
    const purchases = statement.transactions.filter((item) => item.type === 'PURCHASE')
    const refunds = statement.transactions.filter((item) => item.type === 'REFUND')
    const feeDebits = (statement.financialAdjustments ?? []).filter((item) => item.direction === 'DEBIT')

    expect(purchases).toHaveLength(2)
    expect(refunds).toHaveLength(1)
    expect(purchases.some((item) => item.originalDescription.startsWith('IOF'))).toBe(false)
    expect(feeDebits).toEqual([expect.objectContaining({
      description: 'IOF S/ TRANSACAO DEMO', amount: 200, direction: 'DEBIT', kind: 'TAX',
      cardIdentifier: 'XXXX XXXX XXXX 5875', date: '2026-09-19',
    })])
    expect(statement.cardSubtotals).toEqual([
      { cardIdentifier: 'XXXX XXXX XXXX 5875', amount: 12200 },
      { cardIdentifier: 'XXXX XXXX XXXX 5514', amount: 10000 },
    ])
    expect(statement.purchasesDebitsTotal).toBe(82200)
    expect(purchases.reduce((sum, item) => sum + item.amount, 0) + feeDebits.reduce((sum, item) => sum + item.amount, 0)).toBe(statement.purchasesDebitsTotal)
    expect(statement.creditsPaymentsTotal).toBe(64000)
    expect(statement.previousPayment).toBe(4000)
    expect(statement.reportedTotal).toBe(22200)
    expect(statement.cardSubtotals.reduce((sum, card) => sum + card.amount, 0)).toBe(statement.reportedTotal)
    expect(statement.previousBalance! - statement.creditsPaymentsTotal! + statement.purchasesDebitsTotal!).toBe(statement.reportedTotal)
    expect(statement.errors).toEqual([])
  })

  it('mantém os alertas quando uma taxa torna subtotal ou despesas incompatíveis', () => {
    const pages = structuredClone(internetBankingFinancialAdjustmentsPages)
    pages[0][8] = 'IOF S/ TRANSACAO DEMO | 3,00'
    const statement = parseCardStatementPages(pages)

    expect(statement.errors).toContain('Divergência entre lançamentos e encargos extraídos e subtotal informado para um dos cartões.')
    expect(statement.errors).toContain('Divergência entre débitos financeiros extraídos e total de Despesas locais e no exterior informado pela fatura.')
  })

  it('reconhece mobile por conteúdo, não por nome, e mantém o parser legado', () => {
    expect(detectBradescoInvoiceLayout(syntheticPages)).toBe('MOBILE_APP')
    expect(parseCardStatementPages(syntheticPages, 'arquivo-sem-nome-conhecido.pdf').sourceLayout).toBe('MOBILE_APP')
  })

  it('não trata um layout desconhecido como uma fatura vazia válida', () => {
    const unknown = parseCardStatementPages([['Documento financeiro', 'Conteúdo não reconhecido']], 'fatura.pdf')
    expect(detectBradescoInvoiceLayout([['Documento financeiro', 'Conteúdo não reconhecido']])).toBe('UNKNOWN')
    expect(unknown).toMatchObject({ sourceLayout: 'UNKNOWN', dueDate: null, reportedTotal: null, transactions: [], cardSubtotals: [] })
    expect(unknown.errors).toContain('Este layout de fatura Bradesco ainda não foi reconhecido.')
  })

  it('gera a mesma identidade financeira para uma fatura equivalente nos dois layouts', () => {
    const internet = parseCardStatementPages(internetBankingInvoicePages)
    const mobile = {
      ...internet,
      sourceLayout: 'MOBILE_APP' as const,
      statementIdentity: 'identity-do-mobile',
      cardSubtotals: internet.cardSubtotals.map((card) => ({ ...card, cardIdentifier: `6550 XXXX XXXX ${card.cardIdentifier.slice(-4)}` })),
      transactions: internet.transactions.map((transaction) => ({ ...transaction, cardIdentifier: `6550 XXXX XXXX ${transaction.cardIdentifier.slice(-4)}` })),
    }
    expect(cardStatementFinancialIdentity(internet)).toBe(cardStatementFinancialIdentity(mobile))
  })

  it('extrai tabela, dois cartões, parcelas, pagamentos excluídos e valida os totais sintéticos', () => {
    const statement = parseCardStatementPages(syntheticPages, 'fatura-sintetica.pdf')
    const reimported = parseCardStatementPages(structuredClone(syntheticPages), 'outro-nome.pdf')
    expect(statement.pageCount).toBe(2)
    expect(statement.transactions).toHaveLength(5)
    expect(statement.transactions.map((item) => item.cardIdentifier)).toEqual([
      '4321 XXXX XXXX 1111', '4321 XXXX XXXX 1111', '4321 XXXX XXXX 1111', '4321 XXXX XXXX 2222', '4321 XXXX XXXX 2222',
    ])
    expect(statement.transactions[0]).toMatchObject({ date: '2025-06-02', amount: 1000, city: 'CIDADE A', installment: 2, totalInstallments: 2 })
    expect(statement.transactions[0]).toMatchObject({ purchaseDate: '2025-06-02', invoiceDueDate: '2025-07-12', statementDueDate: '2025-07-12' })
    expect(statement.transactions[1]).toMatchObject({ date: '2025-06-06', amount: 2000, city: 'CIDADE B', installment: 2, totalInstallments: 4 })
    expect(statement.transactions[2]).toMatchObject({ date: '2025-06-12', city: 'CIDADE C', installment: null, totalInstallments: null })
    expect(statement.cardSubtotals).toEqual([{ cardIdentifier: '4321 XXXX XXXX 1111', amount: 6000 }, { cardIdentifier: '4321 XXXX XXXX 2222', amount: 4000 }])
    expect(statement.reportedTotal).toBe(10000)
    expect(statement.purchasesDebitsTotal).toBe(10000)
    expect(statement.previousPayment).toBeNull()
    expect(statement.dueDate).toBe('2025-07-12')
    expect(statement.nextClosingDate).toBe('2025-07-30')
    expect(statement.errors).toEqual([])
    expect(reimported.statementIdentity).toBe(statement.statementIdentity)
    expect(reimported.transactions.map((item) => item.id)).toEqual(statement.transactions.map((item) => item.id))
  })

  it('preserva a data de compra e o vencimento como campos separados e não infere vencimento pelo fechamento', () => {
    const statement = parseCardStatementPages([
      ['Total da fatura', 'Cliente Exemplo R$ 10,00', 'Previsão de fechamento da próxima fatura: 30/03/2026'],
      ['Lançamentos', 'Número do Cartão 4321 XXXX XXXX 1111', '02/02/2026 | COMPRA SINTETICA | CIDADE A | | | 10,00', 'Total da fatura em real 10,00'],
    ])
    expect(statement.dueDate).toBeNull()
    expect(statement.nextClosingDate).toBe('2026-03-30')
    expect(statement.transactions[0]).toMatchObject({
      date: '2026-02-02', purchaseDate: '2026-02-02', invoiceDueDate: null, statementDueDate: null,
    })
  })

  it('registra pagamento anterior como informação separada sem incluí-lo como compra', () => {
    const pages = structuredClone(syntheticPages)
    pages[1].splice(4, 0, '12/05 | PAGTO. POR DEB EM C/C | | | | 50,00-')
    const statement = parseCardStatementPages(pages)
    expect(statement.previousPayment).toBe(5000)
    expect(statement.transactions).toHaveLength(5)
    expect(statement.transactions.reduce((sum, item) => sum + item.amount, 0)).toBe(10000)
  })

  it('aponta totais inconsistentes e conversão de valores brasileiros', () => {
    const pages = structuredClone(syntheticPages)
    pages[1][6] = '12/06 | LIVRARIA TESTE | CIDADE C | | | 31,00'
    const statement = parseCardStatementPages(pages)
    expect(statement.errors).toContain('Divergência entre lançamentos extraídos e subtotal informado para o cartão final 1111.')
    expect(statement.errors).toContain('Divergência entre compras extraídas e total de Compras/Débitos informado pela fatura.')
    expect(parseBrazilianMoney('1.245,87')).toBe(124587)
  })

  it('concilia apenas Crédito_Bradesco e distingue match, ambiguidade e compra não registrada', () => {
    const statement = parseCardStatementPages(syntheticPages)
    const sheet = [
      { ...ledger('same', '2025-06-02', '(2/2) Mercado', 1000), installment: 2, totalInstallments: 2 },
      { ...ledger('amb-a', '2025-06-06', '(2/4) Farmacia', 2000), installment: 2, totalInstallments: 4 },
      { ...ledger('amb-b', '2025-06-07', '(2/4) Farmacia duplicada', 2000), installment: 2, totalInstallments: 4 },
      ledger('wrong-method', '2025-06-12', 'Livro', 3000, 'Débito'),
      ledger('other', '2025-06-10', 'Loja', 1500),
      ledger('service', '2025-06-12', 'Serviço', 2500),
    ]
    const result = reconcileCardStatement(statement, sheet)
    expect(result.matches.map((match) => match.status)).toEqual(['CARD_MATCHED', 'CARD_REVIEW', 'CARD_MISSING', 'CARD_MATCHED', 'CARD_MATCHED'])
    expect(result.matches[1].candidates.map((item) => item.id)).toEqual(['amb-a', 'amb-b'])
    expect(result.difference).toBe(5000)
  })

  it('mantém o pagamento agregado separado do conjunto de compras individuais', () => {
    const statement: CardStatement = parseCardStatementPages(syntheticPages)
    const result = reconcileCardStatement(statement, [ledger('one', '2025-06-02', 'Mercado', 1000)])
    expect(result.statementTotal).toBe(10000)
    expect(result.matches).toHaveLength(5)
    expect(result.matches.filter((match) => match.status === 'CARD_MISSING')).toHaveLength(5)
  })

  it('usa o vencimento da fatura como data forte sem alterar a data real da compra', () => {
    const statement = parseCardStatementPages(syntheticPages)
    const purchase = { ...statement.transactions[0], installment: null, totalInstallments: null }
    expect(purchase.purchaseDate).toBe('2025-06-02')
    expect(purchase.date).toBe(purchase.purchaseDate)
    expect(purchase.invoiceDueDate).toBe('2025-07-12')
    const dueDateStatement = { ...statement, transactions: [purchase, ...statement.transactions.slice(1)] }
    const result = reconcileCardStatement(dueDateStatement, [ledger('due-date-row', '2025-07-12', 'Mercado Exemplo', 1000)])
    expect(result.matches[0]).toMatchObject({ status: 'CARD_MATCHED', sheet: { date: '2025-07-12' } })
    expect(result.matches[0].transaction.purchaseDate).toBe('2025-06-02')
    expect(result.matches[0].evidence).toContain('Data da planilha igual ao vencimento da fatura')
  })

  it('reconhece Kindle com descrição humana diferente na data de vencimento e não o classifica como ausente', () => {
    const base = parseCardStatementPages(syntheticPages)
    const purchase = { ...base.transactions[0], id: 'kindle-pdf', date: '2026-02-02', purchaseDate: '2026-02-02', invoiceDueDate: '2026-03-12', statementDueDate: '2026-03-12', description: 'Amazon Kindle Unltd', originalDescription: 'Amazon Kindle Unltd', amount: 299, installment: null, totalInstallments: null }
    const statement = { ...base, dueDate: '2026-03-12', transactions: [purchase] }
    const existing = { ...ledger('kindle-sheet', '2026-03-12', 'Assinatura Kindle unlimited (2 meses)', 299), type: 'OTHER' as const }
    const result = reconcileCardStatement(statement, [existing])
    expect(result.matches[0]).toMatchObject({ status: 'CARD_MATCHED', sheet: { id: 'kindle-sheet' } })
    expect(result.matches[0].candidates.map((item) => item.id)).toEqual(['kindle-sheet'])
    expect(result.matches.some((match) => match.status === 'CARD_MISSING')).toBe(false)
    expect(findDuplicateGroups([existing, ledger('kindle-duplicate', '2026-03-12', 'Assinatura Kindle', 299)])).toHaveLength(1)
  })

  it('reconhece descrições concatenadas e abreviadas sem regras específicas de marca', () => {
    const base = parseCardStatementPages(syntheticPages)
    const source = base.transactions[0]
    const pairs = [
      ['SELFITHOMEROCASTELOBRA', 'Mensalidade Selfit'],
      ['ASAAS*OFICINA CR', 'Oficina Criativa Renovação'],
    ]
    for (const [pdfDescription, sheetDescription] of pairs) {
      const purchase = { ...source, id: pdfDescription, date: '2026-02-02', purchaseDate: '2026-02-02', invoiceDueDate: '2026-03-12', description: pdfDescription, originalDescription: pdfDescription, amount: 1000, installment: null, totalInstallments: null }
      const statement = { ...base, dueDate: '2026-03-12', transactions: [purchase] }
      const row = ledger(`row-${pdfDescription}`, '2026-03-12', sheetDescription, 1000)
      expect(reconcileCardStatement(statement, [row]).matches[0]).toMatchObject({ status: 'CARD_MATCHED', sheet: { id: row.id } })
    }
  })

  it('mantém ambiguidade com dois candidatos compatíveis de mesmo valor e vencimento', () => {
    const base = parseCardStatementPages(syntheticPages)
    const purchase = { ...base.transactions[0], id: 'kindle-pdf', date: '2026-02-02', purchaseDate: '2026-02-02', invoiceDueDate: '2026-03-12', statementDueDate: '2026-03-12', description: 'Amazon Kindle Unltd', originalDescription: 'Amazon Kindle Unltd', amount: 299, installment: null, totalInstallments: null }
    const statement = { ...base, dueDate: '2026-03-12', transactions: [purchase] }
    const rows = [ledger('kindle-a', '2026-03-12', 'Assinatura Kindle unlimited (2 meses)', 299), ledger('kindle-b', '2026-03-12', 'Kindle Unlimited mensal', 299)]
    expect(reconcileCardStatement(statement, rows).matches[0]).toMatchObject({ status: 'CARD_REVIEW', sheet: null })
  })

  it('não reutiliza a mesma linha para duas compras iguais da mesma fatura', () => {
    const base = parseCardStatementPages(syntheticPages)
    const first = { ...base.transactions[0], id: 'amazon-1', date: '2026-02-02', purchaseDate: '2026-02-02', invoiceDueDate: '2026-03-12', description: 'Amazon Kindle Unltd', originalDescription: 'Amazon Kindle Unltd', amount: 990, installment: null, totalInstallments: null }
    const second = { ...first, id: 'amazon-2' }
    const statement = { ...base, dueDate: '2026-03-12', transactions: [first, second] }
    const result = reconcileCardStatement(statement, [ledger('one-kindle-row', '2026-03-12', 'Assinatura Kindle unlimited', 990)])
    expect(result.matches.map((match) => match.status)).toEqual(['CARD_REVIEW', 'CARD_REVIEW'])
    expect(result.matches.every((match) => match.sheet == null)).toBe(true)
  })

  it('concilia duas compras indistinguíveis contra exatamente duas linhas pelo grupo, sem inventar vínculos individuais', () => {
    const base = parseCardStatementPages(syntheticPages)
    const makePurchase = (id: string) => ({ ...base.transactions[0], id, date: '2026-02-09', purchaseDate: '2026-02-09', invoiceDueDate: '2026-03-12', statementDueDate: '2026-03-12', description: 'Amazon Digital BR', originalDescription: 'Amazon Digital BR', amount: 990, installment: null, totalInstallments: null })
    const statement = { ...base, dueDate: '2026-03-12', transactions: [makePurchase('amazon-digital-1'), makePurchase('amazon-digital-2')] }
    const rows = [ledger('book-a', '2026-03-12', 'Livro Imparaveis Amazon', 990), ledger('book-b', '2026-03-12', 'Livro Manual do imparavel Amazon', 990)]
    const result = reconcileCardStatement(statement, rows)
    expect(result.matches.map((match) => match.status)).toEqual(['CARD_GROUP_MATCHED', 'CARD_GROUP_MATCHED'])
    expect(result.matches.every((match) => match.sheet === null && match.candidates.length === 2)).toBe(true)
    expect(result.eligibleSheetTotal).toBe(1980)
    expect(result.difference).toBe(0)
  })

  it('não usa matching por multiplicidade quando as quantidades diferem ou há candidatos extras', () => {
    const base = parseCardStatementPages(syntheticPages)
    const makePurchase = (id: string) => ({ ...base.transactions[0], id, date: '2026-02-09', purchaseDate: '2026-02-09', invoiceDueDate: '2026-03-12', statementDueDate: '2026-03-12', description: 'Amazon Digital BR', originalDescription: 'Amazon Digital BR', amount: 990, installment: null, totalInstallments: null })
    const purchases = [makePurchase('amazon-digital-1'), makePurchase('amazon-digital-2')]
    const statement = { ...base, dueDate: '2026-03-12', transactions: purchases }
    const twoRows = [ledger('book-a', '2026-03-12', 'Livro Imparaveis Amazon', 990), ledger('book-b', '2026-03-12', 'Livro Manual do imparavel Amazon', 990)]
    expect(reconcileCardStatement({ ...statement, transactions: [purchases[0]] }, twoRows).matches[0].status).toBe('CARD_REVIEW')
    const threeRows = [...twoRows, ledger('book-c', '2026-03-12', 'Outro livro Amazon', 990)]
    expect(reconcileCardStatement(statement, threeRows).matches.map((match) => match.status)).toEqual(['CARD_REVIEW', 'CARD_REVIEW'])
  })

  it('não inclui no grupo uma linha consumida por uma correspondência forte confirmada', () => {
    const base = parseCardStatementPages(syntheticPages)
    const makePurchase = (id: string, description = 'Amazon Digital BR') => ({ ...base.transactions[0], id, date: '2026-02-09', purchaseDate: '2026-02-09', invoiceDueDate: '2026-03-12', statementDueDate: '2026-03-12', description, originalDescription: description, amount: 990, installment: null, totalInstallments: null })
    const purchases = [makePurchase('amazon-1'), makePurchase('amazon-2'), makePurchase('book-specific', 'Livro Imparaveis Amazon Digital BR')]
    const statement = { ...base, dueDate: '2026-03-12', transactions: purchases }
    const rows = [ledger('book-a', '2026-03-12', 'Livro Imparaveis Amazon', 990), ledger('book-b', '2026-03-12', 'Livro Manual do imparavel Amazon', 990)]
    const result = reconcileCardStatement(statement, rows, new Map([['book-specific', 'book-a']]))
    expect(result.matches.find((match) => match.transaction.id === 'book-specific')?.status).toBe('CARD_MATCHED')
    expect(result.matches.filter((match) => match.transaction.id !== 'book-specific').map((match) => match.status)).toEqual(['CARD_REVIEW', 'CARD_REVIEW'])
    expect(result.matches.some((match) => match.status === 'CARD_GROUP_MATCHED')).toBe(false)
  })

  it('aceita datas históricas próximas à compra quando a planilha não usa vencimento', () => {
    const statement = parseCardStatementPages(syntheticPages)
    const purchase = { ...statement.transactions[0], installment: null, totalInstallments: null }
    const historicalStatement = { ...statement, transactions: [purchase, ...statement.transactions.slice(1)] }
    const result = reconcileCardStatement(historicalStatement, [ledger('legacy-date-row', '2025-06-05', 'Mercado Exemplo', 1000)])
    expect(result.matches[0]).toMatchObject({ status: 'CARD_MATCHED', sheet: { date: '2025-06-05' } })
    expect(result.matches[0].evidence).toContain('Data próxima à compra (registro histórico)')
  })

  it('identifica crédito com hífen depois do valor, separa contagens e valida a equação da fatura', () => {
    const statement = parseCardStatementPages(refundStatementPages)
    const purchases = statement.transactions.filter((item) => item.type === 'PURCHASE')
    const refunds = statement.transactions.filter((item) => item.type === 'REFUND')
    expect(statement.transactions).toHaveLength(5)
    expect(purchases).toHaveLength(4)
    expect(refunds).toHaveLength(1)
    expect(purchases[0]).toMatchObject({ amount: 1234, direction: 'DEBIT', type: 'PURCHASE' })
    expect(refunds[0]).toMatchObject({ amount: 1234, direction: 'CREDIT', type: 'REFUND' })
    expect(refunds[0]).not.toHaveProperty('signedAmount')
    expect(purchases.reduce((sum, item) => sum + item.amount, 0)).toBe(4784)
    expect(refunds.reduce((sum, item) => sum + item.amount, 0)).toBe(1234)
    expect(statement.previousPayment).toBe(6918)
    expect(statement.previousBalance).toBe(6000)
    expect(statement.purchasesDebitsTotal).toBe(4784)
    expect(statement.creditsPaymentsTotal).toBe(8152)
    expect(statement.reportedTotal).toBe(2632)
    expect(statement.accountingDifference).toBe(0)
    expect(statement.previousBalance! - statement.creditsPaymentsTotal! + statement.purchasesDebitsTotal!).toBe(statement.reportedTotal)
    expect(statement.cardSubtotals).toEqual([{ cardIdentifier: '4321 XXXX XXXX 1111', amount: 3550 }])
    expect(statement.errors).toEqual([])
  })

  it('mantém os créditos fora da conciliação e da lista de compras do cartão ausentes', () => {
    const statement = parseCardStatementPages(refundStatementPages)
    const result = reconcileCardStatement(statement, [])
    expect(result.matches).toHaveLength(4)
    expect(result.matches.filter((match) => match.status === 'CARD_MISSING')).toHaveLength(3)
    expect(result.matches.find((match) => match.transaction.type === 'PURCHASE')).toMatchObject({ status: 'CARD_REFUNDED', transaction: { financialStatus: 'REFUNDED', amount: 1234 } })
    expect(result.matches.some((match) => match.transaction.type === 'REFUND')).toBe(false)
    expect(result.statementTotal).toBe(3550)
    expect(result.matches.find((match) => match.status === 'CARD_REFUNDED')?.transaction).toBe(statement.transactions[0])
  })

  it('vincula o pagamento de R$ 312,75 ao total da fatura na data do vencimento', () => {
    const statement: CardStatement = { ...parseCardStatementPages(syntheticPages), dueDate: '2026-06-12', reportedTotal: 31275, cardSubtotals: [
      { cardIdentifier: '4321 XXXX XXXX 5875', amount: 12990 },
      { cardIdentifier: '4321 XXXX XXXX 5514', amount: 18285 },
    ] }
    const bank: BankTransaction = { id: 'payment-31275', source: 'BANK', sheetRecordId: null, bankTransactionId: 'payment-31275', date: '2026-06-12', description: 'GASTOS CARTAO DE CREDITO', originalDescription: 'GASTOS CARTAO DE CREDITO', amount: 31275, direction: 'DEBIT', directionKnown: true, type: 'CARD_PAYMENT', paymentMethod: '', category: '', month: '', year: '2026', isFixed: null, isEssential: null, installment: null, totalInstallments: null, balanceAfter: null, original: {} }
    expect(identifyStatementPayment(statement, [bank])).toBe(bank)
    expect(statement.cardSubtotals.reduce((sum, card) => sum + card.amount, 0)).toBe(statement.reportedTotal)
    expect(statement.cardSubtotals).toHaveLength(2)
  })

  it('mantém pagamento agregado ligado ao total/vencimento sem converter compras em pagamento ou despesa individual', () => {
    const statement = parseCardStatementPages(syntheticPages)
    const payment = cardBank('invoice-payment', '2025-07-12', 10000)
    const identified = identifyStatementPayment(statement, [payment])
    expect(identified).toBe(payment)
    expect(statement.transactions.every((transaction) => transaction.type === 'PURCHASE' && transaction.amount < statement.reportedTotal!)).toBe(true)
    expect(reconcileCardStatement(statement, []).matches).toHaveLength(statement.transactions.length)
    const bankResult = reconcile([payment], [], { identifiedCardPaymentIds: new Set([payment.id]) })
    expect(bankResult.items[0]).toMatchObject({ status: 'CARD_PAYMENT_IDENTIFIED', bank: { type: 'CARD_PAYMENT', amount: 10000 } })
    expect(bankResult.items[0].composition).toEqual([])
  })

  it('associa pagamentos distintos a faturas distintas e nunca reutiliza o mesmo pagamento', () => {
    const base = parseCardStatementPages(syntheticPages)
    const june = { ...base, statementIdentity: 'june', dueDate: '2026-06-12', reportedTotal: 31275 }
    const july = { ...base, statementIdentity: 'july', dueDate: '2026-07-12', reportedTotal: 43120 }
    const junePayment = cardBank('june-payment', '2026-06-12', 31275)
    const julyPayment = cardBank('july-payment', '2026-07-12', 43120)
    const links = identifyStatementPayments([june, july], [junePayment, julyPayment])
    expect(links.get(june)).toBe(junePayment)
    expect(links.get(july)).toBe(julyPayment)
    expect(new Set([...links.values()].map((item) => item.id)).size).toBe(2)

    const onePayment = identifyStatementPayments([june, { ...june, statementIdentity: 'june-copy' }], [junePayment])
    expect(onePayment.size).toBe(1)
  })

  it('mantém faturas de ciclos diferentes do mesmo cartão e seus estornos em conjuntos independentes', () => {
    const refunded = parseCardStatementPages(refundStatementPages)
    const nextCyclePages = structuredClone(syntheticPages)
    nextCyclePages[0][2] = 'Cliente Exemplo R$ 100,00 12/07/2025'
    const nextCycle = parseCardStatementPages(nextCyclePages)
    expect(refunded.statementIdentity).not.toBe(nextCycle.statementIdentity)
    expect(refunded.transactions[0].financialStatus).toBe('REFUNDED')
    expect(nextCycle.transactions.every((item) => item.financialStatus !== 'REFUNDED')).toBe(true)
    expect(reconcileCardStatement(refunded, []).matches.filter((item) => item.status === 'CARD_REFUNDED')).toHaveLength(1)
    expect(reconcileCardStatement(nextCycle, []).matches.filter((item) => item.status === 'CARD_REFUNDED')).toHaveLength(0)
  })

  it('não usa compras antigas Crédito_Bradesco para explicar um pagamento já vinculado ao total do PDF', () => {
    const statement: CardStatement = { ...parseCardStatementPages(syntheticPages), dueDate: '2026-06-12', reportedTotal: 31275 }
    const bank: BankTransaction = { id: 'explicit-payment', source: 'BANK', sheetRecordId: null, bankTransactionId: 'explicit-payment', date: '2026-06-12', description: 'GASTOS CARTAO DE CREDITO', originalDescription: 'GASTOS CARTAO DE CREDITO', amount: 31275, direction: 'DEBIT', directionKnown: true, type: 'CARD_PAYMENT', paymentMethod: '', category: '', month: '', year: '2026', isFixed: null, isEssential: null, installment: null, totalInstallments: null, balanceAfter: null, original: {} }
    const oldPurchases = [ledger('old-1', '2025-06-11', 'Compra antiga 1', 200000), ledger('old-2', '2025-06-11', 'Compra antiga 2', 55516)]
    const identified = identifyStatementPayment(statement, [bank])!
    const result = reconcile([bank], oldPurchases, { identifiedCardPaymentIds: new Set([identified.id]) })
    expect(result.items[0]).toMatchObject({ status: 'CARD_PAYMENT_IDENTIFIED', composition: [], compositionOptions: [], cardSummary: null })
    expect(result.items[0].composition).toHaveLength(0)
  })

  it('continua conciliando compras individuais separadamente do pagamento agregado', () => {
    const statement = parseCardStatementPages(syntheticPages)
    const sheet = [
      { ...ledger('first', '2025-06-02', '(2/2) Mercado Exemplo', 1000), installment: 2, totalInstallments: 2 },
      { ...ledger('second', '2025-06-06', '(2/4) Farmacia Modelo', 2000), installment: 2, totalInstallments: 4 },
    ]
    const result = reconcileCardStatement(statement, sheet)
    expect(result.matches.slice(0, 2).map((match) => match.status)).toEqual(['CARD_MATCHED', 'CARD_MATCHED'])
    expect(result.eligibleSheetTotal).toBe(3000)
  })

  it('encontra a parcela 6/6 mesmo quando o PDF preserva a data original meses antes', () => {
    const statement = installmentStatement()
    const result = reconcileCardStatement(statement, [installmentLedger('installment-6', '2026-05-12', 6)])
    expect(statement.transactions[0].date).toBe('2025-10-30')
    expect(result.matches[0]).toMatchObject({ status: 'CARD_MATCHED', sheet: { id: 'installment-6', date: '2026-05-12' } })
  })

  it('compara descrições abreviadas com a descrição-base após remover o prefixo da parcela', () => {
    const result = reconcileCardStatement(installmentStatement(), [installmentLedger('short-description', '2026-05-12', 6)])
    expect(result.matches[0].status).toBe('CARD_MATCHED')
    expect(result.matches[0].evidence).toContain('Descrição compatível')
  })

  it('usa uma sequência coerente de parcelas como evidência adicional', () => {
    const sheet = [
      installmentLedger('3', '2026-02-01', 3),
      installmentLedger('4', '2026-03-12', 4),
      installmentLedger('5', '2026-04-12', 5),
      installmentLedger('6', '2026-05-12', 6),
    ]
    const result = reconcileCardStatement(installmentStatement(), sheet)
    expect(result.matches[0]).toMatchObject({ status: 'CARD_MATCHED', sheet: { id: '6' } })
    expect(result.matches[0].evidence).toContain('Sequência de parcelas encontrada')
  })

  it('não associa a mesma quantia quando o número da parcela é diferente', () => {
    const result = reconcileCardStatement(installmentStatement(), [installmentLedger('wrong-installment', '2026-05-12', 5)])
    expect(result.matches[0].status).toBe('CARD_MISSING')
    expect(result.matches[0].candidates).toEqual([])
  })

  it('mantém o matching baseado em data para uma compra sem indicação de parcela', () => {
    const statement = installmentStatement('2026-05-12', 'ASAAS OFICINA CR')
    statement.transactions[0].installment = null
    statement.transactions[0].totalInstallments = null
    expect(reconcileCardStatement(statement, [ledger('same-day', '2026-05-12', 'ASAAS OFICINA CR', 9450)]).matches[0].status).toBe('CARD_MATCHED')
    expect(reconcileCardStatement(statement, [ledger('old-date', '2026-02-12', 'ASAAS OFICINA CR', 9450)]).matches[0].status).toBe('CARD_MISSING')
  })

  it('aceita candidato único por valor, vencimento e Crédito_Bradesco mesmo com descrição humana diferente (PETZ)', () => {
    const statement = parseCardStatementPages(syntheticPages)
    statement.dueDate = '2026-05-12'
    statement.transactions = [{ ...statement.transactions[0], id: 'petz-pdf', date: '2026-04-27', purchaseDate: '2026-04-27', invoiceDueDate: '2026-05-12', statementDueDate: '2026-05-12', originalDescription: 'PETZ DIGITAL', description: 'PETZ DIGITAL', amount: 28950, installment: null, totalInstallments: null }]
    const petz = ledger('petz-sheet', '2026-05-12', 'Ração 10kg Buba + Maya', 28950)
    const result = reconcileCardStatement(statement, [petz])
    expect(findExistingCostYearCandidates(statement, statement.transactions[0], [petz])).toEqual([petz])
    expect(result.matches[0]).toMatchObject({ status: 'CARD_MATCHED', sheet: petz })
    expect(result.matches[0].evidence).toContain('Candidato único por valor, vencimento e Crédito_Bradesco')
  })

  it('concilia o Kindle pelo vencimento da fatura apesar da descrição e data real diferentes', () => {
    const statement = parseCardStatementPages(syntheticPages)
    statement.dueDate = '2026-03-12'
    statement.transactions = [{ ...statement.transactions[0], id: 'kindle-pdf', date: '2026-02-02', purchaseDate: '2026-02-02', invoiceDueDate: '2026-03-12', statementDueDate: '2026-03-12', originalDescription: 'Amazon Kindle Unltd', description: 'Amazon Kindle Unltd', amount: 299, installment: null, totalInstallments: null }]
    const kindle = ledger('kindle-sheet', '2026-03-12', 'Assinatura Kindle unlimited (2 meses)', 299)
    expect(reconcileCardStatement(statement, [kindle]).matches[0]).toMatchObject({ status: 'CARD_MATCHED', sheet: kindle })
  })

  it('classifica uma linha Kindle da planilha como EXPENSE e a concilia sem falso MISSING', () => {
    const parsed = parseLedgerRows([{ Data: '12/03/2026', Descrição: 'Assinatura Kindle unlimited (2 meses)', Custo: '2,99', 'Forma de pagamento': 'Crédito_Bradesco', ID: '131b043e' }], { date: 'Data', description: 'Descrição', amount: 'Custo', paymentMethod: 'Forma de pagamento', id: 'ID' })
    const statement = parseCardStatementPages(syntheticPages)
    statement.dueDate = '2026-03-12'
    statement.transactions = [{ ...statement.transactions[0], id: 'kindle-pdf', date: '2026-02-02', purchaseDate: '2026-02-02', invoiceDueDate: '2026-03-12', statementDueDate: '2026-03-12', originalDescription: 'Amazon Kindle Unltd', description: 'Amazon Kindle Unltd', amount: 299, installment: null, totalInstallments: null }]
    expect(parsed.transactions[0]).toMatchObject({ type: 'EXPENSE', paymentMethod: 'Crédito_Bradesco', amount: 299, date: '2026-03-12' })
    expect(findExistingCostYearCandidates(statement, statement.transactions[0], parsed.transactions)).toEqual([parsed.transactions[0]])
    expect(reconcileCardStatement(statement, parsed.transactions).matches[0]).toMatchObject({ status: 'CARD_MATCHED', sheet: parsed.transactions[0] })
  })

  it('mantém EDZIA PIRES COBDE como candidata à parcela 1/4 apesar da descrição humana diferente', () => {
    const statement = parseCardStatementPages(syntheticPages)
    statement.dueDate = '2026-06-12'
    statement.transactions = [{ ...statement.transactions[0], id: 'edzia-pdf', date: '2026-05-27', purchaseDate: '2026-05-27', invoiceDueDate: '2026-06-12', statementDueDate: '2026-06-12', originalDescription: 'EDZIA PIRES COBDE', description: 'EDZIA PIRES COBDE', amount: 25599, installment: 1, totalInstallments: 4 }]
    const row = { ...ledger('edzia-sheet', '2026-06-12', '(1/4) Consulta Buba Airton', 25599), installment: 1, totalInstallments: 4 }
    const result = reconcileCardStatement(statement, [row])
    expect(findExistingCostYearCandidates(statement, statement.transactions[0], [row])).toEqual([row])
    expect(result.matches[0]).toMatchObject({ status: 'CARD_MATCHED', sheet: row })
  })

  it('usa sequência mensal completa 1/4 a 4/4 como evidência para uma descrição genérica', () => {
    const statement = installmentStatement('2025-10-30', 'EDZIA PIRES COBDE', 1, 4)
    statement.dueDate = '2026-02-12'
    statement.transactions[0].invoiceDueDate = '2026-02-12'
    statement.transactions[0].statementDueDate = '2026-02-12'
    statement.transactions[0].amount = 25599
    const sequence = [1, 2, 3, 4].map((installment, index) => ({ ...ledger(`edzia-${installment}`, ['2025-11-12', '2025-12-12', '2026-01-12', '2026-02-12'][index], `(${installment}/4) Consulta Buba Airton`, 25599), installment, totalInstallments: 4 }))
    const result = reconcileCardStatement(statement, sequence)
    expect(result.matches[0]).toMatchObject({ status: 'CARD_MATCHED', sheet: { id: 'edzia-1' } })
    expect(result.matches[0].evidence).toContain('Sequência de parcelas encontrada')
  })

  it('mantém EDZIA PIRES COBDE como candidata à parcela 1/4 apesar da descrição humana diferente', () => {
    const statement = parseCardStatementPages(syntheticPages)
    statement.dueDate = '2026-06-12'
    statement.transactions = [{ ...statement.transactions[0], id: 'edzia-pdf', date: '2026-05-27', purchaseDate: '2026-05-27', invoiceDueDate: '2026-06-12', statementDueDate: '2026-06-12', originalDescription: 'EDZIA PIRES COBDE', description: 'EDZIA PIRES COBDE', amount: 25599, installment: 1, totalInstallments: 4 }]
    const row = { ...ledger('edzia-sheet', '2026-06-12', '(1/4) Consulta Buba Airton', 25599), installment: 1, totalInstallments: 4 }
    const result = reconcileCardStatement(statement, [row])
    expect(findExistingCostYearCandidates(statement, statement.transactions[0], [row])).toEqual([row])
    expect(result.matches[0]).toMatchObject({ status: 'CARD_MATCHED', sheet: row })
  })

  it('usa sequência mensal completa 1/4 a 4/4 como evidência para uma descrição genérica', () => {
    const statement = installmentStatement('2025-10-30', 'EDZIA PIRES COBDE', 1, 4)
    statement.dueDate = '2026-02-12'
    statement.transactions[0].invoiceDueDate = '2026-02-12'
    statement.transactions[0].statementDueDate = '2026-02-12'
    statement.transactions[0].amount = 25599
    const sequence = [1, 2, 3, 4].map((installment, index) => ({ ...ledger(`edzia-${installment}`, ['2025-11-12', '2025-12-12', '2026-01-12', '2026-02-12'][index], `(${installment}/4) Consulta Buba Airton`, 25599), installment, totalInstallments: 4 }))
    const result = reconcileCardStatement(statement, sequence)
    expect(result.matches[0]).toMatchObject({ status: 'CARD_MATCHED', sheet: { id: 'edzia-1' } })
    expect(result.matches[0].evidence).toContain('Sequência de parcelas encontrada')
  })

  it('mantém múltiplas linhas no conjunto plausível e exige revisão quando o valor e vencimento são ambíguos', () => {
    const statement = parseCardStatementPages(syntheticPages)
    statement.dueDate = '2026-05-12'
    statement.transactions = [{ ...statement.transactions[0], date: '2026-04-27', purchaseDate: '2026-04-27', invoiceDueDate: '2026-05-12', amount: 28950, installment: null, totalInstallments: null }]
    const candidates = [ledger('petz-a', '2026-05-12', 'Ração Buba', 28950), ledger('petz-b', '2026-05-12', 'Compra de animais', 28950)]
    const result = reconcileCardStatement(statement, candidates)
    expect(result.matches[0]).toMatchObject({ status: 'CARD_REVIEW', candidates })
  })

  it('não reutiliza uma linha de vencimento em duas compras da mesma fatura', () => {
    const statement = parseCardStatementPages(syntheticPages)
    statement.dueDate = '2026-05-12'
    statement.transactions = ['PETZ DIGITAL', 'LOJA QUALQUER'].map((description, index) => ({ ...statement.transactions[0], id: `same-row-${index}`, date: '2026-04-27', purchaseDate: '2026-04-27', invoiceDueDate: '2026-05-12', amount: 28950, originalDescription: description, description, installment: null, totalInstallments: null }))
    const row = ledger('single-due-line', '2026-05-12', 'Gasto registrado', 28950)
    const result = reconcileCardStatement(statement, [row])
    expect(result.matches.every((match) => match.status === 'CARD_REVIEW')).toBe(true)
    expect(result.matches.flatMap((match) => match.candidates).every((candidate) => candidate.id === row.id)).toBe(true)
    expect(result.matches.some((match) => match.status === 'CARD_MATCHED')).toBe(false)
  })

  it('converte em REVIEW um candidato já consumido por outra fatura, sem produzir falso MISSING', () => {
    const statement = parseCardStatementPages(syntheticPages)
    statement.dueDate = '2026-05-12'
    statement.transactions = [{ ...statement.transactions[0], id: 'cross-invoice', date: '2026-04-27', purchaseDate: '2026-04-27', invoiceDueDate: '2026-05-12', amount: 28950, installment: null, totalInstallments: null }]
    const row = ledger('shared-due-line', '2026-05-12', 'Registro humano', 28950)
    const initiallyMatched = reconcileCardStatement(statement, [row]).matches[0]
    const afterGlobalAssignment = deriveCardPurchaseStatus(initiallyMatched, { consumedSheetIds: new Set([row.id]) })
    expect(afterGlobalAssignment).toMatchObject({ status: 'CARD_REVIEW', sheet: null, candidates: [row] })
    expect(afterGlobalAssignment.status).not.toBe('CARD_MISSING')
  })

  it('reserva globalmente a linha da confirmação manual e recalcula a outra fatura', () => {
    const ownerStatement = parseCardStatementPages(syntheticPages)
    ownerStatement.statementIdentity = 'invoice-owner'
    ownerStatement.dueDate = '2026-06-12'
    ownerStatement.transactions = [{ ...ownerStatement.transactions[0], id: 'ifood-owner', type: 'PURCHASE', direction: 'DEBIT', financialStatus: 'ACTIVE', date: '2026-06-08', purchaseDate: '2026-06-08', invoiceDueDate: '2026-06-12', statementDueDate: '2026-06-12', amount: 795, installment: null, totalInstallments: null, originalDescription: 'Mensalidade ifood', description: 'Mensalidade ifood' }]
    const otherStatement = { ...ownerStatement, statementIdentity: 'invoice-other', transactions: [{ ...ownerStatement.transactions[0], id: 'ifood-other' }] }
    const confirmedRow = ledger('ifood-confirmed-june', '2026-06-12', 'Mensalidade ifood', 795)
    const alternateRow = ledger('ifood-alternate-june', '2026-06-12', 'Mensalidade ifood', 795)
    const owner = `${ownerStatement.statementIdentity}\u001f${ownerStatement.transactions[0].id}`
    const reservation = new Map([[confirmedRow.id, owner]])
    expect(findExistingCostYearCandidates(ownerStatement, ownerStatement.transactions[0], [confirmedRow])).toEqual([confirmedRow])
    const ownerResult = reconcileCardStatement(ownerStatement, [confirmedRow, alternateRow], new Map([[ownerStatement.transactions[0].id, confirmedRow.id]]), new Map(), reservation)
    const loserWithoutAlternative = reconcileCardStatement(otherStatement, [confirmedRow], new Map(), new Map(), reservation)
    const loserWithAlternative = reconcileCardStatement(otherStatement, [confirmedRow, alternateRow], new Map(), new Map(), reservation)

    expect(ownerResult.matches[0]).toMatchObject({ status: 'CARD_MATCHED', sheet: confirmedRow })
    expect(loserWithoutAlternative.matches[0]).toMatchObject({ status: 'CARD_MISSING', candidates: [] })
    expect(loserWithAlternative.matches[0]).toMatchObject({ status: 'CARD_MATCHED', sheet: alternateRow })
    expect(loserWithAlternative.matches[0].sheet?.id).not.toBe(confirmedRow.id)
  })

  it('mantém a mensalidade do ciclo anterior em REVIEW, nunca como match forte', () => {
    const statement = parseCardStatementPages(syntheticPages)
    statement.dueDate = '2026-06-12'
    statement.transactions = [{ ...statement.transactions[0], id: 'ifood-june', date: '2026-05-14', purchaseDate: '2026-05-14', invoiceDueDate: '2026-06-12', statementDueDate: '2026-06-12', amount: 795, originalDescription: 'IFD*iFood', description: 'IFD*iFood', installment: null, totalInstallments: null }]
    const previousCycle = ledger('ifood-may-cycle', '2026-05-12', 'Mensalidade ifood', 795)
    const result = reconcileCardStatement(statement, [previousCycle])
    expect(result.matches[0]).toMatchObject({ status: 'CARD_REVIEW', candidates: [previousCycle] })
  })

  it('não oferece mensalidades antigas como equivalentes à compra Selfit do ciclo atual', () => {
    const statement = parseCardStatementPages(syntheticPages)
    statement.dueDate = '2026-07-12'
    statement.transactions = [{ ...statement.transactions[0], id: 'selfit-july', date: '2026-06-08', purchaseDate: '2026-06-08', invoiceDueDate: '2026-07-12', statementDueDate: '2026-07-12', amount: 12990, originalDescription: 'SELFITHOMEROCASTELOBRA', description: 'SELFITHOMEROCASTELOBRA', installment: null, totalInstallments: null }]
    const oldMonths = [
      ledger('selfit-may', '2026-05-12', 'Mensalidade Selfit', 12990),
      ledger('selfit-april', '2026-04-12', 'Mensalidade Selfit', 12990),
      ledger('selfit-march', '2026-03-12', 'Mensalidade Selfit', 12990),
      ledger('selfit-february', '2026-02-01', 'Mensalidade Selfit', 12990),
      ledger('selfit-january', '2026-01-01', 'Mensalidade Selfit', 12990),
    ]
    const result = reconcileCardStatement(statement, oldMonths)
    expect(result.matches[0]).toMatchObject({ status: 'CARD_MISSING', candidates: [] })
  })

  it('rejeita os candidatos desta compra, mas permite uma nova linha correta posteriormente', () => {
    const statement = parseCardStatementPages(syntheticPages)
    statement.dueDate = '2026-06-12'
    statement.transactions = [{ ...statement.transactions[0], id: 'ifood-review', date: '2026-05-14', purchaseDate: '2026-05-14', invoiceDueDate: '2026-06-12', statementDueDate: '2026-06-12', amount: 795, originalDescription: 'IFD*iFood', description: 'IFD*iFood', installment: null, totalInstallments: null }]
    const rejected = ledger('ifood-wrong-cycle', '2026-05-12', 'Mensalidade ifood', 795)
    const rejectedOnly = reconcileCardStatement(statement, [rejected], new Map(), new Map([[statement.transactions[0].id, new Set([rejected.id])]]))
    expect(rejectedOnly.matches[0]).toMatchObject({ status: 'CARD_MISSING', candidates: [] })
    const correct = ledger('ifood-correct-cycle', '2026-06-12', 'IFD iFood', 795)
    const withNewCandidate = reconcileCardStatement(statement, [rejected, correct], new Map(), new Map([[statement.transactions[0].id, new Set([rejected.id])]]))
    expect(withNewCandidate.matches[0]).toMatchObject({ status: 'CARD_MATCHED', sheet: correct })
    expect(reconcileCardStatement(statement, [rejected, correct]).matches[0]).toMatchObject({ status: 'CARD_MATCHED', sheet: correct })
  })

  it('permite resolver candidatos da compra e concilia o pagamento agregado 1:N sem criar outra despesa', () => {
    const statement = parseCardStatementPages(syntheticPages)
    const sheet = statement.transactions.map((transaction) => ({
      ...ledger(`sheet-${transaction.id}`, transaction.date,
        transaction.installment == null ? transaction.description : `(${transaction.installment}/${transaction.totalInstallments}) ${transaction.description}`,
        transaction.amount),
      installment: transaction.installment,
      totalInstallments: transaction.totalInstallments,
    }))
    const ambiguousRows = [sheet[1], { ...sheet[1], id: 'second-farmacia', sheetRecordId: 'second-farmacia', date: '2025-06-07', originalDescription: 'Farmacia semelhante' }]
    const ambiguous = reconcileCardStatement(statement, ambiguousRows)
    expect(ambiguous.matches[1].status).toBe('CARD_REVIEW')
    const confirmed = reconcileCardStatement(statement, ambiguousRows, new Map([[statement.transactions[1].id, ambiguousRows[0].id]]))
    expect(confirmed.matches[1]).toMatchObject({ status: 'CARD_MATCHED', sheet: { id: `sheet-${statement.transactions[1].id}` } })

    const bank: BankTransaction = { id: 'bank-card-payment', source: 'BANK', sheetRecordId: null, bankTransactionId: 'payment-1', date: '2025-07-12', description: 'GASTOS CARTAO DE CREDITO', originalDescription: 'GASTOS CARTAO DE CREDITO', amount: 10000, direction: 'DEBIT', directionKnown: true, type: 'CARD_PAYMENT', paymentMethod: '', category: '', month: '', year: '2025', isFixed: null, isEssential: null, installment: null, totalInstallments: null, balanceAfter: null, original: {} }
    const paymentOptions = reconcile([bank], sheet).items[0]
    expect(paymentOptions.compositionStatus).toBe('REVIEW')
    expect(paymentOptions.compositionOptions[0].items).toHaveLength(5)
    expect(paymentOptions.compositionOptions[0].items.reduce((sum, item) => sum + item.amount, 0)).toBe(10000)
    const payment = reconcile([bank], sheet, { confirmedCompositions: new Map([[bank.id, paymentOptions.compositionOptions[0].items.map((item) => item.sheetRecordId) as string[]]]) }).items[0]
    expect(payment.status).toBe('MATCHED')
    expect(payment.composition).toHaveLength(5)
    expect(statement.transactions).toHaveLength(5)
    expect(payment.composition.reduce((sum, item) => sum + item.amount, 0)).toBe(10000)
  })
})
