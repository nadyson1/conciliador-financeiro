import type { BankStatementFormat, BankTransaction, ColumnMap, CsvDocument, ExcludedBankRow, RowIssue } from '../domain/types'
import { initialColumnMap, parseCsvText, readLocalFileText } from './csv'
import { counterpartyEvidence, counterpartyFromDescription, descriptionWithoutCounterparty } from './counterparty'
import { investmentAction, normalizeAmount, normalizeDate, transactionType } from './normalize'
import { parseBankCsvSections } from './transactions'

export type ParsedBankStatementFile = {
  format: BankStatementFormat | 'CSV_GENERIC'
  csv: CsvDocument
  map: ColumnMap
  transactions: BankTransaction[]
  issues: RowIssue[]
  rowCount: number
  ignoredRows: number
  excludedRows: ExcludedBankRow[]
  auxiliaryIncludedCount: number
  auxiliaryOutsidePeriodCount: number
  declaredPeriodStart: string | null
  declaredPeriodEnd: string | null
  actualPeriodStart: string | null
  actualPeriodEnd: string | null
  balanceEvidence: { amount: number; date: string } | null
}

const emptyCsv = (headers: string[], rows: Record<string, string>[], periodStart: string | null, periodEnd: string | null): CsvDocument => ({
  headers, rows, auxiliaryRows: [], auxiliarySectionLabel: null, statementPeriodStart: periodStart,
  statementPeriodEnd: periodEnd, parseErrors: [], delimiter: 'OFX', metadataRowsIgnored: 0,
})

function cleanOfxValue(value: string | undefined) {
  return (value ?? '').replace(/\s+/g, ' ').trim()
}

function ofxTag(block: string, tag: string) {
  const match = block.match(new RegExp(`<${tag}>([^\\r\\n<]*)`, 'i'))
  return cleanOfxValue(match?.[1])
}

function ofxDate(value: string) {
  const match = value.match(/^(\d{4})(\d{2})(\d{2})/)
  return match ? normalizeDate(`${match[1]}-${match[2]}-${match[3]}`) : null
}

function parseOfx(text: string) {
  const statementBlocks = [...text.matchAll(/<STMTTRN>([\s\S]*?)(?=<STMTTRN>|<\/BANKTRANLIST>)/gi)].map((match) => match[1])
  if (!statementBlocks.length) throw new Error('O arquivo parece OFX, mas não contém movimentações bancárias reconhecíveis.')
  const periodStart = ofxDate(ofxTag(text, 'DTSTART'))
  const periodEnd = ofxDate(ofxTag(text, 'DTEND'))
  const balanceBlock = text.match(/<LEDGERBAL>([\s\S]*?)(?:<\/LEDGERBAL>|<AVAILBAL>|<BANKTRANLIST>)/i)?.[1] ?? ''
  const balanceAmount = normalizeAmount(ofxTag(balanceBlock, 'BALAMT'))
  const balanceDate = ofxDate(ofxTag(balanceBlock, 'DTASOF'))
  const balanceEvidence = balanceAmount != null && balanceDate ? { amount: balanceAmount, date: balanceDate } : null
  const headers = ['Data', 'Histórico', 'Docto.', 'Crédito (R$)', 'Débito (R$)', 'Saldo (R$)', 'FITID', 'CHECKNUM', 'TRNTYPE', 'MEMO', 'NAME']
  const rows: Record<string, string>[] = []
  const transactions: BankTransaction[] = []
  const issues: RowIssue[] = []
  statementBlocks.forEach((block, index) => {
    const rawType = ofxTag(block, 'TRNTYPE').toUpperCase()
    const posted = ofxTag(block, 'DTPOSTED')
    const date = ofxDate(posted)
    const amountValue = Number(ofxTag(block, 'TRNAMT'))
    const fitid = ofxTag(block, 'FITID')
    const checknum = ofxTag(block, 'CHECKNUM')
    const memo = ofxTag(block, 'MEMO')
    const name = ofxTag(block, 'NAME')
    const payee = ofxTag(block, 'PAYEE')
    const sourceDescription = memo || name || payee || rawType
    const explicitName = name || payee
    const explicitCounterparty = counterpartyEvidence(explicitName, 'OFX_NAME')
    const memoCounterparty = counterpartyEvidence(counterpartyFromDescription(memo), 'OFX_MEMO')
    const counterpartyEvidenceList = [...explicitCounterparty, ...memoCounterparty]
    const counterpartyName = explicitCounterparty[0]?.name ?? memoCounterparty[0]?.name
    const description = descriptionWithoutCounterparty(memo || sourceDescription, counterpartyName) || sourceDescription
    const validType = Boolean(rawType)
    if (!date || !Number.isFinite(amountValue) || !validType || !description || amountValue === 0) {
      issues.push({ row: index + 1, message: 'Movimentação OFX incompleta: confira TRNTYPE, DTPOSTED, TRNAMT e MEMO/NAME.' })
      return
    }
    const direction = rawType === 'CREDIT' ? 'CREDIT' : rawType === 'DEBIT' ? 'DEBIT' : amountValue > 0 ? 'CREDIT' : 'DEBIT'
    const amount = Math.round(Math.abs(amountValue) * 100)
    const original = { FITID: fitid, CHECKNUM: checknum, TRNTYPE: rawType, DTPOSTED: posted, TRNAMT: String(amountValue), MEMO: memo, NAME: name, PAYEE: payee }
    const row = { Data: `${date.slice(8, 10)}/${date.slice(5, 7)}/${date.slice(0, 4)}`, 'Histórico': description, 'Docto.': checknum, 'Crédito (R$)': direction === 'CREDIT' ? String(amount / 100) : '', 'Débito (R$)': direction === 'DEBIT' ? String(amount / 100) : '', 'Saldo (R$)': '', FITID: fitid, CHECKNUM: checknum, TRNTYPE: rawType, MEMO: memo, NAME: name }
    rows.push(row)
    const type = transactionType(description)
    const bankTransactionId = fitid ? `ofx:${fitid}` : checknum ? `doc:${checknum}` : `auto:ofx:${index + 1}`
    transactions.push({
      id: `bank-${bankTransactionId}`, sourceRow: index + 1, source: 'BANK', sheetRecordId: null,
      bankTransactionId, date, description, originalDescription: description, sourceDescriptions: [sourceDescription],
      ...(counterpartyName ? { counterpartyName, counterpartyEvidence: counterpartyEvidenceList } : {}),
      sourceTransactionIds: fitid ? [`FITID:${fitid}`] : checknum ? [`CHECKNUM:${checknum}`] : [],
      statementFormats: ['OFX'], amount, direction, directionKnown: true, type, investmentAction: investmentAction(description),
      paymentMethod: '', category: '', month: '', year: date.slice(0, 4), isFixed: null, isEssential: null,
      installment: null, totalInstallments: null, balanceAfter: null, original,
    })
  })
  const csv = emptyCsv(headers, rows, periodStart, periodEnd)
  return { csv, map: { date: 'Data', description: 'Histórico', amount: '', debit: 'Débito (R$)', credit: 'Crédito (R$)', id: 'FITID', balance: '' }, transactions, issues, periodStart, periodEnd, balanceEvidence }
}

