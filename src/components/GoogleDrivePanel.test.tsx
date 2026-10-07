import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { GoogleDrivePanel } from './GoogleDrivePanel'

describe('painel de fontes Google Drive', () => {
  it('mostra as pastas configuradas, progresso do lote e sincronização manual', () => {
    render(<GoogleDrivePanel folders={{ invoices: { id: 'invoices', name: 'Faturas' }, statements: { id: 'statements', name: 'Extratos' } }} connected configured loading progress="Processando faturas 2 de 3: fatura.pdf" lastSync={null} summary={null} error="" onSelectFolder={vi.fn()} onSync={vi.fn()}/>)
    expect(screen.getByText('✓ Faturas')).toBeInTheDocument()
    expect(screen.getByText('✓ Extratos')).toBeInTheDocument()
    expect(screen.getByRole('status')).toHaveTextContent('Processando faturas 2 de 3')
    expect(screen.getByRole('button', { name: 'Sincronizando…' })).toBeDisabled()
  })
})
