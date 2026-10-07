import type { BankTransaction, ColumnMap, CsvDocument, ExcludedBankRow, LedgerTransaction, ParsedTransactions, RowIssue } from '../domain/types'
import { classifySheetRecord, investmentAction, normalizeAmount, normalizeDate, parseBoolean, transactionType } from './normalize'
import { stableFingerprint } from '../domain/identity'

const cell = (row: Record<string, string>, key?: string) => key ? String(row[key] ?? '').trim() : ''
const installmentFrom = (description: string) => {
  const match = description.match(/\b(\d{1,2})\s*\/\s*(\d{1,2})\b/)
  return match ? { installment: Number(match[1]), totalInstallments: Number(match[2]) } : { installment: null, totalInstallments: null }
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
      type: classifySheetRecord({ description: originalDescription, paymentMethod }), investmentAction: investmentAction(originalDescription), paymentMethod,
      category: cell(row, map.category), month: cell(row, map.month), year: cell(row, map.year),
      isFixed: parseBoolean(cell(row, map.isFixed)), isEssential: parseBoolean(cell(row, map.isEssential)),
      ...installment, balanceAfter: null, original,
    })
  })
  return { transactions, issues, rowCount: rows.length, ignoredRows: 0 }
}

export function parseBankRows(rows: Record<string, string>[], map: ColumnMap, physicalRowsBeforeHeader = 0, statementPeriod?: { start: string; end: string }): ParsedTransactions<BankTransaction> {
  const transactions: BankTransaction[] = []
  const issues: RowIssue[] = []
  const excludedRows: ExcludedBankRow[] = []
  let ignoredRows = 0
  const exclude = (row: Record<string, string>, index: number, reason: ExcludedBankRow['reason']) => {
    ignoredRows += 1
    const debitText = cell(row, map.debit), creditText = cell(row, map.credit)
    const debit = debitText ? normalizeAmount(debitText) : null
    const credit = creditText ? normalizeAmount(creditText) : null
    const genericAmount = map.amount ? normalizeAmount(cell(row, map.amount)) : null
    const excludedAmount = debitText || creditText ? debit ?? credit : genericAmount
    excludedRows.push({
      row: index + physicalRowsBeforeHeader + 2,
      reason,
      date: normalizeDate(cell(row, map.date)),
      description: cell(row, map.description),
      document: cell(row, map.id) || null,
      balanceAfter: map.balance ? normalizeSignedBalance(cell(row, map.balance)) : null,
      amount: excludedAmount == null ? null : Math.abs(excludedAmount),
      direction: debitText ? 'DEBIT' : creditText ? 'CREDIT' : null,
      credit: credit == null ? null : Math.abs(credit),
      debit: debit == null ? null : Math.abs(debit),
    })
  }
  rows.forEach((row, index) => {
    const date = normalizeDate(cell(row, map.date))
    const originalDescription = cell(row, map.description)
    const debitText = cell(row, map.debit), creditText = cell(row, map.credit)
    const debitPresent = Boolean(debitText), creditPresent = Boolean(creditText)
    const splitColumns = Boolean(map.debit || map.credit)
    const debit = debitPresent ? normalizeAmount(debitText) : null
    const credit = creditPresent ? normalizeAmount(creditText) : null
    const genericAmountText = cell(row, map.amount)
    const rowNumber = index + physicalRowsBeforeHeader + 2
    if (isRepeatedHeader(row, map)) { exclude(row, index, 'REPEATED_HEADER'); return }
    if (!date && !originalDescription && !debitText && !creditText && !genericAmountText) { exclude(row, index, 'EMPTY'); return }
    if (date && statementPeriod && (date < statementPeriod.start || date > statementPeriod.end)) { exclude(row, index, 'OUTSIDE_STATEMENT_PERIOD'); return }
    if (splitColumns && !debitPresent && !creditPresent && !genericAmountText) { exclude(row, index, date && originalDescription ? 'NO_MOVEMENT' : 'FOOTER_OR_METADATA'); return }
    if (!date && !debitPresent && !creditPresent && !genericAmountText) { exclude(row, index, 'EMPTY'); return }
    // Totais e outras linhas de rodapé podem preencher débito e crédito ao mesmo tempo,
    // mas sem data e histórico não representam uma transação individual.
    if (!date && !originalDescription) { exclude(row, index, 'FOOTER_OR_METADATA'); return }
    if (!date || !originalDescription) {
      issues.push({ row: rowNumber, message: `Data ou descrição inválida em linha com valor (data: ${cell(row, map.date) || 'vazia'}; descrição: ${originalDescription || 'vazia'}).` })
      return
    }
    if (splitColumns && debitPresent && creditPresent && ((debit ?? 0) !== 0 || (credit ?? 0) !== 0)) {
      issues.push({ row: rowNumber, message: 'Débito e crédito preenchidos na mesma linha; confira os valores antes de importar.' })
      return
    }
    if (splitColumns && debitPresent && creditPresent && (debit ?? 0) === 0 && (credit ?? 0) === 0) { exclude(row, index, 'NO_MOVEMENT'); return }
    const rawAmount = splitColumns && (debitPresent || creditPresent)
      ? debitPresent ? debit : credit
      : normalizeAmount(genericAmountText)
    const amount = rawAmount == null ? null : Math.abs(rawAmount)
    if (amount == null) {
      if (!date && !debitPresent && !creditPresent && !genericAmountText) { exclude(row, index, 'FOOTER_OR_METADATA'); return }
      issues.push({ row: rowNumber, message: `Data, descrição ou valor inválido (data: ${cell(row, map.date) || 'vazia'}; valor: ${debitText || creditText || genericAmountText || 'vazio'}).` })
      return
    }
    const directionValue = cell(row, map.direction).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
    const describedType = transactionType(originalDescription)
    const action = investmentAction(originalDescription)
    const explicitTextDirection = /credit|credito|entrada|receb|debit|debito|saida|pag/.test(directionValue)
    const directionKnown = Boolean(splitColumns && (debitPresent || creditPresent)) || explicitTextDirection || describedType === 'INCOME' || describedType === 'REFUND' || describedType === 'INVESTMENT_INCOME' || (describedType === 'EXPENSE' && /pix enviado|pix qr code|compra|seguro cart deb bradesco|conta de telefone|mercado|supermercado|farmacia|drogaria|posto de combustivel/.test(originalDescription.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase())) || (describedType === 'INVESTMENT' && action != null) || describedType === 'CARD_PAYMENT'
    let direction: 'DEBIT' | 'CREDIT'
    if (splitColumns && (debitPresent || creditPresent)) direction = debitPresent ? 'DEBIT' : 'CREDIT'
    else if (/credit|credito|entrada|receb/.test(directionValue)) direction = 'CREDIT'
    else if (/debit|debito|saida|pag/.test(directionValue)) direction = 'DEBIT'
    else {
      direction = describedType === 'INCOME' || describedType === 'REFUND' || describedType === 'INVESTMENT_INCOME' || (describedType === 'INVESTMENT' && investmentAction(originalDescription) === 'RESCUE') ? 'CREDIT' : 'DEBIT'
    }
    const paymentMethod = cell(row, map.paymentMethod)
    const classifiedType = transactionType(originalDescription, paymentMethod)
    const type = classifiedType
    const outOfScopeSubtype = /^rentab invest facilcred(?: |$)/.test(originalDescription.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()) ? 'INVEST_FACIL_YIELD' as const : undefined
    const installment = installmentFrom(originalDescription)
    transactions.push({
      id: `bank-${index + 1}`, sourceRow: rowNumber, source: 'BANK', sheetRecordId: null,
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
      transaction.id = `bank-${stableFingerprint([transaction.date, transaction.originalDescription, transaction.amount, transaction.direction, transaction.bankTransactionId])}`
    }
  }
  return { transactions, issues, rowCount: rows.length, ignoredRows, excludedRows }
}

/** Parses the main Bradesco section and its auxiliary recent-movements section independently. */
export function parseBankCsvSections(csv: CsvDocument, map: ColumnMap) {
  const period = csv.statementPeriodStart && csv.statementPeriodEnd
    ? { start: csv.statementPeriodStart, end: csv.statementPeriodEnd }
    : undefined
  const main = parseBankRows(csv.rows, map, csv.metadataRowsIgnored, period)
  const auxiliary = csv.auxiliaryRows.length && period
    ? parseBankRows(csv.auxiliaryRows, map, csv.metadataRowsIgnored + (csv.auxiliaryRowsStartIndex ?? csv.rows.length), period)
    : { transactions: [], issues: [], rowCount: 0, ignoredRows: 0, excludedRows: [] as ExcludedBankRow[] }
  const auxiliaryMerge = mergeAuxiliaryBankTransactionsWithDiagnostics(main.transactions, auxiliary.transactions)
  const transactions = auxiliaryMerge.transactions
  const addedAuxiliary = transactions.length - main.transactions.length
  return {
    ...main,
    transactions,
    issues: [...main.issues, ...auxiliary.issues],
    rowCount: main.rowCount + auxiliary.rowCount,
    ignoredRows: main.ignoredRows + auxiliary.ignoredRows + auxiliaryMerge.duplicates.length,
    excludedRows: [...(main.excludedRows ?? []), ...(auxiliary.excludedRows ?? []), ...auxiliaryMerge.duplicates.map((transaction) => ({
      row: transaction.sourceRow ?? 0,
      reason: 'DUPLICATE_AUXILIARY' as const,
      date: transaction.date,
      description: transaction.originalDescription,
      document: Object.entries(transaction.original).find(([header]) => ['docto', 'documento', 'nsu', 'id transacao'].includes(header.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()))?.[1] ?? null,
      balanceAfter: transaction.balanceAfter,
      amount: transaction.amount,
      direction: transaction.direction,
      credit: transaction.direction === 'CREDIT' ? transaction.amount : null,
      debit: transaction.direction === 'DEBIT' ? transaction.amount : null,
    }))],
    auxiliaryIncludedCount: addedAuxiliary,
    auxiliaryOutsidePeriodCount: (auxiliary.excludedRows ?? []).filter((row) => row.reason === 'OUTSIDE_STATEMENT_PERIOD').length,
  }
}

/** Keep the primary section authoritative and append only genuinely new auxiliary movements. */
function sourceDocument(transaction: BankTransaction) {
  const originalValue = Object.entries(transaction.original).find(([header]) => {
    const normalized = header.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
    return ['docto', 'documento', 'nsu', 'id transacao'].includes(normalized)
  })?.[1]?.trim()
  if (originalValue) return originalValue.toLowerCase()
  return transaction.bankTransactionId.startsWith('auto:') ? '' : transaction.bankTransactionId.replace(/^doc:/, '').toLowerCase()
}

function auxiliaryTransactionIdentity(transaction: BankTransaction) {
    const rawDocument = sourceDocument(transaction)
    const normalizedDescription = transaction.originalDescription.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().replace(/\s+/g, ' ')
    return [transaction.date, rawDocument, normalizedDescription, transaction.direction, transaction.amount].join('|')
}

export function mergeAuxiliaryBankTransactionsWithDiagnostics(primary: BankTransaction[], auxiliary: BankTransaction[]) {
  const seen = new Set(primary.map(auxiliaryTransactionIdentity))
  const appended: BankTransaction[] = []
  const duplicates: BankTransaction[] = []
  for (const transaction of auxiliary) {
    const key = auxiliaryTransactionIdentity(transaction)
    if (seen.has(key)) { duplicates.push(transaction); continue }
    seen.add(key)
    appended.push(transaction)
  }
  return { transactions: [...primary, ...appended], duplicates }
}

export function mergeAuxiliaryBankTransactions(primary: BankTransaction[], auxiliary: BankTransaction[]) {
  return mergeAuxiliaryBankTransactionsWithDiagnostics(primary, auxiliary).transactions
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
