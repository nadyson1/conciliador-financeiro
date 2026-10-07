import type { BankTransaction, CardStatement, CardStatementMatch, CardStatementReconciliation, CardStatementTransaction, LedgerTransaction } from '../domain/types'
import { descriptionSimilarity, normalizeDate, normalizeDescription } from './normalize'
import { stableFingerprint } from '../domain/identity'

type PdfTextItem = { str?: string; transform?: number[]; width?: number; hasEOL?: boolean }
type PdfPage = { getViewport: (options: { scale: number }) => { width: number }; getTextContent: (options?: object) => Promise<{ items: PdfTextItem[] }> }

const moneyPattern = /(?:R\$\s*)?(-?\d{1,3}(?:\.\d{3})*,\d{2}\s*-?)/g
const normalized = (value: string) => value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLocaleLowerCase('pt-BR')

export function parseBrazilianMoney(value: string): number | null {
  const clean = value.replace(/R\$\s*/i, '').replace(/\s+/g, '').trim()
  const negative = clean.startsWith('-') || clean.endsWith('-')
  const numeric = Number(clean.replace(/-/g, '').replace(/\./g, '').replace(',', '.'))
  return Number.isFinite(numeric) ? Math.round(numeric * 100) * (negative ? -1 : 1) : null
}

function statementDate(value: string, dueDate: string | null): string | null {
  if (/^\d{2}\/\d{2}\/\d{4}$/.test(value)) return normalizeDate(value)
  const [day, month] = value.split('/').map(Number)
  if (!day || !month || !dueDate) return null
  const dueYear = Number(dueDate.slice(0, 4)), dueMonth = Number(dueDate.slice(5, 7))
  const year = month > dueMonth ? dueYear - 1 : dueYear
  return normalizeDate(`${String(day).padStart(2, '0')}/${String(month).padStart(2, '0')}/${year}`)
}

function moneyFromLine(line: string): number | null {
  const cells = rowCells(line)
  let match: RegExpMatchArray | null = null
  if (cells.length > 1) {
    for (const cell of cells.slice(3)) {
      match = [...cell.matchAll(moneyPattern)][0] ?? null
      if (match) break
    }
  }
  if (!match) {
    const values = [...line.matchAll(moneyPattern)]
    match = values[values.length - 1] ?? null
  }
  if (!match) return null
  const parsed = parseBrazilianMoney(match[1])
  if (parsed == null || parsed < 0) return parsed
  const position = line.lastIndexOf(match[0]) + match[0].length
  const trailingCellMarker = line.slice(position).replace(/[|\s]/g, '') === '-'
  return trailingCellMarker ? -parsed : parsed
}

function amountAfterLabel(lines: string[], label: RegExp): number | null {
  for (const line of lines) {
    if (!label.test(normalized(line))) continue
    const values = [...line.matchAll(moneyPattern)]
    if (values.length) return parseBrazilianMoney(values[values.length - 1][1])
  }
  return null
}

function cardId(line: string): string | null {
  const match = line.match(/(\d{4})\s+(?:XXXX|X{4})\s+(?:XXXX|X{4})\s+(\d{4})/i)
  return match ? `${match[1]} XXXX XXXX ${match[2]}` : null
}

function parseInstallment(value: string): { installment: number | null; totalInstallments: number | null; description: string } {
  const match = value.match(/(?:^|\s)\(?\s*(\d{1,2})\s*\/\s*(\d{1,2})\s*\)?(?=\s|$)/)
  if (!match) return { installment: null, totalInstallments: null, description: value.trim() }
  return {
    installment: Number(match[1]),
    totalInstallments: Number(match[2]),
    description: value.replace(match[0], ' ').replace(/\s+/g, ' ').trim(),
  }
}

export type BradescoInvoiceLayout = 'MOBILE_APP' | 'INTERNET_BANKING' | 'UNKNOWN'

/** Detects the statement format from document text, never from its filename. */
export function detectBradescoInvoiceLayout(pages: string[][]): BradescoInvoiceLayout {
  const text = normalized(pages.flat().join('\n'))
  const internetBankingMarkers = [
    /fatura\s+data\s+\d{2}\/\d{2}\/\d{4}/,
    /cartao selecionado/,
    /data de vencimento:/,
    /gastos referentes ao cartao:\s*final\s+\d{4}/,
  ]
  if (internetBankingMarkers.filter((marker) => marker.test(text)).length >= 3) return 'INTERNET_BANKING'
  const mobileMarkers = [
    /total da fatura\s+vencimento/,
    /numero do cartao\s+\d{4}\s+x{4}\s+x{4}\s+\d{4}/,
    /historico de lancamentos/,
    /total da fatura em real/,
  ]
  if (mobileMarkers.filter((marker) => marker.test(text)).length >= 2) return 'MOBILE_APP'
  return 'UNKNOWN'
}

/** Stable financial key shared by equivalent PDFs from mobile and Internet Banking. */
export function cardStatementFinancialIdentity(statement: CardStatement): string | null {
  if (!statement.dueDate || statement.reportedTotal == null || !statement.transactions.length) return null
  const cards = [...new Set(statement.transactions.map((item) => item.cardIdentifier.slice(-4)))].sort()
  if (!cards.length) return null
  const transactions = statement.transactions.map((item) => [
    item.cardIdentifier.slice(-4), item.purchaseDate || item.date, normalizeDescription(item.originalDescription),
    item.amount, item.direction, item.type, item.installment ?? '', item.totalInstallments ?? '',
  ].join(':')).sort()
  const subtotals = statement.cardSubtotals.map((item) => `${item.cardIdentifier.slice(-4)}:${item.amount}`).sort()
  return `invoice-${stableFingerprint([statement.dueDate, statement.reportedTotal, cards.join(','), subtotals.join(','), ...transactions])}`
}

