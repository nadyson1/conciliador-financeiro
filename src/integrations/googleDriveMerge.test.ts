import { describe, expect, it } from 'vitest'
import { initialColumnMap, parseCsvText } from '../importers/csv'
import { parseBankRows } from '../importers/transactions'
import { mergeDriveBankSources } from './googleDriveMerge'

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
    expect(mergeDriveBankSources(rows, { 'drive-file-1': rows })).toEqual(rows)
    expect(mergeDriveBankSources([], { 'drive-file-1': rows, 'drive-copy': rows })).toEqual(rows)
  })
})
