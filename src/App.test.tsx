import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { CardStatement } from './domain/types'
import { readCardStatementPdf } from './importers/cardStatement'
import { appendCostYearRecord, GoogleSheetsError, readGoogleSheetLedger, requestGoogleSheetsAccessToken, revokeGoogleSheetsAccessToken } from './integrations/googleSheets'
import { loadGoogleSheetLink, saveGoogleSheetLink } from './integrations/googleSheetLinkStorage'
import { saveDriveFolders } from './integrations/googleDriveStorage'
import { listDecisionTombstones } from './integrations/googleSheetDecisions'
import { cardReviewCandidateIdentity, cardTransactionIdentity, sheetIdentity, stableFingerprint } from './domain/identity'
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
const googleDriveMocks = vi.hoisted(() => ({ list: vi.fn(), download: vi.fn(), pick: vi.fn() }))
const decisionSyncMocks = vi.hoisted(() => ({ sync: vi.fn(), save: vi.fn(), deletion: vi.fn(), deleteDecision: vi.fn(), tombstones: new Map<string, { updatedAt: string; decision: { key: string } }>(), tombstone: vi.fn((decision: { key: string }) => { decisionSyncMocks.tombstones.set(decision.key, { updatedAt: new Date().toISOString(), decision }) }), readRemote: vi.fn() }))

vi.mock('./domain/localDecisions', () => ({
  decisionKey: (kind: string, identities: string[]) => `${kind}:${JSON.stringify(identities)}`,
  listPersistedDecisions: async () => [...savedDecisionStore.values()],
  savePersistedDecision: async (decision: { key: string; kind: string; identities: string[]; selected: string[] }) => { const record = { ...decision, schemaVersion: 1 as const, updatedAt: new Date().toISOString() }; savedDecisionStore.set(decision.key, record); return record },
  deletePersistedDecision: decisionSyncMocks.deleteDecision,
  clearPersistedDecisions: async () => savedDecisionStore.clear(),
}))

