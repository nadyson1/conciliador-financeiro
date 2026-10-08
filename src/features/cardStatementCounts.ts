import type { CardStatementMatch } from '../domain/types'

export function summarizeCardPurchases(matches: CardStatementMatch[]) {
  const matched = matches.filter((match) => match.status === 'CARD_MATCHED' || match.status === 'CARD_GROUP_MATCHED').length
  const review = matches.filter((match) => match.status === 'CARD_REVIEW').length
  const missing = matches.filter((match) => match.status === 'CARD_MISSING' || match.status === 'CARD_MISSING_CONFIRMED').length
  const refunded = matches.filter((match) => match.status === 'CARD_REFUNDED').length
  const ignored = matches.filter((match) => match.status === 'CARD_IGNORED').length
  return { eligible: matched + review + missing, matched, review, missing, refunded, ignored }
}