function statementMonthDate(day: string, monthName: string, dueDate: string | null): string | null {
  const months: Record<string, number> = { jan: 1, fev: 2, mar: 3, abr: 4, mai: 5, jun: 6, jul: 7, ago: 8, set: 9, out: 10, nov: 11, dez: 12 }
  const month = months[normalized(monthName).slice(0, 3)]
  if (!month || !dueDate) return null
  const dueYear = Number(dueDate.slice(0, 4)), dueMonth = Number(dueDate.slice(5, 7))
  const year = month > dueMonth ? dueYear - 1 : dueYear
  return normalizeDate(`${String(day).padStart(2, '0')}/${String(month).padStart(2, '0')}/${year}`)
}

function parseInternetBankingPages(pages: string[][], fileName: string): CardStatement {
  const allLines = pages.flat().map((line) => line.trim())
  const header = allLines.join('\n')
  const dueMatch = header.match(/data de vencimento:[^\d\n]*(\d{2}\/\d{2}\/\d{4})/i)
  const dueDate = dueMatch ? normalizeDate(dueMatch[1]) : null
  const totalMatch = header.match(/total da fatura:[^\d\n]*R\$\s*([\d.]+,\d{2})/i)
    ?? header.match(/total da fatura\s*\(final[^\n]*\):\s*R\$\s*([\d.]+,\d{2})/i)
  const reportedTotal = totalMatch ? parseBrazilianMoney(totalMatch[1]) : null
  const paymentMethodLine = allLines.find((line) => /^forma de pagamento:/i.test(line))
  const invoicePaymentMethod = paymentMethodLine?.split(':').slice(1).join(':').replace(/[|]/g, ' ').trim() || null
  const bestPurchaseLine = allLines.find((line) => /^melhor data de compra:/i.test(line))
  const bestPurchaseDayMatch = bestPurchaseLine?.match(/(\d{1,2})\s*$/)
  const bestPurchaseDay = bestPurchaseDayMatch ? Number(bestPurchaseDayMatch[1]) : null
  const previousBalance = amountAfterLabel(allLines, /saldo anterior/)
  const creditsPaymentsTotal = amountAfterLabel(allLines, /pagamentos?\s*\/\s*creditos/)
    ?? amountAfterLabel(allLines, /\(-\)\s*pagamentos?\s*\/\s*creditos/)
  const purchasesDebitsTotal = amountAfterLabel(allLines, /\(\+\)\s*despesas locais/)
  const transactions: CardStatementTransaction[] = []
  const cardSubtotals: CardStatement['cardSubtotals'] = []
  let activeCard = ''
  let pendingDay: string | null = null
  let pendingDescription: string | null = null
  let previousPayment: number | null = null
  let purchaseId = 0
  const errors: string[] = []

  for (const rawLine of allLines) {
    const line = rawLine.trim()
    const cardHeader = line.match(/gastos referentes ao cart[aã]o:\s*final\s+(\d{4})/i)
    if (cardHeader) {
      activeCard = `XXXX XXXX XXXX ${cardHeader[1]}`
      const subtotal = amountFromCardHeader(line)
      if (subtotal != null) cardSubtotals.push({ cardIdentifier: activeCard, amount: subtotal })
      pendingDay = null
      pendingDescription = null
      continue
    }
    if (/total da fatura\s*\(final/i.test(normalized(line))) { activeCard = ''; continue }
    if (/^\d{1,2}$/.test(line)) { pendingDay = line; pendingDescription = null; continue }
    if (/^(?:jan|fev|mar|abr|mai|jun|jul|ago|set|out|nov|dez)$/i.test(normalized(line))) {
      if (activeCard && pendingDay && pendingDescription) {
        const date = statementMonthDate(pendingDay, line, dueDate)
        const amountMatch = [...pendingDescription.matchAll(moneyPattern)].at(-1)
        const description = amountMatch ? pendingDescription.slice(0, amountMatch.index).replace(/[|]/g, ' ').trim() : ''
        const statementLine = date && amountMatch
          ? [`${date.slice(8, 10)}/${date.slice(5, 7)}/${date.slice(0, 4)}`, description, '', '', '', amountMatch[0]].join(' | ')
          : ''
        if (/\b(?:pagto\.?|pagamento da fatura|pagto por deb)\b/i.test(normalized(pendingDescription))) {
          previousPayment = Math.abs(moneyFromLine(pendingDescription) ?? 0) || previousPayment
        } else {
          const transaction = date ? parsePurchaseRow(statementLine, activeCard, dueDate, ++purchaseId) : null
          if (transaction) transactions.push(transaction)
        }
      }
      pendingDay = null
      pendingDescription = null
      continue
    }
    if (/^resumo das despesas\b/i.test(normalized(line))) { activeCard = ''; pendingDay = null; pendingDescription = null; continue }
    if (!activeCard) continue
    if (/\b(?:pagto\.?|pagamento da fatura|pagto por deb)\b/i.test(normalized(line))) {
      previousPayment = Math.abs(moneyFromLine(line) ?? 0) || previousPayment
      pendingDescription = null
      continue
    }
    if (/^saldo anterior\b/i.test(normalized(line))) { pendingDescription = null; continue }
    if (pendingDay && !pendingDescription && moneyFromLine(line) != null) pendingDescription = line
  }

  const distinctCards = [...new Set([...transactions.map((item) => item.cardIdentifier), ...cardSubtotals.map((item) => item.cardIdentifier)])].sort()
  const statementIdentity = `statement-${stableFingerprint([dueDate ?? '', reportedTotal == null ? '' : String(reportedTotal), ...distinctCards.map((id) => id.slice(-4))])}`
  transactions.forEach((transaction) => {
    transaction.statementTotal = reportedTotal
    transaction.id = `card-${statementIdentity}-${stableFingerprint([transaction.cardIdentifier, transaction.date, transaction.originalDescription, transaction.amount, transaction.direction, transaction.installment, transaction.totalInstallments])}`
  })
  const purchaseTotal = transactions.filter((item) => item.type === 'PURCHASE').reduce((sum, item) => sum + item.amount, 0)
  if (!dueDate) errors.push('Vencimento da fatura não encontrado; confira o PDF antes de conciliar.')
  if (reportedTotal == null || reportedTotal <= 0) errors.push('Total informado da fatura não encontrado ou inválido; confira o PDF antes de conciliar.')
  if (!distinctCards.length) errors.push('Nenhum cartão foi identificado na fatura.')
  if (!transactions.length) errors.push('Não foi possível localizar compras ou créditos válidos na fatura.')
  if (reportedTotal != null && cardSubtotals.length && cardSubtotals.reduce((sum, card) => sum + card.amount, 0) !== reportedTotal) errors.push('A soma dos subtotais dos cartões não confere com o total informado da fatura.')
  if (cardSubtotals.some((subtotal) => transactions.filter((item) => item.cardIdentifier === subtotal.cardIdentifier).reduce((sum, item) => sum + (item.direction === 'DEBIT' ? item.amount : -item.amount), 0) !== subtotal.amount)) errors.push('Divergência entre lançamentos extraídos e subtotal informado para um dos cartões.')
  if (purchasesDebitsTotal != null && purchaseTotal !== purchasesDebitsTotal) errors.push('Divergência entre compras extraídas e total de Despesas locais informado pela fatura.')
  const accountingDifference = previousBalance != null && creditsPaymentsTotal != null && purchasesDebitsTotal != null && reportedTotal != null
    ? previousBalance - creditsPaymentsTotal + purchasesDebitsTotal - reportedTotal : null
  if (accountingDifference != null && accountingDifference !== 0) errors.push('A relação entre saldo anterior, créditos/pagamentos, compras/débitos e total da fatura não fecha.')
  return { fileName, sourceLayout: 'INTERNET_BANKING', pageCount: pages.length, statementIdentity, transactions, cardSubtotals, reportedTotal, invoicePaymentMethod, bestPurchaseDay, purchasesDebitsTotal, creditsPaymentsTotal, previousBalance, previousPayment, accountingDifference, dueDate, nextClosingDate: null, errors: [...new Set(errors)] }
}

function amountFromCardHeader(line: string): number | null {
  const match = line.match(/valor da fatura:[^\d\n]*R\$\s*([\d.]+,\d{2})/i)
  return match ? parseBrazilianMoney(match[1]) : null
}

function rowCells(line: string): string[] {
  if (line.includes('|')) return line.split('|').map((part) => part.trim())
  if (line.includes('\t')) return line.split('\t').map((part) => part.trim())
  return [line]
}

function parsePurchaseRow(line: string, cardIdentifier: string, dueDate: string | null, id: number): CardStatementTransaction | null {
  const cells = rowCells(line)
  const rowText = cells.join(' ')
  const dateMatch = rowText.match(/^\s*(\d{2}\/\d{2}(?:\/\d{4})?)\b/)
  const lineHistory = cells.length > 2 ? cells[1] : rowText
  if (!dateMatch || /pagto|pagamento da fatura|saldo anterior/i.test(normalized(lineHistory))) return null
  const date = statementDate(dateMatch[1], dueDate)
  if (!date) return null
  const signedAmount = moneyFromLine(line)
  if (signedAmount == null || signedAmount === 0) return null
  const amount = Math.abs(signedAmount)
  const dateColumn = cells.length > 1 ? cells[0] : ''
  const historyColumn = cells.length > 2 ? cells[1] : ''
  const cityColumn = cells.length > 3 ? cells[2] : ''
  let history: string
  let city: string
  if (historyColumn) {
    history = historyColumn.replace(/^\d{2}\/\d{2}(?:\/\d{4})?\s*/, '').trim()
    city = cityColumn.replace(/\s+/g, ' ').trim()
  } else {
    const tail = rowText.replace(/^\s*\d{2}\/\d{2}(?:\/\d{4})?\s*/, '').replace(moneyPattern, '').trim()
    const installmentMatch = tail.match(/(?:^|\s)\d{1,2}\/\d{1,2}(?=\s|$)/)
    const withoutInstallment = installmentMatch ? tail.replace(installmentMatch[0], ' ').replace(/\s+/g, ' ').trim() : tail
    history = withoutInstallment
    city = ''
  }
  const installment = parseInstallment(history)
  history = installment.description
  const dateTime = dateColumn.match(/\d{2}\/\d{2}(?:\/\d{4})?/)
  if (!history) return null
  return {
    id: `card-${id}`, purchaseDate: dateTime ? statementDate(dateTime[0], dueDate) ?? date : date,
    invoiceDueDate: dueDate, date: dateTime ? statementDate(dateTime[0], dueDate) ?? date : date,
    description: history, originalDescription: history, amount,
    direction: signedAmount < 0 ? 'CREDIT' : 'DEBIT', type: signedAmount < 0 ? 'REFUND' : 'PURCHASE', ...(signedAmount > 0 ? { financialStatus: 'ACTIVE' as const } : {}), cardIdentifier,
    installment: installment.installment, totalInstallments: installment.totalInstallments,
    city, currency: 'BRL', exchangeRate: null, statementDueDate: dueDate, statementTotal: null,
  }
}

/** Parses layout-aware lines emitted from PDF.js. Pipe/tab separators preserve the statement's table columns. */
export function parseCardStatementPages(pages: string[][], fileName = 'Fatura PDF'): CardStatement {
  const layout = detectBradescoInvoiceLayout(pages)
  if (layout === 'INTERNET_BANKING') return parseInternetBankingPages(pages, fileName)
  if (layout === 'UNKNOWN') return {
    fileName, sourceLayout: 'UNKNOWN', pageCount: pages.length,
    statementIdentity: `statement-unsupported-${stableFingerprint([pages.flat().join('\n')])}`,
    transactions: [], cardSubtotals: [], reportedTotal: null, purchasesDebitsTotal: null,
    creditsPaymentsTotal: null, previousBalance: null, previousPayment: null,
    accountingDifference: null, dueDate: null, nextClosingDate: null,
    errors: ['Este layout de fatura Bradesco ainda não foi reconhecido.'],
  }
  return parseMobileAppPages(pages, fileName)
}

function parseMobileAppPages(pages: string[][], fileName: string): CardStatement {
  const pageOne = pages[0]?.join('\n') ?? ''
  let dueDate: string | null = null
  const dueLines = pageOne.split(/\r?\n/)
  const dueHeaderIndex = dueLines.findIndex((line) => /total da fatura.*vencimento/i.test(normalized(line)))
  if (dueHeaderIndex >= 0) {
    const nearby = dueLines.slice(dueHeaderIndex, dueHeaderIndex + 4).join(' ')
    const match = nearby.match(/(\d{2}\/\d{2}\/\d{4})/)
    if (match) dueDate = normalizeDate(match[1])
  }
  const nextCloseMatch = pageOne.match(/previs[aã]o de fechamento da pr[oó]xima fatura\s*:?\s*(\d{2}\/\d{2}\/\d{4})/i)
  const nextClosingDate = nextCloseMatch ? normalizeDate(nextCloseMatch[1]) : null
  const pageOneLines = pages[0] ?? []
  const purchasesDebitsTotal = amountAfterLabel(pageOneLines, /compras\s*\/\s*debitos/)
  const creditsPaymentsTotal = amountAfterLabel(pageOneLines, /creditos\s*\/\s*pagamentos/)
  const previousBalance = amountAfterLabel(pageOneLines, /saldo anterior/)

  const transactions: CardStatementTransaction[] = []
  const cardSubtotals: CardStatement['cardSubtotals'] = []
  const errors: string[] = []
  let sectionActive = false
  let activeCard = ''
  let pendingSubtotalCard = ''
  let previousPayment: number | null = null
  let reportedTotal: number | null = null
  let purchaseId = 0
  for (const page of pages) {
    for (const rawLine of page) {
      const line = rawLine.trim()
      if (/^lan[cç]amentos\b/i.test(normalized(line))) { sectionActive = true; continue }
      if (/^(?:limites?\b|opcoes de pagamento\b|opcoes de parcelamento\b|parcelado facil\b|parcelamento da fatura\b|pagamento minimo\b|parcelas futuras\b|total parcelado\b|juros\b|taxas?\b|cet\b|iof\b|programa de pontos\b|fidelidade\b|informacoes legais\b)/i.test(normalized(line))) { sectionActive = false; activeCard = ''; pendingSubtotalCard = ''; continue }
      const card = cardId(line)
      if (card) { activeCard = card; pendingSubtotalCard = ''; continue }
      if (!sectionActive) continue
      if (/\b(?:pagto\.?|pagamento da fatura|pagto por deb)\b/i.test(normalized(line))) {
        previousPayment = Math.abs(moneyFromLine(line) ?? 0) || previousPayment
        continue
      }
      if (/total para/i.test(normalized(line)) && activeCard) {
        const subtotal = moneyFromLine(line)
        if (subtotal != null) cardSubtotals.push({ cardIdentifier: activeCard, amount: subtotal })
        else pendingSubtotalCard = activeCard
        continue
      }
      if (pendingSubtotalCard && !/^\d{2}\/\d{2}/.test(line)) {
        const subtotal = moneyFromLine(line)
        if (subtotal != null) { cardSubtotals.push({ cardIdentifier: pendingSubtotalCard, amount: subtotal }); pendingSubtotalCard = '' }
        continue
      }
      if (/total da fatura em real/i.test(normalized(line))) {
        reportedTotal = moneyFromLine(line)
        continue
      }
      if (!activeCard || !/^\s*\d{2}\/\d{2}(?:\/\d{4})?\b/.test(line)) continue
      const transaction = parsePurchaseRow(line, activeCard, dueDate, ++purchaseId)
      if (transaction) transactions.push(transaction)
    }
  }
  if (reportedTotal == null) reportedTotal = amountAfterLabel(pages.flat(), /total da fatura em real/)
  const statementIdentity = `statement-${stableFingerprint([dueDate ?? '', reportedTotal == null ? '' : String(reportedTotal), ...[...new Set(transactions.map((item) => item.cardIdentifier))].sort()])}`
  transactions.forEach((transaction) => {
    transaction.statementTotal = reportedTotal
    transaction.id = `card-${statementIdentity}-${stableFingerprint([transaction.cardIdentifier, transaction.date, transaction.originalDescription, transaction.amount, transaction.direction, transaction.installment, transaction.totalInstallments])}`
  })
  // Pair only strong, one-to-one refund evidence: same card, date, amount, and normalized merchant.
  const pairedRefunds = new Set<string>()
  for (const purchase of transactions.filter((item) => item.type === 'PURCHASE')) {
    const refund = transactions.find((item) => item.type === 'REFUND' && !pairedRefunds.has(item.id)
      && item.cardIdentifier === purchase.cardIdentifier && item.date === purchase.date && item.amount === purchase.amount
      && normalizeDescription(item.originalDescription) === normalizeDescription(purchase.originalDescription))
    if (refund) {
      purchase.financialStatus = 'REFUNDED'
      pairedRefunds.add(refund.id)
    }
  }
  for (const subtotal of cardSubtotals) {
    const actual = transactions.filter((transaction) => transaction.cardIdentifier === subtotal.cardIdentifier).reduce((sum, transaction) => sum + (transaction.direction === 'DEBIT' ? transaction.amount : -transaction.amount), 0)
    if (actual !== subtotal.amount) errors.push(`Divergência entre lançamentos extraídos e subtotal informado para o cartão final ${subtotal.cardIdentifier.slice(-4)}.`)
  }
  const purchaseTransactions = transactions.filter((transaction) => transaction.type === 'PURCHASE')
  const purchaseTotal = purchaseTransactions.reduce((sum, transaction) => sum + transaction.amount, 0)
  if (purchasesDebitsTotal != null && purchaseTotal !== purchasesDebitsTotal) errors.push('Divergência entre compras extraídas e total de Compras/Débitos informado pela fatura.')
  const refundsTotal = transactions.filter((transaction) => transaction.type === 'REFUND').reduce((sum, transaction) => sum + transaction.amount, 0)
  if (creditsPaymentsTotal != null && previousPayment != null && previousBalance != null && refundsTotal + previousPayment > creditsPaymentsTotal) errors.push('Os créditos/estornos e o pagamento identificado excedem o total de Créditos/Pagamentos informado pela fatura.')
  const accountingDifference = previousBalance != null && creditsPaymentsTotal != null && purchasesDebitsTotal != null && reportedTotal != null
    ? previousBalance - creditsPaymentsTotal + purchasesDebitsTotal - reportedTotal
    : null
  if (accountingDifference != null && accountingDifference !== 0) errors.push('A relação entre saldo anterior, créditos/pagamentos, compras/débitos e total da fatura não fecha.')
  if (!purchaseTransactions.length) errors.push('Não foi possível localizar compras na seção Lançamentos da fatura.')
  if (reportedTotal == null) errors.push('Total informado da fatura não encontrado; confira o PDF antes de conciliar.')
  return { fileName, sourceLayout: 'MOBILE_APP', pageCount: pages.length, statementIdentity, transactions, cardSubtotals, reportedTotal, purchasesDebitsTotal, creditsPaymentsTotal, previousBalance, previousPayment, accountingDifference, dueDate, nextClosingDate, errors: [...new Set(errors)] }
}

function groupPageText(items: PdfTextItem[], pageWidth: number): string[] {
  const positioned = items.filter((item) => item.str?.trim()).map((item) => ({
    text: item.str!.trim(), x: item.transform?.[4] ?? 0, y: item.transform?.[5] ?? 0, width: item.width ?? 0,
  })).sort((a, b) => b.y - a.y || a.x - b.x)
  const rows: typeof positioned[] = []
  for (const item of positioned) {
    let row = rows.find((candidate) => Math.abs(candidate[0].y - item.y) <= 2.5)
    if (!row) { row = []; rows.push(row) }
    row.push(item)
  }
  rows.sort((a, b) => b[0].y - a[0].y)
  let tableAnchors: number[] = []
  const result: string[] = []
  for (const row of rows) {
    row.sort((a, b) => a.x - b.x)
    const rowText = row.map((item) => item.text).join(' ')
    if (/\bData\b/i.test(rowText) && /Hist[oó]rico de Lan[cç]amentos/i.test(normalized(rowText)) && /Cidade/i.test(rowText)) {
      const findX = (pattern: RegExp) => row.find((item) => pattern.test(normalized(item.text)))?.x
      const anchors = [findX(/^data$/), findX(/^hist[oó]rico/), findX(/^cidade$/), findX(/^us\$/), findX(/^cota[cç][aã]o/), findX(/^r\$$/)].filter((value): value is number => value != null)
      if (anchors.length >= 4) tableAnchors = anchors
    }
    if (tableAnchors.length) {
      const cells = Array.from({ length: tableAnchors.length }, () => [] as string[])
      for (const item of row.filter((entry) => entry.x <= pageWidth * 0.62)) {
        let column = 0
        for (let index = 1; index < tableAnchors.length; index += 1) if (item.x >= tableAnchors[index] - 3) column = index
        cells[column].push(item.text)
      }
      result.push(cells.map((cell) => cell.join(' ')).join(' | '))
    } else result.push(rowText)
  }
  return result
}

export async function readCardStatementPdf(file: File, workerSource?: string): Promise<CardStatement> {
  const [{ getDocument, GlobalWorkerOptions }, workerUrl] = await Promise.all([
    import('pdfjs-dist/legacy/build/pdf.mjs'), import('pdfjs-dist/build/pdf.worker.min.mjs?url'),
  ])
  GlobalWorkerOptions.workerSrc = workerSource ?? workerUrl.default
  const task = getDocument({ data: new Uint8Array(await file.arrayBuffer()) })
  const pdf = await task.promise
  const pages: string[][] = []
  for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
    const page = await pdf.getPage(pageNumber) as unknown as PdfPage
    const pageWidth = page.getViewport({ scale: 1 }).width
    const content = await page.getTextContent({ includeMarkedContent: false })
    pages.push(groupPageText(content.items, pageWidth))
  }
  return parseCardStatementPages(pages, file.name)
}

