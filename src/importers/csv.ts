import Papa from 'papaparse'
import type { BankStatementFormat, CsvDocument } from '../domain/types'

export function parseCsvText(text: string): CsvDocument {
  const source = text.replace(/^\uFEFF/, '')
  const candidates = [',', ';', '\t', '|'].flatMap((delimiter) => {
    const parsed = Papa.parse<string[]>(source, { delimiter, header: false, skipEmptyLines: false, dynamicTyping: false, preview: 80 })
    return (parsed.data ?? []).map((cells, row) => ({ delimiter, row, cells }))
  })
  const headerCandidate = candidates
    .map((candidate) => ({ ...candidate, score: headerScore(candidate.cells) }))
    .filter((candidate) => candidate.score >= 8)
    .sort((a, b) => b.score - a.score || a.row - b.row)[0]
  const delimiter = headerCandidate?.delimiter ?? Papa.parse<string[]>(source, { preview: 1 }).meta.delimiter ?? ','
  const metadataRowsIgnored = headerCandidate?.row ?? 0
  const parseSource = headerCandidate ? source.split(/\r\n|\n|\r/).slice(metadataRowsIgnored).join('\n') : source
  const result = Papa.parse<Record<string, string>>(parseSource, {
    header: true,
    delimiter,
    skipEmptyLines: 'greedy',
    dynamicTyping: false,
    transformHeader: (header) => header.replace(/^\uFEFF/, '').trim(),
  })
  const rawHeaders = result.meta.fields ?? []
  const headers = rawHeaders.filter((header) => header.trim() !== '')
  const allRows = (result.data ?? []).map((row) => {
    const clean: Record<string, string> = {}
    for (const header of headers) clean[header] = String(row[header] ?? '').trim()
    return clean
  }).filter((row) => Object.values(row).some(Boolean))
  const bradescoLike = Boolean(detectColumn(headers, 'date') && detectColumn(headers, 'description')
    && (detectColumn(headers, 'debit') || detectColumn(headers, 'credit')) && detectColumn(headers, 'balance'))
  const hasInternetBankingCompanions = allRows.some((row) => !normalizeHeader(row[detectColumn(headers, 'date')])
    && Boolean(row[detectColumn(headers, 'description')])
    && !row[detectColumn(headers, 'debit')] && !row[detectColumn(headers, 'credit')])
  const bankStatementFormat: BankStatementFormat | undefined = bradescoLike
    ? rawHeaders.some((header) => !header.trim()) && hasInternetBankingCompanions
      ? 'BRADESCO_CSV_INTERNET_BANKING'
      : 'BRADESCO_CSV_MOBILE'
    : undefined
  let auxiliaryStart = -1
  let principalEnd = allRows.length
  let statementPeriodStart: string | null = null
  let statementPeriodEnd: string | null = null
  for (let index = 0; index < allRows.length; index += 1) {
    const values = Object.values(allRows[index])
    const latestMarker = bradescoLike && values.some((value) => normalizeHeader(value) === 'ultimos lancamentos')
    const filterPeriod = bradescoLike ? values.map(readStatementPeriod).find((period) => period != null) : null
    if (filterPeriod) {
      statementPeriodStart = filterPeriod.start
      statementPeriodEnd = filterPeriod.end
      principalEnd = Math.min(principalEnd, index)
    }
    if (latestMarker) {
      auxiliaryStart = index
      principalEnd = Math.min(principalEnd, index)
    }
  }
  const rows = allRows.slice(0, principalEnd)
  const auxiliaryRows = auxiliaryStart >= 0 ? allRows.slice(auxiliaryStart + 1) : []
  const physicalLines = source.split(/\r\n|\n|\r/)
  const firstDataLine = metadataRowsIgnored + 1
  const nonEmptyDataLineNumbers = physicalLines
    .map((line, index) => ({ line, number: index + 1 }))
    .slice(firstDataLine)
    .filter(({ line }) => line.trim().length > 0)
    .map(({ number }) => number)
  const parseErrors = result.errors
    .filter((error) => {
      // Internet Banking omits trailing empty columns in many valid rows.
      // Required financial fields are validated by the row parser below.
      if (error.code === 'TooFewFields') return false
      if (error.code !== 'TooManyFields') return true
      const extra = (result.data[error.row ?? 0] as Record<string, unknown> | undefined)?.__parsed_extra
      // Bancos frequentemente terminam linhas de resumo com um separador vazio.
      // Isso não desloca colunas nem altera transações; campos extras com conteúdo seguem como erro.
      return !Array.isArray(extra) || extra.some((value) => String(value ?? '').trim() !== '')
    })
    .map((error) => {
      const rowIndex = error.row ?? 0
      return `Linha ${nonEmptyDataLineNumbers[rowIndex] ?? rowIndex + metadataRowsIgnored + 2}: ${error.message}`
    })
  return {
    headers,
    rows,
    auxiliaryRows,
    auxiliaryRowsStartIndex: auxiliaryStart >= 0 ? auxiliaryStart + 1 : undefined,
    auxiliarySectionLabel: auxiliaryStart >= 0 ? 'Últimos Lançamentos' : null,
    statementPeriodStart,
    statementPeriodEnd,
    parseErrors,
    delimiter: result.meta.delimiter,
    metadataRowsIgnored,
    bankStatementFormat,
  }
}

