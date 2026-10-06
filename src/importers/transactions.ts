import type { BankTransaction, ColumnMap, LedgerTransaction, ParsedTransactions, RowIssue, TransactionType } from '../domain/types'
import { investmentAction, normalizeAmount, normalizeDate, parseBoolean, transactionType } from './normalize'
import { stableFingerprint } from '../domain/identity'

const cell = (row: Record<string, string>, key?: string) => key ? String(row[key] ?? '').trim() : ''
const installmentFrom = (description: string) => {
  const match = description.match(/\b(\d{1,2})\s*\/\s*(\d{1,2})\b/)
  return match ? { installment: Number(match[1]), totalInstallments: Number(match[2]) } : { installment: null, totalInstallments: null }
}
const sheetType = (description: string, payment: string): TransactionType => {
  const type = transactionType(description, payment)
  // CUSTOS ANO é uma tabela de despesas; só promovemos para fora dessa natureza
  // quando há um sinal explícito, como a forma de pagamento Investimento.
  return type === 'OTHER' ? 'EXPENSE' : type
}

export function parseLedgerRows(rows: Record<string, string>[], map: ColumnMap): ParsedTransactions<LedgerTransaction> {
  const transactions: LedgerTransaction[] = []
  const issues: RowIssue[] = []
  const rawIdCounts = new Map<string, number>()
  if (map.id) rows.forEach((row) => { const id = cell(row, map.id); if (id) rawIdCounts.set(id, (rawIdCounts.get(id) ?? 0) + 1) })
  const fallbackCounts = new Map<string, number>()
  rows.forEach((row, index) => {
    const date = normalizeDate(cell(row, map.date))
    const originalDescription = cell(row, map.description)
    const parsedAmount = normalizeAmount(cell(row, map.amount))
    const rowNumber = index + 2
    if (!date || !originalDescription || parsedAmount == null) {
      issues.push({ row: rowNumber, message: `Data, descrição ou custo inválido (data: ${cell(row, map.date) || 'vazia'}; valor: ${cell(row, map.amount) || 'vazio'}).` })
      return
    }
    const paymentMethod = cell(row, map.paymentMethod)
    const amount = Math.abs(parsedAmount)
    const rawId = cell(row, map.id)
    const installment = installmentFrom(originalDescription)
    const original = { ...row }
    const fingerprint = stableFingerprint([date, originalDescription, amount, installment.installment, installment.totalInstallments])
    const duplicateIndex = (fallbackCounts.get(fingerprint) ?? 0) + 1
    fallbackCounts.set(fingerprint, duplicateIndex)
    const sheetRecordId = rawId && rawIdCounts.get(rawId) === 1 ? rawId : `auto:${fingerprint}:${duplicateIndex}`
    transactions.push({
      id: `sheet-${stableFingerprint([sheetRecordId])}`, source: 'SHEET', sheetRecordId, bankTransactionId: null,
      date, description: originalDescription, originalDescription, amount, direction: 'DEBIT',
      type: sheetType(originalDescription, paymentMethod), investmentAction: investmentAction(originalDescription), paymentMethod,
      category: cell(row, map.category), month: cell(row, map.month), year: cell(row, map.year),
      isFixed: parseBoolean(cell(row, map.isFixed)), isEssential: parseBoolean(cell(row, map.isEssential)),
      ...installment, balanceAfter: null, original,
    })
  })
  return { transactions, issues, rowCount: rows.length, ignoredRows: 0 }
}

