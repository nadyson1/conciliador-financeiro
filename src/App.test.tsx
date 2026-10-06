import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { CardStatement } from './domain/types'
import { readCardStatementPdf } from './importers/cardStatement'
import { GoogleSheetsError, readGoogleSheetLedger, requestGoogleSheetsAccessToken, revokeGoogleSheetsAccessToken } from './integrations/googleSheets'
import { loadGoogleSheetLink, saveGoogleSheetLink } from './integrations/googleSheetLinkStorage'
import App from './App'

const syntheticStatement: CardStatement = {
  fileName: 'fatura-exemplo.pdf', pageCount: 2, statementIdentity: 'statement-example',
  transactions: [
    { id: 'card-a', date: '2025-06-02', description: 'MERCADO EXEMPLO', originalDescription: 'MERCADO EXEMPLO', amount: 6000, direction: 'DEBIT', type: 'PURCHASE', financialStatus: 'ACTIVE', cardIdentifier: '4321 XXXX XXXX 1111', installment: null, totalInstallments: null, city: 'CIDADE A', currency: 'BRL', exchangeRate: null, statementDueDate: '2025-07-12', statementTotal: 10000 },
    { id: 'card-b', date: '2025-06-10', description: 'LOJA TESTE', originalDescription: 'LOJA TESTE', amount: 4000, direction: 'DEBIT', type: 'PURCHASE', financialStatus: 'ACTIVE', cardIdentifier: '4321 XXXX XXXX 2222', installment: null, totalInstallments: null, city: 'CIDADE B', currency: 'BRL', exchangeRate: null, statementDueDate: '2025-07-12', statementTotal: 10000 },
    { id: 'card-c', date: '2025-06-12', description: 'ESTORNO MODELO', originalDescription: 'ESTORNO MODELO', amount: 900, direction: 'CREDIT', type: 'REFUND', financialStatus: 'ACTIVE', cardIdentifier: '4321 XXXX XXXX 1111', installment: null, totalInstallments: null, city: 'CIDADE A', currency: 'BRL', exchangeRate: null, statementDueDate: '2025-07-12', statementTotal: 10000 },
  ],
  cardSubtotals: [{ cardIdentifier: '4321 XXXX XXXX 1111', amount: 6000 }, { cardIdentifier: '4321 XXXX XXXX 2222', amount: 4000 }],
  reportedTotal: 10000, purchasesDebitsTotal: 10000, creditsPaymentsTotal: null, previousBalance: null, previousPayment: 5000, accountingDifference: null,
  dueDate: '2025-07-12', nextClosingDate: '2025-07-30', errors: [],
}

const savedDecisionStore = vi.hoisted(() => new Map<string, { key: string; schemaVersion: 1; kind: string; identities: string[]; selected: string[]; updatedAt: string }>())
const googleSheetsMocks = vi.hoisted(() => ({ read: vi.fn(), requestToken: vi.fn(), revoke: vi.fn() }))
vi.mock('./domain/localDecisions', () => ({
  decisionKey: (kind: string, identities: string[]) => `${kind}:${JSON.stringify(identities)}`,
  listPersistedDecisions: async () => [...savedDecisionStore.values()],
  savePersistedDecision: async (decision: { key: string; kind: string; identities: string[]; selected: string[] }) => savedDecisionStore.set(decision.key, { ...decision, schemaVersion: 1, updatedAt: new Date().toISOString() }),
  deletePersistedDecision: async (key: string) => savedDecisionStore.delete(key),
  clearPersistedDecisions: async () => savedDecisionStore.clear(),
}))

vi.mock('./importers/cardStatement', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./importers/cardStatement')>()
  return { ...actual, readCardStatementPdf: vi.fn(async () => syntheticStatement) }
})

vi.mock('./integrations/googleSheets', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./integrations/googleSheets')>()
  return { ...actual, readGoogleSheetLedger: googleSheetsMocks.read, requestGoogleSheetsAccessToken: googleSheetsMocks.requestToken, revokeGoogleSheetsAccessToken: googleSheetsMocks.revoke }
})

