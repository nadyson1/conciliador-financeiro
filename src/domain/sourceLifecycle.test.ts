import { describe, expect, it } from 'vitest'
import { diagnoseMissingCounterDivergence, retainActiveInvoiceSources, retainCurrentDriveBankSources } from './sourceLifecycle'

describe('lifecycle de fontes financeiras', () => {
  it('mantém uma fatura duplicada enquanto ao menos um PDF Drive permanece presente', () => {
    const invoice = { source: 'DRIVE' as const, driveFileId: 'a', driveFileIds: ['a', 'b'], manualSourceIds: [], financialIdentity: 'invoice-1' }
    expect(retainActiveInvoiceSources([invoice], new Set(['b']))).toEqual([{ ...invoice, driveFileId: 'b', driveFileIds: ['b'] }])
    expect(retainActiveInvoiceSources([invoice], new Set())).toEqual([])
  })

  it('mantém uma fatura manual após a remoção da fonte Drive', () => {
    const invoice = { source: 'DRIVE' as const, driveFileId: 'a', driveFileIds: ['a'], manualSourceIds: ['manual-pdf'], financialIdentity: 'invoice-1' }
    expect(retainActiveInvoiceSources([invoice], new Set())).toEqual([{ ...invoice, driveFileId: undefined, driveFileIds: [], manualSourceIds: ['manual-pdf'] }])
  })

  it('remove CSVs não listados sem afetar outras fontes ativas', () => {
    expect(retainCurrentDriveBankSources({ one: [1], two: [2] }, new Set(['two']))).toEqual({ two: [2] })
  })

  it('identifica e descreve itens presentes em apenas um contador', () => {
    const item = { bank: { id: 'tx-1', originalDescription: 'PIX ENVIADO', date: '2026-10-01', amount: 67770, statementSourceId: 'file-a', statementFileName: 'extrato.csv' }, status: 'MISSING' }
    expect(diagnoseMissingCounterDivergence([item], [])).toMatchObject({
      presentInSummaryOnly: [{ item, reason: expect.stringContaining('extrato.csv') }],
      presentInMissingListOnly: [],
    })
  })
})
