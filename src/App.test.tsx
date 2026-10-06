import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { CardStatement } from './domain/types'
import { readCardStatementPdf } from './importers/cardStatement'
import { appendCostYearRecord, GoogleSheetsError, readGoogleSheetLedger, requestGoogleSheetsAccessToken, revokeGoogleSheetsAccessToken } from './integrations/googleSheets'
import { loadGoogleSheetLink, saveGoogleSheetLink } from './integrations/googleSheetLinkStorage'
import { stableFingerprint } from './domain/identity'
import App from './App'

const syntheticStatement: CardStatement = {
  fileName: 'fatura-exemplo.pdf', pageCount: 2, statementIdentity: 'statement-example',
  transactions: [
    { id: 'card-a', purchaseDate: '2025-06-02', invoiceDueDate: '2025-07-12', date: '2025-06-02', description: 'MERCADO EXEMPLO', originalDescription: 'MERCADO EXEMPLO', amount: 6000, direction: 'DEBIT', type: 'PURCHASE', financialStatus: 'ACTIVE', cardIdentifier: '4321 XXXX XXXX 1111', installment: null, totalInstallments: null, city: 'CIDADE A', currency: 'BRL', exchangeRate: null, statementDueDate: '2025-07-12', statementTotal: 10000 },
    { id: 'card-b', purchaseDate: '2025-06-10', invoiceDueDate: '2025-07-12', date: '2025-06-10', description: 'LOJA TESTE', originalDescription: 'LOJA TESTE', amount: 4000, direction: 'DEBIT', type: 'PURCHASE', financialStatus: 'ACTIVE', cardIdentifier: '4321 XXXX XXXX 2222', installment: null, totalInstallments: null, city: 'CIDADE B', currency: 'BRL', exchangeRate: null, statementDueDate: '2025-07-12', statementTotal: 10000 },
    { id: 'card-c', purchaseDate: '2025-06-12', invoiceDueDate: '2025-07-12', date: '2025-06-12', description: 'ESTORNO MODELO', originalDescription: 'ESTORNO MODELO', amount: 900, direction: 'CREDIT', type: 'REFUND', financialStatus: 'ACTIVE', cardIdentifier: '4321 XXXX XXXX 1111', installment: null, totalInstallments: null, city: 'CIDADE A', currency: 'BRL', exchangeRate: null, statementDueDate: '2025-07-12', statementTotal: 10000 },
  ],
  cardSubtotals: [{ cardIdentifier: '4321 XXXX XXXX 1111', amount: 6000 }, { cardIdentifier: '4321 XXXX XXXX 2222', amount: 4000 }],
  reportedTotal: 10000, purchasesDebitsTotal: 10000, creditsPaymentsTotal: null, previousBalance: null, previousPayment: 5000, accountingDifference: null,
  dueDate: '2025-07-12', nextClosingDate: '2025-07-30', errors: [],
}

const savedDecisionStore = vi.hoisted(() => new Map<string, { key: string; schemaVersion: 1; kind: string; identities: string[]; selected: string[]; updatedAt: string }>())
const googleSheetsMocks = vi.hoisted(() => ({ read: vi.fn(), append: vi.fn(), requestToken: vi.fn(), revoke: vi.fn() }))
const decisionSyncMocks = vi.hoisted(() => ({ sync: vi.fn(), save: vi.fn(), deletion: vi.fn(), tombstone: vi.fn() }))

vi.mock('./domain/localDecisions', () => ({
  decisionKey: (kind: string, identities: string[]) => `${kind}:${JSON.stringify(identities)}`,
  listPersistedDecisions: async () => [...savedDecisionStore.values()],
  savePersistedDecision: async (decision: { key: string; kind: string; identities: string[]; selected: string[] }) => { const record = { ...decision, schemaVersion: 1 as const, updatedAt: new Date().toISOString() }; savedDecisionStore.set(decision.key, record); return record },
  deletePersistedDecision: async (key: string) => savedDecisionStore.delete(key),
  clearPersistedDecisions: async () => savedDecisionStore.clear(),
}))

vi.mock('./integrations/googleSheetDecisions', () => ({
  addDecisionTombstone: decisionSyncMocks.tombstone, listDecisionTombstones: () => ({}), removeDecisionTombstone: vi.fn(),
  syncGoogleSheetDecisions: decisionSyncMocks.sync, syncOneGoogleSheetDecision: decisionSyncMocks.save, syncOneGoogleSheetDeletion: decisionSyncMocks.deletion,
}))

vi.mock('./components/pwaRegistration', () => ({ useRegisterSW: () => ({ needRefresh: [false, vi.fn()], offlineReady: [false, vi.fn()], updateServiceWorker: vi.fn() }) }))

vi.mock('./importers/cardStatement', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./importers/cardStatement')>()
  return { ...actual, readCardStatementPdf: vi.fn(async () => syntheticStatement) }
})

vi.mock('./integrations/googleSheets', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./integrations/googleSheets')>()
  return { ...actual, appendCostYearRecord: googleSheetsMocks.append, readGoogleSheetLedger: googleSheetsMocks.read, requestGoogleSheetsAccessToken: googleSheetsMocks.requestToken, revokeGoogleSheetsAccessToken: googleSheetsMocks.revoke }
})