beforeEach(() => {
  // clearMocks clears call history, but it does not discard queued
  // mockResolvedValueOnce/mockRejectedValueOnce implementations.
  savedDecisionStore.clear()
  localStorage.clear()
  sessionStorage.clear()
  googleSheetsMocks.read.mockReset()
  googleSheetsMocks.requestToken.mockReset()
  googleSheetsMocks.revoke.mockReset()
  vi.mocked(readCardStatementPdf).mockReset()
  vi.mocked(readCardStatementPdf).mockImplementation(async () => syntheticStatement)
  vi.mocked(requestGoogleSheetsAccessToken).mockResolvedValue('test-access-token')
  vi.mocked(readGoogleSheetLedger).mockResolvedValue({ spreadsheetId: 'spreadsheet-id-12345', spreadsheetTitle: 'CONTROLE ORÇAMENTÁRIO PESSOAL 2026', transactions: [], rowCount: 1 })
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('fluxo completo no navegador', () => {
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

  it('mantém vínculo com token expirado e atualiza os dados após reconectar', async () => {
    const user = userEvent.setup()
    saveGoogleSheetLink({ spreadsheetId: 'spreadsheet-id-12345', sheetName: 'CUSTOS ANO', spreadsheetTitle: 'CONTROLE ORÇAMENTÁRIO PESSOAL 2026', lastUpdated: null, autoConnect: true })
    vi.mocked(readGoogleSheetLedger).mockRejectedValueOnce(new GoogleSheetsError('A autorização expirou.', 'AUTH'))
    vi.mocked(requestGoogleSheetsAccessToken).mockResolvedValueOnce('expired-token').mockRejectedValueOnce(new GoogleSheetsError('É necessário reconectar.', 'AUTH'))
    vi.mocked(readGoogleSheetLedger).mockResolvedValue({ spreadsheetId: 'spreadsheet-id-12345', spreadsheetTitle: 'Planilha atualizada após reconexão', transactions: [], rowCount: 2 })
    render(<App />)
    await screen.findByText('Não foi possível renovar a autorização automaticamente. O vínculo foi mantido; use Reconectar Google.')
    await waitFor(() => expect(loadGoogleSheetLink()).toMatchObject({ spreadsheetId: 'spreadsheet-id-12345', autoConnect: false }))
    const reconnect = await screen.findByRole('button', { name: 'Reconectar Google' })
    await user.click(reconnect)
    await screen.findByText('Planilha atualizada após reconexão')
    await screen.findByRole('button', { name: 'Atualizar dados' })
    expect(requestGoogleSheetsAccessToken).toHaveBeenLastCalledWith(expect.any(String))
    expect(readGoogleSheetLedger).toHaveBeenLastCalledWith('spreadsheet-id-12345', 'test-access-token')
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
    await screen.findByText('A aba CUSTOS ANO não foi encontrada.')
    expect(loadGoogleSheetLink()).toMatchObject({ spreadsheetId: 'spreadsheet-id-12345' })

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
    expect(await screen.findByRole('status')).toHaveTextContent(/PDF\(s\) duplicado\(s\)/)
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
    expect(screen.getByText('valido.pdf')).toBeInTheDocument()
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
    await user.click(within(missingRow).getByRole('button', { name: 'Confirmar ausência' }))
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
    expect(screen.getAllByText('AUSÊNCIA CONFIRMADA')).toHaveLength(1)
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
    await waitFor(() => expect(screen.getByText(/Confirmações salvas somente neste dispositivo/)).toBeInTheDocument())
  })

  it('separa revisão de ausências e permite confirmar ou ignorar cada caso', async () => {
    const user = userEvent.setup()
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
    await user.click(screen.getByRole('tab', { name: /Revisão/ }))

    expect(screen.getByText('Loja Antiga')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: '✓ Confirmar' }))
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
