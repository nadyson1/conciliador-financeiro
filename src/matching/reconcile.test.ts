import { describe, expect, it } from 'vitest'
import type { BankTransaction, LedgerTransaction } from '../domain/types'
import { canonicalCompositionKey, reconcile } from './reconcile'
import { summarizeMissingExpenses } from '../domain/bankBalanceAudit'

function sheet(id: string, description: string, date = '2026-01-08', amount = 1350): LedgerTransaction {
  return { id, source: 'SHEET', sheetRecordId: `record-${id}`, bankTransactionId: null, date, description, originalDescription: description, amount, direction: 'DEBIT', type: 'EXPENSE', paymentMethod: 'Pix', category: 'Alimentação', month: '01 - Janeiro', year: date.slice(0, 4), isFixed: false, isEssential: true, installment: null, totalInstallments: null, balanceAfter: null, original: {} }
}
function bank(id: string, description: string, date = '2026-01-08', amount = 1350, direction: 'DEBIT' | 'CREDIT' = 'DEBIT', type: BankTransaction['type'] = 'EXPENSE'): BankTransaction {
  return { id, source: 'BANK', sheetRecordId: null, bankTransactionId: `bank-ref-${id}`, date, description, originalDescription: description, amount, direction, type, paymentMethod: 'Pix', category: '', month: '', year: date.slice(0, 4), isFixed: null, isEssential: null, installment: null, totalInstallments: null, balanceAfter: null, original: {} }
}

