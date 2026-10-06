import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  extractSpreadsheetId, GOOGLE_SHEETS_SCOPE, GoogleSheetsError, mapGoogleSheetValues,
  readGoogleSheetLedger, requestGoogleSheetsAccessToken, revokeGoogleSheetsAccessToken,
} from './googleSheets'

const headers = ['Ano', 'Descrição', 'ID', 'Data', 'Custo', 'Mês', 'Categoria', 'Forma de pagamento', 'É fixo?', 'É essencial?']
const values = [headers, ['2026', 'Mercado sintético', 'row-id-001', '12/05/2026', '94,50', '05 - Maio', 'Casa', 'Pix', 'Não', 'Sim']]

function response(body: unknown, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response
}

describe('leitura da aba financeira via Google Sheets', () => {
  beforeEach(() => { delete (window as Window & { google?: unknown }).google })

  it('faz o primeiro consentimento sem forçar prompt nem seletor de conta', async () => {
    const requestAccessToken = vi.fn((_options?: { prompt?: string }) => tokenCallback({ access_token: 'memory-token' }))
    let tokenCallback: (response: { access_token: string }) => void = () => undefined
    const initTokenClient = vi.fn((options: { callback: (result: { access_token: string }) => void }) => {
      tokenCallback = options.callback
      return { requestAccessToken }
    })
    ;(window as Window & { google?: unknown }).google = { accounts: { oauth2: { initTokenClient, revoke: vi.fn() } } }
    await expect(requestGoogleSheetsAccessToken('client-id.apps.googleusercontent.com')).resolves.toBe('memory-token')
    expect(initTokenClient).toHaveBeenCalledWith(expect.objectContaining({ scope: GOOGLE_SHEETS_SCOPE, include_granted_scopes: true }))
    expect(requestAccessToken).toHaveBeenCalledOnce()
    expect(requestAccessToken).toHaveBeenCalledWith()
    expect(GOOGLE_SHEETS_SCOPE).toBe('https://www.googleapis.com/auth/spreadsheets')
  })

  it('tenta restaurar token após reload sem abrir consentimento ou seletor de conta', async () => {
    const requestAccessToken = vi.fn((_options?: { prompt?: string }) => tokenCallback({ access_token: 'renewed-memory-token' }))
    let tokenCallback: (response: { access_token: string }) => void = () => undefined
    const initTokenClient = vi.fn((options: { callback: (result: { access_token: string }) => void }) => {
      tokenCallback = options.callback
      return { requestAccessToken }
    })
    ;(window as Window & { google?: unknown }).google = { accounts: { oauth2: { initTokenClient, revoke: vi.fn() } } }
    await expect(requestGoogleSheetsAccessToken('client-id.apps.googleusercontent.com', '')).resolves.toBe('renewed-memory-token')
    expect(requestAccessToken).toHaveBeenCalledWith({ prompt: '' })
  })

  it('revoga autorização somente quando solicitado explicitamente', () => {
    const revoke = vi.fn()
    ;(window as Window & { google?: unknown }).google = { accounts: { oauth2: { initTokenClient: vi.fn(), revoke } } }
    revokeGoogleSheetsAccessToken('memory-token')
    expect(revoke).toHaveBeenCalledWith('memory-token', expect.any(Function))
  })

  it('extrai ID de URL e aceita ID direto', () => {
    expect(extractSpreadsheetId('https://docs.google.com/spreadsheets/d/abcdefghijklmnop/edit#gid=0')).toBe('abcdefghijklmnop')
    expect(extractSpreadsheetId('abcdefghijklmnop')).toBe('abcdefghijklmnop')
    expect(() => extractSpreadsheetId('inválido')).toThrow(GoogleSheetsError)
  })

  it('mapeia as dez colunas por nome e preserva ID, Mês e Ano', () => {
    const [ledger] = mapGoogleSheetValues(values)
    expect(ledger).toMatchObject({
      sheetRecordId: 'row-id-001', date: '2026-05-12', amount: 9450, month: '05 - Maio', year: '2026',
      category: 'Casa', paymentMethod: 'Pix', isFixed: false, isEssential: true,
    })
    expect(ledger.original.ID).toBe('row-id-001')
  })

  it('lê exclusivamente a aba CUSTOS ANO e converte para LedgerTransaction', async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(response({ properties: { title: 'Finanças' }, sheets: [{ properties: { sheetId: 7, title: 'CUSTOS ANO' } }] }))
      .mockResolvedValueOnce(response({ values }))
    const result = await readGoogleSheetLedger('https://docs.google.com/spreadsheets/d/abcdefghijklmnop/edit', 'token', fetcher)
    expect(result).toMatchObject({ spreadsheetId: 'abcdefghijklmnop', spreadsheetTitle: 'Finanças', rowCount: 1 })
    expect(result.transactions[0].sheetRecordId).toBe('row-id-001')
    expect(decodeURIComponent(fetcher.mock.calls[1][0] as string)).toContain("'CUSTOS ANO'!A:ZZ")
    expect(fetcher.mock.calls.every((call) => (call[1] as RequestInit).method !== 'POST')).toBe(true)
  })

  it('mostra erro claro quando CUSTOS ANO não existe', async () => {
    const fetcher = vi.fn().mockResolvedValue(response({ sheets: [{ properties: { title: 'Resumo' } }] }))
    await expect(readGoogleSheetLedger('abcdefghijklmnop', 'token', fetcher)).rejects.toMatchObject({ code: 'TAB_MISSING' })
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it('recusa cabeçalhos incompletos ou repetidos', () => {
    expect(() => mapGoogleSheetValues([headers.slice(0, 5)])).toThrow(/Cabeçalhos ausentes/)
    expect(() => mapGoogleSheetValues([[...headers, 'Categoria']])).toThrow(/repetidos/)
  })

  it('interrompe a leitura ao encontrar IDs repetidos ou linhas inválidas', () => {
    expect(() => mapGoogleSheetValues([headers, values[1], [...values[1].slice(0, 2), 'row-id-001', ...values[1].slice(3)]])).toThrow(/ID contém valores repetidos/)
    expect(() => mapGoogleSheetValues([headers, ['2026', 'Sem custo', 'row-id-002', '12/05/2026', '', '05 - Maio', 'Casa', 'Pix', 'Não', 'Sim']])).toThrow(/linha\(s\).*inválido/)
  })

  it.each([[401, 'AUTH'], [403, 'ACCESS'], [404, 'NOT_FOUND']] as const)('classifica resposta HTTP %s', async (status, code) => {
    const fetcher = vi.fn().mockResolvedValue(response({}, status))
    await expect(readGoogleSheetLedger('abcdefghijklmnop', 'token', fetcher)).rejects.toMatchObject({ code })
  })

  it('não altera Mês/Ano nem inclui caminho de escrita na leitura', async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(response({ properties: { title: 'Finanças' }, sheets: [{ properties: { title: 'CUSTOS ANO' } }] }))
      .mockResolvedValueOnce(response({ values }))
    const [{ transactions }] = [await readGoogleSheetLedger('abcdefghijklmnop', 'token', fetcher)]
    expect(transactions[0].month).toBe('05 - Maio')
    expect(transactions[0].year).toBe('2026')
    expect(fetcher.mock.calls.map(([url]) => String(url))).not.toContain(expect.stringContaining('/values:append'))
  })
})
