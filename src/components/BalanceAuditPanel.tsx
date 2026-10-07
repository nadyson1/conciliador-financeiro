import type { BankBalanceAudit } from '../domain/bankBalanceAudit'

const currency = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' })
const formatCents = (cents: number) => currency.format(cents / 100)
const dateLabel = (date: string) => {
  const [year, month, day] = date.split('-')
  return `${day}/${month}/${year}`
}
const exclusionLabel: Record<string, string> = {
  EMPTY: 'linha vazia',
  REPEATED_HEADER: 'cabeçalho repetido',
  NO_MOVEMENT: 'linha sem débito/crédito; saldo preservado como referência',
  FOOTER_OR_METADATA: 'metadado ou resumo do extrato, não uma movimentação individual',
  OUTSIDE_STATEMENT_PERIOD: 'fora do período principal; mantida apenas como referência de saldo',
}

export function BalanceAuditPanel({ audit }: { audit: BankBalanceAudit }) {
  if (audit.reportedBalance == null || audit.initialBalance == null || audit.calculatedBalance == null || audit.difference == null) return null
  const balanced = audit.isBalanced === true
  const exclusionCounts = audit.excludedRows.reduce<Record<string, number>>((counts, row) => {
    counts[row.reason] = (counts[row.reason] ?? 0) + 1
    return counts
  }, {})
  return <section className={`balance-audit ${balanced ? 'balance-audit-good' : 'balance-audit-warning'}`} aria-label="Conferência aritmética do extrato">
    <div className="balance-audit-heading">
      <strong>{balanced ? '✓ Extrato conferido' : `Diferença de conferência do extrato: ${formatCents(Math.abs(audit.difference))}`}</strong>
      <small>{balanced ? 'Saldo calculado confere com o saldo informado.' : 'Esta é uma checagem aritmética do extrato, não o total de despesas ausentes.'}</small>
    </div>
    {!balanced && <p className="balance-audit-helper">Compara o saldo final informado pelo banco com o saldo obtido ao somar as entradas e subtrair as saídas importadas.</p>}
    <details>
      <summary>Ver cálculo</summary>
      <div className="balance-equation">
        <span>Saldo inicial</span><strong>{formatCents(audit.initialBalance)}</strong>
        <span>+ Total de entradas</span><strong>{formatCents(audit.totalCredits)}</strong>
        <span>− Total de saídas</span><strong>{formatCents(audit.totalDebits)}</strong>
        <span>Saldo calculado</span><strong>{formatCents(audit.calculatedBalance)}</strong>
        <span>Saldo final informado</span><strong>{formatCents(audit.reportedBalance)}</strong>
        <span>Diferença (informado − calculado)</span><strong>{formatCents(audit.difference)}</strong>
      </div>
      <small className="balance-audit-counts">Cálculo com {audit.movementCount} {audit.movementCount === 1 ? 'movimentação válida' : 'movimentações válidas'}; {audit.excludedRows.length} {audit.excludedRows.length === 1 ? 'linha ignorada' : 'linhas ignoradas'}.</small>
      {Object.entries(exclusionCounts).length > 0 && <div className="balance-exclusions"><strong>Linhas ignoradas</strong>{Object.entries(exclusionCounts).map(([reason, count]) => <small key={reason}>{count} · {exclusionLabel[reason] ?? reason}</small>)}</div>}
      {audit.discontinuities.length > 0 && <div className="balance-discontinuities"><strong>Movimentações que podem explicar a diferença</strong>{audit.discontinuities.map((row, index) => <small key={`${row.date}-${index}`}>
        {dateLabel(row.date)} · {row.description} · {formatCents(row.amount)} ({row.direction === 'CREDIT' ? 'entrada' : 'saída'}). Saldo esperado: {formatCents(row.expectedBalance)}; informado: {formatCents(row.reportedBalance)}.{row.gapDays > 1 ? ` Intervalo de ${row.gapDays} dias desde a movimentação anterior (${dateLabel(row.previousDate)}).` : ''}
      </small>)}</div>}
      {audit.excludedRows.some((row) => row.balanceAfter != null) && <div className="balance-exclusions"><strong>Referências de saldo em linhas ignoradas</strong>{audit.excludedRows.filter((row) => row.balanceAfter != null).map((row) => <small key={row.row}>Linha {row.row}{row.date ? ` · ${dateLabel(row.date)}` : ''}{row.description ? ` · ${row.description}` : ''} · saldo {formatCents(row.balanceAfter!)}</small>)}</div>}
    </details>
  </section>
}
