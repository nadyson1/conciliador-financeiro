import { describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach } from 'vitest'
import userEvent from '@testing-library/user-event'
import { GoogleDrivePanel } from './GoogleDrivePanel'
import type { DriveSyncSummary } from './GoogleDrivePanel'

const folders = { invoices: { id: 'invoices', name: 'Faturas' }, statements: { id: 'statements', name: 'Extratos' } }
const baseProps = { folders, connected: true, configured: true, loading: false, progress: '', lastSync: null, error: '', onSelectFolder: vi.fn(), onSync: vi.fn() }

afterEach(cleanup)

describe('painel de fontes Google Drive', () => {
  it('mostra as pastas configuradas, progresso do lote e sincronização manual', () => {
    render(<GoogleDrivePanel {...baseProps} loading progress="Processando faturas 2 de 3: fatura.pdf" summary={null}/> )
    expect(screen.getByText('✓ Faturas')).toBeInTheDocument()
    expect(screen.getByText('✓ Extratos')).toBeInTheDocument()
    expect(screen.getByRole('status')).toHaveTextContent('Processando faturas 2 de 3')
    expect(screen.getByRole('button', { name: 'Sincronizando…' })).toBeDisabled()
  })

  it('separa arquivos físicos, faturas únicas, duplicados e arquivos ausentes', () => {
    const { container } = render(<GoogleDrivePanel {...baseProps} summary={{ invoicesFound: 10, invoicesUnique: 9, invoiceDuplicates: 1, statementsFound: 2, alreadyKnown: 12, newProcessed: 0, errors: 0, removedFromFolders: 0 }}/> )
    const summary = within(container).getByRole('status')
    expect(summary).toHaveTextContent('10 arquivo(s) encontrado(s) · 9 faturas únicas · 1 duplicado ignorado')
    expect(summary).toHaveTextContent('Arquivos ausentes desde a última listagem: 0')
  })

  it('renderiza uma linha por fatura, destaca o duplicado e mantém sucesso discreto', () => {
    const summary: DriveSyncSummary = {
      invoicesFound: 3, invoicesUnique: 2, invoiceDuplicates: 1, invoiceErrors: 0,
      invoiceFileOutcomes: [
        { fileId: 'a', fileName: 'fatura-junho.pdf', status: 'PROCESSED_UNIQUE', financialIdentity: 'junho' },
        { fileId: 'b', fileName: 'copia-junho.pdf', status: 'DUPLICATE_FINANCIAL', financialIdentity: 'junho' },
        { fileId: 'c', fileName: 'fatura-julho.pdf', status: 'PROCESSED_UNIQUE', financialIdentity: 'julho' },
      ], statementsFound: 0, alreadyKnown: 0, newProcessed: 3, errors: 0, removedFromFolders: 0,
    }
    const { container } = render(<GoogleDrivePanel {...baseProps} summary={summary}/> )
    fireEvent.click(screen.getByText('Status das faturas · 3'))
    const list = container.querySelector<HTMLElement>('.drive-file-list')!
    expect(within(list).getAllByRole('listitem')).toHaveLength(3)
    expect(within(list).getByText('fatura-junho.pdf')).toBeInTheDocument()
    expect(within(list).getByText('copia-junho.pdf')).toBeInTheDocument()
    expect(within(list).getByText('Duplicado financeiro')).toBeInTheDocument()
    expect(within(list).getAllByText('Processado')).toHaveLength(2)
    expect(container.querySelector<HTMLElement>('.drive-file-card.tone-duplicate')).toBeInTheDocument()
    expect(container.querySelector<HTMLElement>('.drive-file-card.tone-success')).toBeInTheDocument()
    expect(screen.getByText('3 arquivos · 2 únicos · 1 duplicados · 0 erros')).toBeInTheDocument()
  })

  it('filtra só problemas e Todos restaura todos os arquivos', () => {
    const summary: DriveSyncSummary = {
      invoicesFound: 3, invoicesUnique: 2,
      invoiceFileOutcomes: [
        { fileId: 'a', fileName: 'normal.pdf', status: 'PROCESSED_UNIQUE' },
        { fileId: 'b', fileName: 'repetida.pdf', status: 'DUPLICATE_FINANCIAL' },
        { fileId: 'c', fileName: 'falha.pdf', status: 'PARSE_ERROR' },
      ], statementsFound: 0, alreadyKnown: 0, newProcessed: 2, errors: 1, removedFromFolders: 0,
    }
    render(<GoogleDrivePanel {...baseProps} summary={summary}/> )
    fireEvent.click(screen.getByText('Status das faturas · 3'))
    fireEvent.click(screen.getByRole('button', { name: /Só problemas/ }))
    expect(screen.queryByText('normal.pdf')).not.toBeInTheDocument()
    expect(screen.getByText('repetida.pdf')).toBeInTheDocument()
    expect(screen.getByText('falha.pdf')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Todos' }))
    expect(screen.getByText('normal.pdf')).toBeInTheDocument()
  })

  it('mantém erro individual em estado visual de alerta', () => {
    const summary: DriveSyncSummary = {
      invoicesFound: 1, invoicesUnique: 0, invoiceErrors: 1,
      invoiceFileOutcomes: [{ fileId: 'bad', fileName: 'corrompida.pdf', status: 'PARSE_ERROR', errorMessage: 'PDF inválido.' }],
      statementsFound: 0, alreadyKnown: 0, newProcessed: 0, errors: 1, removedFromFolders: 0,
    }
    const { container } = render(<GoogleDrivePanel {...baseProps} summary={summary}/> )
    fireEvent.click(screen.getByText('Status das faturas · 1'))
    expect(screen.getByText('corrompida.pdf')).toBeInTheDocument()
    expect(screen.getByText('PDF inválido.')).toBeInTheDocument()
    expect(container.querySelector<HTMLElement>('.drive-file-card.tone-error')).toBeInTheDocument()
  })

  it('resume 9 faturas válidas e 1 duplicado, sem criar erros', () => {
    const outcomes = [
      ...Array.from({ length: 9 }, (_, index) => ({ fileId: `pdf-${index}`, fileName: `fatura-${index}.pdf`, status: 'PROCESSED_UNIQUE' as const, financialIdentity: `invoice-${index}` })),
      { fileId: 'pdf-copy', fileName: 'fatura-copia.pdf', status: 'DUPLICATE_FINANCIAL' as const, financialIdentity: 'invoice-0' },
    ]
    const summary: DriveSyncSummary = {
      invoicesFound: 10, invoicesUnique: 9, invoiceDuplicates: 1, invoiceErrors: 0, invoiceFileOutcomes: outcomes,
      statementsFound: 0, alreadyKnown: 0, newProcessed: 10, errors: 0, removedFromFolders: 0,
    }
    const { container } = render(<GoogleDrivePanel {...baseProps} summary={summary}/> )
    const details = container.querySelector<HTMLElement>('details.drive-diagnostic-toggle')!
    const header = within(details).getByText('Status das faturas · 10').closest('summary') as HTMLElement
    expect(header).toHaveAttribute('aria-expanded', 'false')
    expect(within(header).getByText('▸')).toBeInTheDocument()
    expect(within(header).getByText('10 arquivos · 9 únicos · 1 duplicados · 0 erros')).toBeInTheDocument()
    fireEvent.click(header)
    expect(header).toHaveAttribute('aria-expanded', 'true')
    expect(within(header).getByText('▾')).toBeInTheDocument()
    const list = within(details).getByRole('list')
    expect(within(list).getAllByText('Processado')).toHaveLength(9)
    expect(within(list).getByText('Duplicado financeiro')).toBeInTheDocument()
    expect(within(list).queryByText('Erro')).not.toBeInTheDocument()
  })

  it('expande e recolhe o cabeçalho por teclado, mantendo aria-expanded e filtro interno', async () => {
    const user = userEvent.setup()
    const summary: DriveSyncSummary = {
      invoicesFound: 2, invoicesUnique: 1, invoiceDuplicates: 1,
      invoiceFileOutcomes: [
        { fileId: 'good', fileName: 'boa.pdf', status: 'PROCESSED_UNIQUE', financialIdentity: 'invoice' },
        { fileId: 'copy', fileName: 'copia.pdf', status: 'DUPLICATE_FINANCIAL', financialIdentity: 'invoice' },
      ], statementsFound: 0, alreadyKnown: 0, newProcessed: 2, errors: 0, removedFromFolders: 0,
    }
    const { container } = render(<GoogleDrivePanel {...baseProps} summary={summary}/> )
    const details = container.querySelector<HTMLElement>('details.drive-diagnostic-toggle')!
    const header = within(details).getByText('Status das faturas · 2').closest('summary') as HTMLElement
    header.focus()
    await user.keyboard('{Enter}')
    expect(header).toHaveAttribute('aria-expanded', 'true')
    expect(within(details).getByRole('button', { name: /Só problemas/ })).toBeInTheDocument()
    await user.click(within(details).getByRole('button', { name: /Só problemas/ }))
    expect(within(details).queryByText('boa.pdf')).not.toBeInTheDocument()
    expect(within(details).getByText('copia.pdf')).toBeInTheDocument()
    header.focus()
    await user.keyboard(' ')
    expect(header).toHaveAttribute('aria-expanded', 'false')
  })

  it('tem toggle de extratos e descreve sobreposição como deduplicação de movimentações', () => {
    const summary: DriveSyncSummary = {
      invoicesFound: 0, statementsFound: 2, alreadyKnown: 0, newProcessed: 2, errors: 0, removedFromFolders: 0,
      statementFileOutcomes: [
        { fileId: 'csv1', fileName: 'extrato-jan-jul.csv', status: 'PROCESSED', periodStart: '01/01/2026', periodEnd: '23/07/2026', transactionCount: 611, ignoredRowCount: 2 },
        { fileId: 'csv2', fileName: 'extrato-set-out.csv', status: 'WARNING', periodStart: '01/09/2026', periodEnd: '07/10/2026', transactionCount: 169, overlapCount: 12, detail: '1 aviso na leitura; movimentações válidas foram carregadas.' },
      ],
    }
    render(<GoogleDrivePanel {...baseProps} summary={summary}/> )
    fireEvent.click(screen.getByText(/Status dos extratos · 2/))
    expect(screen.getByText('extrato-jan-jul.csv')).toBeInTheDocument()
    expect(screen.getByText('611 movimentações processadas')).toBeInTheDocument()
    expect(screen.getByText('2 linhas ignoradas')).toBeInTheDocument()
    expect(screen.getByText('extrato-set-out.csv')).toBeInTheDocument()
    expect(screen.getByText('12 movimentações já existiam em outros extratos e foram deduplicadas.')).toBeInTheDocument()
    expect(screen.queryByText(/arquivo duplicado/i)).not.toBeInTheDocument()
  })

  it('preserva nome, período, status e contagem de movimentos em largura mobile', () => {
    const summary: DriveSyncSummary = {
      invoicesFound: 0, statementsFound: 1, alreadyKnown: 0, newProcessed: 1, errors: 0, removedFromFolders: 0,
      statementFileOutcomes: [{ fileId: 'csv', fileName: 'extrato-com-nome-longo-de-outubro.csv', status: 'PROCESSED', periodStart: '01/10/2026', periodEnd: '07/10/2026', transactionCount: 18 }],
    }
    const { container } = render(<GoogleDrivePanel {...baseProps} summary={summary}/> )
    fireEvent.click(screen.getByText(/Status dos extratos · 1/))
    const card = container.querySelector<HTMLElement>('.drive-statement-list .drive-file-card')!
    expect(within(card).getByText('extrato-com-nome-longo-de-outubro.csv')).toBeInTheDocument()
    expect(within(card).getByText('Período declarado: 01/10/2026 → 07/10/2026')).toBeInTheDocument()
    expect(within(card).getByText('18 movimentações processadas')).toBeInTheDocument()
    expect(card).toHaveClass('tone-success')
  })

  it('usa o mesmo cabeçalho expansível acessível nos extratos', () => {
    const summary: DriveSyncSummary = {
      invoicesFound: 0, statementsFound: 1, alreadyKnown: 0, newProcessed: 1, errors: 0, removedFromFolders: 0,
      statementFileOutcomes: [{ fileId: 'csv', fileName: 'extrato.csv', status: 'PROCESSED', transactionCount: 3 }],
    }
    const { container } = render(<GoogleDrivePanel {...baseProps} summary={summary}/> )
    const details = container.querySelector<HTMLElement>('.drive-diagnostic-toggle')!
    const header = within(details).getByText('Status dos extratos · 1').closest('summary') as HTMLElement
    expect(header).toHaveAttribute('aria-expanded', 'false')
    expect(within(header).getByText('▸')).toBeInTheDocument()
    fireEvent.click(header)
    expect(header).toHaveAttribute('aria-expanded', 'true')
    expect(within(header).getByText('▾')).toBeInTheDocument()
    expect(within(details).getByText('extrato.csv')).toBeInTheDocument()
  })

  it('mostra o formato e separa o período declarado das movimentações presentes', () => {
    const summary: DriveSyncSummary = {
      invoicesFound: 0, statementsFound: 1, alreadyKnown: 0, newProcessed: 1, errors: 0, removedFromFolders: 0,
      statementFileOutcomes: [{ fileId: 'ofx', fileName: 'extrato.ofx', status: 'PROCESSED', format: 'OFX', periodStart: '01/01/2026', periodEnd: '01/01/2026', actualPeriodStart: '01/01/2026', actualPeriodEnd: '02/01/2026', transactionCount: 2 }],
    }
    render(<GoogleDrivePanel {...baseProps} summary={summary}/> )
    fireEvent.click(screen.getByText(/Status dos extratos · 1/))
    expect(screen.getByText('Formato: OFX')).toBeInTheDocument()
    expect(screen.getByText('Período declarado: 01/01/2026 → 01/01/2026')).toBeInTheDocument()
    expect(screen.getByText('Movimentações presentes: 01/01/2026 → 02/01/2026')).toBeInTheDocument()
  })

  it('usa Status dos extratos como bloco único e mantém Remover da sessão no arquivo carregado', () => {
    const onRemoveStatement = vi.fn()
    const summary: DriveSyncSummary = {
      invoicesFound: 0, statementsFound: 1, alreadyKnown: 0, newProcessed: 1, errors: 0, removedFromFolders: 0,
      statementFileOutcomes: [{ fileId: 'csv-1', fileName: 'extrato-junho.csv', status: 'PROCESSED', periodStart: '01/06/2026', periodEnd: '30/06/2026', transactionCount: 24 }],
    }
    const { container } = render(<GoogleDrivePanel {...baseProps} summary={summary} loadedStatements={[{ id: 'csv-1', name: 'extrato-junho.csv' }]} onRemoveStatement={onRemoveStatement}/> )
    expect(screen.getByText('Status dos extratos · 1')).toBeInTheDocument()
    expect(screen.queryByText(/Extratos carregados nesta sessão/)).not.toBeInTheDocument()
    fireEvent.click(screen.getByText('Status dos extratos · 1'))
    const item = container.querySelector<HTMLElement>('.drive-statement-list .drive-file-card')!
    expect(within(item).getByText('extrato-junho.csv')).toBeInTheDocument()
    fireEvent.click(within(item).getByRole('button', { name: 'Remover da sessão' }))
    expect(onRemoveStatement).toHaveBeenCalledWith('csv-1')
  })

  it('mantém o resumo de sincronização e sinaliza arquivos que precisam de atenção', () => {
    const { container } = render(<GoogleDrivePanel {...baseProps} summary={{ invoicesFound: 10, invoicesUnique: 8, invoiceDuplicates: 1, invoiceErrors: 1, invoiceFileOutcomes: [
      { fileId: 'copy', fileName: 'copia.pdf', status: 'DUPLICATE_FINANCIAL', financialIdentity: 'invoice-1' },
      { fileId: 'bad', fileName: 'falha.pdf', status: 'PARSE_ERROR' },
    ], statementsFound: 0, alreadyKnown: 0, newProcessed: 0, errors: 1, removedFromFolders: 0 }}/> )
    const summary = within(container).getByRole('status')
    expect(summary).toHaveTextContent('8 faturas únicas · 1 duplicado ignorado')
    expect(summary).toHaveTextContent('Faturas com erro: 1')
    expect(summary).toHaveTextContent('1 arquivo(s) precisam de atenção.')
  })
})
