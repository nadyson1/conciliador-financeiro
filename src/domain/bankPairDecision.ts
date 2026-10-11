import { decisionKey, type DecisionKind, type PersistedDecision } from './localDecisions'

export type BankPairAction = 'PAIR_CONFIRMED' | 'PAIR_REJECTED'

export type BankPairDecisionReplacement = {
  decision: Omit<PersistedDecision, 'schemaVersion' | 'updatedAt'>
  superseded: PersistedDecision[]
}

/**
 * Builds an exact-pair replacement. PAIR_CONFIRMED is keyed by bank subject,
 * so its selected row must also be checked before it can be superseded.
 */
export function buildBankPairDecisionReplacement(
  active: PersistedDecision[],
  action: BankPairAction,
  bankIdentity: string,
  sheetIdentity: string,
): BankPairDecisionReplacement {
  const kind: DecisionKind = action
  const identities = action === 'PAIR_CONFIRMED' ? [bankIdentity] : [bankIdentity, sheetIdentity]
  const decision = {
    key: decisionKey(kind, identities),
    kind,
    identities,
    selected: action === 'PAIR_CONFIRMED' ? [sheetIdentity] : [],
  }
  const oppositeKind = action === 'PAIR_CONFIRMED' ? 'PAIR_REJECTED' : 'PAIR_CONFIRMED'
  const oppositeIdentities = action === 'PAIR_CONFIRMED' ? [bankIdentity, sheetIdentity] : [bankIdentity]
  const oppositeKey = decisionKey(oppositeKind, oppositeIdentities)
  const opposite = active.find((item) => item.key === oppositeKey
    && item.kind === oppositeKind
    && JSON.stringify(item.identities) === JSON.stringify(oppositeIdentities)
    && (item.kind !== 'PAIR_CONFIRMED' || item.selected.length === 1 && item.selected[0] === sheetIdentity))

  return { decision, superseded: opposite ? [opposite] : [] }
}