function hasMovement(row: Record<string, string>, map: ColumnMap) {
  return Boolean(normalizeDate(row[map.date]) && row[map.description]
    && (normalizeAmount(row[map.debit ?? '']) || normalizeAmount(row[map.credit ?? '']) || normalizeAmount(row[map.amount])))
}

function csvMovementDates(csv: CsvDocument, map: ColumnMap) {
  return [...csv.rows, ...csv.auxiliaryRows]
    .filter((row) => hasMovement(row, map))
    .map((row) => normalizeDate(row[map.date])!)
    .sort()
}

function combineInternetBankingDescriptions(csv: CsvDocument, map: ColumnMap) {
  const combine = (sourceRows: Record<string, string>[]) => {
    const rows: Record<string, string>[] = []
    let previousMovement = -1
    let combined = 0
    for (const row of sourceRows) {
      const date = normalizeDate(row[map.date])
      const desc = (row[map.description] ?? '').trim()
      const hasValue = Object.entries(row).some(([header, value]) => Boolean(value?.trim()) && header !== map.description)
      if (date) {
        rows.push({ ...row })
        previousMovement = hasMovement(row, map) ? rows.length - 1 : -1
      } else if (previousMovement >= 0 && desc && !hasValue) {
        const normalized = desc.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
        const isFooterOrHeader = /^(total|data|historico|saldo|filtro|ultimos lancamentos)( |$)/.test(normalized)
        if (!isFooterOrHeader) {
          const complement = /^(des|rem|fav|orig)\s*:/i.test(desc) ? desc : `Des: ${desc}`
          const transaction = rows[previousMovement]
          transaction.__counterpartyName = counterpartyFromDescription(complement) ?? ''
          transaction.__counterpartySource = 'CSV_INTERNET_BANKING'
          transaction.__sourceDescription = `${transaction.__sourceDescription ?? transaction[map.description]} ${complement}`.trim()
          combined += 1
        } else rows.push({ ...row })
      } else {
        rows.push({ ...row })
      }
    }
    return { rows, combined }
  }
  const main = combine(csv.rows)
  const auxiliary = combine(csv.auxiliaryRows)
  return { ...csv, rows: main.rows, auxiliaryRows: auxiliary.rows, companionRowsCombined: main.combined + auxiliary.combined }
}

