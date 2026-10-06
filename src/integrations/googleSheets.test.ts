import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  appendCostYearRecord, extractSpreadsheetId, generateCostYearId, GOOGLE_SHEETS_SCOPE, GoogleSheetsError, mapGoogleSheetValues,
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
    expect(() => mapGoogleSheetValues([headers, ['2026', 'Sem custo', 'row-id-002', '12/05/2026', '', '05 - Maio', 'Casa', 'Pix', 'Não', 'Sim']])).toThrow(/Integridade inválida|linha\(s\).*inválido/)
  })

  it('ignora linhas futuras que contêm apenas FALSE nos checkboxes', () => {
    const futureDefaults = Array.from({ length: 250 }, () => ['', '', '', '', '', '', '', '', 'FALSE', 'FALSE'])
    expect(() => mapGoogleSheetValues([headers, ...futureDefaults])).toThrow(/não contém lançamentos válidos/)
    expect(mapGoogleSheetValues([headers, values[1], ...futureDefaults])).toHaveLength(1)
  })

  it('trata linha financeira sem ID como erro de integridade, não como linha vazia', () => {
    expect(() => mapGoogleSheetValues([headers, ['2026', 'Compra sem ID', '', '12/05/2026', '94,50', '05 - Maio', 'Casa', 'Pix', 'FALSE', 'FALSE']]))
      .toThrow(/Integridade inválida na linha 2.*ID/)
  })

  it('trata outros dados principais em linha incompleta como erro de integridade', () => {
    expect(() => mapGoogleSheetValues([headers, ['2026', '', '', '', '', '', 'Casa', '', 'FALSE', 'FALSE']]))
      .toThrow(/Integridade inválida na linha 2/)
  })

  it('gera ID hexadecimal de oito caracteres e repete em caso de colisão', () => {
    const blocks = [[0x12, 0x34, 0x56, 0x78], [0xab, 0xcd, 0xef, 0x01]]
    const randomBytes = (buffer: Uint8Array) => { buffer.set(blocks.shift()!); return buffer }
    expect(generateCostYearId(['12345678'], randomBytes)).toBe('abcdef01')
    expect(generateCostYearId([], (buffer) => { buffer.set([1, 2, 3, 4]); return buffer })).toMatch(/^[0-9a-f]{8}$/)
  })

  it('faz append na próxima linha lógica, ignora checkboxes futuros e não escreve Mês/Ano', async () => {
    const futureDefaults = Array.from({ length: 250 }, () => ['', '', '', '', '', '', '', '', 'FALSE', 'FALSE'])
    let currentValues = [headers, values[1], ...futureDefaults] as unknown[][]
    let appendedUrl = ''
    let appendedBody: { values: unknown[][] } | null = null
    const fetcherMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.includes(':append')) {
        appendedUrl = decodeURIComponent(url)
        appendedBody = JSON.parse(String(init?.body)) as { values: unknown[][] }
        const row = [...appendedBody.values[0]]
        row[0] = ''
        row[1] = 'Conta de telefone'
        row[2] = String(row[2])
        row[3] = ''
        row[3] = '06/01/2026'
        row[4] = '45,00'
        row[5] = ''
        row[6] = 'Casa'
        row[7] = 'Débito automático'
        row[8] = 'FALSE'
        row[9] = 'FALSE'
        currentValues.splice(2, 0, row)
        return response({ updates: { updatedRange: "'CUSTOS ANO'!A3:J3" } })
      }
      if (url.includes('/values/')) return response({ values: currentValues })
      return response({ properties: { title: 'Finanças' }, sheets: [{ properties: { sheetId: 1, title: 'CUSTOS ANO' } }] })
    })
    const fetcher = fetcherMock as unknown as typeof fetch
    const result = await appendCostYearRecord('abcdefghijklmnop', 'token', { description: 'Conta de telefone', date: '2026-01-06', category: 'Casa', amount: 4500, paymentMethod: 'Débito automático', isFixed: false, isEssential: false }, fetcher, { randomBytes: (buffer) => { buffer.set([0x12, 0x34, 0x56, 0x78]); return buffer } })
    expect(result).toMatchObject({ rowCount: 2, alreadyPresent: false, transaction: { sheetRecordId: '12345678' } })
    expect(appendedUrl).toContain("'CUSTOS ANO'!A:H:append")
    expect(appendedBody!.values[0]).toHaveLength(10)
    expect(appendedBody!.values[0][5]).toBeNull()
    expect(appendedBody!.values[0][0]).toBeNull()
    expect(appendedBody!.values[0][8]).toBe(false)
    expect(appendedBody!.values[0][8]).toBe(false)
    expect(fetcherMock.mock.calls.filter(([url]) => String(url).includes(':append'))).toHaveLength(1)
    expect(fetcherMock.mock.calls.every(([url, init]) => !String(url).includes(':batchClear') && init?.method !== 'DELETE' && !(String(url).includes('/values/') && init?.method === 'PUT'))).toBe(true)
  })

  it('não duplica uma linha financeira já existente', async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(response({ properties: { title: 'Finanças' }, sheets: [{ properties: { title: 'CUSTOS ANO' } }] }))
      .mockResolvedValueOnce(response({ values }))
    const result = await appendCostYearRecord('abcdefghijklmnop', 'token', { description: 'Mercado sintético', date: '2026-05-12', category: 'Casa', amount: 9450, paymentMethod: 'Pix', isFixed: false, isEssential: true }, fetcher)
    expect(result.alreadyPresent).toBe(true)
    expect(fetcher).toHaveBeenCalledTimes(2)
    expect(fetcher.mock.calls.some(([url]) => String(url).includes(':append'))).toBe(false)
  })

  it('não grava categoria não verificada quando ainda não há opções de categoria carregadas', async () => {
    const currentValues: unknown[][] = [headers]
    const fetcherMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      void init
      if (url.includes('/values/')) return response({ values: currentValues })
      return response({ properties: { title: 'Finanças' }, sheets: [{ properties: { title: 'CUSTOS ANO' } }] })
    })
    const fetcher = fetcherMock as unknown as typeof fetch
    await expect(appendCostYearRecord('abcdefghijklmnop', 'token', { description: 'Conta modelo', date: '2026-01-06', category: 'Casa', amount: 1000, paymentMethod: 'Pix', isFixed: false, isEssential: false }, fetcher))
      .rejects.toMatchObject({ code: 'INTEGRITY' })
    expect(fetcherMock.mock.calls).toHaveLength(2)
    expect(fetcherMock.mock.calls.some(([url]) => String(url).includes(':append'))).toBe(false)
  })

  it('releitura após resposta ambígua não repete o append', async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(response({ properties: { title: 'Finanças' }, sheets: [{ properties: { title: 'CUSTOS ANO' } }] }))
      .mockResolvedValueOnce(response({ values }))
      .mockRejectedValueOnce(new TypeError('network lost'))
      .mockResolvedValueOnce(response({ properties: { title: 'Finanças' }, sheets: [{ properties: { title: 'CUSTOS ANO' } }] }))
      .mockResolvedValueOnce(response({ values }))
    await expect(appendCostYearRecord('abcdefghijklmnop', 'token', { description: 'Novo item', date: '2026-01-06', category: 'Casa', amount: 1000, paymentMethod: 'Pix', isFixed: false, isEssential: false }, fetcher, { randomBytes: (buffer) => { buffer.set([0, 0, 0, 1]); return buffer } }))
      .rejects.toMatchObject({ code: 'AMBIGUOUS' })
    expect(fetcher.mock.calls.filter(([url]) => String(url).includes(':append'))).toHaveLength(1)
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
