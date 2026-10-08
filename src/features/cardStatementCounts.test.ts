import { describe, expect, it } from 'vitest'
import type { CardStatementMatch } from '../domain/types'
import { summarizeCardPurchases } from './cardStatementCounts'

const match = (status: CardStatementMatch['status']) => ({ status } as CardStatementMatch)

describe('contadores derivados das compras PDF', () => {
  it('conta sete compras realmente conciliadas', () => {
    expect(summarizeCardPurchases(Array.from({ length: 7 }, () => match('CARD_MATCHED')))).toEqual({ eligible: 7, matched: 7, review: 0, missing: 0, refunded: 0, ignored: 0 })
  })

  it('separa sete elegíveis entre três conciliadas e quatro ausentes', () => {
    const result = summarizeCardPurchases([
      ...Array.from({ length: 3 }, () => match('CARD_MATCHED')),
      ...Array.from({ length: 4 }, () => match('CARD_MISSING')),
    ])
    expect(result).toMatchObject({ eligible: 7, matched: 3, review: 0, missing: 4 })
    expect(result.eligible).toBe(result.matched + result.review + result.missing)
  })

  it('mantém REVIEW separado e deixa compras estornadas/ignoradas fora da invariante', () => {
    const result = summarizeCardPurchases([
      match('CARD_MATCHED'), match('CARD_REVIEW'), match('CARD_MISSING'),
      match('CARD_REFUNDED'), match('CARD_IGNORED'),
    ])
    expect(result).toEqual({ eligible: 3, matched: 1, review: 1, missing: 1, refunded: 1, ignored: 1 })
    expect(result.eligible).toBe(result.matched + result.review + result.missing)
  })

  it('preserva o caso de cinco elegíveis com uma conciliada e quatro ausentes', () => {
    const result = summarizeCardPurchases([
      match('CARD_MATCHED'), ...Array.from({ length: 4 }, () => match('CARD_MISSING')),
    ])
    expect(result).toMatchObject({ eligible: 5, matched: 1, review: 0, missing: 4 })
  })
})
