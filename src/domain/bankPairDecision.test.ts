import { describe, expect, it } from 'vitest'
import { buildBankPairDecisionReplacement } from './bankPairDecision'
import { decisionKey, type PersistedDecision } from './localDecisions'

const confirmed = (bank: string, sheet: string): PersistedDecision => ({
  key: decisionKey('PAIR_CONFIRMED', [bank]), schemaVersion: 1, kind: 'PAIR_CONFIRMED',
  identities: [bank], selected: [sheet], updatedAt: '2026-10-01T10:00:00.000Z',
})
const rejected = (bank: string, sheet: string): PersistedDecision => ({
  key: decisionKey('PAIR_REJECTED', [bank, sheet]), schemaVersion: 1, kind: 'PAIR_REJECTED',
  identities: [bank, sheet], selected: [], updatedAt: '2026-10-01T10:00:00.000Z',
})

describe('substituição de decisão do mesmo par bancário', () => {
  it('confirmar A-B depois de rejeitar A-B substitui somente a rejeição exata', () => {
    const prior = rejected('bank:A', 'sheet:B')
    const result = buildBankPairDecisionReplacement([prior], 'PAIR_CONFIRMED', 'bank:A', 'sheet:B')
    expect(result.decision).toMatchObject({ kind: 'PAIR_CONFIRMED', identities: ['bank:A'], selected: ['sheet:B'] })
    expect(result.superseded).toEqual([prior])
  })

  it('rejeitar A-B depois de confirmar A-B substitui a confirmação exata', () => {
    const prior = confirmed('bank:A', 'sheet:B')
    const result = buildBankPairDecisionReplacement([prior], 'PAIR_REJECTED', 'bank:A', 'sheet:B')
    expect(result.decision).toMatchObject({ kind: 'PAIR_REJECTED', identities: ['bank:A', 'sheet:B'], selected: [] })
    expect(result.superseded).toEqual([prior])
  })

  it('confirmar A-B1 não remove rejeição de A-B2 nem decisão de outro subject', () => {
    const b1 = rejected('bank:A', 'sheet:B1')
    const b2 = rejected('bank:A', 'sheet:B2')
    const other = rejected('bank:other', 'sheet:B1')
    const result = buildBankPairDecisionReplacement([b1, b2, other], 'PAIR_CONFIRMED', 'bank:A', 'sheet:B1')
    expect(result.superseded).toEqual([b1])
  })

  it('não rejeita B quando a confirmação ativa do mesmo subject aponta para outra linha', () => {
    const prior = confirmed('bank:A', 'sheet:B2')
    const result = buildBankPairDecisionReplacement([prior], 'PAIR_REJECTED', 'bank:A', 'sheet:B1')
    expect(result.superseded).toEqual([])
  })

  it('repetir uma ação após sua primeira aplicação não reativa a decisão oposta', () => {
    const prior = rejected('bank:A', 'sheet:B')
    const first = buildBankPairDecisionReplacement([prior], 'PAIR_CONFIRMED', 'bank:A', 'sheet:B')
    const afterFirst = [
      { ...first.decision, schemaVersion: 1 as const, updatedAt: '2026-10-01T10:00:00.002Z' },
    ]
    const retry = buildBankPairDecisionReplacement(afterFirst, 'PAIR_CONFIRMED', 'bank:A', 'sheet:B')
    expect(retry.decision).toMatchObject({ kind: 'PAIR_CONFIRMED', selected: ['sheet:B'] })
    expect(retry.superseded).toEqual([])
  })
})