describe('motor de conciliação', () => {
  it('concilia valor, data e descrição sem confundir os IDs independentes', () => {
    const result = reconcile([bank('b1', 'Café Central')], [sheet('s1', 'Cafe Central')])
    expect(result.items[0].status).toBe('MATCHED')
    expect(result.items[0].sheet?.sheetRecordId).toBe('record-s1')
    expect(result.items[0].bank.bankTransactionId).toBe('bank-ref-b1')
  })

  it('usa datas próximas como sinal e datas distantes não bastam para confirmar', () => {
    expect(reconcile([bank('b1', 'Café Central', '2026-01-09')], [sheet('s1', 'Cafe Central')]).items[0].status).toBe('REVIEW')
    const distant = reconcile([bank('b1', 'Café Central', '2026-01-20')], [sheet('s1', 'Cafe Central')]).items[0]
    expect(distant.status).toBe('MISSING')
    expect(distant.candidate).toBeNull()
  })

  it('não concilia somente pelo mesmo valor e sinaliza par ambíguo para revisão', () => {
    expect(reconcile([bank('b1', 'Loja X', '2026-01-09')], [sheet('s1', 'Escola Y')]).items[0].status).toBe('REVIEW')
    const ambiguous = reconcile([bank('b1', 'Mercado')], [sheet('s1', 'Mercado A'), sheet('s2', 'Mercado A')])
    expect(ambiguous.items[0].status).toBe('REVIEW')
    expect(ambiguous.items[0].candidate).not.toBeNull()
  })

  it('mantém a relação 1:1 quando há duas movimentações candidatas', () => {
    const result = reconcile([bank('b1', 'Café'), bank('b2', 'Café')], [sheet('s1', 'Café')])
    expect(result.items.filter((item) => item.status === 'MATCHED')).toHaveLength(0)
    expect(result.items.every((item) => item.status === 'REVIEW')).toBe(true)
    expect(result.items.filter((item) => item.sheet).map((item) => item.sheet?.sheetRecordId)).toEqual(['record-s1'])
  })

  it('atribui globalmente duas movimentações repetidas a duas linhas sem reutilizar a mesma linha', () => {
    const banks = [bank('B1', 'PIX ENVIADO', '2026-01-05', 1500), bank('B2', 'PIX ENVIADO', '2026-01-05', 1500)]
    const sheets = [sheet('S1', 'Caipirinha Vila Tabajara', '2026-01-03', 1500), sheet('S2', 'Doação para pedinte filhos', '2026-01-05', 1500)]
    const result = reconcile(banks, sheets)
    const reverse = reconcile([...banks].reverse(), [...sheets].reverse())
    const assignment = (items: typeof result.items) => Object.fromEntries(items.map((item) => [item.bank.id, item.sheet?.id ?? null]))
    expect(assignment(result.items)).toEqual({ B1: 'S2', B2: 'S1' })
    expect(assignment(reverse.items)).toEqual(assignment(result.items))
    expect(new Set(result.items.map((item) => item.sheet?.sheetRecordId).filter(Boolean)).size).toBe(2)
    expect(result.items.map((item) => item.status)).toEqual(['MATCHED', 'REVIEW'])
    expect(result.items[0].candidate?.matchMethod).toBe('STRUCTURAL')
    expect(result.items[1].candidate?.dateDistance).toBe(2)
  })

  it('escolhe a solução global claramente superior e deixa em revisão o par a dois dias', () => {
    const banks = [bank('B1', 'Doacao para pedinte filhos', '2026-01-05', 1500), bank('B2', 'Eventospg', '2026-01-05', 1500)]
    const sheets = [sheet('S1', 'Caipirinha Vila Tabajara', '2026-01-03', 1500), sheet('S2', 'Doação para pedinte filhos', '2026-01-05', 1500)]
    const result = reconcile(banks, sheets)
    expect(result.items.map((item) => [item.bank.id, item.sheet?.id, item.status])).toEqual([
      ['B1', 'S2', 'MATCHED'],
      ['B2', 'S1', 'REVIEW'],
    ])
    expect(result.items[1].candidate?.dateDistance).toBe(2)
  })

  it('mantém REVIEW quando as soluções globais têm pontuações iguais', () => {
    const banks = [bank('B1', 'Café Central', '2026-01-08', 2500), bank('B2', 'Café Central', '2026-01-08', 2500)]
    const sheets = [sheet('S1', 'Cafe Central', '2026-01-08', 2500), sheet('S2', 'Cafe Central', '2026-01-08', 2500)]
    const result = reconcile(banks, sheets)
    expect(result.items.map((item) => item.status)).toEqual(['REVIEW', 'REVIEW'])
    expect(new Set(result.items.map((item) => item.sheet?.sheetRecordId)).size).toBe(2)
    expect(result.items.every((item) => item.candidate?.reasons.some((reason) => reason.includes('soluções globais próximas')))).toBe(true)
  })

  it('reserva um lançamento para o banco mais forte quando outro banco também o disputa', () => {
    const result = reconcile(
      [bank('strong', 'Mercado Central', '2026-01-08', 1800), bank('weak', 'PIX ENVIADO', '2026-01-08', 1800)],
      [sheet('market', 'Mercado Central', '2026-01-08', 1800)],
    )
    expect(result.items.map((item) => [item.bank.id, item.sheet?.id, item.status])).toEqual([
      ['strong', 'market', 'MATCHED'],
      ['weak', undefined, 'MISSING'],
    ])
  })

  it('ignora duplicidades heurísticas do banco e preserva duplicidades da planilha', () => {
    const duplicateA = sheet('s1', 'Uber', '2026-01-08', 2000)
    const duplicateB = sheet('s2', 'Uber', '2026-01-08', 2000)
    const result = reconcile([bank('b1', 'PIX RECEBIDO', '2026-01-08', 2000, 'CREDIT', 'INCOME'), bank('b2', 'PIX RECEBIDO', '2026-01-08', 2000, 'CREDIT', 'INCOME')], [duplicateA, duplicateB])
    expect(result.duplicateGroups).toHaveLength(1)
    expect(result.duplicateGroups[0]).toMatchObject({ source: 'SHEET', transactionIds: ['s1', 's2'] })
    expect(result.items.map((item) => item.status)).toEqual(['OUT_OF_SCOPE', 'OUT_OF_SCOPE'])
  })

  it('classifica transferências e pagamentos de cartão fora das ausências', () => {
    const result = reconcile([bank('b1', 'Transferencia para CC Nubank', '2026-01-08', 1350, 'DEBIT', 'TRANSFER'), bank('b2', 'GASTOS CARTAO DE CREDITO', '2026-01-08', 9990, 'DEBIT', 'CARD_PAYMENT')], [])
    expect(result.items.map((item) => item.status)).toEqual(['OUT_OF_SCOPE', 'CARD_DIVERGENCE'])
  })

  it.each(['PIX ENVIADO', 'PIX QR CODE DINAMICO', 'PIX QR CODE ESTATICO'])('reconhece Transferência como alias histórico de Pix para %s', (description) => {
    const historical = sheet('legacy', 'Transferencia para conta de destino')
    historical.paymentMethod = 'Transferência'
    historical.type = 'TRANSFER'
    const result = reconcile([bank('pix', description)], [historical])
    expect(result.items[0]).toMatchObject({ status: 'MATCHED', sheet: { id: 'legacy' } })
    expect(result.items[0].reasonCode).toBe('LEGACY_PAYMENT_ALIAS')
    expect(result.items[0].candidate?.reasons).toContain('Alias histórico de forma de pagamento: Pix ↔ Transferência')
  })

  it('prefere Pix exato ao alias legado e mantém revisão quando dois aliases são ambíguos', () => {
    const exact = sheet('pix', 'Conta de destino')
    exact.paymentMethod = 'Pix'
    const historical = sheet('legacy', 'Transferencia para conta de destino')
    historical.paymentMethod = 'Transferência'; historical.type = 'TRANSFER'
    const preferred = reconcile([bank('pix-bank', 'PIX ENVIADO')], [exact, historical])
    expect(preferred.items[0]).toMatchObject({ status: 'MATCHED', sheet: { id: 'pix' } })

    const ambiguous = reconcile([bank('ambiguous', 'PIX ENVIADO')], [
      { ...historical, id: 'legacy-a', sheetRecordId: 'legacy-a' },
      { ...historical, id: 'legacy-b', sheetRecordId: 'legacy-b' },
    ])
    expect(ambiguous.items[0].status).toBe('REVIEW')
  })

  it('mantém entradas bancárias fora da lista de despesas ausentes', () => {
    const incoming = bank('b-in', 'PIX RECEBIDO', '2026-01-08', 1200, 'CREDIT', 'INCOME')
    const result = reconcile([incoming], [sheet('s1', 'Mercado')])
    expect(result.items[0].status).toBe('OUT_OF_SCOPE')
    expect(result.items[0].bank.direction).toBe('CREDIT')
  })

  it('neutraliza uma saída PIX integralmente devolvida antes de classificá-la como ausente', () => {
    const original = bank('pix-out', 'PIX QR CODE ESTATICO', '2026-09-18', 67770)
    const refund = bank('pix-refund', 'DEVOLUCAO PIX', '2026-10-07', 67770, 'CREDIT', 'REFUND')
    const result = reconcile([original, refund], [])
    expect(result.items.map((item) => item.status)).toEqual(['REFUNDED', 'REFUNDED'])
    expect(result.bankRefundGroups).toMatchObject([{ status: 'REFUNDED', originalTransactionIds: ['pix-out'], refundTransactionId: 'pix-refund', grossAmount: 67770, refundAmount: 67770, netAmount: 0 }])
    expect(summarizeMissingExpenses(result.items).count).toBe(0)
    expect(result.items.some((item) => item.status === 'MISSING')).toBe(false)
  })

  it('envia devolução ambígua para revisão sem escolher uma saída arbitrariamente', () => {
    const first = bank('pix-a', 'PIX QR CODE ESTATICO', '2026-09-18', 67770)
    const second = bank('pix-b', 'PIX ENVIADO para loja', '2026-09-20', 67770)
    const refund = bank('pix-refund', 'DEVOLUCAO PIX', '2026-10-07', 67770, 'CREDIT', 'REFUND')
    const result = reconcile([first, second, refund], [])
    expect(result.items.map((item) => item.status)).toEqual(['REVIEW', 'REVIEW', 'OUT_OF_SCOPE'])
    expect(result.bankRefundGroups).toMatchObject([{ status: 'REVIEW', originalTransactionIds: ['pix-a', 'pix-b'], refundTransactionId: 'pix-refund', grossAmount: null, netAmount: null }])
    expect(summarizeMissingExpenses(result.items).count).toBe(0)
  })

  it('prioriza a devolução exata para não deixar crédito parcial competir com ela', () => {
    const original = bank('pix-out', 'PIX QR CODE ESTATICO', '2026-09-18', 67770)
    const fullRefund = bank('pix-full-refund', 'DEVOLUCAO PIX', '2026-10-07', 67770, 'CREDIT', 'REFUND')
    const unrelatedSmallerRefund = bank('pix-other-refund', 'DEVOLUCAO PIX', '2026-10-06', 1200, 'CREDIT', 'REFUND')
    const result = reconcile([original, fullRefund, unrelatedSmallerRefund], [])
    expect(result.items.map((item) => item.status)).toEqual(['REFUNDED', 'REFUNDED', 'OUT_OF_SCOPE'])
    expect(result.bankRefundGroups).toMatchObject([{ status: 'REFUNDED', originalTransactionIds: ['pix-out'], refundTransactionId: 'pix-full-refund', netAmount: 0 }])
  })

  it('não coloca saídas em REVIEW por uma devolução parcial genérica com várias possíveis origens', () => {
    const first = bank('pix-a', 'PIX QR CODE ESTATICO', '2026-09-18', 67770)
    const second = bank('pix-b', 'PIX ENVIADO', '2026-09-20', 80000)
    const refund = bank('pix-refund', 'DEVOLUCAO PIX', '2026-10-07', 1200, 'CREDIT', 'REFUND')
    const result = reconcile([first, second, refund], [])
    expect(result.bankRefundGroups).toEqual([])
    expect(result.items.filter((item) => item.status === 'REVIEW')).toEqual([])
    expect(result.items.slice(0, 2).map((item) => item.status)).toEqual(['MISSING', 'MISSING'])
  })

  it('mantém a saída como despesa após devolução parcial e calcula o líquido', () => {
    const original = bank('pix-out', 'PIX ENVIADO para loja', '2026-09-18', 100000)
    const refund = bank('pix-refund', 'DEVOLUCAO PIX', '2026-10-07', 40000, 'CREDIT', 'REFUND')
    const result = reconcile([original, refund], [])
    expect(result.items.map((item) => item.status)).toEqual(['MISSING', 'OUT_OF_SCOPE'])
    expect(result.bankRefundGroups).toMatchObject([{ status: 'PARTIAL', grossAmount: 100000, refundAmount: 40000, netAmount: 60000 }])
    expect(summarizeMissingExpenses(result.items)).toMatchObject({ count: 1, total: 100000 })
  })

  it('não cria relação de devolução para PIX sem crédito explícito posterior', () => {
    const normalPix = bank('pix-out', 'PIX QR CODE ESTATICO', '2026-09-18', 67770)
    const result = reconcile([normalPix], [])
    expect(result.items[0].status).toBe('MISSING')
    expect(result.bankRefundGroups).toEqual([])
  })

  it('separa possível ausência e lançamento da planilha não encontrado', () => {
    const result = reconcile([bank('b1', 'Mercado XYZ')], [sheet('s1', 'Conta de luz', '2026-01-15', 5000)])
    expect(result.items[0].status).toBe('MISSING')
    expect(result.unmatchedSheet.map((item) => item.id)).toEqual(['s1'])
  })

  it('classifica como ausência saídas sem candidato plausível, inclusive tipos OTHER', () => {
    const pix = bank('pix', 'PIX ENVIADO', '2026-02-20', 1200)
    const insurance = bank('insurance', 'SEGURO CARTAO DEB BRADESCO', '2026-02-20', 499, 'DEBIT', 'OTHER')
    const result = reconcile([pix, insurance], [])
    expect(result.items.map((item) => item.status)).toEqual(['MISSING', 'MISSING'])
    expect(result.items.every((item) => item.status !== 'REVIEW')).toBe(true)
  })

  it('mantém REVIEW apenas com candidato plausível e separa ambiguidade de ausência', () => {
    const unique = reconcile([bank('pix', 'PIX ENVIADO', '2026-02-20', 6000)], [sheet('uber', 'Uber', '2026-02-20', 6000)])
    const ambiguous = reconcile([bank('pix', 'PIX ENVIADO', '2026-02-20', 6000)], [sheet('uber', 'Uber', '2026-02-20', 6000), sheet('wash', 'Lavagem', '2026-02-20', 6000)])
    const superficial = reconcile([bank('pix', 'PIX ENVIADO', '2026-02-20', 1200)], [sheet('same-text', 'PIX ENVIADO', '2026-02-20', 1500)])
    expect(unique.items[0].status).toBe('MATCHED')
    expect(ambiguous.items[0].status).toBe('REVIEW')
    expect(superficial.items[0]).toMatchObject({ status: 'MISSING', candidate: null, sheet: null })
    expect(superficial.items[0].reasonCode).toBe('MISSING_NO_CANDIDATE')
  })

  it('retira de REVIEW candidatos fora da janela, de natureza incompatível ou já confirmados', () => {
    const far = bank('far', 'Mercado Central', '2026-02-20', 1200)
    const confirmedBank = bank('confirmed', 'PIX ENVIADO', '2026-02-20', 1500)
    const extraBank = bank('extra', 'PIX ENVIADO', '2026-02-20', 1500)
    const farSheet = sheet('far-sheet', 'Mercado Central', '2026-02-15', 1200)
    const wrongNature = sheet('wrong-nature', 'Transferência', '2026-02-20', 1300); wrongNature.type = 'TRANSFER'
    const confirmedSheet = sheet('confirmed-sheet', 'Uber', '2026-02-20', 1500)
    const result = reconcile([far, confirmedBank, extraBank, bank('nature', 'Conta luz', '2026-02-20', 1300)], [farSheet, wrongNature, confirmedSheet], { confirmedPairs: new Map([['confirmed', 'confirmed-sheet']]) })
    expect(result.items.map((item) => item.status)).toEqual(['MISSING', 'MATCHED', 'MISSING', 'MISSING'])
  })

  it('aceita revisão manual e mantém o vínculo 1:1', () => {
    const result = reconcile([bank('b1', 'Loja X')], [sheet('s1', 'Escola Y')], { confirmedPairs: new Map([['b1', 's1']]) })
    expect(result.items[0].status).toBe('MATCHED')
    expect(result.unmatchedSheet).toHaveLength(0)
  })

  it('concilia a fatura 1:N somente com Crédito_Bradesco e soma exata', () => {
    const card = bank('bill', 'GASTOS CARTAO DE CREDITO', '2026-02-02', 100000, 'DEBIT', 'CARD_PAYMENT')
    const purchases = [sheet('a', 'Compra A', '2026-01-10', 15000), sheet('b', 'Compra B', '2026-01-12', 25000), sheet('c', 'Compra C', '2026-01-20', 30000), sheet('d', 'Compra D', '2026-01-25', 30000)]
    purchases.forEach((item) => { item.paymentMethod = 'Crédito_Bradesco' })
    const result = reconcile([card], purchases)
    expect(result.items[0]).toMatchObject({ status: 'CARD_DIVERGENCE', compositionStatus: 'REVIEW' })
    expect(result.items[0].composition).toHaveLength(0)
    expect(result.items[0].compositionOptions[0].items.reduce((sum, item) => sum + item.amount, 0)).toBe(100000)
  })

  it('não usa outra forma de pagamento, diferença de valor ou compra posterior para compor fatura', () => {
    const card = bank('bill', 'GASTOS CARTAO DE CREDITO', '2026-02-02', 10000, 'DEBIT', 'CARD_PAYMENT')
    const wrongMethod = sheet('cash', 'Compra', '2026-01-20', 10000); wrongMethod.paymentMethod = 'Débito'
    const later = sheet('later', 'Compra', '2026-02-03', 10000); later.paymentMethod = 'Crédito_Bradesco'
    const split = sheet('split', 'Compra', '2026-01-30', 9999); split.paymentMethod = 'Crédito_Bradesco'
    const result = reconcile([card], [wrongMethod, later, split])
    expect(result.items[0]).toMatchObject({ status: 'CARD_DIVERGENCE', compositionStatus: 'NO_MATCH' })
  })

  it('registra divergência positiva sem afirmar que seja uma compra esquecida', () => {
    const card = bank('bill', 'GASTOS CARTAO DE CREDITO', '2026-02-02', 100000, 'DEBIT', 'CARD_PAYMENT')
    const purchase = sheet('purchase', 'Compras registradas', '2026-01-20', 85000); purchase.paymentMethod = 'Crédito_Bradesco'
    const result = reconcile([card], [purchase])
    expect(result.items[0]).toMatchObject({ status: 'CARD_DIVERGENCE', compositionStatus: 'NO_MATCH', cardSummary: { eligiblePurchaseCount: 1, eligiblePurchaseTotal: 85000, difference: 15000 } })
    expect(result.items[0].status).not.toBe('MISSING')
    expect(result.items[0].status).not.toBe('REVIEW')
  })

  it('registra excedente elegível sem tratá-lo automaticamente como erro', () => {
    const card = bank('bill', 'GASTOS CARTAO DE CREDITO', '2026-02-02', 100000, 'DEBIT', 'CARD_PAYMENT')
    const purchase = sheet('purchase', 'Compra possivelmente de outro ciclo', '2026-01-20', 120000); purchase.paymentMethod = 'Crédito_Bradesco'
    const result = reconcile([card], [purchase])
    expect(result.items[0]).toMatchObject({ status: 'CARD_DIVERGENCE', compositionStatus: 'NO_MATCH', cardSummary: { eligiblePurchaseTotal: 120000, difference: -20000 } })
  })

  it('marca REVIEW quando mais de uma composição exata é possível e permite confirmação explícita', () => {
    const card = bank('bill', 'GASTOS CARTAO DE CREDITO', '2026-02-02', 10000, 'DEBIT', 'CARD_PAYMENT')
    const purchases = [sheet('a', 'Compra A', '2026-01-10', 5000), sheet('b', 'Compra B', '2026-01-12', 5000), sheet('c', 'Compra C', '2026-01-20', 10000)]
    purchases.forEach((item) => { item.paymentMethod = 'Crédito_Bradesco' })
    const result = reconcile([card], purchases)
    expect(result.items[0]).toMatchObject({ status: 'CARD_DIVERGENCE', compositionStatus: 'REVIEW' })
    expect(result.items[0].compositionOptions.length).toBe(2)
    expect(new Set(result.items[0].compositionOptions.map((option) => canonicalCompositionKey(option.items))).size).toBe(2)
    const chosen = result.items[0].compositionOptions[0].items.map((item) => item.sheetRecordId)
    const confirmed = reconcile([card], purchases, { confirmedCompositions: new Map([['bill', chosen]]) })
    expect(confirmed.items[0]).toMatchObject({ status: 'MATCHED', compositionStatus: 'MATCHED' })
  })

  it('deixa faturas compartilharem candidatos antes da confirmação e bloqueia após confirmar', () => {
    const bills = [bank('bill-1', 'GASTOS CARTAO DE CREDITO', '2026-02-01', 10000, 'DEBIT', 'CARD_PAYMENT'), bank('bill-2', 'GASTOS CARTAO DE CREDITO', '2026-02-10', 10000, 'DEBIT', 'CARD_PAYMENT')]
    const purchase = sheet('a', 'Compra', '2026-01-20', 10000); purchase.paymentMethod = 'Crédito_Bradesco'
    const result = reconcile(bills, [purchase])
    expect(result.items.every((item) => item.compositionOptions.length === 1)).toBe(true)
    expect(result.items.every((item) => item.compositionOptions[0].items[0].sheetRecordId === purchase.sheetRecordId)).toBe(true)
    const confirmed = reconcile(bills, [purchase], { confirmedCompositions: new Map([['bill-1', [purchase.sheetRecordId]], ['bill-2', [purchase.sheetRecordId]]]) })
    expect(confirmed.items[0]).toMatchObject({ status: 'MATCHED', compositionStatus: 'MATCHED' })
    expect(confirmed.items[1].compositionOptions).toHaveLength(0)
    expect(confirmed.items[1].compositionStatus).toBe('NO_MATCH')
  })

  it('deduplica uma composição pelo conjunto canônico de sheetRecordIds', () => {
    const a = sheet('a', 'Compra A', '2026-01-10', 5000); a.sheetRecordId = 'record-a'; a.paymentMethod = 'Crédito_Bradesco'
    const b = sheet('b', 'Compra B', '2026-01-11', 5000); b.sheetRecordId = 'record-b'; b.paymentMethod = 'Crédito_Bradesco'
    const sameA = sheet('a-copy', 'Compra A repetida no arquivo', '2026-01-10', 5000); sameA.sheetRecordId = 'record-a'; sameA.paymentMethod = 'Crédito_Bradesco'
    const card = bank('bill', 'GASTOS CARTAO DE CREDITO', '2026-02-02', 10000, 'DEBIT', 'CARD_PAYMENT')
    const result = reconcile([card], [a, b, sameA])
    expect(canonicalCompositionKey([a, b])).toBe(canonicalCompositionKey([b, a]))
    expect(result.items[0].compositionOptions).toHaveLength(1)
    expect(result.items[0].compositionOptions[0].items.map((item) => item.sheetRecordId).sort()).toEqual(['record-a', 'record-b'])
  })

  it('considera compras antigas dentro do horizonte configurável e as ranqueia temporalmente', () => {
    const card = bank('bill', 'GASTOS CARTAO DE CREDITO', '2026-06-01', 10000, 'DEBIT', 'CARD_PAYMENT')
    const recent = sheet('recent', 'Compra recente', '2026-05-20', 10000); recent.paymentMethod = 'Crédito_Bradesco'
    const older = sheet('older', 'Compra antiga', '2026-01-01', 10000); older.paymentMethod = 'Crédito_Bradesco'
    const result = reconcile([card], [older, recent])
    expect(result.items[0].compositionOptions).toHaveLength(2)
    expect(result.items[0].compositionOptions[0].items[0].id).toBe('recent')
    expect(result.items[0].compositionOptions[1].items[0].id).toBe('older')
    expect(result.items[0].compositionOptions[0].score).toBeGreaterThan(result.items[0].compositionOptions[1].score)
  })

  it('sinaliza busca acima do limite sem afirmar ausência ou solução segura', () => {
    const card = bank('bill', 'GASTOS CARTAO DE CREDITO', '2026-02-02', 10000, 'DEBIT', 'CARD_PAYMENT')
    const purchases = Array.from({ length: 25 }, (_, index) => {
      const item = sheet(`candidate-${index}`, `Compra ${index}`, '2026-01-10', 400)
      item.paymentMethod = 'Crédito_Bradesco'
      return item
    })
    const result = reconcile([card], purchases)
    expect(result.items[0]).toMatchObject({ status: 'CARD_DIVERGENCE', compositionStatus: 'LIMITED' })
    expect(result.items[0].compositionOptions).toHaveLength(0)
  })

  it('mantém REVIEW se a direção da saída não estiver confirmada no arquivo', () => {
    const unknown = bank('unknown', 'LANÇAMENTO SEM CONTEXTO', '2026-01-08', 1350, 'DEBIT', 'OTHER')
    unknown.directionKnown = false
    expect(reconcile([unknown], []).items[0].status).toBe('REVIEW')
  })

  it('permite associar aplicação do banco ao item Investimento sem contar como despesa conciliada', () => {
    const application = bank('apply', 'APLICACAO CDB', '2026-01-08', 450000, 'DEBIT', 'INVESTMENT')
    const investment = sheet('investment', 'Reserva mensal', '2026-01-08', 450000); investment.type = 'INVESTMENT'; investment.paymentMethod = 'Investimento'
    const result = reconcile([application], [investment])
    expect(result.items[0]).toMatchObject({ status: 'OUT_OF_SCOPE', sheet: investment })
    expect(result.items[0].candidate).not.toBeNull()
    expect(result.unmatchedSheet).toHaveLength(0)
  })

  it('faz match estrutural com valor, mesma data e par único apesar de descrições distintas', () => {
    const result = reconcile([bank('phone', 'CONTA DE TELEFONE', '2026-02-20', 2489)], [sheet('claro', 'Mensalidade Claro móvel', '2026-02-20', 2489)])
    expect(result.items[0]).toMatchObject({ status: 'MATCHED', candidate: { confidence: 90, matchMethod: 'STRUCTURAL' } })
    expect(result.items[0].candidate?.reasons).toEqual(expect.arrayContaining(['Valor exato', 'Mesma data', 'Direção compatível', 'Única candidata plausível', 'Descrição bancária genérica; não penalizada']))
  })

  it('mantém revisão quando mesmo valor e data têm duas candidatas plausíveis', () => {
    const result = reconcile([bank('pix', 'PIX ENVIADO', '2026-02-20', 6000)], [sheet('uber', 'Uber', '2026-02-20', 6000), sheet('wash', 'Lavagem', '2026-02-20', 6000)])
    expect(result.items[0].status).toBe('REVIEW')
    expect(result.items[0].candidate?.confidence).toBe(90)
    expect(result.items[0].candidate?.reasons).toContain('Mais de uma candidata plausível; revisão necessária')
  })

  it.each([1, 2, 3])('mantém REVIEW para valor exato com diferença de %i dia(s)', (dayDistance) => {
    const bankDate = '2026-02-20'
    const sheetDate = `2026-02-${String(20 - dayDistance).padStart(2, '0')}`
    const result = reconcile([bank('b', 'PIX QR CODE DINAMICO', bankDate, 3290)], [sheet('s', 'Compra sem identificação', sheetDate, 3290)])
    expect(result.items[0].status).toBe('REVIEW')
    if (dayDistance === 3) expect(result.items[0].candidate?.confidence).toBe(71)
  })

  it('ignora tokens genéricos e não os usa para reduzir nem inflar a evidência textual', () => {
    const bradescoPurchase = sheet('purchase', 'Compra supermercado', '2026-02-20', 5000)
    bradescoPurchase.paymentMethod = 'Crédito_Bradesco'
    const result = reconcile([bank('visa', 'COMPRA CARTAO VISA', '2026-02-20', 5000)], [bradescoPurchase])
    expect(result.items[0].status).toBe('MATCHED')
    expect(result.items[0].candidate?.confidence).toBe(90)
    expect(result.items[0].candidate?.descriptionSimilarity).toBe(0)
    expect(result.items[0].candidate?.reasons).toContain('Descrição bancária genérica; não penalizada')
  })

  it.each([
    ['COMPRA CARTAO VISA', 'Pousada Canoa Quebrada (2/2)', 21700, 'Crédito_Bradesco', 75],
    ['PIX ENVIADO', 'Passeio Buggy Canoa Quebrada', 10000, 'Pix', 80],
    ['PIX QR CODE ESTATICO', 'Água passeio', 500, 'Pix', 80],
  ] as const)('concilia estruturalmente %s na mesma data sem inflar score ou confiança', (bankDescription, sheetDescription, amount, paymentMethod, score) => {
    const ledgerEntry = sheet('generic-sheet', sheetDescription, '2026-01-06', amount)
    ledgerEntry.paymentMethod = paymentMethod
    const result = reconcile([bank('generic-bank', bankDescription, '2026-01-06', amount)], [ledgerEntry])
    expect(result.items[0]).toMatchObject({ status: 'MATCHED', candidate: { score, confidence: 90, matchMethod: 'STRUCTURAL' } })
  })

  it('trata PIX ENVIADO como match estrutural quando único e como revisão quando ambíguo', () => {
    const unique = reconcile([bank('pix-one', 'PIX ENVIADO', '2026-02-20', 6000)], [sheet('uber', 'Uber', '2026-02-20', 6000)])
    const ambiguous = reconcile([bank('pix-many', 'PIX ENVIADO', '2026-02-20', 6000)], [sheet('uber', 'Uber', '2026-02-20', 6000), sheet('wash', 'Lavagem', '2026-02-20', 6000)])
    expect(unique.items[0].status).toBe('MATCHED')
    expect(ambiguous.items[0].status).toBe('REVIEW')
  })

  it('não marca automaticamente valor diferente nem direção incompatível', () => {
    const amountDifference = reconcile([bank('b', 'Telefone', '2026-02-20', 2489)], [sheet('s', 'Mensalidade Claro', '2026-02-20', 2490)])
    const directionDifference = reconcile([bank('credit', 'CONTA DE TELEFONE', '2026-02-20', 2489, 'CREDIT', 'INCOME')], [sheet('s', 'Mensalidade Claro', '2026-02-20', 2489)])
    const unknownDirection = bank('unknown', 'Mercado Central', '2026-02-20', 5000)
    unknownDirection.directionKnown = false
    const unknown = reconcile([unknownDirection], [sheet('market', 'Mercado Central', '2026-02-20', 5000)])
    expect(amountDifference.items[0].status).not.toBe('MATCHED')
    expect(directionDifference.items[0].status).not.toBe('MATCHED')
    expect(unknown.items[0].status).toBe('REVIEW')
  })
})
