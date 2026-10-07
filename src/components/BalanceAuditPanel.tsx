import { useState } from 'react'
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
  DUPLICATE_AUXILIARY: 'repetida em Últimos Lançamentos; já existe no bloco principal',
}

export function balanceAuditHeadline(audit: BankBalanceAudit) {
  if (audit.difference == null || audit.isBalanced == null) return '◌ Conferência incompleta'
  if (audit.isBalanced && audit.difference === 0) return '✓ Extrato conferido'
  return `⚠ Diferença de ${formatCents(Math.abs(audit.difference))}`
}

const shortCsvName = (fileName: string) => `${(fileName.trim().replace(/\.csv$/i, '') || 'extrato').slice(0, 5)}....csv`

export function StatementBalanceAccordion({ fileName, audit }: { fileName: string; audit: BankBalanceAudit }) {
  const [expanded, setExpanded] = useState(false)
  const headline = balanceAuditHeadline(audit)
  return <details className="statement-balance-audit" onToggle={(event) => setExpanded(event.currentTarget.open)}>
    <summary aria-expanded={expanded} aria-label={`${shortCsvName(fileName)} · ${headline}`}>
      <span className="statement-balance-chevron" aria-hidden="true">{expanded ? '▾' : '▸'}</span>
      <span className="statement-balance-name" title={fileName}>{shortCsvName(fileName)}</span>
      <span className={`statement-balance-status ${audit.isBalanced && audit.difference === 0 ? 'is-confirmed' : audit.difference == null ? 'is-incomplete' : 'is-warning'}`}>{headline}</span>
    </summary>
    <BalanceAuditPanel audit={audit}/>
  </details>
}

export function BalanceAuditPanel({ audit }: { audit: BankBalanceAudit }) {
  if (audit.reportedBalance == null || audit.initialBalance == null || audit.calculatedBalance == null || audit.difference == null) return null
  const referenceDiscrepancy = audit.referenceDiscrepancy
  const balanced = audit.isBalanced === true && audit.difference === 0
  const exclusionCounts = audit.excludedRows.reduce<Record<string, number>>((counts, row) => {
    counts[row.reason] = (counts[row.reason] ?? 0) + 1
    return counts
  }, {})
  return <section className={`balance-audit ${balanced ? 'balance-audit-good' : 'balance-audit-warning'}`} aria-label="Conferência aritmética do extrato">
    <div className="balance-audit-heading">
      <strong>{balanceAuditHeadline(audit)}</strong>
      <small>{balanced ? 'Saldo calculado confere com o saldo informado.' : 'Esta conferência usa apenas o extrato bancário e é independente da CUSTOS ANO e da lista de Ausentes.'}</small>
    </div>
    {referenceDiscrepancy && <p className="balance-audit-aux-note">Referência auxiliar do CSV diverge {formatCents(Math.abs(referenceDiscrepancy.difference))}. O arquivo apresenta essa alteração sem lançamento financeiro correspondente; ela não altera o status principal quando a soma das movimentações fecha.</p>}
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
      {referenceDiscrepancy && <div className="balance-discontinuities"><strong>Primeira divergência da cadeia de saldos</strong><small>
        Linha {referenceDiscrepancy.sourceRow} · {dateLabel(referenceDiscrepancy.date)} · {referenceDiscrepancy.description} · documento {referenceDiscrepancy.document ?? 'não informado'}.
        Crédito: {formatCents(referenceDiscrepancy.credit)}; débito: {formatCents(referenceDiscrepancy.debit)}; saldo anterior: {formatCents(referenceDiscrepancy.previousBalance)}; esperado: {formatCents(referenceDiscrepancy.expectedBalance)}; informado: {formatCents(referenceDiscrepancy.reportedBalance)}; diferença: {formatCents(referenceDiscrepancy.difference)}.
        {referenceDiscrepancy.compensatedByFollowingRow ? `A diferença desaparece na linha ${referenceDiscrepancy.compensationSourceRow}, sem alterar o saldo final da sequência.` : 'A diferença continua após esta linha.'}
      </small></div>}
      {audit.discontinuities.length > 0 && <div className="balance-discontinuities"><strong>Outras transições de saldo incompatíveis</strong>{audit.discontinuities.filter((row) => row !== referenceDiscrepancy).map((row, index) => <small key={`${row.date}-${index}`}>
        Linha {row.sourceRow} · {dateLabel(row.date)} · {row.description} · documento {row.document ?? 'não informado'}; crédito {formatCents(row.credit)}; débito {formatCents(row.debit)}; saldo anterior {formatCents(row.previousBalance)}; esperado {formatCents(row.expectedBalance)}; informado {formatCents(row.reportedBalance)}; diferença {formatCents(row.difference)}.{row.compensatedByFollowingRow ? ` Diferença compensada na linha ${row.compensationSourceRow}.` : ''}{row.gapDays > 1 ? ` Intervalo de ${row.gapDays} dias desde a linha anterior (${dateLabel(row.previousDate)}).` : ''}
      </small>)}</div>}
      {audit.excludedRows.length > 0 && <div className="balance-exclusions"><strong>Linhas ignoradas e excluídas</strong>{audit.excludedRows.map((row) => <small key={row.row}>Linha {row.row}{row.date ? ` · ${dateLabel(row.date)}` : ''}{row.description ? ` · ${row.description}` : ''}{row.document ? ` · documento ${row.document}` : ''} · crédito {formatCents(row.credit ?? (row.direction === 'CREDIT' ? row.amount ?? 0 : 0))}; débito {formatCents(row.debit ?? (row.direction === 'DEBIT' ? row.amount ?? 0 : 0))}{row.balanceAfter != null ? `; saldo ${formatCents(row.balanceAfter)}` : ''} · {exclusionLabel[row.reason] ?? row.reason}</small>)}</div>}
    </details>
  </section>
}
