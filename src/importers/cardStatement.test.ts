import { describe, expect, it } from 'vitest'
import type { BankTransaction, CardStatement, LedgerTransaction } from '../domain/types'
import { deriveCardPurchaseStatus, findExistingCostYearCandidates, identifyStatementPayment, identifyStatementPayments, parseBrazilianMoney, parseCardStatementPages, reconcileCardStatement } from './cardStatement'
import { findDuplicateGroups, reconcile } from '../matching/reconcile'

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
    expect(reconcileCardStatement(statement, [ledger('old-date', '2026-02-12', 'ASAAS OFICINA CR', 9450)]).matches[0].status).toBe('CARD_REVIEW')
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
