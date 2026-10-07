import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen, within } from '@testing-library/react'
import { auditBankBalance } from '../domain/bankBalanceAudit'
import type { BankTransaction } from '../domain/types'
import { BalanceAuditPanel } from './BalanceAuditPanel'

afterEach(cleanup)

const transaction = (overrides: Partial<BankTransaction> = {}): BankTransaction => ({
  id: 'bank-1', source: 'BANK', sheetRecordId: null, bankTransactionId: 'tx-1', date: '2026-01-01',
  description: 'Abertura', originalDescription: 'Abertura', amount: 0, direction: 'CREDIT', type: 'OTHER',
  paymentMethod: '', category: '', month: '', year: '2026', isFixed: null, isEssential: null,
  installment: null, totalInstallments: null, balanceAfter: 5000, original: {}, ...overrides,
})

describe('resumo visual da conferência de saldo', () => {
  it('mostra confirmação compacta quando o saldo fecha', () => {
    render(<BalanceAuditPanel audit={auditBankBalance([transaction()])}/>)
    expect(screen.getByText('✓ Extrato conferido')).toBeInTheDocument()
    expect(screen.getByText('Saldo calculado confere com o saldo informado.')).toBeInTheDocument()
    expect(screen.queryByText(/não o total de despesas ausentes/)).not.toBeInTheDocument()
  })

  it('explica que a diferença é aritmética e mostra o detalhamento e linhas ignoradas', () => {
    const audit = auditBankBalance([
      transaction(),
      transaction({ id: 'debit', bankTransactionId: 'tx-2', date: '2026-02-10', description: 'PIX ENVIADO', originalDescription: 'PIX ENVIADO', amount: 1000, direction: 'DEBIT', balanceAfter: 2000 }),
    ], [{ row: 8, reason: 'NO_MOVEMENT', date: '2026-02-09', description: 'COD. LANC. 0', balanceAfter: 4000, amount: 0, direction: 'DEBIT' }])
    render(<BalanceAuditPanel audit={audit}/>)
    expect(screen.getByText('Diferença de conferência do extrato: R$ 20,00')).toBeInTheDocument()
    expect(screen.getByText(/não o total de despesas ausentes/)).toBeInTheDocument()
    const panel = screen.getByRole('region', { name: 'Conferência aritmética do extrato' })
    within(panel).getByText('Ver cálculo').click()
    expect(within(panel).getByText('Saldo inicial')).toBeInTheDocument()
    expect(within(panel).getByText('− Total de saídas')).toBeInTheDocument()
    expect(within(panel).getByText(/1 linha ignorada/)).toBeInTheDocument()
    expect(within(panel).getByText(/saldo preservado como referência/)).toBeInTheDocument()
  })
})
