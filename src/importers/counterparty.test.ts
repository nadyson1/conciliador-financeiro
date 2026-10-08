import { describe, expect, it } from 'vitest'
import { counterpartyLabel, descriptionWithoutCounterparty } from './counterparty'

describe('apresentação contextual da contraparte', () => {
  it('usa Para em pagamentos PIX de saída, De em entradas/estornos e Estabelecimento em compras', () => {
    expect(counterpartyLabel({ description: 'PIX ENVIADO', direction: 'DEBIT', type: 'EXPENSE' })).toBe('Para')
    expect(counterpartyLabel({ description: 'PIX QR CODE DINAMICO', direction: 'DEBIT', type: 'EXPENSE' })).toBe('Para')
    expect(counterpartyLabel({ description: 'PIX RECEBIDO', direction: 'CREDIT', type: 'INCOME' })).toBe('De')
    expect(counterpartyLabel({ description: 'DEVOLUCAO PIX', direction: 'CREDIT', type: 'REFUND' })).toBe('De')
    expect(counterpartyLabel({ description: 'COMPRA VISA', direction: 'DEBIT', type: 'EXPENSE' })).toBe('Estabelecimento')
    expect(counterpartyLabel({ description: 'Compra no débito', direction: 'DEBIT', type: 'EXPENSE' })).toBe('Estabelecimento')
    expect(counterpartyLabel({ description: 'Pix Qrcode Din', direction: 'DEBIT', type: 'EXPENSE' })).toBe('Para')
    expect(counterpartyLabel({ description: 'SAQUE', direction: 'DEBIT', type: 'OTHER' })).toBe('Contraparte')
  })

  it('remove a contraparte da descrição-base para evitar repetir o mesmo nome na apresentação', () => {
    expect(descriptionWithoutCounterparty('Nomerkado', 'Nomerkado')).toBe('Nomerkado')
    expect(descriptionWithoutCounterparty('COMPRA VISA Nomerkado', 'Nomerkado')).toBe('COMPRA VISA')
  })
})
