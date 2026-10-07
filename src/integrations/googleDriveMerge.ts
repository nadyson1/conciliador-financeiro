import type { BankTransaction } from '../domain/types'
import { bankIdentity } from '../domain/identity'

/** Combines source files as multisets, retaining the largest occurrence count per stable bank identity. */
export function mergeDriveBankSources(manual: BankTransaction[], drive: Record<string, BankTransaction[]>): BankTransaction[] {
  const sources = [manual, ...Object.keys(drive).sort().map((key) => drive[key])]
  const maxCounts = new Map<string, number>()
  for (const source of sources) {
    const counts = new Map<string, number>()
    source.forEach((row) => counts.set(bankIdentity(row), (counts.get(bankIdentity(row)) ?? 0) + 1))
    counts.forEach((count, identity) => maxCounts.set(identity, Math.max(maxCounts.get(identity) ?? 0, count)))
  }
  const emitted = new Map<string, number>()
  const output: BankTransaction[] = []
  for (const source of sources) for (const row of source) {
    const identity = bankIdentity(row), count = (emitted.get(identity) ?? 0) + 1
    if (count <= (maxCounts.get(identity) ?? 0)) { output.push(row); emitted.set(identity, count) }
  }
  return output
}
