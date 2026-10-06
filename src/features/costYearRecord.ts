import { normalizeDescription } from '../importers/normalize'

export type CostPaymentSource = 'BANK' | 'STATEMENT'
export const COST_YEAR_PAYMENT_METHODS = ['Pix', 'Débito', 'Débito automático', 'Investimento', 'Crédito_Bradesco'] as const

/** Uses explicit merchant-history patterns only; unknown bank descriptions stay unclassified. */
export function inferCostPaymentMethod(description: string, source: CostPaymentSource = 'BANK'): string {
  if (source === 'STATEMENT') return 'Crédito_Bradesco'
  const value = normalizeDescription(description)
  if (/^pix (?:enviado|qr code dinamico|qr code estatico)(?: |$)/.test(value)) return 'Pix'
  if (/^(?:compra cartao visa|seguro cart deb bradesco)(?: |$)/.test(value)) return 'Débito'
  if (/^conta de telefone(?: |$)/.test(value)) return 'Débito automático'
  if (/^aplicacao cdb(?: |$)/.test(value)) return 'Investimento'
  return ''
}