function readStatementPeriod(value: string): { start: string; end: string } | null {
  const normalized = value.normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  const match = normalized.match(/movimentacao\s+entre\s*:?\s*(\d{1,2}\/\d{1,2}\/\d{4})\s+e\s+(\d{1,2}\/\d{1,2}\/\d{4})/i)
  if (!match) return null
  const toIso = (date: string) => {
    const [day, month, year] = date.split('/')
    return `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`
  }
  return { start: toIso(match[1]), end: toIso(match[2]) }
}

function headerScore(cells: string[]): number {
  const fields = cells.map((cell) => normalizeHeader(cell))
  const has = (key: string) => fields.some((field) => (synonyms[key] ?? []).includes(field))
  const date = has('date'), description = has('description')
  const value = has('amount') || has('debit') || has('credit')
  if (!date || !description || !value) return 0
  return 8 + Number(has('amount')) * 2 + Number(has('debit')) * 2 + Number(has('credit')) * 2 + Number(has('balance')) + Number(has('id'))
}

export async function readCsvFile(file: File): Promise<CsvDocument> {
  return parseCsvText(await readLocalFileText(file))
}

export async function readLocalFileText(file: File): Promise<string> {
  const text = await file.text()
  if (!text.includes('\uFFFD') || typeof file.arrayBuffer !== 'function') return text
  const bytes = await file.arrayBuffer()
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes) }
  catch { return new TextDecoder('windows-1252').decode(bytes) }
}

export function normalizeHeader(value: string): string {
  return value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLocaleLowerCase('pt-BR').replace(/[^a-z0-9]+/g, ' ').trim()
}

const synonyms: Record<string, string[]> = {
  date: ['data', 'data da compra', 'data lancamento', 'data transacao', 'dt lancamento', 'date'],
  description: ['descricao', 'historico', 'estabelecimento', 'lancamento', 'description', 'merchant', 'favorecido'],
  amount: ['custo', 'valor', 'valor da transacao', 'valor lancamento', 'amount', 'valor r'],
  debit: ['debito', 'debitos', 'debito r', 'saida', 'saidas'],
  credit: ['credito', 'creditos', 'credito r', 'entrada', 'entradas'],
  direction: ['tipo', 'natureza', 'operacao', 'debito credito'],
  id: ['id', 'identificador', 'id transacao', 'codigo transacao', 'transaction id', 'nsu', 'docto', 'documento'],
  balance: ['saldo', 'saldo apos lancamento', 'saldo final', 'saldo r', 'balance'],
  paymentMethod: ['forma de pagamento', 'meio de pagamento', 'pagamento', 'payment method'],
  category: ['categoria'], month: ['mes'], year: ['ano'], isFixed: ['e fixo', 'fixo'], isEssential: ['e essencial', 'essencial'],
}

export function detectColumn(headers: string[], key: string): string {
  const accepted = synonyms[key] ?? []
  const normalized = headers.map((header) => ({ header, value: normalizeHeader(header) }))
  return normalized.find(({ value }) => accepted.includes(value))?.header ?? ''
}

export function initialColumnMap(headers: string[], mode: 'sheet' | 'bank') {
  const found = (key: string) => detectColumn(headers, key)
  return mode === 'sheet'
    ? { date: found('date'), description: found('description'), amount: found('amount'), month: found('month'), year: found('year'), category: found('category'), paymentMethod: found('paymentMethod'), isFixed: found('isFixed'), isEssential: found('isEssential'), id: found('id') }
    : { date: found('date'), description: found('description'), amount: found('amount'), direction: found('direction'), debit: found('debit'), credit: found('credit'), id: found('id'), balance: found('balance'), paymentMethod: found('paymentMethod') }
}