beforeEach(() => {
  // clearMocks clears call history, but it does not discard queued
  // mockResolvedValueOnce/mockRejectedValueOnce implementations.
  savedDecisionStore.clear()
  localStorage.clear()
  sessionStorage.clear()
  googleSheetsMocks.read.mockReset()
  googleSheetsMocks.append.mockReset()
  googleSheetsMocks.requestToken.mockReset()
  googleSheetsMocks.revoke.mockReset()
  decisionSyncMocks.sync.mockReset().mockImplementation(async (_id: string, _token: string, local: unknown[]) => local)
  decisionSyncMocks.save.mockReset()
  decisionSyncMocks.deletion.mockReset()
  decisionSyncMocks.tombstone.mockReset()
  vi.mocked(readCardStatementPdf).mockReset()
  vi.mocked(readCardStatementPdf).mockImplementation(async () => syntheticStatement)
  vi.mocked(requestGoogleSheetsAccessToken).mockResolvedValue('test-access-token')
  vi.mocked(readGoogleSheetLedger).mockResolvedValue({ spreadsheetId: 'spreadsheet-id-12345', spreadsheetTitle: 'CONTROLE ORÇAMENTÁRIO PESSOAL 2026', transactions: [], rowCount: 1 })
  vi.spyOn(window, 'scrollTo').mockImplementation(() => undefined)
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('fluxo completo no navegador', () => {
  it('adiciona somente após confirmação, valida campos e associa a nova linha ao ausente', async () => {
    const user = userEvent.setup()
    const existing = { id: 'sheet-old', source: 'SHEET' as const, sheetRecordId: 'sheet-old', bankTransactionId: null, date: '2026-01-05', description: 'Escola', originalDescription: 'Escola', amount: 9900, direction: 'DEBIT' as const, type: 'EXPENSE' as const, paymentMethod: 'Pix', category: 'Casa', month: '01 - Janeiro', year: '2026', isFixed: false, isEssential: false, installment: null, totalInstallments: null, balanceAfter: null, original: {} }
    const created = { ...existing, id: 'sheet-new', sheetRecordId: 'abcd1234', date: '2026-01-08', description: 'PIX ENVIADO MERCADO', originalDescription: 'PIX ENVIADO MERCADO', amount: 4500, category: 'Casa', paymentMethod: 'Pix' }
    googleSheetsMocks.read.mockResolvedValue({ spreadsheetId: 'spreadsheet-id-12345', spreadsheetTitle: 'Planilha para escrita', transactions: [existing], rowCount: 1 })
    saveGoogleSheetLink({ spreadsheetId: 'spreadsheet-id-12345', sheetName: 'CUSTOS ANO', spreadsheetTitle: 'Planilha para escrita', lastUpdated: null, autoConnect: true })
    render(<App />)
    await screen.findByText(/Lançamentos carregados do Google Sheets/)
    await user.upload(screen.getByLabelText('Selecionar arquivo CSV'), new File(['Data,Descrição,Valor,Tipo\n08/01/2026,PIX ENVIADO MERCADO,"45,00",Débito'], 'banco.csv', { type: 'text/csv' }))
    await user.click(await screen.findByRole('button', { name: 'Usar 1 linha(s) válidas' }))
    await user.click(screen.getByRole('button', { name: /Conciliar agora/ }))
    await user.click(screen.getByRole('tab', { name: /Ausentes/ }))
    await user.click(await screen.findByRole('button', { name: 'Adicionar à CUSTOS ANO' }))
    const dialog = screen.getByRole('dialog', { name: 'Adicionar lançamento à CUSTOS ANO' })
    expect(dialog).toBeInTheDocument()
    expect(screen.getByLabelText('Descrição')).toHaveValue('PIX ENVIADO MERCADO')
    expect(screen.getByLabelText('Data')).toHaveValue('2026-01-08')
    expect(screen.getByLabelText('Custo (R$)')).toHaveValue(45)
    expect(screen.getByLabelText('Categoria')).toHaveValue('')
    expect(screen.getByLabelText('Forma de pagamento')).toHaveValue('Pix')
    expect(appendCostYearRecord).not.toHaveBeenCalled()
    await user.selectOptions(screen.getByLabelText('Categoria'), 'Casa')
    await user.clear(screen.getByLabelText('Descrição'))
    await user.click(within(dialog).getByRole('button', { name: 'Adicionar à CUSTOS ANO' }))
    expect(await screen.findByText('Informe uma descrição.')).toBeInTheDocument()
    expect(appendCostYearRecord).not.toHaveBeenCalled()
    await user.type(screen.getByLabelText('Descrição'), 'PIX ENVIADO MERCADO')
    const appendResult = { spreadsheetId: 'spreadsheet-id-12345', spreadsheetTitle: 'Planilha para escrita', transactions: [existing, created], rowCount: 2, transaction: created, alreadyPresent: false }
    let resolveAppend!: (value: typeof appendResult) => void
    googleSheetsMocks.append.mockImplementationOnce(() => new Promise((resolve) => { resolveAppend = resolve }))
    await user.dblClick(within(dialog).getByRole('button', { name: 'Adicionar à CUSTOS ANO' }))
    expect(appendCostYearRecord).toHaveBeenCalledOnce()
    expect([...savedDecisionStore.values()].some((decision) => decision.kind === 'MISSING_ADDED_TO_SHEET' && decision.selected[0] === 'abcd1234')).toBe(false)
    resolveAppend(appendResult)
    expect(await screen.findByText('Lançamento adicionado à CUSTOS ANO e confirmado na conciliação.')).toBeInTheDocument()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(appendCostYearRecord).toHaveBeenCalledWith('spreadsheet-id-12345', 'test-access-token', expect.objectContaining({ description: 'PIX ENVIADO MERCADO', date: '2026-01-08', amount: 4500, category: 'Casa', paymentMethod: 'Pix', isFixed: false, isEssential: false }))
    expect([...savedDecisionStore.values()].some((decision) => decision.kind === 'MISSING_ADDED_TO_SHEET' && decision.selected[0] === 'abcd1234')).toBe(true)
    expect(screen.getByRole('button', { name: /Ausentes/ })).toHaveTextContent('0')
  })

  it('agrupa os rendimentos Invest Fácil fora de Ausentes e não oferece adicionar crédito', async () => {
    const user = userEvent.setup()
    render(<App />)
    const sheet = new File(['Descrição,Data,Custo\nEscola,01/01/2026,"90,00"'], 'custos.csv', { type: 'text/csv' })
    const bank = new File(['Data,Histórico,Crédito (R$),Débito (R$)\n02/10/2026,RENTAB.INVEST FACILCRED*,"0,03",\n03/10/2026,RENTAB.INVEST FACILCRED*,"0,02",\n04/10/2026,RENTAB.INVEST FACILCRED*,"0,01",\n05/10/2026,PIX RECEBIDO,"12,00",'], 'extrato.csv', { type: 'text/csv' })
    await user.upload(screen.getAllByLabelText('Selecionar arquivo CSV')[0], sheet)
    await user.click(await screen.findByRole('button', { name: 'Usar 1 linha(s) válidas' }))
    await user.upload(screen.getAllByLabelText('Selecionar arquivo CSV')[1], bank)
    await user.click(await screen.findByRole('button', { name: 'Usar 4 linha(s) válidas' }))
    await user.click(screen.getByRole('button', { name: /Conciliar agora/ }))
    await user.click(screen.getByRole('tab', { name: /Fora do escopo/ }))
    expect(screen.getByText('Rendimentos Invest Fácil')).toBeInTheDocument()
    expect(screen.getByText(/3 créditos · total R\$ 0,06/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Adicionar à CUSTOS ANO' })).not.toBeInTheDocument()
    await user.click(screen.getByRole('tab', { name: /Ausentes/ }))
    expect(screen.queryByText('PIX RECEBIDO')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Adicionar à CUSTOS ANO' })).not.toBeInTheDocument()
  })

  it('mostra Adicionar à CUSTOS ANO para todas as despesas bancárias MISSING cobertas por regras determinísticas', async () => {
    const user = userEvent.setup()
    render(<App />)
    await user.upload(screen.getAllByLabelText('Selecionar arquivo CSV')[0], new File(['Descrição,Data,Custo\nEscola,01/01/2026,"90,00"'], 'custos.csv', { type: 'text/csv' }))
    await user.click(await screen.findByRole('button', { name: 'Usar 1 linha(s) válidas' }))
    const bankCsv = [
      'Data,Histórico,Valor,Tipo',
      '08/01/2026,PIX ENVIADO,"5,01",Débito',
      '08/01/2026,PIX QR CODE DINAMICO,"5,02",Débito',
      '08/01/2026,PIX QR CODE ESTATICO,"5,03",Débito',
      '08/01/2026,COMPRA CARTAO VISA,"5,04",Débito',
      '08/01/2026,SEGURO CART DEB BRADESCO,"5,05",Débito',
      '08/01/2026,CONTA DE TELEFONE,"5,06",Débito',
    ].join('\n')
    await user.upload(screen.getAllByLabelText('Selecionar arquivo CSV')[1], new File([bankCsv], 'extrato.csv', { type: 'text/csv' }))
    await user.click(await screen.findByRole('button', { name: 'Usar 6 linha(s) válidas' }))
    await user.click(screen.getByRole('button', { name: /Conciliar agora/ }))
    await user.click(screen.getByRole('tab', { name: /Ausentes/ }))
    expect(screen.getAllByRole('button', { name: 'Adicionar à CUSTOS ANO' })).toHaveLength(6)
  })

  it('não mostra PIX legado como ausente quando Transferência histórica existe na CUSTOS ANO', async () => {
    const user = userEvent.setup()
    render(<App />)
    await user.upload(screen.getAllByLabelText('Selecionar arquivo CSV')[0], new File(['Descrição,Data,Custo,Forma de pagamento\nTransferencia para CC Nubank,08/01/2026,"60,00",Transferência'], 'custos.csv', { type: 'text/csv' }))
    await user.click(await screen.findByRole('button', { name: 'Usar 1 linha(s) válidas' }))
    await user.upload(screen.getAllByLabelText('Selecionar arquivo CSV')[1], new File(['Data,Histórico,Valor,Tipo\n08/01/2026,PIX ENVIADO,"60,00",Débito'], 'extrato.csv', { type: 'text/csv' }))
    await user.click(await screen.findByRole('button', { name: 'Usar 1 linha(s) válidas' }))
    await user.click(screen.getByRole('button', { name: /Conciliar agora/ }))
    expect(screen.getByRole('button', { name: /Conciliadas/ })).toHaveTextContent('1')
    await user.click(screen.getByRole('tab', { name: /Ausentes/ }))
    expect(screen.getByText('Nenhuma despesa ausente')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Adicionar à CUSTOS ANO' })).not.toBeInTheDocument()
  })

  it('abre inclusão de despesa com forma desconhecida vazia e exige escolha antes de gravar', async () => {
    const user = userEvent.setup()
    googleSheetsMocks.read.mockResolvedValue({ spreadsheetId: 'spreadsheet-id-12345', spreadsheetTitle: 'Planilha para escrita', transactions: [{ id: 'category-row', source: 'SHEET', sheetRecordId: 'category-row', bankTransactionId: null, date: '2026-01-01', description: 'Escola', originalDescription: 'Escola', amount: 9000, direction: 'DEBIT', type: 'EXPENSE', paymentMethod: 'Pix', category: 'Casa', month: '01 - Janeiro', year: '2026', isFixed: false, isEssential: false, installment: null, totalInstallments: null, balanceAfter: null, original: {} }], rowCount: 1 })
    saveGoogleSheetLink({ spreadsheetId: 'spreadsheet-id-12345', sheetName: 'CUSTOS ANO', spreadsheetTitle: 'Planilha para escrita', lastUpdated: null, autoConnect: true })
    render(<App />)
    await screen.findByText(/Lançamentos carregados do Google Sheets/)
    await user.upload(screen.getByLabelText('Selecionar arquivo CSV'), new File(['Data,Descrição,Valor,Tipo\n08/01/2026,COMPRA DE SERVICO,"45,00",Débito'], 'banco.csv', { type: 'text/csv' }))
    await user.click(await screen.findByRole('button', { name: 'Usar 1 linha(s) válidas' }))
    await user.click(screen.getByRole('button', { name: /Conciliar agora/ }))
    await user.click(screen.getByRole('tab', { name: /Ausentes/ }))
    await user.click(await screen.findByRole('button', { name: 'Adicionar à CUSTOS ANO' }))
    expect(screen.getByLabelText('Forma de pagamento')).toHaveValue('')
    await user.selectOptions(screen.getByLabelText('Categoria'), 'Casa')
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Adicionar à CUSTOS ANO' }))
    expect(await screen.findByText('Selecione uma forma de pagamento válida.')).toBeInTheDocument()
    expect(appendCostYearRecord).not.toHaveBeenCalled()
  })

  it('mantém o ausente e os campos preenchidos após falha de token e permite reconectar', async () => {
    const user = userEvent.setup()
    const existing = { id: 'sheet-old', source: 'SHEET' as const, sheetRecordId: 'sheet-old', bankTransactionId: null, date: '2026-01-05', description: 'Escola', originalDescription: 'Escola', amount: 9900, direction: 'DEBIT' as const, type: 'EXPENSE' as const, paymentMethod: 'Pix', category: 'Casa', month: '01 - Janeiro', year: '2026', isFixed: false, isEssential: false, installment: null, totalInstallments: null, balanceAfter: null, original: {} }
    googleSheetsMocks.read.mockResolvedValue({ spreadsheetId: 'spreadsheet-id-12345', spreadsheetTitle: 'Planilha para escrita', transactions: [existing], rowCount: 1 })
    googleSheetsMocks.append.mockRejectedValueOnce(new GoogleSheetsError('Autorização expirada.', 'AUTH'))
    saveGoogleSheetLink({ spreadsheetId: 'spreadsheet-id-12345', sheetName: 'CUSTOS ANO', spreadsheetTitle: 'Planilha para escrita', lastUpdated: null, autoConnect: true })
    render(<App />)
    await screen.findByText(/Lançamentos carregados do Google Sheets/)
    await user.upload(screen.getByLabelText('Selecionar arquivo CSV'), new File(['Data,Descrição,Valor,Tipo\n08/01/2026,PIX ENVIADO MERCADO,"45,00",Débito'], 'banco.csv', { type: 'text/csv' }))
    await user.click(await screen.findByRole('button', { name: 'Usar 1 linha(s) válidas' }))
    await user.click(screen.getByRole('button', { name: /Conciliar agora/ }))
    await user.click(screen.getByRole('tab', { name: /Ausentes/ }))
    await user.click(await screen.findByRole('button', { name: 'Adicionar à CUSTOS ANO' }))
    const dialog = screen.getByRole('dialog')
    await user.selectOptions(screen.getByLabelText('Categoria'), 'Casa')
    await user.click(within(dialog).getByRole('button', { name: 'Adicionar à CUSTOS ANO' }))
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('Autorização expirada')
    expect(screen.getByLabelText('Descrição')).toHaveValue('PIX ENVIADO MERCADO')
    expect(screen.getByRole('button', { name: /Ausentes/ })).toHaveTextContent('1')
    await user.click(within(dialog).getByRole('button', { name: 'Reconectar Google' }))
    await waitFor(() => expect(readGoogleSheetLedger).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(within(dialog).queryByRole('button', { name: 'Reconectar Google' })).not.toBeInTheDocument())
    expect(screen.getByLabelText('Descrição')).toHaveValue('PIX ENVIADO MERCADO')
    expect(screen.getByRole('button', { name: /Ausentes/ })).toHaveTextContent('1')
  })

  it('restaura o vínculo e tenta atualizar uma vez ao abrir o app', async () => {
    saveGoogleSheetLink({ spreadsheetId: 'spreadsheet-id-12345', sheetName: 'CUSTOS ANO', spreadsheetTitle: 'CONTROLE ORÇAMENTÁRIO PESSOAL 2026', lastUpdated: '2026-10-06T03:19:00.000Z', autoConnect: true })
    render(<App />)
    await waitFor(() => expect(readGoogleSheetLedger).toHaveBeenCalledOnce())
    expect(requestGoogleSheetsAccessToken).toHaveBeenCalledOnce()
    expect(requestGoogleSheetsAccessToken).toHaveBeenCalledWith(expect.any(String), '')
    expect(screen.getByText('CONTROLE ORÇAMENTÁRIO PESSOAL 2026')).toBeInTheDocument()
    expect(screen.getByText('Aba: CUSTOS ANO')).toBeInTheDocument()
    expect(screen.queryByLabelText('URL ou ID da planilha')).not.toBeInTheDocument()
    expect(loadGoogleSheetLink()?.spreadsheetId).toBe('spreadsheet-id-12345')
  })

  it('sincroniza decisões após carregar a planilha e permite sincronização manual', async () => {
    const user = userEvent.setup()
    saveGoogleSheetLink({ spreadsheetId: 'spreadsheet-id-12345', sheetName: 'CUSTOS ANO', spreadsheetTitle: 'Planilha sincronizada', lastUpdated: null, autoConnect: true })
    render(<App />)
    expect(await screen.findByRole('status')).toHaveTextContent('Decisões sincronizadas')
    expect(decisionSyncMocks.sync).toHaveBeenCalledWith('spreadsheet-id-12345', 'test-access-token', [], {})
    await user.click(screen.getByRole('button', { name: 'Sincronizar decisões' }))
    await waitFor(() => expect(decisionSyncMocks.sync).toHaveBeenCalledTimes(2))
  })

  it('oculta o upload CUSTOS ANO ao escolher Google Sheets e permite voltar ao CSV sem desconectar', async () => {
    const user = userEvent.setup()
    vi.mocked(readGoogleSheetLedger).mockResolvedValue({ spreadsheetId: 'spreadsheet-id-12345', spreadsheetTitle: 'Planilha de exemplo', transactions: [{ id: 'sheet-a', source: 'SHEET', sheetRecordId: 'row-a', bankTransactionId: null, date: '2026-05-12', description: 'Mercado', originalDescription: 'Mercado', amount: 5000, direction: 'DEBIT', type: 'EXPENSE', paymentMethod: 'Pix', category: 'Casa', month: '05 - Maio', year: '2026', isFixed: false, isEssential: true, installment: null, totalInstallments: null, balanceAfter: null, original: {} }], rowCount: 1 })
    saveGoogleSheetLink({ spreadsheetId: 'spreadsheet-id-12345', sheetName: 'CUSTOS ANO', spreadsheetTitle: 'Planilha de exemplo', lastUpdated: null, autoConnect: true })
    render(<App />)
    await screen.findByText(/Lançamentos carregados do Google Sheets/)
    const sourceOptions = within(screen.getByRole('group', { name: 'FONTE DOS LANÇAMENTOS' }))
    await user.click(sourceOptions.getByRole('radio', { name: /Google Sheets/ }))
    expect(screen.queryByRole('heading', { name: 'Importar lançamentos' })).not.toBeInTheDocument()
    expect(screen.getAllByLabelText('Selecionar arquivo CSV')).toHaveLength(1)
    await user.click(sourceOptions.getByRole('radio', { name: 'Importar CSV' }))
    expect(screen.getByRole('heading', { name: 'Importar lançamentos' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Sincronizar decisões' })).toBeInTheDocument()
    expect(screen.getByText(/Google conectado/)).toBeInTheDocument()
    await user.upload(screen.getAllByLabelText('Selecionar arquivo CSV')[0], new File(['Descrição,Data,Custo\nMercado local,08/01/2026,"45,00"'], 'custos-local.csv', { type: 'text/csv' }))
    await user.click(await screen.findByRole('button', { name: 'Usar 1 linha(s) válidas' }))
    vi.mocked(readGoogleSheetLedger).mockResolvedValueOnce({ spreadsheetId: 'spreadsheet-id-12345', spreadsheetTitle: 'Planilha atualizada', transactions: [], rowCount: 3 })
    await user.click(screen.getByRole('button', { name: 'Atualizar dados' }))
    await screen.findByText('Planilha atualizada')
    expect(screen.getByRole('heading', { name: 'Importar lançamentos' })).toBeInTheDocument()
    expect(screen.getByText('1 movimentações carregadas')).toBeInTheDocument()
    expect(sourceOptions.getByRole('radio', { name: 'Importar CSV' })).toBeChecked()
  })

  it('disponibiliza a mesma sincronização nos resultados e preserva decisões locais em caso de falha', async () => {
    const user = userEvent.setup()
    const seededDecision = { key: 'BANK_IGNORED:["bank:fingerprint"]', schemaVersion: 1 as const, kind: 'BANK_IGNORED', identities: ['bank:fingerprint'], selected: [], updatedAt: '2026-10-06T00:00:00.000Z' }
    savedDecisionStore.set(seededDecision.key, seededDecision)
    vi.mocked(readGoogleSheetLedger).mockResolvedValue({ spreadsheetId: 'spreadsheet-id-12345', spreadsheetTitle: 'Planilha pronta', transactions: [{ id: 'sheet-a', source: 'SHEET', sheetRecordId: 'row-a', bankTransactionId: null, date: '2026-01-08', description: 'Mercado', originalDescription: 'Mercado', amount: 4500, direction: 'DEBIT', type: 'EXPENSE', paymentMethod: 'Pix', category: 'Casa', month: '01 - Janeiro', year: '2026', isFixed: false, isEssential: true, installment: null, totalInstallments: null, balanceAfter: null, original: {} }], rowCount: 1 })
    saveGoogleSheetLink({ spreadsheetId: 'spreadsheet-id-12345', sheetName: 'CUSTOS ANO', spreadsheetTitle: 'Planilha pronta', lastUpdated: null, autoConnect: true })
    render(<App />)
    await screen.findByText(/Lançamentos carregados do Google Sheets/)
    await user.upload(screen.getByLabelText('Selecionar arquivo CSV'), new File(['Data,Descrição,Valor,Tipo\n08/01/2026,Mercado,"45,00",Débito'], 'banco.csv', { type: 'text/csv' }))
    await user.click(await screen.findByRole('button', { name: 'Usar 1 linha(s) válidas' }))
    await user.click(screen.getByRole('button', { name: /Conciliar agora/ }))
    expect(screen.getByRole('button', { name: 'Sincronizar decisões' })).toBeInTheDocument()
    decisionSyncMocks.sync.mockRejectedValueOnce(new Error('Falha sintética'))
    await user.click(screen.getByRole('button', { name: 'Sincronizar decisões' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Decisões mantidas neste dispositivo')
    expect(savedDecisionStore.has(seededDecision.key)).toBe(true)
  })

  it('faz scroll para o topo somente ao entrar nos resultados', async () => {
    const user = userEvent.setup()
    render(<App />)
    const files = [
      new File(['Descrição,Data,Custo\nMercado,08/01/2026,"45,00"'], 'custos.csv', { type: 'text/csv' }),
      new File(['Data,Descrição,Valor,Tipo\n08/01/2026,Mercado,"45,00",Débito'], 'banco.csv', { type: 'text/csv' }),
    ]
    await user.upload(screen.getAllByLabelText('Selecionar arquivo CSV')[0], files[0])
    await user.click(await screen.findByRole('button', { name: 'Usar 1 linha(s) válidas' }))
    await user.upload(screen.getAllByLabelText('Selecionar arquivo CSV')[1], files[1])
    await user.click(await screen.findByRole('button', { name: 'Usar 1 linha(s) válidas' }))
    await user.click(screen.getByRole('button', { name: /Conciliar agora/ }))
    expect(window.scrollTo).toHaveBeenCalledOnce()
    expect(window.scrollTo).toHaveBeenCalledWith({ top: 0, left: 0, behavior: 'auto' })
    await user.click(screen.getByRole('tab', { name: /Ausentes/ }))
    expect(window.scrollTo).toHaveBeenCalledOnce()
  })

  it('mantém a ação sticky oculta quando o botão original está visível', () => {
    class VisibleObserver {
      constructor(private callback: IntersectionObserverCallback) {}
      observe(target: Element) { this.callback([{ isIntersecting: true, target } as IntersectionObserverEntry], this as unknown as IntersectionObserver) }
      disconnect() {}
      unobserve() {}
      takeRecords() { return [] }
      root = null
      rootMargin = '0px'
      thresholds = [0]
    }
    vi.stubGlobal('IntersectionObserver', VisibleObserver)
    render(<App />)
    expect(screen.getByRole('button', { name: /Conciliar agora/ })).toBeInTheDocument()
    expect(document.querySelector('.sticky-reconcile')).not.toBeInTheDocument()
  })

  it('mostra ação sticky quando o botão original sai da viewport e mantém as validações', async () => {
    const user = userEvent.setup()
    class HiddenObserver {
      constructor(private callback: IntersectionObserverCallback) {}
      observe(target: Element) { this.callback([{ isIntersecting: false, target } as IntersectionObserverEntry], this as unknown as IntersectionObserver) }
      disconnect() {}
      unobserve() {}
      takeRecords() { return [] }
      root = null
      rootMargin = '0px'
      thresholds = [0]
    }
    vi.stubGlobal('IntersectionObserver', HiddenObserver)
    render(<App />)
    const sticky = await screen.findByRole('button', { name: 'Conciliar agora' })
    expect(sticky).toBeDisabled()
    await user.upload(screen.getAllByLabelText('Selecionar arquivo CSV')[0], new File(['Descrição,Data,Custo\nMercado,08/01/2026,"45,00"'], 'custos.csv', { type: 'text/csv' }))
    await user.click(await screen.findByRole('button', { name: 'Usar 1 linha(s) válidas' }))
    await user.upload(screen.getAllByLabelText('Selecionar arquivo CSV')[1], new File(['Data,Descrição,Valor,Tipo\n08/01/2026,Mercado,"45,00",Débito'], 'banco.csv', { type: 'text/csv' }))
    await user.click(await screen.findByRole('button', { name: 'Usar 1 linha(s) válidas' }))
    expect(screen.getByRole('button', { name: 'Conciliar agora' })).toBeEnabled()
    await user.click(screen.getByRole('button', { name: 'Conciliar agora' }))
    expect(await screen.findByRole('heading', { name: 'Visão geral' })).toBeInTheDocument()
  })

  it('mantém vínculo com token expirado e atualiza os dados após reconectar', async () => {
    const user = userEvent.setup()
    saveGoogleSheetLink({ spreadsheetId: 'spreadsheet-id-12345', sheetName: 'CUSTOS ANO', spreadsheetTitle: 'CONTROLE ORÇAMENTÁRIO PESSOAL 2026', lastUpdated: null, autoConnect: true })
    vi.mocked(readGoogleSheetLedger).mockRejectedValueOnce(new GoogleSheetsError('A autorização expirou.', 'AUTH'))
    vi.mocked(requestGoogleSheetsAccessToken).mockResolvedValueOnce('expired-token').mockRejectedValueOnce(new GoogleSheetsError('É necessário reconectar.', 'AUTH'))
    vi.mocked(readGoogleSheetLedger).mockResolvedValue({ spreadsheetId: 'spreadsheet-id-12345', spreadsheetTitle: 'Planilha atualizada após reconexão', transactions: [], rowCount: 2 })
    render(<App />)
    await waitFor(() => expect(loadGoogleSheetLink()).toMatchObject({ spreadsheetId: 'spreadsheet-id-12345', autoConnect: false }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Reconectar Google' })).toBeEnabled())
    const reconnect = await screen.findByRole('button', { name: 'Reconectar Google' })
    await user.click(reconnect)
    await screen.findByText('Planilha atualizada após reconexão')
    await screen.findByRole('button', { name: 'Atualizar dados' })
    expect(googleSheetsMocks.read).toHaveBeenCalledWith('spreadsheet-id-12345', 'test-access-token')
    expect(loadGoogleSheetLink()).toMatchObject({ spreadsheetId: 'spreadsheet-id-12345', autoConnect: true })
  })

  it('troca a planilha somente depois que a nova CUSTOS ANO é validada e lida', async () => {
    const user = userEvent.setup()
    saveGoogleSheetLink({ spreadsheetId: 'spreadsheet-id-12345', sheetName: 'CUSTOS ANO', spreadsheetTitle: 'Planilha antiga', lastUpdated: null, autoConnect: false })
    render(<App />)
    await user.click(screen.getByRole('button', { name: 'Trocar planilha' }))
    const input = screen.getByLabelText('URL ou ID da planilha')
    await user.clear(input); await user.type(input, 'new-spreadsheet-id-67890')
    vi.mocked(readGoogleSheetLedger).mockRejectedValueOnce(new GoogleSheetsError('A aba CUSTOS ANO não foi encontrada.', 'TAB_MISSING'))
    await user.click(screen.getByRole('button', { name: 'Validar e trocar planilha' }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Validar e trocar planilha' })).toBeEnabled())
    expect(loadGoogleSheetLink()).toMatchObject({ spreadsheetId: 'spreadsheet-id-12345' })
    await user.click(screen.getByRole('button', { name: 'Cancelar troca' }))
    expect(screen.getByText('Planilha antiga')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Trocar planilha' }))
    const newInput = screen.getByLabelText('URL ou ID da planilha')
    await user.clear(newInput); await user.type(newInput, 'new-spreadsheet-id-67890')
    vi.mocked(readGoogleSheetLedger).mockResolvedValueOnce({ spreadsheetId: 'new-spreadsheet-id-67890', spreadsheetTitle: 'Planilha nova', transactions: [], rowCount: 8 })
    await user.click(screen.getByRole('button', { name: 'Validar e trocar planilha' }))
    await screen.findByText('Planilha nova')
    await screen.findByRole('button', { name: 'Atualizar dados' })
    await waitFor(() => expect(loadGoogleSheetLink()).toMatchObject({ spreadsheetId: 'new-spreadsheet-id-67890', autoConnect: true }))
  })

  it('desconecta o Google sem apagar o vínculo local', async () => {
    const user = userEvent.setup()
    saveGoogleSheetLink({ spreadsheetId: 'spreadsheet-id-12345', sheetName: 'CUSTOS ANO', spreadsheetTitle: 'Planilha vinculada', lastUpdated: null, autoConnect: true })
    render(<App />)
    await screen.findByText('✓ Planilha vinculada · Google conectado')
    await user.click(await screen.findByRole('button', { name: 'Desconectar Google' }))
    expect(revokeGoogleSheetsAccessToken).toHaveBeenCalledWith('test-access-token')
    expect(loadGoogleSheetLink()).toMatchObject({ spreadsheetId: 'spreadsheet-id-12345', sheetName: 'CUSTOS ANO', autoConnect: false })
  })

  it('preserva a leitura atual e permite tentar novamente quando a atualização falha', async () => {
    const user = userEvent.setup()
    saveGoogleSheetLink({ spreadsheetId: 'spreadsheet-id-12345', sheetName: 'CUSTOS ANO', spreadsheetTitle: 'Planilha vinculada', lastUpdated: null, autoConnect: true })
    render(<App />)
    await screen.findByRole('button', { name: 'Atualizar dados' })
    vi.mocked(readGoogleSheetLedger).mockRejectedValueOnce(new GoogleSheetsError('Falha de conexão ao Google Sheets.', 'NETWORK'))
    await user.click(screen.getByRole('button', { name: 'Atualizar dados' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Falha de conexão')
    expect(screen.getByText('CONTROLE ORÇAMENTÁRIO PESSOAL 2026')).toBeInTheDocument()
    expect(loadGoogleSheetLink()?.spreadsheetId).toBe('spreadsheet-id-12345')
    expect(screen.getByRole('button', { name: 'Atualizar dados' })).toBeInTheDocument()
  })

  it('lê a fatura PDF localmente, mostra compras e distingue cartão ausente de pagamento agregado', async () => {
    const user = userEvent.setup()
    render(<App />)
    const sheetFile = new File(['Descrição,Data,Custo,Forma de pagamento\nMercado exemplo,02/06/2025,"60,00",Crédito_Bradesco'], 'custos.csv', { type: 'text/csv' })
    await user.upload(screen.getAllByLabelText('Selecionar arquivo CSV')[0], sheetFile)
    await user.click(await screen.findByRole('button', { name: 'Usar 1 linha(s) válidas' }))
    await user.upload(screen.getByLabelText('Selecionar fatura PDF'), new File(['synthetic'], 'fatura.pdf', { type: 'application/pdf' }))
    expect(await screen.findByText(/PDF lido · 2 páginas · 2 cartões · 2 compras/)).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: /Conciliar agora/ }))
    await user.click(screen.getByRole('tab', { name: /Faturas PDF/ }))
    expect(screen.getByText(/MERCADO EXEMPLO/)).toBeInTheDocument()
    expect(screen.getByText(/ESTORNO MODELO/)).toBeInTheDocument()
    expect(screen.getByText('CRÉDITO/ESTORNO')).toBeInTheDocument()
    expect(screen.getByText('COMPRA DE CARTÃO NÃO REGISTRADA')).toBeInTheDocument()
    expect(screen.getByText(/Pagamento anterior identificado: R\$\s*50,00 · excluído das compras da fatura/)).toBeInTheDocument()
    expect(screen.getByText(/Nenhum pagamento bancário com o total da fatura foi identificado perto do vencimento/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Adicionar à CUSTOS ANO' })).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Adicionar à CUSTOS ANO' }))
    expect(screen.getByLabelText('Forma de pagamento')).toHaveValue('Crédito_Bradesco')
  })

  it('adiciona compra ausente de PDF como Crédito_Bradesco e persiste vínculo com a transação da fatura', async () => {
    const user = userEvent.setup()
    const category = { id: 'category-row', source: 'SHEET' as const, sheetRecordId: 'category-row', bankTransactionId: null, date: '2026-01-01', description: 'Escola', originalDescription: 'Escola', amount: 9000, direction: 'DEBIT' as const, type: 'EXPENSE' as const, paymentMethod: 'Pix', category: 'Casa', month: '01 - Janeiro', year: '2026', isFixed: false, isEssential: false, installment: null, totalInstallments: null, balanceAfter: null, original: {} }
    const added = { ...category, id: 'added-card-row', sheetRecordId: 'added-card-row', date: '2025-06-11', description: 'LOJA TESTE', originalDescription: 'LOJA TESTE', amount: 4000, paymentMethod: 'Crédito_Bradesco' }
    googleSheetsMocks.read.mockResolvedValue({ spreadsheetId: 'spreadsheet-id-12345', spreadsheetTitle: 'Planilha para escrita', transactions: [category], rowCount: 1 })
    googleSheetsMocks.append.mockResolvedValue({ spreadsheetId: 'spreadsheet-id-12345', spreadsheetTitle: 'Planilha para escrita', transactions: [category, added], rowCount: 2, transaction: added, alreadyPresent: false })
    saveGoogleSheetLink({ spreadsheetId: 'spreadsheet-id-12345', sheetName: 'CUSTOS ANO', spreadsheetTitle: 'Planilha para escrita', lastUpdated: null, autoConnect: true })
    render(<App />)
    await screen.findByText(/Lançamentos carregados do Google Sheets/)
    await user.upload(screen.getByLabelText('Selecionar fatura PDF'), new File(['synthetic'], 'fatura.pdf', { type: 'application/pdf' }))
    await screen.findByText(/PDF lido · 2 páginas · 2 cartões · 2 compras/)
    await user.click(screen.getByRole('button', { name: /Conciliar agora/ }))
    await user.click(screen.getByRole('tab', { name: /Faturas PDF/ }))
    const cardRow = screen.getByText(/LOJA TESTE/).closest('article')!
    expect(within(cardRow).getByText(/Data real da compra/)).toBeInTheDocument()
    expect(within(cardRow).getByText(/Vencimento da fatura: 12\/07\/2025 · data sugerida para CUSTOS ANO/)).toBeInTheDocument()
    expect(within(cardRow).getByText(/Próximo fechamento previsto: 30\/07\/2025/)).toBeInTheDocument()
    await user.click(within(cardRow).getByRole('button', { name: 'Adicionar à CUSTOS ANO' }))
    expect(screen.getByLabelText('Data')).toHaveValue('2025-07-12')
    fireEvent.change(screen.getByLabelText('Data'), { target: { value: '2025-06-11' } })
    expect(screen.getByLabelText('Forma de pagamento')).toHaveValue('Crédito_Bradesco')
    await user.selectOptions(screen.getByLabelText('Categoria'), 'Casa')
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Adicionar à CUSTOS ANO' }))
    expect(await screen.findByText('Compra da fatura adicionada à CUSTOS ANO e conciliada.')).toBeInTheDocument()
    expect(appendCostYearRecord).toHaveBeenCalledWith('spreadsheet-id-12345', 'test-access-token', expect.objectContaining({ date: '2025-06-11', paymentMethod: 'Crédito_Bradesco' }))
    expect([...savedDecisionStore.values()].some((decision) => decision.kind === 'STATEMENT_MATCH_CONFIRMED' && decision.identities[0].startsWith('statement-example-') && decision.selected[0] === 'added-card-row')).toBe(true)
    expect(screen.queryAllByText('COMPRA DE CARTÃO NÃO REGISTRADA')).toHaveLength(1)
  })

  it('bloqueia o append se a releitura encontrar um lançamento provável que surgiu após a conciliação', async () => {
    const user = userEvent.setup()
    const category = { id: 'category-row', source: 'SHEET' as const, sheetRecordId: 'category-row', bankTransactionId: null, date: '2026-01-01', description: 'Escola', originalDescription: 'Escola', amount: 9000, direction: 'DEBIT' as const, type: 'EXPENSE' as const, paymentMethod: 'Pix', category: 'Casa', month: '01 - Janeiro', year: '2026', isFixed: false, isEssential: false, installment: null, totalInstallments: null, balanceAfter: null, original: {} }
    const candidate = { ...category, id: 'kindle-existing', sheetRecordId: 'kindle-existing', date: '2025-07-12', description: 'Assinatura Kindle unlimited (2 meses)', originalDescription: 'Assinatura Kindle unlimited (2 meses)', amount: 299, paymentMethod: 'Crédito_Bradesco', type: 'OTHER' as const }
    const statement: CardStatement = { ...structuredClone(syntheticStatement), transactions: [{ ...syntheticStatement.transactions[0], id: 'kindle-card', date: '2025-06-02', purchaseDate: '2025-06-02', invoiceDueDate: '2025-07-12', statementDueDate: '2025-07-12', description: 'Amazon Kindle Unltd', originalDescription: 'Amazon Kindle Unltd', amount: 299 }] }
    vi.mocked(readCardStatementPdf).mockResolvedValueOnce(statement)
    googleSheetsMocks.read.mockResolvedValueOnce({ spreadsheetId: 'spreadsheet-id-12345', spreadsheetTitle: 'Planilha para escrita', transactions: [category], rowCount: 1 })
      .mockResolvedValueOnce({ spreadsheetId: 'spreadsheet-id-12345', spreadsheetTitle: 'Planilha para escrita', transactions: [category, candidate], rowCount: 2 })
    saveGoogleSheetLink({ spreadsheetId: 'spreadsheet-id-12345', sheetName: 'CUSTOS ANO', spreadsheetTitle: 'Planilha para escrita', lastUpdated: null, autoConnect: true })
    render(<App />)
    await screen.findByText(/Lançamentos carregados do Google Sheets/)
    await user.upload(screen.getByLabelText('Selecionar fatura PDF'), new File(['synthetic'], 'kindle.pdf', { type: 'application/pdf' }))
    await screen.findByText(/PDF lido · 2 páginas/)
    await user.click(screen.getByRole('button', { name: /Conciliar agora/ }))
    await user.click(screen.getByRole('tab', { name: /Faturas PDF/ }))
    const cardRow = screen.getByText(/Amazon Kindle Unltd/).closest('article')!
    await user.click(within(cardRow).getByRole('button', { name: 'Adicionar à CUSTOS ANO' }))
    await user.selectOptions(screen.getByLabelText('Categoria'), 'Casa')
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Adicionar à CUSTOS ANO' }))
    expect(await screen.findByText(/Já existe um lançamento provável na CUSTOS ANO/)).toBeInTheDocument()
    expect(appendCostYearRecord).not.toHaveBeenCalled()
    expect(await screen.findByText(/CUSTOS ANO: 12\/07\/2025 · Assinatura Kindle unlimited/)).toBeInTheDocument()
    const refreshedCard = screen.getByText(/Amazon Kindle Unltd/).closest('article')!
    expect(within(refreshedCard).getByRole('button', { name: 'Usar este lançamento' })).toBeInTheDocument()
    await user.click(within(refreshedCard).getByRole('button', { name: 'Usar este lançamento' }))
    await waitFor(() => expect([...savedDecisionStore.values()].some((decision) => decision.kind === 'STATEMENT_MATCH_CONFIRMED' && decision.selected[0] === 'kindle-existing')).toBe(true))
  })

  it('invalida confirmação persistida de ausência quando a CUSTOS ANO atual contém a compra', async () => {
    const user = userEvent.setup()
    const statement: CardStatement = { ...structuredClone(syntheticStatement), statementIdentity: 'statement-kindle', dueDate: '2026-03-12', transactions: [{ ...syntheticStatement.transactions[0], id: 'kindle-card', date: '2026-02-02', purchaseDate: '2026-02-02', invoiceDueDate: '2026-03-12', statementDueDate: '2026-03-12', description: 'Amazon Kindle Unltd', originalDescription: 'Amazon Kindle Unltd', amount: 299 }] }
    // Historical fingerprint from before the card identifier became part of the hash.
    const item = statement.transactions[0]
    const identity = `${statement.statementIdentity}:${stableFingerprint([item.date, item.originalDescription, item.amount, item.direction, item.installment, item.totalInstallments])}`
    const decision = { key: `CARD_MISSING_CONFIRMED:${JSON.stringify([identity])}`, schemaVersion: 1 as const, kind: 'CARD_MISSING_CONFIRMED', identities: [identity], selected: [], updatedAt: new Date().toISOString() }
    savedDecisionStore.set(decision.key, decision)
    const existing = { id: 'kindle-existing', source: 'SHEET' as const, sheetRecordId: 'kindle-existing', bankTransactionId: null, date: '2026-03-12', description: 'Assinatura Kindle unlimited (2 meses)', originalDescription: 'Assinatura Kindle unlimited (2 meses)', amount: 299, direction: 'DEBIT' as const, type: 'OTHER' as const, paymentMethod: 'Crédito_Bradesco', category: 'Assinaturas', month: '03 - Março', year: '2026', isFixed: false, isEssential: false, installment: null, totalInstallments: null, balanceAfter: null, original: {} }
    const unrelatedBankDecision = { key: `MISSING_ADDED_TO_SHEET:${JSON.stringify([identity])}`, schemaVersion: 1 as const, kind: 'MISSING_ADDED_TO_SHEET', identities: [identity], selected: ['kindle-existing'], updatedAt: new Date().toISOString() }
    savedDecisionStore.set(unrelatedBankDecision.key, unrelatedBankDecision)
    vi.mocked(readCardStatementPdf).mockResolvedValueOnce(statement)
    googleSheetsMocks.read.mockResolvedValue({ spreadsheetId: 'spreadsheet-id-12345', spreadsheetTitle: 'Planilha atual', transactions: [existing], rowCount: 1 })
    saveGoogleSheetLink({ spreadsheetId: 'spreadsheet-id-12345', sheetName: 'CUSTOS ANO', spreadsheetTitle: 'Planilha atual', lastUpdated: null, autoConnect: true })
    render(<App />)
    await screen.findByText(/Lançamentos carregados do Google Sheets/)
    await user.upload(screen.getByLabelText('Selecionar fatura PDF'), new File(['synthetic'], 'kindle.pdf', { type: 'application/pdf' }))
    await screen.findByText(/PDF lido · 2 páginas/)
    await waitFor(() => expect(savedDecisionStore.has(decision.key)).toBe(false))
    expect(savedDecisionStore.has(unrelatedBankDecision.key)).toBe(true)
    expect(decisionSyncMocks.tombstone).toHaveBeenCalledWith(decision)
    await user.click(screen.getByRole('button', { name: /Conciliar agora/ }))
    await user.click(screen.getByRole('tab', { name: /Faturas PDF/ }))
    const row = screen.getByText(/Amazon Kindle Unltd/).closest('article')!
    expect(within(row).queryByText('AUSÊNCIA CONFIRMADA')).not.toBeInTheDocument()
    expect(within(row).getByText('MATCHED · Crédito_Bradesco')).toBeInTheDocument()
    expect(within(row).queryByRole('button', { name: 'Adicionar à CUSTOS ANO' })).not.toBeInTheDocument()
  })

  it('remove confirmação MISSING_ADDED_TO_SHEET órfã quando a linha já não existe na CUSTOS ANO', async () => {
    const user = userEvent.setup()
    const orphan = { key: 'MISSING_ADDED_TO_SHEET:["doc:orphan-bank"]', schemaVersion: 1 as const, kind: 'MISSING_ADDED_TO_SHEET', identities: ['doc:orphan-bank'], selected: ['deleted-sheet-row'], updatedAt: new Date().toISOString() }
    savedDecisionStore.set(orphan.key, orphan)
    const category = { id: 'category-row', source: 'SHEET' as const, sheetRecordId: 'category-row', bankTransactionId: null, date: '2026-01-01', description: 'Escola', originalDescription: 'Escola', amount: 9000, direction: 'DEBIT' as const, type: 'EXPENSE' as const, paymentMethod: 'Pix', category: 'Casa', month: '01 - Janeiro', year: '2026', isFixed: false, isEssential: false, installment: null, totalInstallments: null, balanceAfter: null, original: {} }
    googleSheetsMocks.read.mockResolvedValue({ spreadsheetId: 'spreadsheet-id-12345', spreadsheetTitle: 'Planilha com linha removida', transactions: [category], rowCount: 1 })
    saveGoogleSheetLink({ spreadsheetId: 'spreadsheet-id-12345', sheetName: 'CUSTOS ANO', spreadsheetTitle: 'Planilha com linha removida', lastUpdated: null, autoConnect: true })
    render(<App />)
    await screen.findByText(/Lançamentos carregados do Google Sheets/)
    await waitFor(() => expect(savedDecisionStore.has(orphan.key)).toBe(false))
    expect(decisionSyncMocks.tombstone).toHaveBeenCalledWith(orphan)
    await user.upload(screen.getByLabelText('Selecionar arquivo CSV'), new File(['Data,Descrição,Valor,Tipo,ID\n08/01/2026,PIX ENVIADO MERCADO,"45,00",Débito,orphan-bank'], 'banco.csv', { type: 'text/csv' }))
    await user.click(await screen.findByRole('button', { name: 'Usar 1 linha(s) válidas' }))
    await user.click(screen.getByRole('button', { name: /Conciliar agora/ }))
    await user.click(screen.getByRole('tab', { name: /Ausentes/ }))
    expect(screen.getByText('PIX ENVIADO MERCADO')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Adicionar à CUSTOS ANO' })).toBeInTheDocument()
  })

  it('usa a data real da compra como fallback quando falta vencimento, sem usar fechamento', async () => {
    const fallbackStatement: CardStatement = {
      ...structuredClone(syntheticStatement), dueDate: null, nextClosingDate: '2025-07-30',
      transactions: structuredClone(syntheticStatement.transactions).map((transaction) => ({ ...transaction, invoiceDueDate: null, statementDueDate: null })),
    }
    vi.mocked(readCardStatementPdf).mockResolvedValueOnce(fallbackStatement)
    const user = userEvent.setup()
    render(<App />)
    await user.upload(screen.getAllByLabelText('Selecionar arquivo CSV')[0], new File(['Descrição,Data,Custo,Categoria\nEscola,01/01/2025,90,Casa'], 'custos.csv', { type: 'text/csv' }))
    await user.click(await screen.findByRole('button', { name: 'Usar 1 linha(s) válidas' }))
    await user.upload(screen.getByLabelText('Selecionar fatura PDF'), new File(['fallback statement'], 'fatura-sem-vencimento.pdf', { type: 'application/pdf' }))
    await screen.findByText(/PDF lido · 2 páginas/)
    await user.click(screen.getByRole('button', { name: /Conciliar agora/ }))
    await user.click(screen.getByRole('tab', { name: /Faturas PDF/ }))
    const firstMissing = screen.getAllByText('COMPRA DE CARTÃO NÃO REGISTRADA')[0].closest('article')!
    expect(within(firstMissing).getByText(/Vencimento não identificado/)).toBeInTheDocument()
    expect(within(firstMissing).getByText(/Próximo fechamento previsto: 30\/07\/2025/)).toBeInTheDocument()
    await user.click(within(firstMissing).getByRole('button', { name: 'Adicionar à CUSTOS ANO' }))
    expect(screen.getByLabelText('Data')).toHaveValue('2025-06-02')
    expect(screen.getByText(/Vencimento não identificado; a data da compra foi preenchida como alternativa/)).toBeInTheDocument()
  })

  it('adiciona e remove PDFs individualmente, permite seleção múltipla e rejeita duplicatas na sessão', async () => {
    const user = userEvent.setup()
    render(<App />)
    const input = screen.getByLabelText('Selecionar fatura PDF') as HTMLInputElement
    expect(input.multiple).toBe(true)
    const june = new File(['june pdf bytes'], 'fatura-junho.pdf', { type: 'application/pdf' })
    const july = new File(['july pdf bytes'], 'fatura-julho.pdf', { type: 'application/pdf' })
    await user.upload(input, [june, july])
    expect(await screen.findByText('fatura-junho.pdf')).toBeInTheDocument()
    expect(await screen.findByText('fatura-julho.pdf')).toBeInTheDocument()
    expect(screen.getAllByText(/✓ Processado · PDF lido/)).toHaveLength(2)

    await user.upload(screen.getByLabelText('Selecionar fatura PDF'), june)
    expect(await screen.findByText(/PDF\(s\) duplicado\(s\)/)).toBeInTheDocument()
    expect(screen.getAllByText('fatura-junho.pdf')).toHaveLength(1)
    await user.click(screen.getByRole('button', { name: 'Remover fatura-junho.pdf' }))
    expect(screen.queryByText('fatura-junho.pdf')).not.toBeInTheDocument()
    await user.upload(screen.getByLabelText('Selecionar fatura PDF'), new File(['august pdf bytes'], 'fatura-agosto.pdf', { type: 'application/pdf' }))
    expect(await screen.findByText('fatura-agosto.pdf')).toBeInTheDocument()
    expect(screen.getByText('fatura-julho.pdf')).toBeInTheDocument()
  })

  it('mantém erro isolado de um PDF e processa os outros arquivos selecionados', async () => {
    vi.mocked(readCardStatementPdf).mockImplementation(async (file) => {
      if (file.name === 'corrompido.pdf') throw new Error('synthetic parse error')
      return syntheticStatement
    })
    const user = userEvent.setup()
    render(<App />)
    await user.upload(screen.getByLabelText('Selecionar fatura PDF'), [
      new File(['bad'], 'corrompido.pdf', { type: 'application/pdf' }),
      new File(['good'], 'valido.pdf', { type: 'application/pdf' }),
    ])
    expect(await screen.findByText('corrompido.pdf')).toBeInTheDocument()
    expect(screen.getByText('⚠ Erro de parsing')).toBeInTheDocument()
    expect(await screen.findByText('valido.pdf')).toBeInTheDocument()
    expect(screen.getByText(/✓ Processado · PDF lido/)).toBeInTheDocument()
  })

  it('salva uma confirmação por identidade da fatura e a preserva ao iniciar outra conciliação', async () => {
    const user = userEvent.setup()
    const june = new File(['bill june'], 'junho.pdf', { type: 'application/pdf' })
    const july = new File(['bill july'], 'julho.pdf', { type: 'application/pdf' })
    const sheet = new File(['Descrição,Data,Custo,Forma de pagamento\nMERCADO EXEMPLO,02/06/2025,"60,00",Crédito_Bradesco'], 'custos.csv', { type: 'text/csv' })
    render(<App />)
    await user.upload(screen.getAllByLabelText('Selecionar arquivo CSV')[0], sheet)
    await user.click(await screen.findByRole('button', { name: 'Usar 1 linha(s) válidas' }))
    await user.upload(screen.getByLabelText('Selecionar fatura PDF'), [june, july])
    await screen.findByText('junho.pdf')
    await screen.findByText('julho.pdf')
    await user.click(screen.getByRole('button', { name: /Conciliar agora/ }))
    await user.click(screen.getByRole('tab', { name: /Faturas PDF/ }))
    const missingRow = screen.getAllByText('COMPRA DE CARTÃO NÃO REGISTRADA')[0].closest('.statement-transaction') as HTMLElement
    expect(within(missingRow).queryByRole('button', { name: /Confirmar ausência|Desfazer confirmação/ })).not.toBeInTheDocument()
    await user.click(within(missingRow).getByRole('button', { name: 'Ignorar' }))
    await waitFor(() => expect(savedDecisionStore.size).toBe(1))
    const savedIdentity = [...savedDecisionStore.values()][0].identities[0]

    await user.click(screen.getByRole('button', { name: 'Nova conciliação' }))
    await user.upload(screen.getAllByLabelText('Selecionar arquivo CSV')[0], sheet)
    await user.click(await screen.findByRole('button', { name: 'Usar 1 linha(s) válidas' }))
    await user.upload(screen.getByLabelText('Selecionar fatura PDF'), [june, july])
    await screen.findByText('junho.pdf')
    await screen.findByText('julho.pdf')
    await user.click(screen.getByRole('button', { name: /Conciliar agora/ }))
    await user.click(screen.getByRole('tab', { name: /Faturas PDF/ }))
    expect(screen.getAllByText('COMPRA IGNORADA')).toHaveLength(1)
    expect([...savedDecisionStore.values()][0].kind).toBe('CARD_PURCHASE_IGNORED')
    expect([...savedDecisionStore.values()][0].identities[0]).toBe(savedIdentity)
  })

  it('importa CSVs, valida e concilia localmente; filtra por ano/mês e exporta', async () => {
    const user = userEvent.setup()
    render(<App />)
    const ledgerCsv = [
      'Descrição,Data,Mês,Ano,Categoria,Custo,Forma de pagamento,É fixo?,É essencial?,ID',
      'Mercado Central,08/01/2026,01 - Janeiro,2026,Alimentação,"45,00",Débito,Não,Sim,plan-001',
      'Café Nova,08/02/2027,02 - Fevereiro,2027,Alimentação,"22,00",Débito,Não,Sim,plan-003',
      'Linha inválida,xx/13/2026,01 - Janeiro,2026,Teste,n/a,Débito,Não,Não,plan-002',
    ].join('\n')
    const bankCsv = ['Data,Descrição,Valor,Tipo,Forma de pagamento,ID', '08/01/2026,Mercado Central,"45,00",Débito,Débito,bank-001', '08/02/2027,Café Nova,"22,00",Débito,Débito,bank-003'].join('\n')
    const sheetFile = new File([ledgerCsv], 'custos-ano.csv', { type: 'text/csv' })
    const bankFile = new File([bankCsv], 'extrato.csv', { type: 'text/csv' })

    const inputs = screen.getAllByLabelText('Selecionar arquivo CSV')
    await user.upload(inputs[0], sheetFile)
    expect(await screen.findByText('2 válidas · 1 problemas')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Usar 2 linha(s) válidas' }))
    expect(screen.getByText('2 movimentações carregadas')).toBeInTheDocument()
    expect(screen.getByText('1 linha com problema não importada')).toBeInTheDocument()
    expect(screen.getByText('Falta aceitar as linhas válidas do extrato bancário.')).toBeInTheDocument()

    const bankInput = screen.getAllByLabelText('Selecionar arquivo CSV')[1]
    await user.upload(bankInput, bankFile)
    expect(await screen.findByText('2 válidas · 0 problemas')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Usar 2 linha(s) válidas' }))
    await user.click(screen.getByRole('button', { name: /Conciliar agora/ }))

    expect(await screen.findByRole('heading', { name: 'Visão geral' })).toBeInTheDocument()
    expect(document.querySelector('.metric-green .metric-value')).toHaveTextContent('2')
    expect(screen.getAllByText(/Match automático: valor, data, direção e solução global 1:1/)).toHaveLength(2)
    await user.click(screen.getByRole('button', { name: /Ausentes/ }))
    expect(screen.getByText('Nenhuma despesa ausente')).toBeInTheDocument()
    expect(within(screen.getByRole('tablist')).getByRole('tab', { name: /Ausentes/ })).toHaveAttribute('aria-selected', 'true')
    await user.click(screen.getByRole('button', { name: /Conciliadas/ }))
    expect(screen.getByText('Tudo em dia por aqui')).toBeInTheDocument()

    await user.selectOptions(screen.getByLabelText('Ano'), '2027')
    expect(document.querySelector('.metric-green .metric-value')).toHaveTextContent('1')
    await user.selectOptions(screen.getByLabelText('Ano'), '2026')
    await user.selectOptions(screen.getByLabelText('Mês'), '02')
    expect(document.querySelector('.metric-green .metric-value')).toHaveTextContent('0')
    await user.selectOptions(screen.getByLabelText('Mês'), 'all')

    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:test')
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
    const anchorClick = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    await user.click(screen.getByRole('button', { name: '↓ Resumo' }))
    expect(URL.createObjectURL).toHaveBeenCalledOnce()
    expect(anchorClick).toHaveBeenCalledOnce()
    expect(within(screen.getByRole('tablist')).getByRole('tab', { name: /Resumo/ })).toHaveAttribute('aria-selected', 'true')
    await waitFor(() => expect(screen.getByText(/Confirmações salvas neste dispositivo/)).toBeInTheDocument())
  })

  it('separa revisão de ausências e permite confirmar ou ignorar cada caso', async () => {
    const user = userEvent.setup()
    const scrollTo = window.scrollTo
    render(<App />)
    const sheetFile = new File([
      'Descrição,Data,Mês,Ano,Categoria,Custo,Forma de pagamento,ID\nLoja Antiga,08/01/2026,01 - Janeiro,2026,Outros,"13,50",Pix,plan-10',
    ], 'custos.csv', { type: 'text/csv' })
    const bankFile = new File([
      'Data,Descrição,Valor,Tipo,Forma de pagamento,ID\n09/01/2026,Escola Nova,"13,50",Débito,Pix,bank-10\n09/01/2026,Mercado XYZ,"45,00",Débito,Débito,bank-11',
    ], 'banco.csv', { type: 'text/csv' })
    await user.upload(screen.getAllByLabelText('Selecionar arquivo CSV')[0], sheetFile)
    await user.click(await screen.findByRole('button', { name: 'Usar 1 linha(s) válidas' }))
    await user.upload(screen.getAllByLabelText('Selecionar arquivo CSV')[1], bankFile)
    await user.click(await screen.findByRole('button', { name: 'Usar 2 linha(s) válidas' }))
    await user.click(screen.getByRole('button', { name: /Conciliar agora/ }))
    expect(scrollTo).toHaveBeenCalledOnce()
    await user.click(screen.getByRole('tab', { name: /Revisão/ }))

    expect(screen.getByText('Loja Antiga')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: '✓ Confirmar' }))
    expect(scrollTo).toHaveBeenCalledOnce()
    expect(screen.queryByText('Loja Antiga')).not.toBeInTheDocument()
    await user.click(screen.getByRole('tab', { name: /Ausentes/ }))
    expect(screen.getByText('Mercado XYZ')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Ignorar' }))
    expect(screen.getByText('Nenhuma despesa ausente')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Nova conciliação' }))
    await user.upload(screen.getAllByLabelText('Selecionar arquivo CSV')[0], sheetFile)
    await user.click(await screen.findByRole('button', { name: 'Usar 1 linha(s) válidas' }))
    await user.upload(screen.getAllByLabelText('Selecionar arquivo CSV')[1], bankFile)
    await user.click(await screen.findByRole('button', { name: 'Usar 2 linha(s) válidas' }))
    await user.click(screen.getByRole('button', { name: /Conciliar agora/ }))
    expect(await screen.findByRole('button', { name: /Conciliadas/ })).toHaveTextContent('1')
    await user.click(screen.getByRole('tab', { name: /Revisão/ }))
    expect(screen.getByText('Nenhum item para revisar')).toBeInTheDocument()
    await user.click(screen.getByRole('tab', { name: /Ausentes/ }))
    expect(screen.getByText('Nenhuma despesa ausente')).toBeInTheDocument()
    expect(savedDecisionStore.size).toBe(2)
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    await user.click(screen.getByRole('button', { name: 'Limpar confirmações salvas' }))
    await waitFor(() => expect(savedDecisionStore.size).toBe(0))
  })

  it('importa o cabeçalho deslocado do Bradesco e habilita a conciliação após os dois arquivos', async () => {
    const user = userEvent.setup()
    render(<App />)
    const sheetFile = new File([
      'Descrição,Data,Custo\nCOMPRA CARTAO VISA,02/02/2026,"133,50"',
    ], 'custos.csv', { type: 'text/csv' })
    const bankFile = new File([[
      'Extrato de: Ag: 6240 | Conta: 306475-1',
      'Data | Histórico | Docto. | Crédito (R$) | Débito (R$) | Saldo (R$)',
      '30/01/2026 | COD. LANC. 0 | 0 | 0,00 | 0,00 | 1.908,23',
      '02/02/2026 | PIX RECEBIDO | 722215 | 12,00 |  | 1.920,23',
      '02/02/2026 | PIX RECEBIDO | 1159471 | 1.175,00 |  | 3.095,23',
      '02/02/2026 | COMPRA CARTAO VISA | 500011 |  | 133,50 | 2.961,73',
      '03/02/2026 | Sem valor | 8 |  |  | 2.961,73',
      'Data | Histórico | Docto. | Crédito (R$) | Débito (R$) | Saldo (R$)',
      'RESUMO | Saldo final |  |  |  | 2.961,73',
    ].join('\n')], 'bradesco.csv', { type: 'text/csv' })
    await user.upload(screen.getAllByLabelText('Selecionar arquivo CSV')[0], sheetFile)
    await user.click(await screen.findByRole('button', { name: 'Usar 1 linha(s) válidas' }))
    await user.upload(screen.getAllByLabelText('Selecionar arquivo CSV')[1], bankFile)
    expect(await screen.findByText('4 válidas · 0 problemas')).toBeInTheDocument()
    expect(screen.getByText('1 linha(s) de metadados ignorada(s) antes do cabeçalho')).toBeInTheDocument()
    expect(screen.getByText(/3 linha\(s\) ignoradas/)).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Usar 4 linha(s) válidas' }))
    await user.click(screen.getByRole('button', { name: /Conciliar agora/ }))
    expect(await screen.findByRole('heading', { name: 'Visão geral' })).toBeInTheDocument()
    expect(document.querySelector('.metric-green .metric-value')).toHaveTextContent('1')
  })

  it('mostra a composição 1:N da fatura com valores e forma de pagamento', async () => {
    const user = userEvent.setup()
    render(<App />)
    const sheetFile = new File(['Descrição,Data,Custo,Forma de pagamento\nCompra A,10/01/2026,"50,00",Crédito_Bradesco\nCompra B,20/01/2026,"50,00",Crédito_Bradesco'], 'custos.csv', { type: 'text/csv' })
    const bankFile = new File(['Data,Descrição,Valor,Tipo\n02/02/2026,GASTOS CARTAO DE CREDITO,"100,00",Débito'], 'banco.csv', { type: 'text/csv' })
    await user.upload(screen.getAllByLabelText('Selecionar arquivo CSV')[0], sheetFile)
    await user.click(await screen.findByRole('button', { name: 'Usar 2 linha(s) válidas' }))
    await user.upload(screen.getAllByLabelText('Selecionar arquivo CSV')[1], bankFile)
    await user.click(await screen.findByRole('button', { name: 'Usar 1 linha(s) válidas' }))
    await user.click(screen.getByRole('button', { name: /Conciliar agora/ }))
    expect(screen.getByRole('button', { name: /Para revisar/ })).toHaveTextContent('0')
    expect(screen.getByRole('button', { name: /Divergências de cartão/ })).toHaveTextContent('1')
    await user.click(screen.getByRole('tab', { name: /Faturas/ }))
    expect(screen.getByText(/Compra A/)).toBeInTheDocument()
    expect(screen.getByText(/Compra B/)).toBeInTheDocument()
    expect(screen.getAllByText('Crédito_Bradesco')).toHaveLength(2)
    expect(screen.getAllByText('R$ 100,00').length).toBeGreaterThanOrEqual(2)
    await user.click(screen.getByRole('button', { name: '✓ Confirmar composição' }))
    await waitFor(() => expect(savedDecisionStore.size).toBe(1))
    await user.click(screen.getByRole('tab', { name: 'Resumo' }))
    expect(await screen.findByText('Pagamentos de cartão conciliados')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Nova conciliação' }))
    await user.upload(screen.getAllByLabelText('Selecionar arquivo CSV')[0], sheetFile)
    await user.click(await screen.findByRole('button', { name: 'Usar 2 linha(s) válidas' }))
    await user.upload(screen.getAllByLabelText('Selecionar arquivo CSV')[1], bankFile)
    await user.click(await screen.findByRole('button', { name: 'Usar 1 linha(s) válidas' }))
    await user.click(screen.getByRole('button', { name: /Conciliar agora/ }))
    expect(await screen.findByText(/Decisão salva neste dispositivo/)).toBeInTheDocument()
  })

  it('separa fatura sem composição exata em divergências de cartão e informa valores sem presumir a causa', async () => {
    const user = userEvent.setup()
    render(<App />)
    const sheetFile = new File(['Descrição,Data,Custo,Forma de pagamento\nCompras registradas,20/01/2026,"850,00",Crédito_Bradesco'], 'custos.csv', { type: 'text/csv' })
    const bankFile = new File(['Data,Descrição,Valor,Tipo\n02/02/2026,GASTOS CARTAO DE CREDITO,"1.000,00",Débito'], 'banco.csv', { type: 'text/csv' })
    await user.upload(screen.getAllByLabelText('Selecionar arquivo CSV')[0], sheetFile)
    await user.click(await screen.findByRole('button', { name: 'Usar 1 linha(s) válidas' }))
    await user.upload(screen.getAllByLabelText('Selecionar arquivo CSV')[1], bankFile)
    await user.click(await screen.findByRole('button', { name: 'Usar 1 linha(s) válidas' }))
    await user.click(screen.getByRole('button', { name: /Conciliar agora/ }))
    expect(screen.getByRole('button', { name: /Para revisar/ })).toHaveTextContent('0')
    expect(screen.getByRole('button', { name: /Ausentes/ })).toHaveTextContent('0')
    expect(screen.getByRole('button', { name: /Divergências de cartão/ })).toHaveTextContent('1')
    await user.click(screen.getByRole('tab', { name: /Faturas/ }))
    expect(screen.getByText(/R\$ 850,00/)).toBeInTheDocument()
    expect(screen.getByText('Diferença em relação às compras elegíveis: R$ 150,00')).toBeInTheDocument()
    expect(screen.getByText(/diferença pode indicar uma compra não registrada.*não identifica sozinho a causa/i)).toBeInTheDocument()
  })

  it('preserva a fonte aceita e permite substituir, remover e importar novamente', async () => {
    const user = userEvent.setup()
    render(<App />)
    const first = new File(['Descrição,Data,Custo\nMercado Central,08/01/2026,"45,00"'], 'custos-1.csv', { type: 'text/csv' })
    const replacement = new File(['Descrição,Data,Custo\nCafé Central,08/01/2026,"12,00"'], 'custos-2.csv', { type: 'text/csv' })
    await user.upload(screen.getAllByLabelText('Selecionar arquivo CSV')[0], first)
    await user.click(await screen.findByRole('button', { name: 'Usar 1 linha(s) válidas' }))
    expect(screen.getByText('custos-1.csv')).toBeInTheDocument()

    await user.upload(screen.getAllByLabelText('Selecionar arquivo CSV')[0], replacement)
    expect(await screen.findByText('custos-2.csv')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Usar 1 linha(s) válidas' }))
    expect(screen.getByText('1 movimentações carregadas')).toBeInTheDocument()
    expect(screen.getByText('custos-2.csv')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Remover' }))
    expect(screen.queryByText('custos-2.csv')).not.toBeInTheDocument()
    await user.upload(screen.getAllByLabelText('Selecionar arquivo CSV')[0], first)
    await user.click(await screen.findByRole('button', { name: 'Usar 1 linha(s) válidas' }))
    expect(screen.getByText('custos-1.csv')).toBeInTheDocument()
  })
})