function withSourceMetadata(transactions: BankTransaction[], format: BankStatementFormat) {
  return transactions.map((transaction) => {
    const description = transaction.originalDescription
    const sourceId = transaction.original.FITID
      ? `FITID:${transaction.original.FITID}`
      : transaction.original.CHECKNUM ? `CHECKNUM:${transaction.original.CHECKNUM}`
      : Object.entries(transaction.original).find(([key]) => /^(docto\.?|documento|nsu)$/i.test(key.trim()))?.[1]
        ? `DOCUMENT:${Object.entries(transaction.original).find(([key]) => /^(docto\.?|documento|nsu)$/i.test(key.trim()))?.[1]}` : ''
    return {
      ...transaction,
      sourceDescriptions: [...new Set([...(transaction.sourceDescriptions ?? []), description])],
      sourceTransactionIds: [...new Set([...(transaction.sourceTransactionIds ?? []), ...(sourceId ? [sourceId] : [])])],
      statementFormats: [...new Set([...(transaction.statementFormats ?? []), format])],
    }
  })
}

export function parseBankStatementText(text: string): ParsedBankStatementFile {
  const source = text.replace(/^\uFEFF/, '')
  const hasOfxEnvelope = /<OFX(?:\s|>)|<BANKMSGSRSV1>|(?:^|\r?\n)OFXHEADER\s*:/i.test(source)
  if (hasOfxEnvelope && /<STMTTRN>/i.test(source)) {
    const parsed = parseOfx(source)
    return {
      format: 'OFX', csv: { ...parsed.csv, bankStatementFormat: 'OFX' }, map: parsed.map,
      transactions: parsed.transactions, issues: parsed.issues, rowCount: parsed.csv.rows.length, ignoredRows: 0,
      excludedRows: [], auxiliaryIncludedCount: 0, auxiliaryOutsidePeriodCount: 0,
      declaredPeriodStart: parsed.periodStart, declaredPeriodEnd: parsed.periodEnd,
      actualPeriodStart: parsed.transactions.map((transaction) => transaction.date).sort()[0] ?? null,
      actualPeriodEnd: parsed.transactions.map((transaction) => transaction.date).sort().at(-1) ?? null,
      balanceEvidence: parsed.balanceEvidence,
    }
  }
  const csv = parseCsvText(source)
  if (!csv.headers.length || !csv.rows.length) throw new Error('Arquivo de extrato vazio ou layout não reconhecido.')
  const format = csv.bankStatementFormat ?? 'CSV_GENERIC'
  const map = initialColumnMap(csv.headers, 'bank') as ColumnMap
  if (format === 'CSV_GENERIC' && (!map.date || !map.description || (!(map.debit && map.credit) && !map.amount))) {
    throw new Error('Layout de extrato não reconhecido.')
  }
  const preparedCsv = format === 'BRADESCO_CSV_INTERNET_BANKING' ? combineInternetBankingDescriptions(csv, map) : csv
  const parsingCsv = format === 'BRADESCO_CSV_INTERNET_BANKING'
    // Keep the auxiliary section enabled while preventing its export filter from
    // hiding recent movements that are present in the file but outside that range.
    ? { ...preparedCsv, statementPeriodStart: '0001-01-01', statementPeriodEnd: '9999-12-31' }
    : preparedCsv
  const parsed = parseBankCsvSections(parsingCsv, map)
  const typedFormat = format === 'CSV_GENERIC' ? null : format
  const transactions = typedFormat ? withSourceMetadata(parsed.transactions, typedFormat) : parsed.transactions
  const dates = transactions.map((transaction) => transaction.date).sort()
  const presentDates = csvMovementDates(csv, map)
  return {
    format, csv: preparedCsv, map, transactions,
    issues: [...csv.parseErrors.map((message, index) => ({ row: index + 1, message })), ...parsed.issues],
    rowCount: parsed.rowCount + ((preparedCsv as CsvDocument & { companionRowsCombined?: number }).companionRowsCombined ?? 0),
    ignoredRows: parsed.ignoredRows + ((preparedCsv as CsvDocument & { companionRowsCombined?: number }).companionRowsCombined ?? 0),
    excludedRows: parsed.excludedRows ?? [], auxiliaryIncludedCount: parsed.auxiliaryIncludedCount,
    auxiliaryOutsidePeriodCount: parsed.auxiliaryOutsidePeriodCount,
    declaredPeriodStart: csv.statementPeriodStart,
    declaredPeriodEnd: csv.statementPeriodEnd,
    actualPeriodStart: presentDates[0] ?? dates[0] ?? null, actualPeriodEnd: presentDates.at(-1) ?? dates.at(-1) ?? null,
    balanceEvidence: null,
  }
}

export async function readBankStatementFile(file: File): Promise<ParsedBankStatementFile> {
  return parseBankStatementText(await readLocalFileText(file))
}
