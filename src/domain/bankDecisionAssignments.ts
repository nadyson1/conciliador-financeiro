import type { BankTransaction, LedgerTransaction } from './types'
import type { PersistedDecision } from './localDecisions'
import { bankIdentity, sheetIdentity } from './identity'
import { auditPersistedDecision } from './decisionAudit'

export type ConfirmedBankAssignments = {
  confirmedPairs: Map<string, string>
  conflictingSheetIds: Set<string>
  conflictingBankIds: Set<string>
  confirmedBankAssignmentsBySheetRecordId: Map<string, string[]>
  conflictingConfirmedAssignments: Map<string, LedgerTransaction[]>
}

/** Resolves only valid manual assignments, then detects row ownership conflicts globally. */
export function resolveConfirmedBankAssignments(decisions: PersistedDecision[], banks: BankTransaction[], sheets: LedgerTransaction[]): ConfirmedBankAssignments {
  const confirmedPairs = new Map<string, string>()
  const bySheet = new Map<string, { bank: BankTransaction; sheet: LedgerTransaction }[]>()
  const auditContext = { banks, sheets, statements: [] }
  for (const decision of decisions) {
    if (decision.kind !== 'PAIR_CONFIRMED' || auditPersistedDecision(decision, auditContext).status !== 'VALID') continue
    const bank = banks.find((row) => bankIdentity(row) === decision.identities[0])
    const sheet = sheets.find((row) => sheetIdentity(row) === decision.selected[0])
    if (!bank || !sheet) continue
    const list = bySheet.get(sheet.sheetRecordId) ?? []
    list.push({ bank, sheet })
    bySheet.set(sheet.sheetRecordId, list)
  }
  const conflictingSheetIds = new Set<string>(), conflictingBankIds = new Set<string>()
  const conflictingConfirmedAssignments = new Map<string, LedgerTransaction[]>()
  const confirmedBankAssignmentsBySheetRecordId = new Map<string, string[]>()
  for (const [recordId, owners] of bySheet) {
    const ownerIds = [...new Set(owners.map(({ bank }) => bank.id))]
    confirmedBankAssignmentsBySheetRecordId.set(recordId, ownerIds)
    if (ownerIds.length > 1) {
      owners.forEach(({ bank, sheet }) => {
        conflictingSheetIds.add(sheet.id); conflictingBankIds.add(bank.id)
        const rows = conflictingConfirmedAssignments.get(bank.id) ?? []
        if (!rows.some((row) => row.id === sheet.id)) rows.push(sheet)
        conflictingConfirmedAssignments.set(bank.id, rows)
      })
      continue
    }
    const { bank, sheet } = owners[0]
    confirmedPairs.set(bank.id, sheet.id)
  }
  return { confirmedPairs, conflictingSheetIds, conflictingBankIds, confirmedBankAssignmentsBySheetRecordId, conflictingConfirmedAssignments }
}
