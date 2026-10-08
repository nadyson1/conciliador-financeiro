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

  it('usa a ordem dos lançamentos como evidência apenas quando quase todo o extrato já tem âncoras cross-format únicas', () => {
    const makeRow = (id: string, date: string, description: string, doc: string, format: 'BRADESCO_CSV_MOBILE' | 'BRADESCO_CSV_INTERNET_BANKING'): import('../domain/types').BankTransaction => ({
      id, source: 'BANK', sheetRecordId: null, bankTransactionId: `doc:${doc}`, date, description,
      originalDescription: description, sourceDescriptions: [description], sourceTransactionIds: [`DOCUMENT:${doc}`],
      statementFormats: [format], amount: 1000, direction: 'DEBIT', type: 'EXPENSE', paymentMethod: '',
      category: '', month: '', year: date.slice(0, 4), isFixed: null, isEssential: null, installment: null,
      totalInstallments: null, balanceAfter: null, original: { 'Docto.': doc },
    })
    const mobile = Array.from({ length: 18 }, (_, index) => makeRow(`m-${index}`, `2026-01-${String(index + 1).padStart(2, '0')}`, `Compra ${index}`, `M-${index}`, 'BRADESCO_CSV_MOBILE'))
    const internet = Array.from({ length: 18 }, (_, index) => makeRow(`i-${index}`, `2026-01-${String(index + 1).padStart(2, '0')}`, `Transação ${index}`, `I-${index}`, 'BRADESCO_CSV_INTERNET_BANKING'))
    mobile.push(makeRow('m-ambiguous-1', '2026-02-01', 'PIX ENVIADO', 'M-A', 'BRADESCO_CSV_MOBILE'))
    mobile.push(makeRow('m-ambiguous-2', '2026-02-01', 'PIX ENVIADO', 'M-B', 'BRADESCO_CSV_MOBILE'))
    internet.push(makeRow('i-ambiguous-1', '2026-02-01', 'PAGAMENTO', 'I-A', 'BRADESCO_CSV_INTERNET_BANKING'))
    internet.push(makeRow('i-ambiguous-2', '2026-02-01', 'TRANSFERENCIA', 'I-B', 'BRADESCO_CSV_INTERNET_BANKING'))

    const merged = mergeDriveBankSourcesWithStats([], { first: mobile, second: internet })
    expect(merged.transactions).toHaveLength(20)
    expect(merged.totalOverlaps).toBe(20)
    expect(merged.transactions.find((row) => row.date === '2026-02-01' && row.bankTransactionId === 'doc:M-A')?.sourceTransactionIds).toContain('DOCUMENT:I-A')
    expect(merged.transactions.find((row) => row.date === '2026-02-01' && row.bankTransactionId === 'doc:M-B')?.sourceTransactionIds).toContain('DOCUMENT:I-B')
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
