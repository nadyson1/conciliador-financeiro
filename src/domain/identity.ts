import type { BankTransaction, CardStatement, CardStatementTransaction, LedgerTransaction } from './types'

/** Compact deterministic identifiers keep decision metadata independent of file row numbers. */
export function stableFingerprint(parts: Array<string | number | null | undefined>): string {
  const value = parts.map((part) => String(part ?? '').trim()).join('\u001f')
  let first = 0x811c9dc5
  let second = 0x9e3779b9
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    first = Math.imul(first ^ code, 0x01000193) >>> 0
    second = Math.imul(second ^ (code + index), 0x85ebca6b) >>> 0
  }
  return `${first.toString(16).padStart(8, '0')}${second.toString(16).padStart(8, '0')}`
}

export const sheetIdentity = (item: LedgerTransaction) => item.sheetRecordId || `sheet:${stableFingerprint([item.date, item.originalDescription, item.amount, item.direction, item.installment, item.totalInstallments])}`
export const bankIdentity = (item: BankTransaction) => item.bankTransactionId || `bank:${stableFingerprint([item.date, item.originalDescription, item.amount, item.direction, item.balanceAfter, item.type])}`
export const cardTransactionIdentity = (statement: CardStatement | string, item: CardStatementTransaction) => `${typeof statement === 'string' ? statement : statement.statementIdentity}:${stableFingerprint([item.cardIdentifier, item.date, item.originalDescription, item.amount, item.direction, item.installment, item.totalInstallments])}`

/**
 * Identities used by older app builds are retained as aliases while decisions
 * are migrated. In particular, the transaction date could be represented by
 * either the purchase date or the invoice date, and early versions did not
 * include the card suffix in the fingerprint.
 */
export function cardTransactionIdentityVariants(statement: CardStatement | string, item: CardStatementTransaction, legacyStatementIdentity?: string | null): string[] {
  const prefixes = [...new Set([typeof statement === 'string' ? statement : statement.statementIdentity, legacyStatementIdentity].filter((value): value is string => Boolean(value)))]
  const dates = [...new Set([item.date, item.purchaseDate, item.invoiceDueDate, item.statementDueDate].filter((value): value is string => Boolean(value)))]
  const fingerprints = new Set<string>()
  for (const date of dates) {
    fingerprints.add(stableFingerprint([item.cardIdentifier, date, item.originalDescription, item.amount, item.direction, item.installment, item.totalInstallments]))
    fingerprints.add(stableFingerprint([date, item.originalDescription, item.amount, item.direction, item.installment, item.totalInstallments]))
  }
  return prefixes.flatMap((prefix) => [...fingerprints].map((fingerprint) => `${prefix}:${fingerprint}`))
}