vi.mock('./integrations/googleSheetDecisions', () => ({
  addDecisionTombstone: decisionSyncMocks.tombstone, listDecisionTombstones: () => Object.fromEntries(decisionSyncMocks.tombstones), removeDecisionTombstone: vi.fn((key: string) => decisionSyncMocks.tombstones.delete(key)),
  readGoogleSheetDecisionsReadOnly: decisionSyncMocks.readRemote,
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

vi.mock('./integrations/googleDrive', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./integrations/googleDrive')>()
  return { ...actual, listGoogleDriveFolder: googleDriveMocks.list, downloadGoogleDriveFile: googleDriveMocks.download, selectGoogleDriveFolder: googleDriveMocks.pick }
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
  decisionSyncMocks.deleteDecision.mockReset().mockImplementation(async (key: string) => savedDecisionStore.delete(key))
  decisionSyncMocks.tombstone.mockReset()
  decisionSyncMocks.tombstones.clear()
  decisionSyncMocks.readRemote.mockReset().mockResolvedValue({ exists: false, active: [], tombstones: [] })
  vi.mocked(readCardStatementPdf).mockReset()
  vi.mocked(readCardStatementPdf).mockImplementation(async () => syntheticStatement)
  vi.mocked(requestGoogleSheetsAccessToken).mockResolvedValue('test-access-token')
  vi.mocked(readGoogleSheetLedger).mockResolvedValue({ spreadsheetId: 'spreadsheet-id-12345', spreadsheetTitle: 'CONTROLE ORÇAMENTÁRIO PESSOAL 2026', transactions: [], rowCount: 1 })
  googleDriveMocks.list.mockReset().mockResolvedValue([])
  googleDriveMocks.download.mockReset()
  googleDriveMocks.pick.mockReset().mockResolvedValue(null)
  vi.spyOn(window, 'scrollTo').mockImplementation(() => undefined)
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('fluxo completo no navegador', () => {
  it('executa Auditor de consistência sem escrever na planilha nem alterar decisões', async () => {
    const user = userEvent.setup()
    const kindleStatement: CardStatement = { ...structuredClone(syntheticStatement), fileName: 'fatura-kindle.pdf', statementIdentity: 'statement-kindle-regression', dueDate: '2026-03-12', reportedTotal: 299, purchasesDebitsTotal: 299, transactions: [{ ...syntheticStatement.transactions[0], id: 'kindle-purchase', date: '2026-02-02', purchaseDate: '2026-02-02', invoiceDueDate: '2026-03-12', statementDueDate: '2026-03-12', originalDescription: 'Amazon Kindle Unltd', description: 'Amazon Kindle Unltd', amount: 299, statementTotal: 299 }] }
    vi.mocked(readCardStatementPdf).mockResolvedValueOnce(kindleStatement)
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    render(<App />)
    await user.upload(screen.getAllByLabelText('Selecionar arquivo CSV')[0], new File(['Descrição,Data,Custo,Forma de pagamento\nAssinatura Kindle unlimited (2 meses),12/03/2026,"2,99",Crédito_Bradesco'], 'custos.csv', { type: 'text/csv' }))
    await user.click(await screen.findByRole('button', { name: 'Usar 1 linha(s) válidas' }))
    await user.upload(screen.getByLabelText('Selecionar fatura PDF'), new File(['synthetic'], 'fatura.pdf', { type: 'application/pdf' }))
    await screen.findByText(/^Fatura /)
    await user.click(screen.getByRole('button', { name: /Conciliar agora/ }))
    const savedBefore = [...savedDecisionStore.entries()]
    const readStorage = (storage: Storage) => Array.from({ length: storage.length }, (_, index) => storage.key(index)!).map((key) => [key, storage.getItem(key)])
    const storageBefore = { local: readStorage(localStorage), session: readStorage(sessionStorage) }
    const tabCountsBefore = [/^Revisão/, /^Ausentes/, /^Faturas\s+\d+$/, /^Faturas PDF/].map((name) => screen.getByRole('tab', { name }).textContent)
    const localSetItem = vi.spyOn(Storage.prototype, 'setItem')
    const localRemoveItem = vi.spyOn(Storage.prototype, 'removeItem')
    await user.click(screen.getByRole('button', { name: 'Auditar consistência' }))
    expect(await screen.findByRole('tab', { name: /Auditoria/ })).toBeInTheDocument()
    expect(screen.getByText('Auditoria de consistência')).toBeInTheDocument()
    expect(screen.getByText(/nenhuma alteração foi feita/i)).toBeInTheDocument()
    expect(appendCostYearRecord).not.toHaveBeenCalled()
    expect(googleSheetsMocks.append).not.toHaveBeenCalled()
    expect(decisionSyncMocks.tombstone).not.toHaveBeenCalled()
    expect(decisionSyncMocks.save).not.toHaveBeenCalled()
    expect(decisionSyncMocks.deletion).not.toHaveBeenCalled()
    expect(decisionSyncMocks.sync).not.toHaveBeenCalled()
    expect(localSetItem).not.toHaveBeenCalled()
    expect(localRemoveItem).not.toHaveBeenCalled()
    expect([...savedDecisionStore.entries()]).toEqual(savedBefore)
    expect({ local: readStorage(localStorage), session: readStorage(sessionStorage) }).toEqual(storageBefore)
    expect([/^Revisão/, /^Ausentes/, /^Faturas\s+\d+$/, /^Faturas PDF/].map((name) => screen.getByRole('tab', { name }).textContent)).toEqual(tabCountsBefore)
    expect(screen.queryByText(/CARD_MISSING_NO_CANDIDATE/)).not.toBeInTheDocument()
    await user.click(screen.getByText(/Compras avaliadas/))
    await user.click(screen.getByText('Detalhes técnicos da avaliação'))
    expect(document.querySelector('pre')?.textContent).toContain('"estadoPuro": "CARD_MATCHED"')
    expect([...savedDecisionStore.entries()]).toEqual(savedBefore)
    expect(decisionSyncMocks.tombstone).not.toHaveBeenCalled()
    expect(decisionSyncMocks.deletion).not.toHaveBeenCalled()
  })

  it('descarta apenas o vínculo antigo provado em DOUBLE_CLAIM e recalcula as duas compras', async () => {
    const user = userEvent.setup()
    const makePurchase = (id: string, purchaseDate: string, dueDate: string): CardStatement['transactions'][number] => ({ ...syntheticStatement.transactions[0], id, purchaseDate, date: purchaseDate, invoiceDueDate: dueDate, statementDueDate: dueDate, originalDescription: 'SELFITHOMEROCASTELOBRA', description: 'SELFITHOMEROCASTELOBRA', amount: 12990 })
    const mayPurchase = makePurchase('selfit-may-purchase', '2026-05-08', '2026-06-12')
    const aprilPurchase = makePurchase('selfit-april-purchase', '2026-04-08', '2026-05-12')
    const juneStatement: CardStatement = { ...structuredClone(syntheticStatement), fileName: 'fatura-junho.pdf', statementIdentity: 'selfit-june-invoice', dueDate: '2026-06-12', reportedTotal: 12990, purchasesDebitsTotal: 12990, transactions: [mayPurchase] }
    const mayStatement: CardStatement = { ...structuredClone(syntheticStatement), fileName: 'fatura-maio.pdf', statementIdentity: 'selfit-may-invoice', dueDate: '2026-05-12', reportedTotal: 12990, purchasesDebitsTotal: 12990, transactions: [aprilPurchase] }
    const row = (id: string, date: string) => ({ id, source: 'SHEET' as const, sheetRecordId: id, bankTransactionId: null, date, description: 'Mensalidade Selfit', originalDescription: 'Mensalidade Selfit', amount: 12990, direction: 'DEBIT' as const, type: 'EXPENSE' as const, paymentMethod: 'Crédito_Bradesco', category: 'Saúde', month: '', year: date.slice(0, 4), isFixed: false, isEssential: true, installment: null, totalInstallments: null, balanceAfter: null, original: {} })
    const mayRow = row('6bf22757', '2026-05-12')
    const juneRow = row('selfit-june-row', '2026-06-12')
    const decision = { key: `STATEMENT_MATCH_CONFIRMED:${JSON.stringify([cardTransactionIdentity(juneStatement, mayPurchase)])}`, schemaVersion: 1 as const, kind: 'STATEMENT_MATCH_CONFIRMED', identities: [cardTransactionIdentity(juneStatement, mayPurchase)], selected: [sheetIdentity(mayRow)], updatedAt: '2026-06-01T00:00:00.000Z' }
    const unrelated = { key: 'PAIR_CONFIRMED:["bank:unrelated"]', schemaVersion: 1 as const, kind: 'PAIR_CONFIRMED', identities: ['bank:unrelated'], selected: ['sheet:unrelated'], updatedAt: '2026-06-01T00:00:00.000Z' }
    savedDecisionStore.set(decision.key, decision)
    savedDecisionStore.set(unrelated.key, unrelated)
    googleSheetsMocks.read.mockResolvedValue({ spreadsheetId: 'spreadsheet-id-12345', spreadsheetTitle: 'Planilha Selfit', transactions: [mayRow, juneRow], rowCount: 2 })
    saveGoogleSheetLink({ spreadsheetId: 'spreadsheet-id-12345', sheetName: 'CUSTOS ANO', spreadsheetTitle: 'Planilha Selfit', lastUpdated: null, autoConnect: true })
    vi.mocked(readCardStatementPdf).mockImplementation(async (file) => file.name.includes('maio') ? mayStatement : juneStatement)
    decisionSyncMocks.readRemote.mockResolvedValueOnce({ exists: false, active: [], tombstones: [] }).mockResolvedValueOnce({ exists: true, active: [], tombstones: [decision] })
    decisionSyncMocks.tombstone.mockImplementation((record) => { decisionSyncMocks.tombstones.set(record.key, { updatedAt: new Date().toISOString(), decision: record }) })
    decisionSyncMocks.deletion.mockImplementation(async (_id, _token, record, deletedAt) => {
      expect(record.key).toBe(decision.key)
      expect(listDecisionTombstones()[record.key]?.updatedAt).toBe(deletedAt)
      expect(Object.keys(listDecisionTombstones())).toEqual([decision.key])
    })
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true)
    render(<App />)
    await screen.findByText(/Lançamentos carregados do Google Sheets/)
    await user.upload(screen.getByLabelText('Selecionar fatura PDF'), [new File(['may invoice'], 'fatura-maio.pdf', { type: 'application/pdf' }), new File(['june invoice'], 'fatura-junho.pdf', { type: 'application/pdf' })])
    await waitFor(() => expect(screen.getAllByText(/^Fatura /)).toHaveLength(2))
    await user.click(screen.getByRole('button', { name: /Conciliar agora/ }))
    await user.click(screen.getByRole('button', { name: 'Auditar consistência' }))
    expect(await screen.findByRole('heading', { name: 'O mesmo lançamento está ligado a duas compras' })).toBeInTheDocument()
    decisionSyncMocks.deleteDecision.mockClear()
    const discard = await screen.findByRole('button', { name: 'Descartar vínculo antigo' })
    await user.click(discard)
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining('Nenhuma linha da CUSTOS ANO será alterada.'))
    expect(confirm.mock.calls.at(-1)?.[0]).toContain('encontrou outro lançamento válido')
    await waitFor(() => expect(decisionSyncMocks.deletion).toHaveBeenCalledWith('spreadsheet-id-12345', 'test-access-token', decision, expect.any(String)))
    await waitFor(() => expect(savedDecisionStore.has(decision.key)).toBe(false))
    expect(decisionSyncMocks.deleteDecision.mock.calls.map(([key]) => key)).toEqual([decision.key])
    expect(googleSheetsMocks.append).not.toHaveBeenCalled()
    await waitFor(() => expect(screen.queryByRole('heading', { name: 'O mesmo lançamento está ligado a duas compras' })).not.toBeInTheDocument())
    await user.click(screen.getByText(/Compras avaliadas/))
    await waitFor(() => expect(Array.from(document.querySelectorAll('pre')).filter((pre) => pre.textContent?.includes('"estadoAtual": "CARD_MATCHED"'))).toHaveLength(2))
    expect(Object.keys(listDecisionTombstones()).filter((key) => key === decision.key)).toHaveLength(1)
  })

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

  it('mostra no resumo de Ausentes apenas saídas visíveis e atualiza o total com o filtro de mês', async () => {
    const user = userEvent.setup()
    render(<App />)
    await user.upload(screen.getAllByLabelText('Selecionar arquivo CSV')[0], new File(['Descrição,Data,Custo\nEscola,01/01/2026,"90,00"'], 'custos.csv', { type: 'text/csv' }))
    await user.click(await screen.findByRole('button', { name: 'Usar 1 linha(s) válidas' }))
    const bankCsv = [
      'Data,Histórico,Valor,Tipo',
      '05/03/2026,PIX ENVIADO,"10,00",Débito',
      '05/04/2026,PIX ENVIADO,"20,00",Débito',
      '06/03/2026,PIX RECEBIDO,"40,00",Crédito',
      '07/03/2026,GASTOS CARTAO DE CREDITO,"30,00",Débito',
    ].join('\n')
    await user.upload(screen.getAllByLabelText('Selecionar arquivo CSV')[1], new File([bankCsv], 'extrato.csv', { type: 'text/csv' }))
    await user.click(await screen.findByRole('button', { name: 'Usar 4 linha(s) válidas' }))
    await user.click(screen.getByRole('button', { name: /Conciliar agora/ }))
    await user.click(screen.getByRole('tab', { name: /Ausentes/ }))
    expect(screen.getByRole('region', { name: 'Resumo de despesas ausentes' })).toHaveTextContent('2 lançamentos ausentes')
    expect(screen.getByRole('region', { name: 'Resumo de despesas ausentes' })).toHaveTextContent('Total: R$ 30,00')
    await user.selectOptions(screen.getByLabelText('Mês'), '03')
    expect(screen.getByRole('region', { name: 'Resumo de despesas ausentes' })).toHaveTextContent('1 lançamento ausente')
    expect(screen.getByRole('region', { name: 'Resumo de despesas ausentes' })).toHaveTextContent('Total: R$ 10,00')
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
    expect(requestGoogleSheetsAccessToken).toHaveBeenCalledWith(expect.any(String), '', false)
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
    expect(await screen.findByText(/^Fatura /)).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: /Conciliar agora/ }))
    await user.click(screen.getByRole('tab', { name: /Faturas PDF/ }))
    await user.click(screen.getByRole('button', { name: 'Mostrar conciliadas' }))
    await user.click(screen.getByRole('button', { name: 'Mostrar tudo' }))
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
    await screen.findByText(/^Fatura /)
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
    await screen.findByText(/^Fatura /)
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
    await screen.findByText(/^Fatura /)
    await waitFor(() => expect(savedDecisionStore.has(decision.key)).toBe(false))
    expect(savedDecisionStore.has(unrelatedBankDecision.key)).toBe(true)
    expect(decisionSyncMocks.tombstone).toHaveBeenCalledWith(decision)
    await user.click(screen.getByRole('button', { name: /Conciliar agora/ }))
    await user.click(screen.getByRole('tab', { name: /Faturas PDF/ }))
    await user.click(await screen.findByRole('button', { name: 'Mostrar conciliadas' }))
    const row = screen.getByText(/Amazon Kindle Unltd/).closest('article')!
    expect(within(row).queryByText('AUSÊNCIA CONFIRMADA')).not.toBeInTheDocument()
    expect(within(row).getByText('MATCHED · Crédito_Bradesco')).toBeInTheDocument()
    expect(within(row).queryByRole('button', { name: 'Adicionar à CUSTOS ANO' })).not.toBeInTheDocument()
  })

  it('rebaixa para REVIEW um vínculo confirmado cuja linha teve a data editada', async () => {
    const user = userEvent.setup()
    const statement: CardStatement = { ...structuredClone(syntheticStatement), statementIdentity: 'statement-kindle-date-edit', dueDate: '2026-03-12', transactions: [{ ...syntheticStatement.transactions[0], id: 'kindle-date-edit', date: '2026-02-02', purchaseDate: '2026-02-02', invoiceDueDate: '2026-03-12', statementDueDate: '2026-03-12', description: 'Amazon Kindle Unltd', originalDescription: 'Amazon Kindle Unltd', amount: 299 }] }
    const identity = `${statement.statementIdentity}:${stableFingerprint([statement.transactions[0].cardIdentifier, statement.transactions[0].date, statement.transactions[0].originalDescription, statement.transactions[0].amount, statement.transactions[0].direction, null, null])}`
    const saved = { key: `STATEMENT_MATCH_CONFIRMED:${JSON.stringify([identity])}`, schemaVersion: 1 as const, kind: 'STATEMENT_MATCH_CONFIRMED', identities: [identity], selected: ['kindle-edited-row'], updatedAt: new Date().toISOString() }
    savedDecisionStore.set(saved.key, saved)
    const edited = { id: 'kindle-edited-row', source: 'SHEET' as const, sheetRecordId: 'kindle-edited-row', bankTransactionId: null, date: '2026-04-12', description: 'Assinatura Kindle unlimited (2 meses)', originalDescription: 'Assinatura Kindle unlimited (2 meses)', amount: 299, direction: 'DEBIT' as const, type: 'OTHER' as const, paymentMethod: 'Crédito_Bradesco', category: 'Assinaturas', month: '04 - Abril', year: '2026', isFixed: false, isEssential: false, installment: null, totalInstallments: null, balanceAfter: null, original: {} }
    vi.mocked(readCardStatementPdf).mockResolvedValueOnce(statement)
    googleSheetsMocks.read.mockResolvedValue({ spreadsheetId: 'spreadsheet-id-12345', spreadsheetTitle: 'Planilha editada', transactions: [edited], rowCount: 1 })
    saveGoogleSheetLink({ spreadsheetId: 'spreadsheet-id-12345', sheetName: 'CUSTOS ANO', spreadsheetTitle: 'Planilha editada', lastUpdated: null, autoConnect: true })
    render(<App />)
    await screen.findByText(/Lançamentos carregados do Google Sheets/)
    await user.upload(screen.getByLabelText('Selecionar fatura PDF'), new File(['synthetic'], 'kindle-date-edit.pdf', { type: 'application/pdf' }))
    await screen.findByText(/^Fatura /)
    await user.click(screen.getByRole('button', { name: /Conciliar agora/ }))
    await user.click(screen.getByRole('tab', { name: /Faturas PDF/ }))
    const row = screen.getByText(/Amazon Kindle Unltd/).closest('article')!
    expect(within(row).getByText('REVISAR CORRESPONDÊNCIA')).toBeInTheDocument()
    expect(within(row).getByText(/CUSTOS ANO: 12\/04\/2026 · Assinatura Kindle unlimited/)).toBeInTheDocument()
    expect(within(row).queryByText('COMPRA DE CARTÃO NÃO REGISTRADA')).not.toBeInTheDocument()
    expect(savedDecisionStore.has(saved.key)).toBe(true)
  })

  it('permite rejeitar candidatos de REVIEW, sincroniza a decisão e reabre ao surgir candidato novo', async () => {
    const user = userEvent.setup()
    const statement: CardStatement = { ...structuredClone(syntheticStatement), fileName: 'fatura-ifood.pdf', statementIdentity: 'statement-ifood-review', dueDate: '2026-06-12', transactions: [{ ...syntheticStatement.transactions[0], id: 'ifood-purchase', date: '2026-05-14', purchaseDate: '2026-05-14', invoiceDueDate: '2026-06-12', statementDueDate: '2026-06-12', description: 'IFD*iFood', originalDescription: 'IFD*iFood', amount: 795, installment: null, totalInstallments: null }] }
    const oldCycle = { id: 'ifood-old-row', source: 'SHEET' as const, sheetRecordId: 'ifood-old-row', bankTransactionId: null, date: '2026-05-12', description: 'Mensalidade ifood', originalDescription: 'Mensalidade ifood', amount: 795, direction: 'DEBIT' as const, type: 'OTHER' as const, paymentMethod: 'Crédito_Bradesco', category: 'Assinaturas', month: '05 - Maio', year: '2026', isFixed: false, isEssential: false, installment: null, totalInstallments: null, balanceAfter: null, original: {} }
    googleSheetsMocks.read.mockResolvedValueOnce({ spreadsheetId: 'spreadsheet-id-12345', spreadsheetTitle: 'Planilha de ciclos', transactions: [oldCycle], rowCount: 1 })
    saveGoogleSheetLink({ spreadsheetId: 'spreadsheet-id-12345', sheetName: 'CUSTOS ANO', spreadsheetTitle: 'Planilha de ciclos', lastUpdated: null, autoConnect: true })
    vi.mocked(readCardStatementPdf).mockResolvedValueOnce(statement)
    render(<App />)
    await screen.findByText(/Lançamentos carregados do Google Sheets/)
    await user.upload(screen.getByLabelText('Selecionar fatura PDF'), new File(['synthetic'], 'ifood.pdf', { type: 'application/pdf' }))
    await screen.findByText(/^Fatura /)
    await user.click(screen.getByRole('button', { name: /Conciliar agora/ }))
    await user.click(screen.getByRole('tab', { name: /Faturas PDF/ }))
    const cardRow = screen.getByText(/IFD\*iFood/).closest('article')!
    expect(within(cardRow).getByText('REVISAR CORRESPONDÊNCIA')).toBeInTheDocument()
    await user.click(within(cardRow).getByRole('button', { name: 'Nenhum desses — está ausente' }))
    await waitFor(() => expect([...savedDecisionStore.values()].some((record) => record.kind === 'CARD_REVIEW_REJECTED_CANDIDATES')).toBe(true))
    const rejection = [...savedDecisionStore.values()].find((record) => record.kind === 'CARD_REVIEW_REJECTED_CANDIDATES')!
    expect(rejection.selected).toEqual([cardReviewCandidateIdentity(oldCycle)])
    await waitFor(() => expect(decisionSyncMocks.save).toHaveBeenCalledWith('spreadsheet-id-12345', 'test-access-token', rejection))
    expect(await screen.findByText('COMPRA DE CARTÃO NÃO REGISTRADA')).toBeInTheDocument()
    const missingRow = screen.getByText(/IFD\*iFood/).closest('article')!
    expect(within(missingRow).getByRole('button', { name: 'Adicionar à CUSTOS ANO' })).toBeInTheDocument()
    expect(within(missingRow).getByRole('button', { name: 'Ignorar' })).toBeInTheDocument()
  })

  it('recolhe faturas conciliadas, destaca exceções e mantém expansão somente na interface', async () => {
    const user = userEvent.setup()
    const clearStatement: CardStatement = { ...structuredClone(syntheticStatement), fileName: 'fatura-julho.pdf', statementIdentity: 'statement-july-clear', dueDate: '2025-07-12', reportedTotal: 6000, purchasesDebitsTotal: 6000, cardSubtotals: [{ cardIdentifier: '4321 XXXX XXXX 1111', amount: 6000 }], transactions: [{ ...syntheticStatement.transactions[0], id: 'july-clear-purchase', cardIdentifier: '4321 XXXX XXXX 1111', purchaseDate: '2025-06-02', date: '2025-06-02', invoiceDueDate: '2025-07-12', statementDueDate: '2025-07-12', amount: 6000, originalDescription: 'MERCADO JULHO', description: 'MERCADO JULHO' }] }
    const issueStatement: CardStatement = { ...structuredClone(syntheticStatement), fileName: 'fatura-agosto.pdf', statementIdentity: 'statement-august-issue', dueDate: '2025-08-12', reportedTotal: 7000, purchasesDebitsTotal: 7000, cardSubtotals: [{ cardIdentifier: '4321 XXXX XXXX 1111', amount: 7000 }], transactions: [
      { ...syntheticStatement.transactions[0], id: 'august-matched-purchase', cardIdentifier: '4321 XXXX XXXX 1111', purchaseDate: '2025-07-02', date: '2025-07-02', invoiceDueDate: '2025-08-12', statementDueDate: '2025-08-12', amount: 4000, originalDescription: 'SERVIÇO EXISTENTE', description: 'SERVIÇO EXISTENTE' },
      { ...syntheticStatement.transactions[0], id: 'august-missing-purchase', cardIdentifier: '4321 XXXX XXXX 1111', purchaseDate: '2025-07-08', date: '2025-07-08', invoiceDueDate: '2025-08-12', statementDueDate: '2025-08-12', amount: 3000, originalDescription: 'LOJA AUSENTE', description: 'LOJA AUSENTE' },
    ] }
    const row = (id: string, date: string, description: string, amount: number) => ({ id, source: 'SHEET' as const, sheetRecordId: id, bankTransactionId: null, date, description, originalDescription: description, amount, direction: 'DEBIT' as const, type: 'OTHER' as const, paymentMethod: 'Crédito_Bradesco', category: 'Casa', month: '', year: date.slice(0, 4), isFixed: false, isEssential: false, installment: null, totalInstallments: null, balanceAfter: null, original: {} })
    const sheetRows = [row('july-sheet', '2025-07-12', 'Compra cartão cadastrada', 6000), row('august-sheet', '2025-08-12', 'Compra cartão cadastrada', 4000)]
    googleSheetsMocks.read.mockResolvedValue({ spreadsheetId: 'spreadsheet-id-12345', spreadsheetTitle: 'Planilha UX', transactions: sheetRows, rowCount: sheetRows.length })
    saveGoogleSheetLink({ spreadsheetId: 'spreadsheet-id-12345', sheetName: 'CUSTOS ANO', spreadsheetTitle: 'Planilha UX', lastUpdated: null, autoConnect: true })
    vi.mocked(readCardStatementPdf).mockResolvedValueOnce(clearStatement).mockResolvedValueOnce(issueStatement)
    const { container } = render(<App />)
    await screen.findByText(/Lançamentos carregados do Google Sheets/)
    await user.upload(screen.getByLabelText('Selecionar arquivo CSV'), new File(['Data,Descrição,Valor,Tipo,Forma de pagamento,ID\n12/07/2025,GASTOS CARTAO DE CREDITO,"60,00",Débito,Débito,pay-july\n12/08/2025,GASTOS CARTAO DE CREDITO,"70,00",Débito,Débito,pay-august'], 'pagamentos.csv', { type: 'text/csv' }))
    await user.click(await screen.findByRole('button', { name: 'Usar 2 linha(s) válidas' }))
    await user.upload(screen.getByLabelText('Selecionar fatura PDF'), [new File(['july pdf'], 'fatura-julho.pdf', { type: 'application/pdf' }), new File(['august pdf'], 'fatura-agosto.pdf', { type: 'application/pdf' })])
    await waitFor(() => expect(screen.getAllByText(/^Fatura /)).toHaveLength(2))
    await user.click(screen.getByRole('button', { name: /Conciliar agora/ }))
    await user.click(screen.getByRole('tab', { name: /Faturas PDF/ }))
    expect(container.querySelectorAll('.statement-results')).toHaveLength(2)
    expect(screen.getByText(/LOJA AUSENTE/)).toBeInTheDocument()
    expect(screen.queryByText(/SERVIÇO EXISTENTE/)).not.toBeInTheDocument()
    expect(screen.getAllByRole('button', { name: 'Mostrar tudo' })[0]).toHaveAttribute('aria-expanded', 'false')
    await user.click(screen.getByRole('button', { name: 'Só pendências' }))
    expect(container.querySelectorAll('.statement-results')).toHaveLength(1)
    await user.click(screen.getByRole('button', { name: 'Todas' }))
    const issueInvoice = [...container.querySelectorAll<HTMLElement>('.statement-results')].find((card) => card.textContent?.includes('LOJA AUSENTE'))!
    await user.click(within(issueInvoice).getByRole('button', { name: 'Mostrar conciliadas' }))
    expect(screen.getByText(/SERVIÇO EXISTENTE/)).toBeInTheDocument()
    await user.click(within(issueInvoice).getByRole('button', { name: 'Recolher' }))
    expect(screen.queryByText(/SERVIÇO EXISTENTE/)).not.toBeInTheDocument()
    expect(savedDecisionStore.size).toBe(0)
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
    await screen.findByText(/^Fatura /)
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
    const savedKey = 'PAIR_CONFIRMED:["bank:keep"]'
    savedDecisionStore.set(savedKey, { key: savedKey, schemaVersion: 1, kind: 'PAIR_CONFIRMED', identities: ['bank:keep'], selected: ['sheet:keep'], updatedAt: '2026-01-01T00:00:00.000Z' })
    render(<App />)
    const input = screen.getByLabelText('Selecionar fatura PDF') as HTMLInputElement
    expect(input.multiple).toBe(true)
    const june = new File(['june pdf bytes'], 'fatura-junho.pdf', { type: 'application/pdf' })
    const july = new File(['july pdf bytes'], 'fatura-julho.pdf', { type: 'application/pdf' })
    await user.upload(input, [june, july])
    expect(await screen.findByRole('button', { name: 'Remover fatura-junho.pdf' })).toBeInTheDocument()
    expect(await screen.findByRole('button', { name: 'Remover fatura-julho.pdf' })).toBeInTheDocument()
    expect(screen.getAllByText(/^Fatura /)).toHaveLength(2)

    await user.upload(screen.getByLabelText('Selecionar fatura PDF'), june)
    expect(await screen.findByText(/1 PDF duplicado foi ignorado/)).toBeInTheDocument()
    expect(screen.getAllByRole('button', { name: 'Remover fatura-junho.pdf' })).toHaveLength(1)
    await user.click(screen.getByRole('button', { name: 'Remover fatura-junho.pdf' }))
    expect(screen.queryByRole('button', { name: 'Remover fatura-junho.pdf' })).not.toBeInTheDocument()
    await user.upload(screen.getByLabelText('Selecionar fatura PDF'), june)
    expect(await screen.findByRole('button', { name: 'Remover fatura-junho.pdf' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Remover fatura-julho.pdf' })).toBeInTheDocument()
    await user.upload(screen.getByLabelText('Selecionar fatura PDF'), july)
    expect(await screen.findByText(/1 PDF duplicado foi ignorado/)).toBeInTheDocument()
    expect(savedDecisionStore.has(savedKey)).toBe(true)
    await user.upload(screen.getByLabelText('Selecionar fatura PDF'), june)
    expect(await screen.findByText(/1 PDF duplicado foi ignorado/)).toBeInTheDocument()
  })

  it('não cria duas conciliações para PDFs mobile e Internet Banking com o mesmo conteúdo financeiro', async () => {
    const user = userEvent.setup()
    const internetLayout = { ...structuredClone(syntheticStatement), sourceLayout: 'INTERNET_BANKING' as const, statementIdentity: 'statement-internet-banking' }
    const mobileLayout = { ...structuredClone(syntheticStatement), sourceLayout: 'MOBILE_APP' as const }
    vi.mocked(readCardStatementPdf).mockResolvedValueOnce(mobileLayout).mockResolvedValueOnce(internetLayout)
    render(<App />)
    await user.upload(screen.getByLabelText('Selecionar fatura PDF'), [
      new File(['mobile pdf bytes'], 'mobile.pdf', { type: 'application/pdf' }),
      new File(['internet banking pdf bytes'], 'internet-banking.pdf', { type: 'application/pdf' }),
    ])
    expect(await screen.findByText(/1 fatura com conteúdo financeiro já carregado foi ignorada/)).toBeInTheDocument()
    expect(screen.getAllByTestId('card-pdf-entry')).toHaveLength(1)
    expect(screen.getByRole('button', { name: 'Remover mobile.pdf' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Remover internet-banking.pdf' })).not.toBeInTheDocument()
  })

  it('mantém vários PDFs válidos compactos, resume o lote e expande/recolhe os detalhes sob demanda', async () => {
    const user = userEvent.setup()
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true)
    render(<App />)
    await user.upload(screen.getByLabelText('Selecionar fatura PDF'), [
      new File(['invoice one'], 'Bradesco_Fatura_nome-extenso_1.pdf', { type: 'application/pdf' }),
      new File(['invoice two'], 'Bradesco_Fatura_nome-extenso_2.pdf', { type: 'application/pdf' }),
    ])

    expect(await screen.findByText('2 faturas carregadas')).toBeInTheDocument()
    expect(screen.getByText('4 compras · 2 estornos/créditos')).toBeInTheDocument()
    expect(screen.getByText('Total líquido: R$ 200,00')).toBeInTheDocument()
    expect(screen.getByText('✓ Todas as faturas foram lidas corretamente')).toBeInTheDocument()
    const entries = screen.getAllByTestId('card-pdf-entry')
    expect(entries).toHaveLength(2)
    for (const entry of entries) {
      expect(within(entry).getByText('Fatura 12/07/2025 · 2 cartões')).toBeInTheDocument()
      expect(within(entry).getByText('R$ 100,00 · 2 compras · 1 estorno/crédito')).toBeInTheDocument()
      expect(within(entry).getByText('✓ Valores conferem')).toBeInTheDocument()
      expect(within(entry).getByRole('button', { name: 'Ver detalhes' })).toHaveAttribute('aria-expanded', 'false')
      expect(within(entry).queryByText(/Bradesco_Fatura_nome-extenso/)).not.toBeInTheDocument()
    }
    expect(screen.getByLabelText('Selecionar fatura PDF').parentElement).toHaveClass('card-pdf-drop-compact')

    await user.click(screen.getByRole('button', { name: 'Expandir todas' }))
    expect(await screen.findByText('Arquivo: Bradesco_Fatura_nome-extenso_1.pdf')).toBeInTheDocument()
    expect(screen.getAllByText('2 páginas · 2 cartões encontrados · final 1111, final 2222')).toHaveLength(2)
    expect(screen.getAllByText('Compras e créditos extraídos')).toHaveLength(2)
    await user.click(screen.getByRole('button', { name: 'Recolher todas' }))
    expect(screen.queryByText('Arquivo: Bradesco_Fatura_nome-extenso_1.pdf')).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Remover todas' }))
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining('Remover todas as faturas PDF'))
    expect(screen.queryByText('2 faturas carregadas')).not.toBeInTheDocument()
  })

  it('abre automaticamente uma fatura com divergência e preserva o diagnóstico nos detalhes', async () => {
    vi.mocked(readCardStatementPdf).mockResolvedValueOnce({ ...structuredClone(syntheticStatement), errors: ['A soma extraída difere do total informado.'] })
    const user = userEvent.setup()
    render(<App />)
    await user.upload(screen.getByLabelText('Selecionar fatura PDF'), new File(['problem invoice'], 'fatura-divergente.pdf', { type: 'application/pdf' }))
    const entry = await screen.findByTestId('card-pdf-entry')
    expect(within(entry).getAllByText('⚠ Valores não conferem')).toHaveLength(2)
    expect(within(entry).getByRole('button', { name: 'Recolher detalhes' })).toHaveAttribute('aria-expanded', 'true')
    expect(within(entry).getByText('Arquivo: fatura-divergente.pdf')).toBeInTheDocument()
    expect(within(entry).getByText('A soma extraída difere do total informado.')).toBeInTheDocument()
  })

  it('libera os sete PDFs ao removê-los da sessão e aceita o mesmo lote novamente sem reload', async () => {
    const user = userEvent.setup()
    render(<App />)
    const files = Array.from({ length: 7 }, (_, index) => new File([`pdf-content-${index}`], `fatura-${index + 1}.pdf`, { type: 'application/pdf' }))
    await user.upload(screen.getByLabelText('Selecionar fatura PDF'), files)
    await waitFor(() => expect(screen.getAllByText(/^Fatura /)).toHaveLength(7))
    for (const file of files) await user.click(screen.getByRole('button', { name: `Remover ${file.name}` }))
    expect(screen.queryByRole('button', { name: 'Remover fatura-1.pdf' })).not.toBeInTheDocument()
    await user.upload(screen.getByLabelText('Selecionar fatura PDF'), files)
    await waitFor(() => expect(screen.getAllByText(/^Fatura /)).toHaveLength(7))
    for (const file of files) expect(screen.getByRole('button', { name: `Remover ${file.name}` })).toBeInTheDocument()
  })

  it('processa uma única cópia quando o mesmo PDF aparece duas vezes no mesmo lote', async () => {
    const user = userEvent.setup()
    const one = new File(['same bytes'], 'fatura-a.pdf', { type: 'application/pdf' })
    const duplicate = new File(['same bytes'], 'copia.pdf', { type: 'application/pdf' })
    vi.mocked(readCardStatementPdf).mockClear()
    render(<App />)
    await user.upload(screen.getByLabelText('Selecionar fatura PDF'), [one, duplicate])
    expect(await screen.findByRole('button', { name: 'Remover fatura-a.pdf' })).toBeInTheDocument()
    await screen.findByText(/1 PDF duplicado foi ignorado/)
    expect(screen.queryByText('copia.pdf')).not.toBeInTheDocument()
    expect(vi.mocked(readCardStatementPdf)).toHaveBeenCalledTimes(1)
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
    expect(await screen.findByText('Arquivo: corrompido.pdf')).toBeInTheDocument()
    expect(screen.getByText('⚠ Erro de parsing')).toBeInTheDocument()
    expect(await screen.findByRole('button', { name: 'Remover valido.pdf' })).toBeInTheDocument()
    expect(screen.getByText('Fatura 12/07/2025 · 2 cartões')).toBeInTheDocument()
    expect(screen.getByText('1 PDF não pôde ser lido.')).toBeInTheDocument()
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
    await screen.findByRole('button', { name: 'Remover junho.pdf' })
    await screen.findByRole('button', { name: 'Remover julho.pdf' })
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
    await screen.findByRole('button', { name: 'Remover junho.pdf' })
    await screen.findByRole('button', { name: 'Remover julho.pdf' })
    await user.click(screen.getByRole('button', { name: /Conciliar agora/ }))
    await user.click(screen.getByRole('tab', { name: /Faturas PDF/ }))
    await user.click(screen.getByRole('button', { name: 'Mostrar ignorados' }))
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
    expect(await screen.findByText('2 válidas · 0 ignoradas · 0 problemas')).toBeInTheDocument()
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
    expect(await screen.findByText('Extrato reconhecido')).toBeInTheDocument()
    expect(screen.getByText('3 lançamentos válidos')).toBeInTheDocument()
    expect(screen.getByText('Formato identificado: Bradesco')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Configuração avançada/ })).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByText('Direção da conta')).not.toBeInTheDocument()
    await user.click(screen.getByText(/Ver prévia/))
    expect(screen.getByText('1 linha(s) de metadados ignoradas antes do cabeçalho.')).toBeInTheDocument()
    expect(screen.getByText(/4 ignoradas/)).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: /Configuração avançada/ }))
    expect(screen.getByRole('button', { name: /Configuração avançada/ })).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByText('Direção da conta')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Usar extrato' }))
    expect(screen.getByText(/Extrato carregado · 3 lançamentos/)).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: /Conciliar agora/ }))
    expect(await screen.findByRole('heading', { name: 'Visão geral' })).toBeInTheDocument()
    expect(document.querySelector('.metric-green .metric-value')).toHaveTextContent('1')
  })

  it('abre o mapeamento quando o CSV bancário tem colunas candidatas ambíguas', async () => {
    const user = userEvent.setup()
    render(<App />)
    const file = new File(['Data,Data transação,Histórico,Crédito (R$),Débito (R$),Saldo (R$)\n02/02/2026,02/02/2026,PIX RECEBIDO,"12,00",,120,00'], 'ambiguo.csv', { type: 'text/csv' })
    await user.upload(screen.getAllByLabelText('Selecionar arquivo CSV')[1], file)
    expect(await screen.findByText('Precisamos confirmar algumas colunas')).toBeInTheDocument()
    expect(screen.getByText('Confira o mapeamento das colunas')).toBeInTheDocument()
    expect(screen.getByLabelText(/Data/)).toBeInTheDocument()
    expect(screen.queryByText('Extrato reconhecido')).not.toBeInTheDocument()
  })

  it('inicia Correspondências encontradas recolhido e preserva os controles manuais', async () => {
    const user = userEvent.setup()
    render(<App />)
    const sheet = new File(['Descrição,Data,Custo\nCafé Exemplo,02/02/2026,"12,00"'], 'custos.csv', { type: 'text/csv' })
    const bank = new File(['Data,Descrição,Valor,Tipo\n02/02/2026,Café Exemplo,"12,00",Débito'], 'banco.csv', { type: 'text/csv' })
    await user.upload(screen.getAllByLabelText('Selecionar arquivo CSV')[0], sheet)
    await user.click(await screen.findByRole('button', { name: 'Usar 1 linha(s) válidas' }))
    await user.upload(screen.getAllByLabelText('Selecionar arquivo CSV')[1], bank)
    await user.click(await screen.findByRole('button', { name: 'Usar 1 linha(s) válidas' }))
    await user.click(screen.getByRole('button', { name: /Conciliar agora/ }))

    const matches = await screen.findByText(/Correspondências encontradas · 1/)
    const disclosure = matches.closest('details') as HTMLElement
    expect(disclosure).not.toHaveAttribute('open')
    await user.click(within(disclosure).getByText(/Correspondências encontradas/))
    expect(disclosure).toHaveAttribute('open')
    expect(within(disclosure).getAllByText(/Café Exemplo/)).toHaveLength(2)
    await user.click(within(disclosure).getByText(/Correspondências encontradas/))
    expect(disclosure).not.toHaveAttribute('open')
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
    const confirmedPayment = document.querySelector('.card-payment-card') as HTMLElement
    expect(within(confirmedPayment).getByRole('button', { name: 'Ver detalhes' })).toHaveAttribute('aria-expanded', 'false')
    expect(within(confirmedPayment).queryByText(/Decisão salva neste dispositivo/)).not.toBeInTheDocument()
    await user.click(within(confirmedPayment).getByRole('button', { name: 'Ver detalhes' }))
    expect(within(confirmedPayment).getByText(/Decisão salva neste dispositivo/)).toBeInTheDocument()
    await user.click(within(confirmedPayment).getByRole('button', { name: 'Recolher detalhes' }))
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

  it('reconecta uma vez e sincroniza PDF/CSV do Drive pelos parsers existentes, sem repetir arquivos iguais na sessão', async () => {
    const user = userEvent.setup()
    saveGoogleSheetLink({ spreadsheetId: 'spreadsheet-id-12345', sheetName: 'CUSTOS ANO', spreadsheetTitle: 'Planilha conectada', lastUpdated: null, autoConnect: true })
    saveDriveFolders({ invoices: { id: 'invoice-folder', name: 'Faturas' }, statements: { id: 'statement-folder', name: 'Extratos' } })
    googleDriveMocks.list.mockImplementation(async (folderId: string) => folderId === 'invoice-folder'
      ? [
        { id: 'drive-pdf', name: 'fatura-drive.pdf', mimeType: 'application/pdf', modifiedTime: '2026-10-06T10:00:00Z', size: '20' },
        { id: 'ignored-pdf-folder', name: 'not-a-pdf.txt', mimeType: 'text/plain', modifiedTime: '2026-10-06T10:00:00Z' },
      ]
      : [
        { id: 'drive-csv', name: 'extrato-drive.csv', mimeType: 'text/csv', modifiedTime: '2026-10-06T10:00:00Z', size: '80' },
        { id: 'ignored-csv-folder', name: 'not-a-csv.pdf', mimeType: 'application/pdf', modifiedTime: '2026-10-06T10:00:00Z' },
      ])
    googleDriveMocks.download.mockImplementation(async (id: string) => new Blob([id === 'drive-csv'
      ? 'Data;Histórico;Débito R$;Crédito R$;Saldo\n05/10/2026;PIX ENVIADO;25,00;;-100,00'
      : 'synthetic pdf'], { type: id === 'drive-csv' ? 'text/csv' : 'application/pdf' }))
    render(<App />)
    expect(await screen.findByText('2 arquivo(s) novo(s) processado(s)')).toBeInTheDocument()
    expect(googleDriveMocks.list).toHaveBeenCalledWith('invoice-folder', 'test-access-token')
    expect(googleDriveMocks.list).toHaveBeenCalledWith('statement-folder', 'test-access-token')
    expect(googleDriveMocks.download).toHaveBeenCalledTimes(2)
    expect(googleDriveMocks.download).not.toHaveBeenCalledWith('ignored-pdf-folder', expect.anything())
    expect(googleDriveMocks.download).not.toHaveBeenCalledWith('ignored-csv-folder', expect.anything())
    expect(vi.mocked(readCardStatementPdf)).toHaveBeenCalledWith(expect.objectContaining({ name: 'fatura-drive.pdf' }))
    expect(vi.mocked(requestGoogleSheetsAccessToken)).toHaveBeenCalledWith('vitest-mock-client.apps.googleusercontent.com', '', true)
    expect(screen.getByRole('region', { name: 'Fontes do Google Drive' })).toHaveTextContent('Extratos: 1')

    await user.upload(screen.getByLabelText('Selecionar fatura PDF'), new File(['synthetic pdf'], 'manual-copia.pdf', { type: 'application/pdf' }))
    expect(await screen.findByText(/PDF duplicado foi ignorado/)).toBeInTheDocument()
    expect(vi.mocked(readCardStatementPdf)).toHaveBeenCalledTimes(1)

    await user.click(screen.getByRole('button', { name: 'Sincronizar arquivos' }))
    await waitFor(() => expect(googleDriveMocks.list).toHaveBeenCalledTimes(4))
    expect(googleDriveMocks.download).toHaveBeenCalledTimes(2)
    await user.click(screen.getByRole('button', { name: 'Remover fatura-drive.pdf' }))
    await user.click(screen.getByRole('button', { name: 'Sincronizar arquivos' }))
    await waitFor(() => expect(googleDriveMocks.list).toHaveBeenCalledTimes(6))
    expect(googleDriveMocks.download).toHaveBeenCalledTimes(2)
    const drivePanel = screen.getByRole('region', { name: 'Fontes do Google Drive' })
    await user.click(within(drivePanel).getByRole('button', { name: 'Remover da sessão' }))
    expect(within(drivePanel).queryByText('extrato-drive.csv')).not.toBeInTheDocument()
    await user.click(within(drivePanel).getByRole('button', { name: 'Sincronizar arquivos' }))
    await waitFor(() => expect(googleDriveMocks.list).toHaveBeenCalledTimes(8))
    expect(googleDriveMocks.download).toHaveBeenCalledTimes(2)
  })

  it('continua processando os demais arquivos se um PDF do Drive falhar', async () => {
    saveGoogleSheetLink({ spreadsheetId: 'spreadsheet-id-12345', sheetName: 'CUSTOS ANO', spreadsheetTitle: 'Planilha conectada', lastUpdated: null, autoConnect: true })
    saveDriveFolders({ invoices: { id: 'invoice-folder', name: 'Faturas' }, statements: null })
    googleDriveMocks.list.mockResolvedValue([
      { id: 'good-pdf', name: 'boa.pdf', mimeType: 'application/pdf', modifiedTime: 'v1' },
      { id: 'bad-pdf', name: 'ruim.pdf', mimeType: 'application/pdf', modifiedTime: 'v1' },
    ])
    googleDriveMocks.download.mockImplementation(async (id: string) => new Blob([id]))
    vi.mocked(readCardStatementPdf).mockImplementation(async (file) => {
      if (file.name === 'ruim.pdf') throw new Error('PDF inválido')
      return syntheticStatement
    })
    render(<App />)
    await waitFor(() => expect(googleDriveMocks.list).toHaveBeenCalledWith('invoice-folder', 'test-access-token'))
    const drivePanel = screen.getByRole('region', { name: 'Fontes do Google Drive' })
    await waitFor(() => {
      expect(within(drivePanel).getByText(/precisam de atenção/)).toBeVisible()
      expect(within(drivePanel).getByRole('button', { name: 'Sincronizar arquivos' })).toBeEnabled()
    })
    const pdfEntries = screen.getAllByTestId('card-pdf-entry')
    expect(pdfEntries).toHaveLength(2)
    expect(within(pdfEntries[0]).getByText('✓ Valores conferem')).toBeInTheDocument()
    expect(within(pdfEntries[1]).getByText('⚠ Erro de parsing')).toBeInTheDocument()
    expect(googleDriveMocks.download).toHaveBeenCalledTimes(2)
    expect(vi.mocked(readCardStatementPdf)).toHaveBeenCalledTimes(2)
  })

  it('não baixa arquivos do Drive sem autorização', async () => {
    saveDriveFolders({ invoices: { id: 'invoice-folder', name: 'Faturas' }, statements: null })
    render(<App />)
    expect(screen.getByRole('button', { name: 'Sincronizar arquivos' })).toBeDisabled()
    expect(googleDriveMocks.download).not.toHaveBeenCalled()
  })

  it('reprocessa um CSV do Drive quando modifiedTime muda', async () => {
    const user = userEvent.setup()
    let modifiedTime = 'v1'
    saveGoogleSheetLink({ spreadsheetId: 'spreadsheet-id-12345', sheetName: 'CUSTOS ANO', spreadsheetTitle: 'Planilha conectada', lastUpdated: null, autoConnect: true })
    saveDriveFolders({ invoices: null, statements: { id: 'statement-folder', name: 'Extratos' } })
    googleDriveMocks.list.mockImplementation(async () => [{ id: 'drive-csv', name: 'extrato.csv', mimeType: 'text/csv', modifiedTime, size: '40' }])
    googleDriveMocks.download.mockImplementation(async () => new Blob([`Data;Histórico;Débito R$;Crédito R$;Saldo\n05/10/2026;PIX ENVIADO;25,00;;-${modifiedTime === 'v1' ? '100,00' : '125,00'}`]))
    render(<App />)
    await waitFor(() => expect(googleDriveMocks.download).toHaveBeenCalledTimes(1))
    expect(await screen.findByText('1 arquivo(s) novo(s) processado(s)')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Sincronizar arquivos' }))
    await waitFor(() => expect(googleDriveMocks.list).toHaveBeenCalledTimes(2))
    expect(googleDriveMocks.download).toHaveBeenCalledTimes(1)
    modifiedTime = 'v2'
    await user.click(screen.getByRole('button', { name: 'Sincronizar arquivos' }))
    await waitFor(() => expect(googleDriveMocks.download).toHaveBeenCalledTimes(2))
    expect(screen.getByRole('region', { name: 'Fontes do Google Drive' })).toHaveTextContent('Extratos: 1')
  })
})
