import type { BankTransaction } from '../domain/types'
import { stableFingerprint } from '../domain/identity'
import { mergeCounterpartyEvidence, preferredCounterpartyName } from '../importers/counterparty'

const normalized = (value: string) => value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().replace(/\s+/g, ' ')
const semanticKey = (row: BankTransaction) => stableFingerprint([row.date, row.direction, row.amount])
const documentId = (row: BankTransaction) => {
  const entry = Object.entries(row.original).find(([key]) => ['docto', 'docto.', 'documento', 'nsu', 'checknum'].includes(normalized(key)))
  return entry?.[1]?.trim().toLowerCase() || ''
}
const transactionSourceIds = (row: BankTransaction) => row.sourceTransactionIds ?? []
const meaningfulWords = (value: string) => normalized(value).split(' ').filter((word) => word.length > 2
  && !['pix', 'qrcode', 'code', 'est', 'din', 'dinamico', 'estatico', 'des', 'rem', 'fav', 'orig'].includes(word))
function descriptionsCompatible(left: string, right: string) {
  if (normalized(left) === normalized(right)) return true
  const a = meaningfulWords(left), b = meaningfulWords(right)
  if (!a.length || !b.length) return false
  const common = new Set(a.filter((word) => b.includes(word)))
  if (common.size >= 2 && common.size / Math.min(a.length, b.length) >= 0.75) return true
  const na = normalized(left), nb = normalized(right)
  return Math.min(na.length, nb.length) >= 12 && (na.includes(nb) || nb.includes(na))
}
function matchEvidence(left: BankTransaction, right: BankTransaction) {
  if (semanticKey(left) !== semanticKey(right)) return 0
  const leftIds = new Set(transactionSourceIds(left))
  if (transactionSourceIds(right).some((id) => leftIds.has(id))) return 3
  const leftDocument = documentId(left), rightDocument = documentId(right)
  if (leftDocument && rightDocument && leftDocument === rightDocument) return 2
  return descriptionsCompatible(left.originalDescription, right.originalDescription) ? 1 : 0
}

function richerDescription(left: string, right: string) {
  const score = (value: string) => meaningfulWords(value).length * 100 + value.trim().length
  return score(right) > score(left) ? right : left
}

