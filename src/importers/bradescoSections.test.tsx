import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import { parseCsvText, initialColumnMap } from './csv'
import { parseBankCsvSections, parseBankRows } from './transactions'
import { auditBankBalance, summarizeMissingExpenses } from '../domain/bankBalanceAudit'
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

  it('incorpora Últimos Lançamentos no período, deduplica e atualiza o saldo usando fixture sanitizada', () => {
    const fixture = readFileSync(`${process.cwd()}/src/importers/fixtures/bradesco-refund-sanitized.csv`, 'utf8')
    const csv = parseCsvText(fixture)
    const map = initialColumnMap(csv.headers, 'bank') as ColumnMap
    const parsed = parseBankCsvSections(csv, map)
    const refund = parsed.transactions.find((item) => item.originalDescription === 'DEVOLUCAO PIX')
    const audit = auditBankBalance(parsed.transactions, parsed.excludedRows)
    const result = reconcile(parsed.transactions, [])

    expect(csv.statementPeriodStart).toBe('2026-09-01')
    expect(csv.statementPeriodEnd).toBe('2026-10-07')
    expect(parsed.transactions.filter((item) => item.bankTransactionId === 'doc:DOC-C')).toHaveLength(1)
    expect(parsed.transactions.some((item) => item.originalDescription === 'COD. LANC. 0')).toBe(false)
    expect(parsed.transactions.some((item) => item.originalDescription === 'Total')).toBe(false)
    expect(parsed.transactions.some((item) => item.date === '2026-10-08')).toBe(false)
    expect(parsed.excludedRows).toContainEqual(expect.objectContaining({ date: '2026-10-02', description: 'COD. LANC. 0', reason: 'NO_MOVEMENT' }))
    expect(parsed.excludedRows).toContainEqual(expect.objectContaining({ date: '2026-10-08', reason: 'OUTSIDE_STATEMENT_PERIOD' }))
    expect(parsed.excludedRows).toContainEqual(expect.objectContaining({ date: null, reason: 'FOOTER_OR_METADATA' }))
    expect(parsed.auxiliaryIncludedCount).toBe(1)
    expect(parsed.auxiliaryOutsidePeriodCount).toBe(1)
    expect(refund).toMatchObject({ date: '2026-10-07', amount: 67770, direction: 'CREDIT', type: 'REFUND', balanceAfter: 108007 })
    expect(result.items.find((item) => item.bank.originalDescription === 'PIX QR CODE ESTATICO')?.status).toBe('REFUNDED')
    expect(result.items.find((item) => item.bank.originalDescription === 'DEVOLUCAO PIX')?.status).toBe('REFUNDED')
    expect(audit).toMatchObject({ reportedBalance: 108007, calculatedBalance: 108007, difference: 0, isBalanced: true })
    expect(result.totals.finalBalance).toBe(108007)
    expect(result.bankRefundGroups).toMatchObject([{ status: 'REFUNDED', grossAmount: 67770, refundAmount: 67770, netAmount: 0 }])
    expect(summarizeMissingExpenses(result.items).count).toBe(1) // somente a compra fictícia do cartão
    expect(summarizeMissingExpenses(result.items).total).toBe(79513)
  })

  it('deduplica crédito repetido entre seções mesmo quando o ID gerado difere e audita a referência COD. LANC. 0', () => {
    const csvText = [
      'Data;Histórico;Docto.;Crédito (R$);Débito (R$);Saldo (R$)',
      '31/01/2026;COD. LANC. 0;0;0,00;;100,00',
      '01/02/2026;RENTAB.INVEST FACILCRED*;2;0,01;;100,01',
      '02/02/2026;RENTAB.INVEST FACILCRED*;2;0,03;;100,04',
      '02/02/2026;COMPRA CARTAO VISA;3;;0,04;100,00',
      'Filtro de resultados - Movimentação entre: 01/02/2026 e 02/02/2026;;;;;',
      'Os dados acima tem como base 03/02/2026 às 10:00 e estão sujeitos a alterações.;;;;;',
      'Últimos Lançamentos;;;;;',
      'Data;Histórico;Docto.;Crédito (R$);Débito (R$);Saldo (R$)',
      '02/02/2026;COD. LANC. 0;0;;;99,97',
      '02/02/2026;RENTAB.INVEST FACILCRED*;2;0,03;;100,00',
      ';;Total;0,03;0,00;100,00',
    ].join('\n')
    const csv = parseCsvText(csvText)
    const map = initialColumnMap(csv.headers, 'bank') as ColumnMap
    const parsed = parseBankCsvSections(csv, map)
    const audit = auditBankBalance(parsed.transactions, parsed.excludedRows)

    expect(parsed.transactions).toHaveLength(3)
    expect(parsed.auxiliaryIncludedCount).toBe(0)
    expect(parsed.excludedRows).toContainEqual(expect.objectContaining({ row: 11, reason: 'DUPLICATE_AUXILIARY', date: '2026-02-02', document: '2', amount: 3, credit: 3, balanceAfter: 10000 }))
    expect(audit).toMatchObject({ calculatedBalance: 10000, reportedBalance: 10000, difference: 0, isBalanced: true })
    expect(audit.referenceDiscrepancy).toMatchObject({ sourceRow: 10, date: '2026-02-02', description: 'COD. LANC. 0', document: '0', credit: 0, debit: 0, previousBalance: 10000, expectedBalance: 10000, reportedBalance: 9997, difference: -3, compensatedByFollowingRow: true, compensationSourceRow: 11 })
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
