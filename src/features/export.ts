import type { BankTransaction, LedgerTransaction, ReconciliationItem, ReconciliationResult } from '../domain/types'

function csvCell(value: unknown) {
  const text = String(value ?? '')
  return `"${text.replace(/"/g, '""')}"`
}
const money = (cents: number) => `R$ ${(cents / 100).toFixed(2).replace('.', ',')}`

export function exportCsv(filename: string, headers: string[], rows: unknown[][]) {
  const text = `\uFEFF${[headers, ...rows].map((row) => row.map(csvCell).join(';')).join('\r\n')}`
  const url = URL.createObjectURL(new Blob([text], { type: 'text/csv;charset=utf-8' }))
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  anchor.click()
  URL.revokeObjectURL(url)
}

export function exportMissing(items: ReconciliationItem[]) {
  const missing = items.filter((item) => item.status === 'MISSING')
  exportCsv('possiveis-ausencias.csv', ['Data', 'Descrição original', 'Valor', 'Direção', 'Forma de pagamento', 'ID bancário'], missing.map(({ bank }) => [bank.date, bank.originalDescription, money(bank.amount), bank.direction, bank.paymentMethod, bank.bankTransactionId]))
}

export function exportReviews(items: ReconciliationItem[]) {
  const review = items.filter((item) => item.status === 'REVIEW')
  exportCsv('itens-para-revisao.csv', ['Estado', 'Data banco', 'Descrição banco', 'Valor', 'Data planilha', 'Descrição planilha', 'Pontuação', 'Motivos'], review.map(({ bank, sheet, candidate }) => ['REVIEW', bank.date, bank.originalDescription, money(bank.amount), sheet?.date ?? '', sheet?.originalDescription ?? '', candidate?.score ?? '', candidate?.reasons.join(' / ') ?? '']))
}

export function exportCardPayments(items: ReconciliationItem[]) {
  const cards = items.filter(({ bank }) => bank.type === 'CARD_PAYMENT')
  const rows = cards.flatMap(({ bank, composition, compositionStatus, cardSummary }) => {
    const summary = [cardSummary?.eligiblePurchaseCount ?? 0, money(cardSummary?.eligiblePurchaseTotal ?? 0), money(cardSummary?.difference ?? 0)]
    return composition.length
      ? composition.map((sheet) => [bank.date, bank.originalDescription, money(bank.amount), compositionStatus ?? 'REVIEW', sheet.date, sheet.originalDescription, money(sheet.amount), sheet.paymentMethod, ...summary])
      : [[bank.date, bank.originalDescription, money(bank.amount), compositionStatus ?? 'NO_MATCH', '', '', '', '', ...summary]]
  })
  exportCsv('composicoes-faturas-cartao.csv', ['Data pagamento', 'Descrição banco', 'Total fatura', 'Estado', 'Data compra', 'Descrição compra', 'Valor compra', 'Forma de pagamento', 'Compras elegíveis encontradas', 'Total compras elegíveis', 'Diferença pagamento menos compras'], rows)
}

export function exportOutOfScope(items: ReconciliationItem[]) {
  const outside = items.filter((item) => item.status === 'OUT_OF_SCOPE')
  exportCsv('movimentacoes-fora-do-escopo.csv', ['Data', 'Descrição', 'Direção', 'Tipo', 'Valor', 'Correspondência planilha'], outside.map(({ bank, sheet }) => [bank.date, bank.originalDescription, bank.direction === 'DEBIT' ? 'Saída' : 'Entrada', bank.type, money(bank.amount), sheet?.originalDescription ?? '']))
}

export function exportDuplicates(result: ReconciliationResult, banks: BankTransaction[], sheets: LedgerTransaction[]) {
  const rows = result.duplicateGroups.flatMap((group) => group.transactionIds.map((id) => {
    const transaction = group.source === 'BANK' ? banks.find((item) => item.id === id) : sheets.find((item) => item.id === id)
    return [group.source, transaction?.date ?? group.date, transaction?.originalDescription ?? group.description, money(transaction?.amount ?? group.amount), id]
  }))
  exportCsv('possiveis-duplicidades.csv', ['Origem', 'Data', 'Descrição original', 'Valor', 'Identificador interno'], rows)
}

export function exportSummary(result: ReconciliationResult, items: ReconciliationItem[]) {
  const count = (state: string) => items.filter((item) => item.status === state).length
  exportCsv('resumo-conciliacao.csv', ['Métrica', 'Valor'], [
    ['Conciliadas', count('MATCHED')], ['Para revisão', count('REVIEW')], ['Possíveis ausências', count('MISSING')], ['Divergências de cartão', count('CARD_DIVERGENCE')], ['Fora do escopo', count('OUT_OF_SCOPE')],
    ['Pagamentos de cartão', items.filter((item) => item.bank.type === 'CARD_PAYMENT').length],
    ['Possíveis duplicidades', result.duplicateGroups.length], ['Ignoradas', count('IGNORED')],
    ['Não encontrados no extrato', result.unmatchedSheet.length], ['Total de débitos', money(result.totals.bankDebit)],
    ['Total de créditos', money(result.totals.bankCredit)], ['Total planilha', money(result.totals.sheetTotal)],
    ['Saldo inicial', result.totals.initialBalance == null ? '' : money(result.totals.initialBalance)], ['Saldo final', result.totals.finalBalance == null ? '' : money(result.totals.finalBalance)],
    ['Saldo calculado', result.totals.calculatedFinalBalance == null ? '' : money(result.totals.calculatedFinalBalance)], ['Diferença de saldo', result.totals.balanceDifference == null ? '' : money(result.totals.balanceDifference)],
  ])
}