export function identifyStatementPayment(statement: CardStatement, banks: BankTransaction[]): BankTransaction | null {
  if (statement.reportedTotal == null || !statement.dueDate) return null
  const candidates = banks.filter((bank) => bank.type === 'CARD_PAYMENT'
    && Math.abs(bank.amount - statement.reportedTotal!) <= 1
    && dayDistance(bank.date, statement.dueDate!) <= 7)
  return [...candidates].sort((a, b) => dayDistance(a.date, statement.dueDate!) - dayDistance(b.date, statement.dueDate!)
    || Math.abs(a.amount - statement.reportedTotal!) - Math.abs(b.amount - statement.reportedTotal!)
    || a.date.localeCompare(b.date))[0] ?? null
}

export function identifyStatementPayments(statements: CardStatement[], banks: BankTransaction[]): Map<CardStatement, BankTransaction> {
  const proposals = statements.map((statement) => {
    const candidates = statement.reportedTotal == null || !statement.dueDate ? [] : banks.filter((bank) => bank.type === 'CARD_PAYMENT'
      && Math.abs(bank.amount - statement.reportedTotal!) <= 1 && dayDistance(bank.date, statement.dueDate!) <= 7)
      .sort((a, b) => dayDistance(a.date, statement.dueDate!) - dayDistance(b.date, statement.dueDate!)
        || Math.abs(a.amount - statement.reportedTotal!) - Math.abs(b.amount - statement.reportedTotal!) || a.date.localeCompare(b.date))
    return { statement, candidates }
  }).sort((a, b) => a.candidates.length - b.candidates.length
    || (a.statement.dueDate ?? '').localeCompare(b.statement.dueDate ?? '')
    || a.statement.statementIdentity.localeCompare(b.statement.statementIdentity))
  const usedBankIds = new Set<string>()
  const linked = new Map<CardStatement, BankTransaction>()
  for (const { statement, candidates } of proposals) {
    const payment = candidates.find((candidate) => !usedBankIds.has(candidate.id))
    if (!payment) continue
    linked.set(statement, payment)
    usedBankIds.add(payment.id)
  }
  return linked
}

