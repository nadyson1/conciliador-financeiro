import { describe, expect, it } from 'vitest'
import { inferCostPaymentMethod } from './costYearRecord'

describe('classificação determinística da forma de pagamento para nova linha', () => {
  it.each([
    ['PIX ENVIADO', 'Pix'],
    ['PIX QR CODE DINAMICO', 'Pix'],
    ['PIX QR CODE ESTATICO', 'Pix'],
    ['Pix Qrcode Din', 'Pix'],
    ['Pix Qrcode Est', 'Pix'],
    ['COMPRA CARTAO VISA', 'Débito'],
    ['Compra Visa', 'Débito'],
    ['SEGURO CART DEB BRADESCO', 'Débito automático'],
    ['Seguro Cart Deb', 'Débito automático'],
    ['CONTA DE TELEFONE', 'Débito automático'],
    ['APLICACAO CDB', 'Investimento'],
  ])('%s → %s', (description, paymentMethod) => expect(inferCostPaymentMethod(description)).toBe(paymentMethod))

  it('usa Crédito_Bradesco somente para itens individuais de fatura e deixa histórico desconhecido em branco', () => {
    expect(inferCostPaymentMethod('MERCADO MODELO', 'STATEMENT')).toBe('Crédito_Bradesco')
    expect(inferCostPaymentMethod('COMPRA MISTERIOSA')).toBe('')
  })
})
