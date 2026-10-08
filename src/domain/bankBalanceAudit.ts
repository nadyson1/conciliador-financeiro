import type { BankTransaction, ExcludedBankRow } from './types'

export interface BalanceDiscontinuity {
  sourceRow: number
  date: string
  description: string
  document: string | null
  credit: number
  debit: number
  previousBalance: number
  amount: number
  direction: BankTransaction['direction']
  previousDate: string
  expectedBalance: number
  reportedBalance: number
  difference: number
  gapDays: number
  reason?: ExcludedBankRow['reason']
  compensatedByFollowingRow: boolean
  compensationSourceRow: number | null
}

export interface BankBalanceAudit {
  initialBalance: number | null
  reportedBalance: number | null
  totalCredits: number
  totalDebits: number
  calculatedBalance: number | null
  difference: number | null
  referenceDiscrepancy: BalanceDiscontinuity | null
  movementCount: number
  excludedRows: ExcludedBankRow[]
  discontinuities: BalanceDiscontinuity[]
  isBalanced: boolean | null
}

const dayNumber = (date: string) => {
  const [year, month, day] = date.split('-').map(Number)
  return Math.floor(Date.UTC(year, month - 1, day) / 86_400_000)
}

const bankDocument = (transaction: BankTransaction) => Object.entries(transaction.original).find(([header]) => {
  const normalized = header.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
  return ['docto', 'documento', 'nsu', 'id transacao'].includes(normalized)
})?.[1]?.trim() || null

/** Confere os saldos informados pelo banco sem interferir no resultado do matching. */
export function auditBankBalance(transactions: BankTransaction[], excludedRows: ExcludedBankRow[] = []): BankBalanceAudit {
  const points = [
    ...transactions.map((transaction, sourceIndex) => ({
      date: transaction.date, sourceRow: transaction.sourceRow ?? sourceIndex, balanceAfter: transaction.balanceAfter,
      amount: transaction.amount, direction: transaction.direction, description: transaction.originalDescription,
      credit: transaction.direction === 'CREDIT' ? transaction.amount : 0,
      debit: transaction.direction === 'DEBIT' ? transaction.amount : 0,
      document: bankDocument(transaction), included: true, reason: undefined,
    })),
    ...excludedRows.filter((row) => row.date && row.balanceAfter != null && (row.reason === 'OUTSIDE_STATEMENT_PERIOD' || row.reason === 'NO_MOVEMENT' || row.reason === 'DUPLICATE_AUXILIARY'))
      .map((row) => ({
        date: row.date!, sourceRow: row.row, balanceAfter: row.balanceAfter, amount: row.amount ?? 0,
        direction: row.direction ?? 'DEBIT' as const, description: row.description, document: row.document ?? null,
        credit: row.credit ?? (row.direction === 'CREDIT' ? row.amount ?? 0 : 0),
        debit: row.debit ?? (row.direction === 'DEBIT' ? row.amount ?? 0 : 0),
        included: false, reason: row.reason,
      })),
  ].filter((point) => point.balanceAfter != null)
    .sort((a, b) => a.date.localeCompare(b.date) || a.sourceRow - b.sourceRow)
  const first = points[0]
  const finalTransaction = transactions.map((transaction, sourceIndex) => ({ transaction, sourceIndex }))
    .filter(({ transaction }) => transaction.balanceAfter != null)
    .sort((a, b) => a.transaction.date.localeCompare(b.transaction.date) || (a.transaction.sourceRow ?? a.sourceIndex) - (b.transaction.sourceRow ?? b.sourceIndex))
    .at(-1)?.transaction
  const initialBalance = first?.balanceAfter == null ? null : first.included
    ? first.balanceAfter - (first.direction === 'CREDIT' ? first.amount : -first.amount)
    : first.balanceAfter
  const totalCredits = transactions.filter((transaction) => transaction.direction === 'CREDIT').reduce((sum, transaction) => sum + transaction.amount, 0)
  const totalDebits = transactions.filter((transaction) => transaction.direction === 'DEBIT').reduce((sum, transaction) => sum + transaction.amount, 0)
  const calculatedBalance = initialBalance == null ? null : initialBalance + totalCredits - totalDebits
  const reportedBalance = finalTransaction?.balanceAfter ?? null
  const difference = reportedBalance == null || calculatedBalance == null ? null : reportedBalance - calculatedBalance

  const discontinuities: BalanceDiscontinuity[] = []
  for (let index = 1; index < points.length; index += 1) {
    const previous = points[index - 1]
    const current = points[index]
    const expectedBalance = previous.balanceAfter! + current.credit - current.debit
    const delta = current.balanceAfter! - expectedBalance
    if ((current.included || current.reason === 'NO_MOVEMENT' || current.reason === 'DUPLICATE_AUXILIARY') && delta !== 0) {
      const next = points[index + 1]
      const nextExpected = next?.balanceAfter == null ? null : current.balanceAfter! + next.credit - next.debit
      const compensatedByFollowingRow = Boolean(next && nextExpected === next.balanceAfter && next.balanceAfter === previous.balanceAfter)
      discontinuities.push({
      sourceRow: current.sourceRow,
      date: current.date,
      description: current.description,
      document: current.document,
      credit: current.credit,
      debit: current.debit,
      previousBalance: previous.balanceAfter!,
      amount: current.amount,
      direction: current.direction,
      previousDate: previous.date,
      expectedBalance,
      reportedBalance: current.balanceAfter!,
      difference: delta,
      gapDays: dayNumber(current.date) - dayNumber(previous.date),
      ...(current.reason ? { reason: current.reason } : {}),
      compensatedByFollowingRow,
      compensationSourceRow: compensatedByFollowingRow ? next!.sourceRow : null,
    })
    }
  }
  const referenceDiscrepancy = discontinuities.find((item) => item.reason === 'NO_MOVEMENT') ?? null

  return {
    initialBalance, reportedBalance, totalCredits, totalDebits, calculatedBalance, difference, referenceDiscrepancy,
    movementCount: transactions.length, excludedRows, discontinuities,
    isBalanced: difference == null ? null : difference === 0,
  }
}

export function selectMissingExpenses<T extends { status: string; bank: BankTransaction }>(items: T[]): T[] {
  return items.filter(({ status, bank }) => status === 'MISSING'
    && bank.direction === 'DEBIT'
    && bank.type === 'EXPENSE')
}

export function summarizeMissingExpenses(items: { status: string; bank: BankTransaction }[]) {
  return summarizeSelectedMissingExpenses(selectMissingExpenses(items))
}

/** Aggregates an already selected missing-expense collection without applying another eligibility filter. */
export function summarizeSelectedMissingExpenses(items: { status: string; bank: BankTransaction }[]) {
  return { count: items.length, total: items.reduce((sum, item) => sum + item.bank.amount, 0) }
}