export function parseBankRows(rows: Record<string, string>[], map: ColumnMap): ParsedTransactions<BankTransaction> {
  const transactions: BankTransaction[] = []
  const issues: RowIssue[] = []
  let ignoredRows = 0
  rows.forEach((row, index) => {
    const date = normalizeDate(cell(row, map.date))
    const originalDescription = cell(row, map.description)
    const debitText = cell(row, map.debit), creditText = cell(row, map.credit)
    const debitPresent = Boolean(debitText), creditPresent = Boolean(creditText)
    const splitColumns = Boolean(map.debit || map.credit)
    const debit = debitPresent ? normalizeAmount(debitText) : null
    const credit = creditPresent ? normalizeAmount(creditText) : null
    const genericAmountText = cell(row, map.amount)
    const rowNumber = index + 2
    if (isRepeatedHeader(row, map)) { ignoredRows += 1; return }
    if (!date && !originalDescription && !debitText && !creditText && !genericAmountText) { ignoredRows += 1; return }
    if (splitColumns && !debitPresent && !creditPresent && !genericAmountText) { ignoredRows += 1; return }
    if (!date && !debitPresent && !creditPresent && !genericAmountText) { ignoredRows += 1; return }
    // Totais e outras linhas de rodapé podem preencher débito e crédito ao mesmo tempo,
    // mas sem data e histórico não representam uma transação individual.
    if (!date && !originalDescription) { ignoredRows += 1; return }
    if (!date || !originalDescription) {
      issues.push({ row: rowNumber, message: `Data ou descrição inválida em linha com valor (data: ${cell(row, map.date) || 'vazia'}; descrição: ${originalDescription || 'vazia'}).` })
      return
    }
    if (splitColumns && debitPresent && creditPresent && ((debit ?? 0) !== 0 || (credit ?? 0) !== 0)) {
      issues.push({ row: rowNumber, message: 'Débito e crédito preenchidos na mesma linha; confira os valores antes de importar.' })
      return
    }
    const rawAmount = splitColumns && (debitPresent || creditPresent)
      ? debitPresent ? debit : credit
      : normalizeAmount(genericAmountText)
    const amount = rawAmount == null ? null : Math.abs(rawAmount)
    if (amount == null) {
      if (!date && !debitPresent && !creditPresent && !genericAmountText) { ignoredRows += 1; return }
      issues.push({ row: rowNumber, message: `Data, descrição ou valor inválido (data: ${cell(row, map.date) || 'vazia'}; valor: ${debitText || creditText || genericAmountText || 'vazio'}).` })
      return
    }
    const directionValue = cell(row, map.direction).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
    const describedType = transactionType(originalDescription)
    const action = investmentAction(originalDescription)
    const explicitTextDirection = /credit|credito|entrada|receb|debit|debito|saida|pag/.test(directionValue)
    const directionKnown = Boolean(splitColumns && (debitPresent || creditPresent)) || explicitTextDirection || describedType === 'INCOME' || describedType === 'INVESTMENT_INCOME' || (describedType === 'EXPENSE' && /pix enviado|pix qr code|compra|seguro cart deb bradesco|conta de telefone|mercado|supermercado|farmacia|drogaria|posto de combustivel/.test(originalDescription.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase())) || (describedType === 'INVESTMENT' && action != null) || describedType === 'CARD_PAYMENT'
    let direction: 'DEBIT' | 'CREDIT'
    if (splitColumns && (debitPresent || creditPresent)) direction = debitPresent ? 'DEBIT' : 'CREDIT'
    else if (/credit|credito|entrada|receb/.test(directionValue)) direction = 'CREDIT'
    else if (/debit|debito|saida|pag/.test(directionValue)) direction = 'DEBIT'
    else {
      direction = describedType === 'INCOME' || describedType === 'INVESTMENT_INCOME' || (describedType === 'INVESTMENT' && investmentAction(originalDescription) === 'RESCUE') ? 'CREDIT' : 'DEBIT'
    }
    const paymentMethod = cell(row, map.paymentMethod)
    const classifiedType = transactionType(originalDescription, paymentMethod)
    const type = classifiedType
    const outOfScopeSubtype = /^rentab invest facilcred(?: |$)/.test(originalDescription.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()) ? 'INVEST_FACIL_YIELD' as const : undefined
    const installment = installmentFrom(originalDescription)
    transactions.push({
      id: `bank-${index + 1}`, source: 'BANK', sheetRecordId: null,
      bankTransactionId: cell(row, map.id) || '',
      date, description: originalDescription, originalDescription, amount, direction, directionKnown,
      type, investmentAction: investmentAction(originalDescription),
      ...(outOfScopeSubtype ? { outOfScopeSubtype } : {}),
      paymentMethod, category: '', month: '', year: date.slice(0, 4), isFixed: null, isEssential: null,
      ...installment, balanceAfter: map.balance ? normalizeSignedBalance(cell(row, map.balance)) : null, original: { ...row },
    })
  })
  {
    const idCounts = new Map<string, number>()
    const fingerprintCounts = new Map<string, number>()
    for (const transaction of transactions) {
      const rawId = cell(transaction.original, map.id)
      if (rawId) idCounts.set(rawId, (idCounts.get(rawId) ?? 0) + 1)
    }
    for (const transaction of transactions) {
      const rawId = cell(transaction.original, map.id)
      if (rawId && idCounts.get(rawId) === 1) transaction.bankTransactionId = `doc:${rawId}`
      else {
        const fingerprint = stableFingerprint([transaction.date, transaction.originalDescription, transaction.amount, transaction.direction, transaction.balanceAfter, transaction.type, rawId])
        const occurrence = (fingerprintCounts.get(fingerprint) ?? 0) + 1
        fingerprintCounts.set(fingerprint, occurrence)
        transaction.bankTransactionId = `auto:${fingerprint}:${occurrence}`
      }
      transaction.id = `bank-${stableFingerprint([transaction.bankTransactionId])}`
    }
  }
  return { transactions, issues, rowCount: rows.length, ignoredRows }
}

function isRepeatedHeader(row: Record<string, string>, map: ColumnMap): boolean {
  const columns = [map.date, map.description, map.id, map.credit, map.debit, map.balance].filter((value): value is string => Boolean(value))
  return columns.length >= 2 && columns.every((header) => {
    const cellValue = cell(row, header).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
    const headerValue = header.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
    return !cellValue || cellValue === headerValue
  })
}

function normalizeSignedBalance(value: string): number | null {
  const normalized = normalizeAmount(value)
  if (normalized == null) return null
  return value.trim().startsWith('-') || value.trim().startsWith('(') ? -normalized : normalized
}
