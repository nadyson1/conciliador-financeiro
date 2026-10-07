import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { parseCsvText, initialColumnMap } from './csv'
import { parseBankRows } from './transactions'
import { auditBankBalance } from '../domain/bankBalanceAudit'
import { reconcile } from '../matching/reconcile'
import { BankCsvUploadCard } from '../components/BankCsvUploadCard'
import type { ColumnMap } from '../domain/types'

const bradescoExport = [
  'Data;Histórico;Docto.;Crédito (R$);Débito (R$);Saldo (R$)',
  '31/12/2025;COD. LANC. 0;0;0,00;0,00;0,00',
  '01/01/2026;PIX RECEBIDO;1;100,00;;100,00',
  '23/07/2026;COMPRA CARTAO VISA;2;;10,00;90,00',
  'Filtro de resultados - Movimentação entre: 01/01/2026 e 23/07/2026;;;;;',
  'Os dados acima tem como base 05/10/2026 às 17:39 e estão sujeitos a alterações.;;;;;',
  'Últimos Lançamentos;;;;;',
  'Data;Histórico;Docto.;Crédito (R$);Débito (R$);Saldo (R$)',
  '01/10/2026;COD. LANC. 0;0;;;1.045,72',
  '02/10/2026;PIX RECEBIDO;3;600,00;;1.645,72',
  '02/10/2026;COMPRA CARTAO VISA;4;;1.243,35;402,37',
  ';;Total;600,00;1.243,35;402,37',
].join('\n')

describe('seções do CSV Bradesco', () => {
  it('isola o período filtrado de Últimos Lançamentos, totais e sequência de saldos', () => {
    const csv = parseCsvText(bradescoExport)
    const map = initialColumnMap(csv.headers, 'bank') as ColumnMap
    const period = { start: csv.statementPeriodStart!, end: csv.statementPeriodEnd! }
    const main = parseBankRows(csv.rows, map, csv.metadataRowsIgnored, period)
    const auxiliary = parseBankRows(csv.auxiliaryRows, map)
    const audit = auditBankBalance(main.transactions, main.excludedRows)
    const result = reconcile(main.transactions, [])

    expect(csv.statementPeriodStart).toBe('2026-01-01')
    expect(csv.statementPeriodEnd).toBe('2026-07-23')
    expect(csv.auxiliarySectionLabel).toBe('Últimos Lançamentos')
    expect(main.transactions).toHaveLength(2)
    expect(main.transactions.at(-1)?.date).toBe('2026-07-23')
    expect(auxiliary.transactions).toHaveLength(2)
    expect(auxiliary.ignoredRows).toBe(3)
    expect(result.items.map((item) => item.bank.date)).toEqual(['2026-01-01', '2026-07-23'])
    expect(result.items.some((item) => item.bank.date.startsWith('2026-10'))).toBe(false)
    expect(result.items.filter((item) => item.status === 'MISSING').map((item) => item.bank.originalDescription)).toEqual(['COMPRA CARTAO VISA'])
    expect(result.totals.bankCredit).toBe(10000)
    expect(result.totals.bankDebit).toBe(1000)
    expect(audit).toMatchObject({ initialBalance: 0, totalCredits: 10000, totalDebits: 1000, calculatedBalance: 9000, reportedBalance: 9000, difference: 0, isBalanced: true })
    expect(main.excludedRows).toContainEqual(expect.objectContaining({ date: '2025-12-31', reason: 'OUTSIDE_STATEMENT_PERIOD', balanceAfter: 0 }))
    expect(audit.discontinuities).toHaveLength(0)
    expect(audit.reportedBalance).not.toBe(40237)
    expect(auxiliary.transactions.some((transaction) => transaction.originalDescription === 'Total')).toBe(false)
  })

  it('mostra o período explícito e a quantidade auxiliar ignorada na interface de importação', () => {
    const csv = parseCsvText(bradescoExport)
    const map = initialColumnMap(csv.headers, 'bank') as ColumnMap
    const main = parseBankRows(csv.rows, map, csv.metadataRowsIgnored, { start: csv.statementPeriodStart!, end: csv.statementPeriodEnd! })
    const auxiliaryTransactionCount = parseBankRows(csv.auxiliaryRows, map).transactions.length
    render(<BankCsvUploadCard
      upload={{ fileName: 'extrato-sintetico.csv', csv, map, valid: main.transactions, issues: [], rowCount: main.rowCount, ignoredRows: main.ignoredRows, auxiliaryTransactionCount }}
      accepted={false}
      onMapChange={vi.fn()}
      onAccept={vi.fn()}
      onClear={vi.fn()}
      onSelect={vi.fn()}
      fieldTitles={{ date: 'Data', description: 'Histórico', amount: 'Valor', direction: 'Direção', debit: 'Saídas', credit: 'Entradas', paymentMethod: 'Forma de pagamento', category: 'Categoria', month: 'Mês', year: 'Ano', isFixed: 'É fixo?', isEssential: 'É essencial?', id: 'Documento', balance: 'Saldo' }}
      requiredFields={['date', 'description']}
      optionalFields={['credit', 'debit', 'balance']}
    />)
    expect(screen.getByText('Período do extrato: 01/01/2026 a 23/07/2026')).toBeInTheDocument()
    expect(screen.getByText(/2 lançamentos recentes fora do período selecionado/)).toBeInTheDocument()
  })
})
