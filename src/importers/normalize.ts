export function normalizeDescription(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLocaleLowerCase('pt-BR')
    .replace(/\b(?:compra aprovada|pagamento aprovado|cartao final \d+)\b/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ')
}

export function normalizeAmount(value: string | number | null | undefined): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? Math.round(Math.abs(value) * 100) : null
  if (value == null) return null
  let raw = String(value).trim().replace(/\s/g, '').replace(/R\$/gi, '').replace(/BRL/gi, '')
  if (!raw) return null
  const negative = raw.startsWith('-') || (raw.startsWith('(') && raw.endsWith(')'))
  raw = raw.replace(/[()]/g, '').replace(/^[+-]/, '').replace(/[^\d.,]/g, '')
  if (!raw || !/\d/.test(raw)) return null

  const comma = raw.lastIndexOf(',')
  const dot = raw.lastIndexOf('.')
  let decimalSeparator = ''
  if (comma >= 0 && dot >= 0) decimalSeparator = comma > dot ? ',' : '.'
  else if (comma >= 0) decimalSeparator = ','
  else if (dot >= 0 && raw.length - dot - 1 !== 3) decimalSeparator = '.'

  let normalized: string
  if (decimalSeparator) {
    const last = raw.lastIndexOf(decimalSeparator)
    normalized = `${raw.slice(0, last).replace(/[.,]/g, '')}.${raw.slice(last + 1).replace(/[.,]/g, '')}`
  } else normalized = raw.replace(/[.,]/g, '')

  const amount = Number(normalized)
  if (!Number.isFinite(amount)) return null
  const cents = Math.round(amount * 100)
  return negative ? -cents : cents
}

export function normalizeDate(value: string | number | null | undefined): string | null {
  if (value == null) return null
  const raw = String(value).trim()
  if (!raw) return null
  const iso = raw.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/)
  if (iso) return validDate(Number(iso[1]), Number(iso[2]), Number(iso[3]))
  const dateOnly = raw.match(/^\d{1,2}[/.\-]\d{1,2}[/.\-]\d{2,4}/)?.[0] ?? raw
  const br = dateOnly.match(/^(\d{1,2})[/.\-](\d{1,2})[/.\-](\d{2}|\d{4})$/)
  if (br) {
    let year = Number(br[3])
    if (year < 100) year += year >= 70 ? 1900 : 2000
    return validDate(year, Number(br[2]), Number(br[1]))
  }
  const numeric = dateOnly.match(/^(\d{1,2})\s+(?:de\s+)?([a-záéíóúãõç]+)\s+(?:de\s+)?(\d{4})$/i)
  if (numeric) {
    const months = ['janeiro', 'fevereiro', 'marco', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro']
    const monthName = numeric[2].normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
    const month = months.indexOf(monthName) + 1
    if (month) return validDate(Number(numeric[3]), month, Number(numeric[1]))
  }
  return null
}

function validDate(year: number, month: number, day: number): string | null {
  const date = new Date(Date.UTC(year, month - 1, day))
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null
  return `${year.toString().padStart(4, '0')}-${month.toString().padStart(2, '0')}-${day.toString().padStart(2, '0')}`
}

export function parseBoolean(value: string | undefined): boolean | null {
  if (value == null || !value.trim()) return null
  const normalized = value.trim().toLocaleLowerCase('pt-BR')
  if (['sim', 's', 'true', 'verdadeiro', '1', 'yes', 'y'].includes(normalized)) return true
  if (['não', 'nao', 'n', 'false', 'falso', '0', 'no'].includes(normalized)) return false
  return null
}

export function descriptionSimilarity(left: string, right: string): number {
  const a = normalizeDescription(left)
  const b = normalizeDescription(right)
  if (!a || !b) return 0
  if (a === b) return 1
  const ta = new Set(a.split(' ').filter((token) => token.length > 1))
  const tb = new Set(b.split(' ').filter((token) => token.length > 1))
  if (!ta.size || !tb.size) return 0
  const intersection = [...ta].filter((token) => tb.has(token)).length
  const dice = (2 * intersection) / (ta.size + tb.size)
  const containment = intersection / Math.min(ta.size, tb.size)
  return Math.max(dice, containment * 0.92)
}

export function transactionType(description: string, paymentMethod = ''): 'EXPENSE' | 'INVESTMENT' | 'INCOME' | 'TRANSFER' | 'CARD_PAYMENT' | 'OTHER' {
  const value = normalizeDescription(description)
  const payment = normalizeDescription(paymentMethod)
  if (/^gastos cartao de credito(?: |$)/.test(value)) return 'CARD_PAYMENT'
  if (/resg|resgate|venc(?:imento)? cdb|resg venc/.test(value)) return 'INVESTMENT'
  if (/aplicacao/.test(value) || payment === 'investimento') return 'INVESTMENT'
  if (/transferencia|ted|\bdoc\b|movimentacao interna|entre contas|transf\b/.test(value)) return 'TRANSFER'
  if (/pix recebido|recebimento pix|credito pix/.test(value)) return 'INCOME'
  if (/pix enviado|envio pix|compra|comp cartao|mercado|supermercado|farmacia|drogaria|posto de combustivel/.test(value)) return 'EXPENSE'
  return 'OTHER'
}

export function investmentAction(description: string): 'APPLICATION' | 'RESCUE' | null {
  const value = normalizeDescription(description)
  if (/resg|resgate|venc(?:imento)? cdb|resg venc/.test(value)) return 'RESCUE'
  if (/aplicacao/.test(value)) return 'APPLICATION'
  return null
}
