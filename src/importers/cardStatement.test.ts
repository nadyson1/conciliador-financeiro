import { describe, expect, it } from 'vitest'
import type { BankTransaction, CardStatement, LedgerTransaction } from '../domain/types'
import { identifyStatementPayment, identifyStatementPayments, parseBrazilianMoney, parseCardStatementPages, reconcileCardStatement } from './cardStatement'
import { reconcile } from '../matching/reconcile'

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

function ledger(id: string, date: string, description: string, amount: number, paymentMethod = 'Crédito_Bradesco'): LedgerTransaction {
  return { id, source: 'SHEET', sheetRecordId: id, bankTransactionId: null, date, description, originalDescription: description, amount, direction: 'DEBIT', type: 'EXPENSE', paymentMethod, category: '', month: '', year: date.slice(0, 4), isFixed: null, isEssential: null, installment: null, totalInstallments: null, balanceAfter: null, original: {} }
}
function installmentStatement(date = '2025-10-30', description = 'ASAAS*OFICINA CR', installment = 6, total = 6): CardStatement {
  const statement = parseCardStatementPages(syntheticPages)
  const transaction = { ...statement.transactions[0], date, description, originalDescription: description, amount: 9450, installment, totalInstallments: total }
  return { ...statement, transactions: [transaction] }
}
function installmentLedger(id: string, date: string, installment: number, description = 'Oficina Criativa Renovação'): LedgerTransaction {
  return { ...ledger(id, date, `(${installment}/6) ${description}`, 9450), installment, totalInstallments: 6 }
}
function cardBank(id: string, date: string, amount: number): BankTransaction {
  return { id, source: 'BANK', sheetRecordId: null, bankTransactionId: id, date, description: 'GASTOS CARTAO DE CREDITO', originalDescription: 'GASTOS CARTAO DE CREDITO', amount, direction: 'DEBIT', directionKnown: true, type: 'CARD_PAYMENT', paymentMethod: '', category: '', month: '', year: date.slice(0, 4), isFixed: null, isEssential: null, installment: null, totalInstallments: null, balanceAfter: null, original: {} }
}

describe('PDF de fatura do cartão', () => {
  it('extrai tabela, dois cartões, parcelas, pagamentos excluídos e valida os totais sintéticos', () => {
    const statement = parseCardStatementPages(syntheticPages, 'fatura-sintetica.pdf')
    const reimported = parseCardStatementPages(structuredClone(syntheticPages), 'outro-nome.pdf')
    expect(statement.pageCount).toBe(2)
    expect(statement.transactions).toHaveLength(5)
    expect(statement.transactions.map((item) => item.cardIdentifier)).toEqual([
      '4321 XXXX XXXX 1111', '4321 XXXX XXXX 1111', '4321 XXXX XXXX 1111', '4321 XXXX XXXX 2222', '4321 XXXX XXXX 2222',
    ])
    expect(statement.transactions[0]).toMatchObject({ date: '2025-06-02', amount: 1000, city: 'CIDADE A', installment: 2, totalInstallments: 2 })
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
