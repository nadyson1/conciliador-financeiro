import { describe, expect, it } from 'vitest'
import { canAddMissingToCostYear } from './missingEligibility'

const bank = (overrides: Partial<Parameters<typeof canAddMissingToCostYear>[0]> = {}) => canAddMissingToCostYear({ source: 'BANK', status: 'MISSING', direction: 'DEBIT', type: 'EXPENSE', ...overrides })

describe('elegibilidade para adicionar à CUSTOS ANO', () => {
  it('permite ausentes bancários de despesa mesmo com campos opcionais desconhecidos', () => {
    expect(bank()).toEqual({ eligible: true, reason: 'ELIGIBLE' })
  })

  it.each([
    ['entrada', { direction: 'CREDIT' as const }, 'NOT_DEBIT'],
    ['pagamento da fatura', { type: 'CARD_PAYMENT' as const }, 'CARD_PAYMENT'],
    ['transferência', { type: 'TRANSFER' as const }, 'OUT_OF_SCOPE_TRANSFER'],
    ['investimento', { type: 'INVESTMENT' as const }, 'OUT_OF_SCOPE_INVESTMENT'],
    ['rendimento de investimento', { type: 'INVESTMENT_INCOME' as const }, 'OUT_OF_SCOPE_INVESTMENT'],
    ['estorno', { type: 'REFUND' as const }, 'REFUND'],
    ['fora do escopo', { status: 'OUT_OF_SCOPE' }, 'NOT_MISSING'],
    ['natureza não reconhecida', { type: 'OTHER' as const }, 'NOT_EXPENSE'],
    ['já presente', { alreadyInSheet: true }, 'ALREADY_IN_SHEET'],
    ['já adicionado', { alreadyAdded: true }, 'ALREADY_ADDED'],
  ])('bloqueia %s com motivo explicável', (_name, input, reason) => {
    expect(bank(input)).toEqual({ eligible: false, reason })
  })

  it('permite somente compra individual ausente de fatura PDF', () => {
    expect(canAddMissingToCostYear({ source: 'STATEMENT', status: 'CARD_MISSING', direction: 'DEBIT', type: 'PURCHASE' })).toEqual({ eligible: true, reason: 'ELIGIBLE' })
    expect(canAddMissingToCostYear({ source: 'STATEMENT', status: 'CARD_MISSING', direction: 'CREDIT', type: 'REFUND' })).toEqual({ eligible: false, reason: 'REFUND' })
  })
})
