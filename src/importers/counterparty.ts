import type { CounterpartyEvidence, CounterpartySource, Direction, TransactionType } from '../domain/types'
import { normalizeBankDescription, normalizeDescription } from './normalize'

const COUNTERPARTY_LABEL = /(?:^|\s)(?:des|rem|fav|orig)\s*:\s*(.+)$/i
const DATE_SUFFIX = /\s+\d{1,2}[/.\-]\d{1,2}(?:[/.\-]\d{2,4})?\s*$/
const GENERIC_NAMES = new Set([
  'pix recebido', 'pix enviado', 'pix qr code estatico', 'pix qr code dinamico',
  'compra visa', 'gasto c credito', 'rent inv facil', 'devolucao pix', 'transferencia',
])

export function cleanCounterpartyName(value: string): string {
  return value
    .replace(/^\s*(?:des|rem|fav|orig)\s*:\s*/i, '')
    .replace(DATE_SUFFIX, '')
    .replace(/[\s\-–—:;,|]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

export function labeledCounterparty(value: string): string | null {
  const match = value.match(COUNTERPARTY_LABEL)
  const name = cleanCounterpartyName(match?.[1] ?? '')
  return name ? name : null
}

export function counterpartyEvidence(name: string | null | undefined, source: CounterpartySource): CounterpartyEvidence[] {
  const cleaned = cleanCounterpartyName(name ?? '')
  if (!cleaned || GENERIC_NAMES.has(normalizeDescription(cleaned))) return []
  return [{ name: cleaned, source }]
}

const SOURCE_PRIORITY: Record<CounterpartySource, number> = {
  OFX_NAME: 4,
  OFX_MEMO: 3,
  CSV_INTERNET_BANKING: 2,
  CSV_MOBILE: 1,
}

export function preferredCounterpartyName(names: (string | undefined)[], evidence: CounterpartyEvidence[]) {
  const candidates = names.map((name) => cleanCounterpartyName(name ?? '')).filter(Boolean)
  const normalizedNames = new Set(candidates.map(normalizeDescription))
  if (normalizedNames.size !== 1) return undefined
  const normalizedName = [...normalizedNames][0]
  const preferred = evidence.filter((item) => normalizeDescription(item.name) === normalizedName)
    .sort((a, b) => SOURCE_PRIORITY[b.source] - SOURCE_PRIORITY[a.source] || b.name.length - a.name.length)[0]
  return preferred?.name ?? candidates[0]
}

export function mergeCounterpartyEvidence(...groups: (CounterpartyEvidence[] | undefined)[]) {
  const evidence: CounterpartyEvidence[] = []
  const seen = new Set<string>()
  for (const group of groups) for (const item of group ?? []) {
    const name = cleanCounterpartyName(item.name)
    if (!name) continue
    const key = `${normalizeDescription(name)}|${item.source}`
    if (seen.has(key)) continue
    seen.add(key)
    evidence.push({ name, source: item.source })
  }
  const normalizedNames = new Set(evidence.map((item) => normalizeDescription(item.name)))
  if (normalizedNames.size !== 1) return { counterpartyName: undefined, counterpartyEvidence: evidence }
  const preferred = [...evidence].sort((a, b) => SOURCE_PRIORITY[b.source] - SOURCE_PRIORITY[a.source] || b.name.length - a.name.length)[0]
  return { counterpartyName: preferred?.name, counterpartyEvidence: evidence }
}

/** Extracts labeled PIX/transfer counterparties, or a useful merchant suffix when present. */
export function counterpartyFromDescription(description: string): string | null {
  const labeled = labeledCounterparty(description)
  if (labeled) return labeled
  const merchantSuffix = description.match(/^\s*(?:compra\s+visa|compra\s+debito|debito|compra|pagamento)\s+(.+)$/i)?.[1]
  const cleaned = cleanCounterpartyName(merchantSuffix ?? '')
  return cleaned && !GENERIC_NAMES.has(normalizeDescription(cleaned)) ? cleaned : null
}

export function descriptionWithoutCounterparty(description: string, name: string | null | undefined): string {
  const labeledStart = description.search(/(?:^|\s)(?:des|rem|fav|orig)\s*:/i)
  if (labeledStart >= 0) return description.slice(0, labeledStart).trim()
  const cleanedName = cleanCounterpartyName(name ?? '')
  if (!cleanedName) return description.trim()
  const escaped = cleanedName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return description.replace(new RegExp(`\\s+${escaped}\\s*$`, 'i'), '').trim() || description.trim()
}

export function counterpartyLabel(input: { description: string; direction: Direction; type: TransactionType }): string {
  if (input.direction === 'CREDIT' || input.type === 'REFUND' || input.type === 'INCOME') return 'De'
  const description = normalizeDescription(normalizeBankDescription(input.description).normalizedDescription)
  if (/^(?:pix enviado|pix qr code)/.test(description)) return 'Para'
  if (/^(?:compra no debito|compra)/.test(description)) return 'Estabelecimento'
  return 'Contraparte'
}