/** Union source files, suppressing only semantic overlaps across different sources. */
export function mergeDriveBankSourcesWithStats(manual: BankTransaction[], drive: Record<string, BankTransaction[]>) {
  const sources = [{ id: 'manual', rows: manual }, ...Object.keys(drive).sort().map((id) => ({ id, rows: drive[id] }))]
  const output: BankTransaction[] = []
  const overlapBySource: Record<string, number> = {}
  for (const source of sources) {
    const earlierCount = output.length
    const sourceGroups = new Map<string, BankTransaction[]>()
    for (const row of source.rows) sourceGroups.set(semanticKey(row), [...(sourceGroups.get(semanticKey(row)) ?? []), row])
    let uniqueCrossFormatAnchors = 0
    for (const [key, rows] of sourceGroups) {
      if (rows.length !== 1) continue
      const candidates = output.slice(0, earlierCount).filter((row) => semanticKey(row) === key)
      if (candidates.length !== 1) continue
      const previousFormats = new Set(candidates[0].statementFormats ?? [])
      if ((rows[0].statementFormats ?? []).some((format) => !previousFormats.has(format))) uniqueCrossFormatAnchors += 1
    }
    const sourceIsStronglyAligned = uniqueCrossFormatAnchors / Math.max(source.rows.length, 1) >= 0.9
    const matches = new Map<number, number>()
    for (const [key, rows] of sourceGroups) {
      const candidates = output.slice(0, earlierCount).map((row, index) => ({ row, index })).filter(({ row }) => semanticKey(row) === key)
      if (rows.length === 1 && candidates.length === 1) {
        const currentFormats = new Set(candidates[0].row.statementFormats ?? [])
        const incomingFormats = rows[0].statementFormats ?? []
        const crossFormat = incomingFormats.some((format) => !currentFormats.has(format))
        if (crossFormat || matchEvidence(candidates[0].row, rows[0]) > 0) {
          // A unique date+amount+direction tuple is a safe fallback across distinct exports.
          matches.set(source.rows.indexOf(rows[0]), candidates[0].index)
          continue
        }
      }
      const rowEdges = rows.map((row) => {
        const scores = candidates.map(({ row: candidate, index }) => ({ index, score: matchEvidence(candidate, row) }))
        const best = Math.max(0, ...scores.map((item) => item.score))
        return best ? { row, score: best, candidates: scores.filter((item) => item.score === best).map((item) => item.index) } : { row, score: 0, candidates: [] as number[] }
      })
      for (const edge of rowEdges) {
        if (edge.candidates.length !== 1) continue
        const candidateIndex = edge.candidates[0]
        const competingRows = rowEdges.filter((other) => other.candidates.length === 1 && other.candidates[0] === candidateIndex)
        if (competingRows.length === 1) matches.set(source.rows.indexOf(edge.row), candidateIndex)
      }
      const crossFormat = rows.some((row) => (row.statementFormats ?? []).some((format) => candidates.some((candidate) => !(candidate.row.statementFormats ?? []).includes(format))))
      if (sourceIsStronglyAligned && crossFormat && rows.length === candidates.length) {
        // If at least 90% of the file has unique cross-format anchors, repeated core keys
        // can be paired by their occurrence order. The whole-file overlap validates that
        // the source exports share the same ordered statement; weaker evidence stays separate.
        const inputIndexes = rows.map((row) => source.rows.indexOf(row))
        const alreadyPairedInput = new Set(inputIndexes.filter((index) => matches.has(index)))
        const pairedOutput = new Set(inputIndexes.flatMap((index) => matches.has(index) ? [matches.get(index)!] : []))
        const remainingInput = inputIndexes.filter((index) => !alreadyPairedInput.has(index))
        const remainingOutput = candidates.map((candidate) => candidate.index).filter((index) => !pairedOutput.has(index))
        if (remainingInput.length === remainingOutput.length) remainingInput.forEach((inputIndex, index) => matches.set(inputIndex, remainingOutput[index]))
      }
    }
    const mergedInputIndexes = new Set<number>()
    const matchedOutputIndexes = new Set<number>()
    for (const [inputIndex, duplicateIndex] of matches) {
      if (matchedOutputIndexes.has(duplicateIndex)) continue
      mergedInputIndexes.add(inputIndex)
      matchedOutputIndexes.add(duplicateIndex)
      overlapBySource[source.id] = (overlapBySource[source.id] ?? 0) + 1
      const current = output[duplicateIndex]
      const row = source.rows[inputIndex]
      const provenance = new Set([...(current.statementSourceIds ?? (current.statementSourceId ? [current.statementSourceId] : [])), source.id])
      const descriptions = new Set([...(current.sourceDescriptions ?? [current.originalDescription]), ...(row.sourceDescriptions ?? [row.originalDescription])])
      const transactionIds = new Set([...(current.sourceTransactionIds ?? []), ...(row.sourceTransactionIds ?? [])])
      const formats = new Set([...(current.statementFormats ?? []), ...(row.statementFormats ?? [])])
      const description = richerDescription(current.originalDescription, row.originalDescription)
      const currentCounterparty = current.counterpartyEvidence ?? (current.counterpartyName ? [{ name: current.counterpartyName, source: current.statementFormats?.includes('OFX') ? 'OFX_NAME' as const : 'CSV_MOBILE' as const }] : [])
      const incomingCounterparty = row.counterpartyEvidence ?? (row.counterpartyName ? [{ name: row.counterpartyName, source: row.statementFormats?.includes('OFX') ? 'OFX_NAME' as const : 'CSV_MOBILE' as const }] : [])
      const counterparty = mergeCounterpartyEvidence(currentCounterparty, incomingCounterparty)
      const currentName = current.counterpartyName ?? (new Set(currentCounterparty.map((item) => normalized(item.name))).size === 1 ? currentCounterparty[0]?.name : undefined)
      const incomingName = row.counterpartyName ?? (new Set(incomingCounterparty.map((item) => normalized(item.name))).size === 1 ? incomingCounterparty[0]?.name : undefined)
      const counterpartyName = preferredCounterpartyName([currentName, incomingName], counterparty.counterpartyEvidence)
      output[duplicateIndex] = {
        ...current, description, originalDescription: description,
        statementSourceIds: [...provenance], sourceDescriptions: [...descriptions],
        sourceTransactionIds: [...transactionIds], statementFormats: [...formats],
        ...counterparty, counterpartyName,
      }
    }
    source.rows.forEach((row, index) => {
      if (mergedInputIndexes.has(index)) return
      output.push({ ...row, statementSourceIds: [...new Set([...(row.statementSourceIds ?? (row.statementSourceId ? [row.statementSourceId] : [])), source.id])] })
    })
  }
  const totalOverlaps = Object.values(overlapBySource).reduce((sum, count) => sum + count, 0)
  return { transactions: output, overlapBySource, totalOverlaps }
}

export function mergeDriveBankSources(manual: BankTransaction[], drive: Record<string, BankTransaction[]>): BankTransaction[] {
  return mergeDriveBankSourcesWithStats(manual, drive).transactions
}
