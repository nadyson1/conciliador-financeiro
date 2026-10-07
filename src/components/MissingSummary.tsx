import type { ReconciliationItem } from '../domain/types'
import { summarizeMissingExpenses } from '../domain/bankBalanceAudit'

const currency = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' })

export function MissingSummary({ items }: { items: ReconciliationItem[] }) {
  const summary = summarizeMissingExpenses(items)
  return <section className="missing-summary" aria-label="Resumo de despesas ausentes">
    <strong>{summary.count} {summary.count === 1 ? 'lançamento ausente' : 'lançamentos ausentes'}</strong>
    <span>Total: {currency.format(summary.total / 100)}</span>
  </section>
}
