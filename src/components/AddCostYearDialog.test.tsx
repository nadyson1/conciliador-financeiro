import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { BankTransaction } from '../domain/types'
import { bankDisplayDescription } from '../importers/normalize'
import { AddCostYearDialog } from './AddCostYearDialog'

afterEach(cleanup)

function bankTransaction(originalDescription: string, counterpartyName?: string): BankTransaction {
  return {
    id: 'bank-test', source: 'BANK', sheetRecordId: null, bankTransactionId: 'bank-test',
    date: '2026-03-02', description: originalDescription, originalDescription, amount: 849,
    direction: 'DEBIT', type: 'EXPENSE', paymentMethod: 'Pix', category: '', month: '', year: '2026',
    isFixed: null, isEssential: null, installment: null, totalInstallments: null, balanceAfter: null, original: {},
    ...(counterpartyName ? { counterpartyName } : {}),
  }
}

function renderDialog(transaction: BankTransaction, onSubmit = vi.fn()) {
  render(<AddCostYearDialog transaction={transaction} categories={['Casa']} connected saving={false} error="" onCancel={vi.fn()} onReconnect={vi.fn()} onSubmit={onSubmit}/> )
  return onSubmit
}

describe('formulário Adicionar lançamento à CUSTOS ANO', () => {
  it.each([
    ['Compra no débito', 'Drogarias Globo'],
    ['Pix Enviado Des: Leticia Martins Furta', 'Leticia Martins Furta'],
    ['Pix QR Code Dinâmico Des: Uber do Brasil Tecnol', 'Uber do Brasil Tecnol'],
    ['Pix QR Code Estático Des: Zig*zero Grau Choper', 'Zig*zero Grau Choper'],
  ])('usa a contraparte exibida no card para “%s”', (description, counterparty) => {
    renderDialog(bankTransaction(description, counterparty))
    expect(screen.getByLabelText('Descrição')).toHaveValue(counterparty)
  })

  it('mantém a descrição amigável como fallback quando não há contraparte útil', () => {
    const transaction = bankTransaction('SEGURO CART DEB BRADESCO')
    renderDialog(transaction)
    expect(screen.getByLabelText('Descrição')).toHaveValue(bankDisplayDescription(transaction.originalDescription))
  })

  it('permite editar a sugestão e envia exatamente o texto final digitado', async () => {
    const user = userEvent.setup()
    const onSubmit = renderDialog(bankTransaction('Pix Enviado Des: Uber do Brasil Tecnol', 'Uber do Brasil Tecnol'))
    const description = screen.getByLabelText('Descrição')
    expect(description).toHaveValue('Uber do Brasil Tecnol')
    await user.clear(description)
    await user.type(description, 'Transporte Uber')
    await user.selectOptions(screen.getByLabelText('Categoria'), 'Casa')
    await user.click(screen.getByRole('button', { name: 'Adicionar à CUSTOS ANO' }))
    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({ description: 'Transporte Uber' }))
  })
})