function dayDistance(a: string, b: string) {
  return Math.abs(Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 86_400_000
}

function installmentInfo(item: LedgerTransaction): { installment: number; total: number; description: string } | null {
  const marker = item.originalDescription.match(/^\s*\((\d{1,2})\s*\/\s*(\d{1,2})\)\s*/)
  const installment = item.installment ?? (marker ? Number(marker[1]) : null)
  const total = item.totalInstallments ?? (marker ? Number(marker[2]) : null)
  if (!installment || !total) return null
  return {
    installment,
    total,
    description: item.originalDescription.replace(/^\s*\(\s*\d{1,2}\s*\/\s*\d{1,2}\s*\)\s*/, '').trim(),
  }
}

function installmentDescriptionSimilarity(left: string, right: string): number {
  const a = normalizeDescription(left).split(' ').filter((token) => token.length > 1)
  const b = normalizeDescription(right).split(' ').filter((token) => token.length > 1)
  if (!a.length || !b.length) return 0
  const matched = new Set<number>()
  let overlap = 0
  for (const token of a) {
    const index = b.findIndex((candidate, candidateIndex) => !matched.has(candidateIndex)
      && (candidate === token || (Math.min(candidate.length, token.length) >= 2 && (candidate.startsWith(token) || token.startsWith(candidate)))))
    if (index >= 0) { matched.add(index); overlap += 1 }
  }
  return Math.max((2 * overlap) / (a.length + b.length), (overlap / Math.min(a.length, b.length)) * 0.92)
}

function hasInstallmentSequence(candidate: LedgerTransaction, rows: LedgerTransaction[]): boolean {
  const current = installmentInfo(candidate)
  if (!current) return false
  const currentMonth = Number(candidate.date.slice(0, 4)) * 12 + Number(candidate.date.slice(5, 7))
  return rows.some((previous) => {
    if (previous.id === candidate.id || previous.amount !== candidate.amount || previous.type !== 'EXPENSE'
      || normalizeDescription(previous.paymentMethod) !== 'credito bradesco') return false
    const info = installmentInfo(previous)
    const month = Number(previous.date.slice(0, 4)) * 12 + Number(previous.date.slice(5, 7))
    return Boolean(info && Math.abs(info.installment - current.installment) === 1 && info.total === current.total
      && Math.abs(month - currentMonth) === 1
      && installmentDescriptionSimilarity(current.description, info.description) >= 0.45)
  })
}

function isCardCostRow(item: LedgerTransaction) {
  return item.direction === 'DEBIT'
    && normalizeDescription(item.paymentMethod) === 'credito bradesco'
    && !['INVESTMENT', 'INVESTMENT_INCOME', 'INCOME', 'TRANSFER', 'CARD_PAYMENT'].includes(item.type)
}

/** Shared candidate search used by reconciliation and the pre-write guard. */
export function findExistingCostYearCandidates(statement: CardStatement, transaction: CardStatementTransaction, sheet: LedgerTransaction[]): LedgerTransaction[] {
  if (transaction.type !== 'PURCHASE' || transaction.financialStatus === 'REFUNDED') return []
  const eligible = sheet.filter(isCardCostRow)
  const isInstallment = transaction.installment != null && transaction.totalInstallments != null
  const purchaseDate = transaction.purchaseDate || transaction.date
  const invoiceDueDate = transaction.invoiceDueDate ?? transaction.statementDueDate ?? statement.dueDate
  const installmentCandidate = (item: LedgerTransaction) => {
    if (!isInstallment || item.amount !== transaction.amount) return false
    const info = installmentInfo(item)
    if (!info || info.installment !== transaction.installment || info.total !== transaction.totalInstallments) return false
    const dueDateMatch = Boolean(invoiceDueDate && item.date === invoiceDueDate)
    const descriptionMatch = installmentDescriptionSimilarity(transaction.originalDescription, info.description) >= 0.35
    const sequenceMatch = hasInstallmentSequence(item, eligible)
    return dueDateMatch || descriptionMatch || sequenceMatch
  }
  const nonInstallmentCandidate = (item: LedgerTransaction) => {
    if (isInstallment || item.amount !== transaction.amount) return false
    if (invoiceDueDate && item.date === invoiceDueDate) return true
    // Historical sheets may use the purchase date. Keep nearby rows reviewable,
    // but never let a recurring merchant name pull in arbitrary older cycles.
    return dayDistance(item.date, purchaseDate) <= 7
  }
  const candidates = eligible.filter(isInstallment ? installmentCandidate : nonInstallmentCandidate)
  if (!isInstallment && invoiceDueDate) {
    const invoiceCycleCandidates = candidates.filter((item) => item.date === invoiceDueDate)
    if (invoiceCycleCandidates.length) return invoiceCycleCandidates
  }
  return candidates.sort((a, b) => isInstallment
    ? installmentDescriptionSimilarity(transaction.originalDescription, installmentInfo(b)?.description ?? b.originalDescription) - installmentDescriptionSimilarity(transaction.originalDescription, installmentInfo(a)?.description ?? a.originalDescription)
      || Number(hasInstallmentSequence(b, eligible)) - Number(hasInstallmentSequence(a, eligible))
    : Number(b.date === invoiceDueDate) - Number(a.date === invoiceDueDate)
      || dayDistance(a.date, purchaseDate) - dayDistance(b.date, purchaseDate)
      || descriptionSimilarity(transaction.originalDescription, b.originalDescription) - descriptionSimilarity(transaction.originalDescription, a.originalDescription))
}

/** Explains the exact shared candidate-search gate for the consistency auditor. */
export function explainCostYearCandidateRejection(statement: CardStatement, transaction: CardStatementTransaction, row: LedgerTransaction, rows: LedgerTransaction[]): string | null {
  if (transaction.type !== 'PURCHASE') return 'a movimentação do PDF não está classificada como compra'
  if (transaction.financialStatus === 'REFUNDED') return 'compra integralmente estornada; excluída da conciliação de ausentes'
  if (row.direction !== 'DEBIT') return `direção ${row.direction}; compra de cartão exige saída (DEBIT)`
  if (normalizeDescription(row.paymentMethod) !== 'credito bradesco') return `Forma de pagamento “${row.paymentMethod || 'não informada'}”; exige Crédito_Bradesco`
  if (['INVESTMENT', 'INVESTMENT_INCOME', 'INCOME', 'TRANSFER', 'CARD_PAYMENT'].includes(row.type)) return `natureza ${row.type}; excluída do conjunto de compras`
  if (row.amount !== transaction.amount) return `valor diferente: planilha ${row.amount} centavos, PDF ${transaction.amount} centavos`

  const isInstallment = transaction.installment != null && transaction.totalInstallments != null
  const invoiceDueDate = transaction.invoiceDueDate ?? transaction.statementDueDate ?? statement.dueDate
  const purchaseDate = transaction.purchaseDate || transaction.date
  if (isInstallment) {
    const info = installmentInfo(row)
    if (!info) return 'linha da planilha não contém parcela N/TOTAL reconhecível'
    if (info.installment !== transaction.installment || info.total !== transaction.totalInstallments) return `parcela incompatível: planilha ${info.installment}/${info.total}, PDF ${transaction.installment}/${transaction.totalInstallments}`
    if (invoiceDueDate && row.date === invoiceDueDate) return null
    const similarity = installmentDescriptionSimilarity(transaction.originalDescription, info.description)
    if (similarity >= 0.35) return null
    if (hasInstallmentSequence(row, rows)) return null
    return `parcela corresponde, mas não há vencimento igual (${invoiceDueDate ?? 'não informado'}), descrição-base suficiente (similaridade ${similarity.toFixed(2)}; mínimo 0,35) nem sequência mensal coerente`
  }
  if (invoiceDueDate && row.date === invoiceDueDate) return null
  const days = dayDistance(row.date, purchaseDate)
  if (days <= 7) return null
  return `data fora da tolerância: planilha ${row.date}, vencimento ${invoiceDueDate ?? 'não informado'}, compra ${purchaseDate}; distância de ${days} dias (máximo 7 dias da compra histórica)`
}

export function reconcileCardStatement(statement: CardStatement, sheet: LedgerTransaction[], confirmedMatches: Map<string, string> = new Map(), rejectedCandidates: Map<string, ReadonlySet<string>> = new Map()): CardStatementReconciliation {
  const purchases = statement.transactions.filter((transaction) => transaction.type === 'PURCHASE' && transaction.financialStatus !== 'REFUNDED')
  // Google Sheets descriptions are user-authored and may not have been classified
  // as EXPENSE by the bank-oriented classifier. Keep the payment method as the
  // primary scope, while explicitly excluding natures that cannot be purchases.
  const eligible = sheet.filter(isCardCostRow)
  const isInstallment = (transaction: CardStatementTransaction) => transaction.installment != null && transaction.totalInstallments != null
  const invoiceDueDate = (transaction: CardStatementTransaction) => transaction.invoiceDueDate ?? transaction.statementDueDate ?? statement.dueDate
  const purchaseDate = (transaction: CardStatementTransaction) => transaction.purchaseDate || transaction.date
  const candidateSearch = (transaction: CardStatementTransaction, rows: LedgerTransaction[]) => {
    const rejected = rejectedCandidates.get(transaction.id)
    return findExistingCostYearCandidates(statement, transaction, rows).filter((row) => !rejected?.has(row.id))
  }
  const confirmedSheetIds = new Set<string>()
  const validConfirmed = new Map<string, LedgerTransaction>()
  for (const transaction of purchases) {
    const sheetId = confirmedMatches.get(transaction.id)
    const match = candidateSearch(transaction, eligible).find((item) => item.id === sheetId)
    if (match && !confirmedSheetIds.has(match.id)) { validConfirmed.set(transaction.id, match); confirmedSheetIds.add(match.id) }
  }
  const candidateSets = purchases.map((transaction) => {
    const available = eligible.filter((item) => !confirmedSheetIds.has(item.id) || validConfirmed.get(transaction.id)?.id === item.id)
    const sorted = candidateSearch(transaction, available)
    return { transaction, sorted, sequenceFound: isInstallment(transaction) && sorted.some((item) => hasInstallmentSequence(item, eligible)) }
  })
  const usageCounts = new Map<string, number>()
  candidateSets.forEach(({ sorted }) => sorted.forEach((candidate) => usageCounts.set(candidate.id, (usageCounts.get(candidate.id) ?? 0) + 1)))
  const groupMatches = new Map<string, LedgerTransaction[]>()
  const grouped = new Set<string>()
  for (const seed of candidateSets) {
    if (grouped.has(seed.transaction.id) || isInstallment(seed.transaction) || seed.sorted.length < 2 || validConfirmed.has(seed.transaction.id)) continue
    const dueDate = invoiceDueDate(seed.transaction)
    const peers = candidateSets.filter((item) => !grouped.has(item.transaction.id) && !isInstallment(item.transaction)
      && !validConfirmed.has(item.transaction.id) && item.transaction.amount === seed.transaction.amount
      && invoiceDueDate(item.transaction) === dueDate && dueDate != null
      && descriptionSimilarity(seed.transaction.originalDescription, item.transaction.originalDescription) >= 0.35)
    if (peers.length < 2) continue
    const peerIds = new Set(peers.map((item) => item.transaction.id))
    const candidateIds = new Set(peers.flatMap((item) => item.sorted.map((candidate) => candidate.id)))
    if (candidateIds.size !== peers.length || peers.some((item) => item.sorted.length !== candidateIds.size
      || item.sorted.some((candidate) => !candidateIds.has(candidate.id)))) continue
    const competingPurchase = candidateSets.some((item) => !peerIds.has(item.transaction.id)
      && item.sorted.some((candidate) => candidateIds.has(candidate.id)))
    if (competingPurchase) continue
    const rows = eligible.filter((item) => candidateIds.has(item.id))
    if (rows.length !== peers.length) continue
    peers.forEach((item) => { grouped.add(item.transaction.id); groupMatches.set(item.transaction.id, rows) })
  }
  const matches: CardStatementMatch[] = statement.transactions.filter((transaction) => transaction.type === 'PURCHASE').map((transaction) => {
    if (transaction.financialStatus === 'REFUNDED') return { transaction, status: 'CARD_REFUNDED', sheet: null, candidates: [] }
    const { sorted, sequenceFound } = candidateSets.find((set) => set.transaction.id === transaction.id)!
    const group = groupMatches.get(transaction.id)
    const confirmed = validConfirmed.get(transaction.id)
    const evidence = isInstallment(transaction) ? [
      'Valor exato',
      `Parcela ${transaction.installment}/${transaction.totalInstallments}`,
      'Crédito_Bradesco',
      'Descrição compatível',
      ...(sequenceFound ? ['Sequência de parcelas encontrada'] : []),
    ] : sorted.length ? [
      'Valor exato',
      'Crédito_Bradesco',
      ...(descriptionSimilarity(transaction.originalDescription, sorted[0].originalDescription) >= 0.35 ? ['Descrição compatível'] : []),
      ...(sorted[0].date === invoiceDueDate(transaction) ? ['Data da planilha igual ao vencimento da fatura'] : dayDistance(sorted[0].date, purchaseDate(transaction)) <= 7 ? ['Data próxima à compra (registro histórico)'] : ['Descrição e valor indicam linha editada; data requer revisão']),
      ...(sorted.length === 1 && sorted[0].date === invoiceDueDate(transaction) ? ['Candidato único por valor, vencimento e Crédito_Bradesco'] : []),
    ] : undefined
    if (group) return { transaction, status: 'CARD_GROUP_MATCHED', sheet: null, candidates: group, evidence: ['Valor exato', 'Crédito_Bradesco', 'Vencimento da fatura', 'Grupo conciliado pela mesma quantidade de lançamentos'] }
    if (confirmed) return { transaction, status: 'CARD_MATCHED', sheet: confirmed, candidates: [confirmed], evidence }
    if (!sorted.length) return { transaction, status: 'CARD_MISSING', sheet: null, candidates: [] }
    const unique = sorted.length === 1 && (usageCounts.get(sorted[0].id) ?? 0) === 1
    if (isInstallment(transaction)) return unique
      ? { transaction, status: 'CARD_MATCHED', sheet: sorted[0], candidates: sorted, evidence }
      : { transaction, status: 'CARD_REVIEW', sheet: null, candidates: sorted, evidence }
    const dueDateMatch = Boolean(invoiceDueDate(transaction) && sorted[0].date === invoiceDueDate(transaction))
    if (unique && dueDateMatch) return { transaction, status: 'CARD_MATCHED', sheet: sorted[0], candidates: sorted, evidence }
    const dueDate = invoiceDueDate(transaction)
    const dateMatchesPurchase = sorted[0].date === purchaseDate(transaction)
      || dayDistance(sorted[0].date, purchaseDate(transaction)) <= 3
        && !(dueDate && isPreviousInvoiceCycleDate(sorted[0].date, dueDate))
    if (unique && dateMatchesPurchase && descriptionSimilarity(transaction.originalDescription, sorted[0].originalDescription) >= 0.35) return { transaction, status: 'CARD_MATCHED', sheet: sorted[0], candidates: sorted, evidence }
    return { transaction, status: 'CARD_REVIEW', sheet: null, candidates: sorted }
  })
  const matchedSheetIds = new Set(matches.flatMap((match) => match.status === 'CARD_MATCHED' && match.sheet ? [match.sheet.id] : match.status === 'CARD_GROUP_MATCHED' ? match.candidates.map((item) => item.id) : []))
  const matchedSheetTotal = eligible.filter((item) => matchedSheetIds.has(item.id)).reduce((sum, item) => sum + item.amount, 0)
  const statementTotal = purchases.reduce((sum, transaction) => sum + transaction.amount, 0)
  return { matches, eligibleSheetTotal: matchedSheetTotal, statementTotal, difference: statementTotal - matchedSheetTotal }
}

function isPreviousInvoiceCycleDate(sheetDate: string, invoiceDueDate: string): boolean {
  const sheetMonth = Number(sheetDate.slice(0, 4)) * 12 + Number(sheetDate.slice(5, 7))
  const dueMonth = Number(invoiceDueDate.slice(0, 4)) * 12 + Number(invoiceDueDate.slice(5, 7))
  const dayDifference = Math.abs(Number(sheetDate.slice(8, 10)) - Number(invoiceDueDate.slice(8, 10)))
  return dueMonth - sheetMonth === 1 && dayDifference <= 3
}

/** Apply persisted ignore/global-consumption state after candidate assignment. */
export function deriveCardPurchaseStatus(match: CardStatementMatch, options: { ignored?: boolean; consumedSheetIds?: ReadonlySet<string> } = {}): CardStatementMatch {
  if (options.ignored && match.status === 'CARD_MISSING') return { ...match, status: 'CARD_IGNORED', sheet: null, candidates: [] }
  const used = options.consumedSheetIds
  if (!used?.size) return match
  if (match.status === 'CARD_MATCHED' && match.sheet && used.has(match.sheet.id)) {
    return { ...match, status: 'CARD_REVIEW', sheet: null, candidates: [match.sheet], evidence: [...(match.evidence ?? []), 'Candidato já atribuído a outra compra; requer revisão'] }
  }
  if (match.status === 'CARD_GROUP_MATCHED' && match.candidates.some((row) => used.has(row.id))) {
    return { ...match, status: 'CARD_REVIEW', sheet: null, candidates: match.candidates, evidence: [...(match.evidence ?? []), 'Parte do grupo já foi atribuída a outra compra; requer revisão'] }
  }
  return match
}
