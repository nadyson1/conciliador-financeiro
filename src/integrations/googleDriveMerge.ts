import type { BankTransaction } from '../domain/types'
import { stableFingerprint } from '../domain/identity'

const normalized = (value: string) => value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().replace(/\s+/g, ' ')
const semanticKey = (row: BankTransaction) => stableFingerprint([row.date, normalized(row.originalDescription), row.direction, row.amount])
const sameMovement = (left: BankTransaction, right: BankTransaction) => semanticKey(left) === semanticKey(right)

/** Union source files, suppressing only semantic overlaps across different sources. */
export function mergeDriveBankSourcesWithStats(manual: BankTransaction[], drive: Record<string, BankTransaction[]>) {
  const sources = [{ id: 'manual', rows: manual }, ...Object.keys(drive).sort().map((id) => ({ id, rows: drive[id] }))]
  const output: BankTransaction[] = []
  const overlapBySource: Record<string, number> = {}
  for (const source of sources) {
    const earlierCount = output.length
    const alreadyMatched = new Set<number>()
    for (const row of source.rows) {
      let duplicateIndex = -1
      for (let index = 0; index < earlierCount; index += 1) {
        if (!alreadyMatched.has(index) && sameMovement(output[index], row)) { duplicateIndex = index; break }
      }
      if (duplicateIndex >= 0) {
        alreadyMatched.add(duplicateIndex)
        overlapBySource[source.id] = (overlapBySource[source.id] ?? 0) + 1
        const current = output[duplicateIndex]
        const sourceIds = new Set([...(current.statementSourceIds ?? (current.statementSourceId ? [current.statementSourceId] : [])), source.id])
        output[duplicateIndex] = { ...current, statementSourceIds: [...sourceIds] }
      } else output.push({ ...row, statementSourceIds: [...new Set([...(row.statementSourceIds ?? (row.statementSourceId ? [row.statementSourceId] : [])), source.id])] })
    }
  }
  const totalOverlaps = Object.values(overlapBySource).reduce((sum, count) => sum + count, 0)
  return { transactions: output, overlapBySource, totalOverlaps }
}

export function mergeDriveBankSources(manual: BankTransaction[], drive: Record<string, BankTransaction[]>): BankTransaction[] {
  return mergeDriveBankSourcesWithStats(manual, drive).transactions
}
