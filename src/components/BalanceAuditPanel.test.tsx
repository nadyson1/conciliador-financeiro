import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { auditBankBalance } from '../domain/bankBalanceAudit'
import type { BankTransaction } from '../domain/types'
import { BalanceAuditPanel, StatementBalanceAccordion } from './BalanceAuditPanel'

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
    ], [{ row: 8, reason: 'NO_MOVEMENT', date: '2026-02-09', description: 'COD. LANC. 0', balanceAfter: 5000, amount: 0, direction: 'DEBIT' }])
    render(<BalanceAuditPanel audit={audit}/>)
    expect(screen.getByText('⚠ Diferença de R$ 20,00')).toBeInTheDocument()
    expect(screen.getByText(/independente da CUSTOS ANO e da lista de Ausentes/)).toBeInTheDocument()
    const panel = screen.getByRole('region', { name: 'Conferência aritmética do extrato' })
    within(panel).getByText('Ver cálculo').click()
    expect(within(panel).getByText('Saldo inicial')).toBeInTheDocument()
    expect(within(panel).getByText('− Total de saídas')).toBeInTheDocument()
    expect(within(panel).getByText(/1 linha ignorada/)).toBeInTheDocument()
    expect(within(panel).getAllByText(/saldo preservado como referência/)).toHaveLength(2)
  })

  it('mostra confirmação no cabeçalho recolhido do accordion', () => {
    render(<StatementBalanceAccordion fileName="extrato-ok.csv" audit={auditBankBalance([transaction()])}/>)
    const accordion = screen.getByText('extra....csv').closest('details')
    expect(accordion).not.toBeNull()
    const summary = within(accordion!).getByText('extra....csv').closest('summary')!
    expect(within(summary).getByText('✓ Extrato conferido')).toHaveClass('is-confirmed')
    expect(accordion).not.toHaveAttribute('open')
  })

  it('mostra a diferença no cabeçalho recolhido do accordion', () => {
    const audit = auditBankBalance([
      transaction({ id: 'opening', amount: 0, balanceAfter: 5000 }),
      transaction({ id: 'debit', date: '2026-01-02', amount: 1000, direction: 'DEBIT', balanceAfter: 3997 }),
    ])
    render(<StatementBalanceAccordion fileName="extrato-divergente.csv" audit={audit}/>)
    const accordion = screen.getByText('extra....csv').closest('details')
    expect(accordion).not.toBeNull()
    const summary = within(accordion!).getByText('extra....csv').closest('summary')!
    expect(within(summary).getByText('⚠ Diferença de R$ 0,03')).toHaveClass('is-warning')
    expect(accordion).not.toHaveAttribute('open')
  })

  it('mantém o status conferido e mostra a divergência auxiliar apenas nos detalhes', async () => {
    const audit = auditBankBalance([
      transaction({ id: 'opening', amount: 0, balanceAfter: 10000 }),
      transaction({ id: 'credit', date: '2026-01-02', amount: 3, direction: 'CREDIT', balanceAfter: 10003 }),
      transaction({ id: 'debit', date: '2026-01-03', amount: 3, direction: 'DEBIT', balanceAfter: 10000 }),
    ], [
      { row: 10, reason: 'NO_MOVEMENT', date: '2026-01-03', description: 'COD. LANC. 0', document: '0', balanceAfter: 9997, amount: null, direction: null },
      { row: 11, reason: 'DUPLICATE_AUXILIARY', date: '2026-01-03', description: 'Rendimento', document: '2', balanceAfter: 10000, amount: 3, direction: 'CREDIT', credit: 3, debit: null },
    ])
    render(<StatementBalanceAccordion fileName="extrato-referencia.csv" audit={audit}/>)
    expect(screen.getByText('extra....csv')).toBeInTheDocument()
    const accordion = screen.getByText('extra....csv').closest('details')!
    const auxiliaryNote = within(accordion).getByText(/Referência auxiliar do CSV diverge/)
    expect(auxiliaryNote.closest('[aria-label="Conferência aritmética do extrato"]')).not.toBeNull()
    fireEvent.click(within(accordion).getByText('extra....csv').closest('summary')!)
    await waitFor(() => expect(accordion).toHaveAttribute('open'))
    expect(within(accordion).getByText(/Referência auxiliar do CSV diverge/)).toBeInTheDocument()
    expect(within(accordion).getByText(/a diferença desaparece na linha 11/i)).toBeInTheDocument()
    expect(audit.isBalanced).toBe(true)
    expect(audit.referenceDiscrepancy?.difference).toBe(-3)
  })

  it('encurta o nome e mantém o cabeçalho inteiro acessível e clicável', async () => {
    render(<StatementBalanceAccordion fileName="39fa4349-d8ac-4040-9383-a4815697f0c9.csv" audit={auditBankBalance([transaction()])}/> )
    const shortenedName = screen.getByText('39fa4....csv')
    const summary = shortenedName.closest('summary')!
    const accordion = summary.closest('details')!
    expect(summary).toHaveAttribute('aria-expanded', 'false')
    expect(within(summary).getByText('✓ Extrato conferido')).toHaveClass('is-confirmed')
    expect(within(summary).getByText('▸')).toBeInTheDocument()

    fireEvent.click(summary)
    await waitFor(() => expect(summary).toHaveAttribute('aria-expanded', 'true'))
    expect(accordion).toHaveAttribute('open')
    expect(within(summary).getByText('▾')).toBeInTheDocument()

    fireEvent.click(summary)
    await waitFor(() => expect(summary).toHaveAttribute('aria-expanded', 'false'))
    expect(within(summary).getByText('▸')).toBeInTheDocument()
  })
})
