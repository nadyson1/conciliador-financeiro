import { describe, expect, it } from 'vitest'
import { initialColumnMap, parseCsvText } from '../importers/csv'
import { parseBankCsvSections, parseBankRows } from '../importers/transactions'
import { mergeDriveBankSources, mergeDriveBankSourcesWithStats } from './googleDriveMerge'
import { reconcile } from '../matching/reconcile'

const csv = 'Data,Histórico,Débito R$,Crédito R$,Saldo\n05/10/2026,PIX ENVIADO,25,,-100\n06/10/2026,PIX ENVIADO,25,,-125'

describe('importação de extrato do Drive pelo parser existente', () => {
  it('produz os mesmos lançamentos do fluxo CSV manual', () => {
    const document = parseCsvText(csv)
    const parsed = parseBankRows(document.rows, initialColumnMap(document.headers, 'bank'), document.metadataRowsIgnored)
    expect(parsed.transactions).toHaveLength(2)
    expect(parsed.transactions.map(({ date, amount, direction }) => ({ date, amount, direction }))).toEqual([
      { date: '2026-10-05', amount: 2500, direction: 'DEBIT' },
      { date: '2026-10-06', amount: 2500, direction: 'DEBIT' },
    ])
  })

  it('deduplica o mesmo CSV vindo de upload manual e Drive, preservando ocorrências legítimas do extrato', () => {
    const document = parseCsvText(csv)
    const rows = parseBankRows(document.rows, initialColumnMap(document.headers, 'bank')).transactions
    expect(mergeDriveBankSources(rows, { 'drive-file-1': rows }).map(({ date, amount, direction }) => ({ date, amount, direction }))).toEqual(rows.map(({ date, amount, direction }) => ({ date, amount, direction })))
    expect(mergeDriveBankSources([], { 'drive-file-1': rows, 'drive-copy': rows })).toHaveLength(rows.length)
  })

  it('une extratos diferentes, deduplica sobreposição entre arquivos e mantém duplicatas dentro de um arquivo', () => {
    const map = initialColumnMap(parseCsvText(csv).headers, 'bank')
    const first = parseBankRows(parseCsvText(csv).rows, map).transactions
    const extra = parseBankRows(parseCsvText('Data,Histórico,Débito R$,Crédito R$,Saldo\n07/10/2026,PIX ENVIADO,10,,-135').rows, map).transactions
    const result = mergeDriveBankSourcesWithStats([], { first, second: [...first, ...extra] })
    expect(result.transactions).toHaveLength(first.length + extra.length)
    expect(result.totalOverlaps).toBe(first.length)
    expect(result.overlapBySource.second).toBe(first.length)
  })

  it('mantém provenance das fontes de uma transação deduplicada para que a remoção de uma não a desative', () => {
    const document = parseCsvText('Data,Histórico,Débito R$\n05/10/2026,PIX ENVIADO,25')
    const row = parseBankRows(document.rows, initialColumnMap(document.headers, 'bank')).transactions[0]
    const [merged] = mergeDriveBankSources([], { fileA: [{ ...row, statementSourceId: 'fileA' }], fileB: [{ ...row, statementSourceId: 'fileB' }] })
    expect(merged.statementSourceIds).toEqual(['fileA', 'fileB'])
    expect(mergeDriveBankSources([], { fileB: [{ ...row, statementSourceId: 'fileB' }] })).toHaveLength(1)
  })

  it('incorpora Últimos Lançamentos, cruza devolução entre fontes e ignora saldo agregado de arquivos diferentes', () => {
    const fixture = 'Data;Histórico;Docto.;Crédito (R$);Débito (R$);Saldo (R$)\n18/09/2026;PIX QR CODE ESTATICO;DOC-B;;677,70;1.197,50\nFiltro de resultados - Movimentação entre: 01/09/2026 e 07/10/2026;;;;;\nÚltimos Lançamentos;;;;;\nData;Histórico;Docto.;Crédito (R$);Débito (R$);Saldo (R$)\n07/10/2026;DEVOLUCAO PIX;DOC-D;677,70;;1.080,07'
    const document = parseCsvText(fixture)
    const parsed = parseBankCsvSections(document, initialColumnMap(document.headers, 'bank'))
    const original = parsed.transactions.find((transaction) => transaction.direction === 'DEBIT')!
    const refund = parsed.transactions.find((transaction) => transaction.type === 'REFUND')!
    const driveUnion = mergeDriveBankSources([], { one: [{ ...original, statementSourceId: 'one' }], two: [{ ...refund, statementSourceId: 'two' }] })
    const result = reconcile(driveUnion, [])
    expect(parsed.auxiliaryIncludedCount).toBe(1)
    expect(result.bankRefundGroups).toMatchObject([{ status: 'REFUNDED', originalTransactionIds: [original.id], refundTransactionId: refund.id }])
    expect(result.items.find((item) => item.bank.id === original.id)?.status).toBe('REFUNDED')
    expect(result.totals.finalBalance).toBeNull()
    expect(result.totals.calculatedFinalBalance).toBeNull()
  })
})
