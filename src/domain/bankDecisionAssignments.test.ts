import { describe, expect, it } from 'vitest'
import type { BankTransaction, LedgerTransaction } from './types'
import type { PersistedDecision } from './localDecisions'
import { bankIdentity, sheetIdentity } from './identity'
import { resolveConfirmedBankAssignments } from './bankDecisionAssignments'
import { reconcile } from '../matching/reconcile'

const bank = (id: string): BankTransaction => ({ id, source: 'BANK', sheetRecordId: null, bankTransactionId: id, date: '2026-02-20', description: 'Uber Viagem', originalDescription: 'Uber Viagem', amount: 6000, direction: 'DEBIT', directionKnown: true, type: 'EXPENSE', paymentMethod: 'Pix', category: '', month: '', year: '2026', isFixed: null, isEssential: null, installment: null, totalInstallments: null, balanceAfter: null, original: {} })
const row = (): LedgerTransaction => ({ id: 's1', source: 'SHEET', sheetRecordId: 'record-1', bankTransactionId: null, date: '2026-02-20', description: 'Uber Viagem', originalDescription: 'Uber Viagem', amount: 6000, direction: 'DEBIT', type: 'EXPENSE', paymentMethod: 'Pix', category: 'Transporte', month: '02 - Fevereiro', year: '2026', isFixed: false, isEssential: false, installment: null, totalInstallments: null, balanceAfter: null, original: {} })
const pair = (source: BankTransaction, target: LedgerTransaction): PersistedDecision => ({ kind: 'PAIR_CONFIRMED', identities: [bankIdentity(source)], selected: [sheetIdentity(target)], key: `PAIR_CONFIRMED:${JSON.stringify([bankIdentity(source)])}`, schemaVersion: 1, updatedAt: '2026-02-20T12:00:00.000Z' })

describe('ownership global de PAIR_CONFIRMED', () => {
  it('detecta conflito manual/manual e não escolhe owner pela ordem', () => {
    const b1 = bank('b1'), b2 = bank('b2'), s = row()
    const resolution = resolveConfirmedBankAssignments([pair(b1, s), pair(b2, s)], [b1, b2], [s])
    expect(resolution.confirmedPairs.size).toBe(0)
    expect(resolution.conflictingSheetIds).toEqual(new Set(['s1']))
    expect(resolution.confirmedBankAssignmentsBySheetRecordId.get('record-1')).toEqual(['b1', 'b2'])
    const result = reconcile([b1, b2], [s], { conflictingConfirmedSheetIds: resolution.conflictingSheetIds, conflictingConfirmedBankIds: resolution.conflictingBankIds, conflictingConfirmedAssignments: resolution.conflictingConfirmedAssignments })
    expect(result.items.map((item) => item.status)).toEqual(['REVIEW', 'REVIEW'])
    expect(result.items.map((item) => item.reviewReason)).toEqual(['ASSIGNMENT_CONFLICT', 'ASSIGNMENT_CONFLICT'])
  })

  it('aplica uma confirmação válida e ignora uma confirmação malformada', () => {
    const b = bank('b1'), s = row(), valid = pair(b, s)
    const malformed = { ...valid, key: 'wrong-key' }
    const resolution = resolveConfirmedBankAssignments([valid], [b], [s])
    expect(resolution.confirmedPairs.get('b1')).toBe('s1')
    expect(resolveConfirmedBankAssignments([malformed], [b], [s]).confirmedPairs.size).toBe(0)
    expect(reconcile([b], [s], { confirmedPairs: resolution.confirmedPairs }).items[0]).toMatchObject({ status: 'MATCHED', sheet: { id: 's1' } })
  })
})
