import { normalizeBankDescription } from '../importers/normalize'

export type CostPaymentSource = 'BANK' | 'STATEMENT'
export const COST_YEAR_PAYMENT_METHODS = ['Pix', 'Débito', 'Débito automático', 'Investimento', 'Crédito_Bradesco'] as const

/** Uses explicit merchant-history patterns only; unknown bank descriptions stay unclassified. */
export function inferCostPaymentMethod(description: string, source: CostPaymentSource = 'BANK'): string {
  if (source === 'STATEMENT') return 'Crédito_Bradesco'
  return normalizeBankDescription(description).suggestedPaymentMethod
}
