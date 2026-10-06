import type { Direction, TransactionType } from '../domain/types'

export type MissingAddReason = 'ELIGIBLE' | 'NOT_MISSING' | 'NOT_DEBIT' | 'NOT_EXPENSE' | 'OUT_OF_SCOPE_TRANSFER' | 'OUT_OF_SCOPE_INVESTMENT' | 'CARD_PAYMENT' | 'REFUND' | 'ALREADY_IN_SHEET' | 'ALREADY_ADDED' | 'UNSUPPORTED_WRITE'

export interface MissingAddCandidate {
  source: 'BANK' | 'STATEMENT'
  status: string
  direction: Direction
  type: TransactionType | 'PURCHASE' | 'REFUND'
  alreadyInSheet?: boolean
  alreadyAdded?: boolean
  hasRequiredFields?: boolean
}

export interface MissingAddDecision { eligible: boolean; reason: MissingAddReason }

/** One explainable gate for both the add action and its opening handler. */
export function canAddMissingToCostYear(item: MissingAddCandidate): MissingAddDecision {
  if (item.alreadyAdded) return { eligible: false, reason: 'ALREADY_ADDED' }
  if (item.alreadyInSheet) return { eligible: false, reason: 'ALREADY_IN_SHEET' }
  if (item.type === 'REFUND') return { eligible: false, reason: 'REFUND' }
  if (item.direction !== 'DEBIT') return { eligible: false, reason: 'NOT_DEBIT' }
  if (item.type === 'CARD_PAYMENT') return { eligible: false, reason: 'CARD_PAYMENT' }
  if (item.type === 'TRANSFER') return { eligible: false, reason: 'OUT_OF_SCOPE_TRANSFER' }
  if (item.type === 'INVESTMENT' || item.type === 'INVESTMENT_INCOME') return { eligible: false, reason: 'OUT_OF_SCOPE_INVESTMENT' }
  if (item.type !== 'PURCHASE' && item.type !== 'EXPENSE') return { eligible: false, reason: 'NOT_EXPENSE' }
  if (item.source === 'STATEMENT' ? item.status !== 'CARD_MISSING' : item.status !== 'MISSING') return { eligible: false, reason: 'NOT_MISSING' }
  if (item.hasRequiredFields === false) return { eligible: false, reason: 'UNSUPPORTED_WRITE' }
  return { eligible: true, reason: 'ELIGIBLE' }
}
