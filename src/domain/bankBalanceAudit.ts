import type { BankTransaction, ExcludedBankRow } from './types'

export interface BalanceDiscontinuity {
  date: string
  description: string
  amount: number
  direction: BankTransaction['direction']
  previousDate: string
  expectedBalance: number
  reportedBalance: number
  difference: number
  gapDays: number
}

export interface BankBalanceAudit {
  initialBalance: number | null
  reportedBalance: number | null
  totalCredits: number
  totalDebits: number
  calculatedBalance: number | null
  difference: number | null
  movementCount: number
  excludedRows: ExcludedBankRow[]
  discontinuities: BalanceDiscontinuity[]
  isBalanced: boolean | null
}

const dayNumber = (date: string) => {
  const [year, month, day] = date.split('-').map(Number)
  return Math.floor(Date.UTC(year, month - 1, day) / 86_400_000)
}

/** Confere os saldos informados pelo banco sem interferir no resultado do matching. */
export function auditBankBalance(transactions: BankTransaction[], excludedRows: ExcludedBankRow[] = []): BankBalanceAudit {
  const points = [
    ...transactions.map((transaction, sourceIndex) => ({
      date: transaction.date, sourceRow: transaction.sourceRow ?? sourceIndex, balanceAfter: transaction.balanceAfter,
      amount: transaction.amount, direction: transaction.direction, description: transaction.originalDescription,
      included: true, reason: undefined,
    })),
    ...excludedRows.filter((row) => row.date && row.balanceAfter != null && (row.reason === 'OUTSIDE_STATEMENT_PERIOD' || row.reason === 'NO_MOVEMENT'))
      .map((row) => ({
        date: row.date!, sourceRow: row.row, balanceAfter: row.balanceAfter, amount: row.amount ?? 0,
        direction: row.direction ?? 'DEBIT' as const, description: row.description, included: false, reason: row.reason,
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
    const expectedBalance = previous.balanceAfter! + (current.direction === 'CREDIT' ? current.amount : -current.amount)
    const delta = current.balanceAfter! - expectedBalance
    if ((current.included || current.reason === 'NO_MOVEMENT') && delta !== 0) discontinuities.push({
      date: current.date,
      description: current.description,
      amount: current.amount,
      direction: current.direction,
      previousDate: previous.date,
      expectedBalance,
      reportedBalance: current.balanceAfter!,
      difference: delta,
      gapDays: dayNumber(current.date) - dayNumber(previous.date),
    })
  }

  return {
    initialBalance, reportedBalance, totalCredits, totalDebits, calculatedBalance, difference,
    movementCount: transactions.length, excludedRows, discontinuities,
    isBalanced: difference == null ? null : difference === 0,
  }
}

export function summarizeMissingExpenses(items: { status: string; bank: BankTransaction }[]) {
  const eligible = items.filter(({ status, bank }) => status === 'MISSING'
    && bank.direction === 'DEBIT'
    && (bank.type === 'EXPENSE' || bank.type === 'OTHER'))
  return { count: eligible.length, total: eligible.reduce((sum, item) => sum + item.bank.amount, 0) }
}
