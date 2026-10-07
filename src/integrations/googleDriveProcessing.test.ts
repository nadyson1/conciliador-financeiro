import { describe, expect, it } from 'vitest'
import { resolveDrivePdfFileOutcome, summarizeDriveInvoiceOutcomes, type DriveFileOutcome } from './googleDriveProcessing'

const outcomes = (unique: number, duplicates: number, extras: Partial<DriveFileOutcome>[] = []): DriveFileOutcome[] => [
  ...Array.from({ length: unique }, (_, index) => ({ fileId: `unique-${index}`, fileName: `invoice-${index}.pdf`, status: 'PROCESSED_UNIQUE' as const, financialIdentity: `identity-${index}` })),
  ...Array.from({ length: duplicates }, (_, index) => ({ fileId: `duplicate-${index}`, fileName: `copy-${index}.pdf`, status: 'DUPLICATE_FINANCIAL' as const, financialIdentity: `identity-${index}` })),
  ...extras.map((extra, index) => ({ fileId: `extra-${index}`, fileName: `extra-${index}.pdf`, status: 'PARSE_ERROR' as const, ...extra })),
]

describe('relatório explícito do processamento de faturas Drive', () => {
  it('resolve status a partir do resultado efetivo mesmo quando a lista individual ainda não está disponível', () => {
    expect(resolveDrivePdfFileOutcome('ok', 'ok.pdf', { processed: 1, errors: 0, duplicates: 0, semanticIdentities: ['invoice-ok'] }))
      .toMatchObject({ status: 'PROCESSED_UNIQUE', financialIdentity: 'invoice-ok' })
    expect(resolveDrivePdfFileOutcome('copy', 'copy.pdf', { processed: 0, errors: 0, duplicates: 1, semanticIdentities: ['invoice-ok'] }))
      .toMatchObject({ status: 'DUPLICATE_FINANCIAL', financialIdentity: 'invoice-ok' })
    expect(resolveDrivePdfFileOutcome('bad', 'bad.pdf', { processed: 0, errors: 1, duplicates: 0, semanticIdentities: [] }))
      .toMatchObject({ status: 'PARSE_ERROR' })
  })

  it('mantém erro para PDF que realmente falhou no parsing', () => {
    const result = resolveDrivePdfFileOutcome('bad', 'corrompido.pdf', {
      processed: 0, errors: 1, duplicates: 0, semanticIdentities: [],
      fileOutcomes: [{ fileId: 'bad', fileName: 'corrompido.pdf', status: 'PARSE_ERROR', errorMessage: 'PDF inválido.' }],
    })
    expect(result).toMatchObject({ status: 'PARSE_ERROR', errorMessage: 'PDF inválido.' })
  })

  it('conta 10 arquivos, 9 invoices e 1 duplicado pelo status explícito', () => {
    const result = summarizeDriveInvoiceOutcomes(10, outcomes(9, 1))
    expect(result).toMatchObject({ invoicesFound: 10, invoicesUnique: 9, invoiceDuplicates: 1, invoiceErrors: 0 })
  })

  it('conta 6 arquivos, 5 invoices e 1 duplicado pelo status explícito', () => {
    const result = summarizeDriveInvoiceOutcomes(6, outcomes(5, 1))
    expect(result).toMatchObject({ invoicesFound: 6, invoicesUnique: 5, invoiceDuplicates: 1, invoiceErrors: 0 })
  })

  it('não aumenta a quantidade de invoices quando chega outra fonte da mesma invoice', () => {
    const result = summarizeDriveInvoiceOutcomes(2, [
      { fileId: 'a', fileName: 'a.pdf', status: 'PROCESSED_UNIQUE', financialIdentity: 'same-invoice' },
      { fileId: 'b', fileName: 'b.pdf', status: 'DUPLICATE_FINANCIAL', financialIdentity: 'same-invoice' },
    ])
    expect(result.invoicesUnique).toBe(1)
    expect(result.invoiceDuplicates).toBe(1)
  })

  it('não contabiliza erros de parsing nem arquivos não suportados como duplicados', () => {
    const result = summarizeDriveInvoiceOutcomes(3, [
      { fileId: 'good', fileName: 'good.pdf', status: 'PROCESSED_UNIQUE', financialIdentity: 'invoice-a' },
      { fileId: 'bad', fileName: 'bad.pdf', status: 'PARSE_ERROR' },
      { fileId: 'other', fileName: 'notes.txt', status: 'UNSUPPORTED' },
    ])
    expect(result).toMatchObject({ invoicesFound: 3, invoicesUnique: 1, invoiceDuplicates: 0, invoiceErrors: 1, invoiceUnsupported: 1 })
  })
})
