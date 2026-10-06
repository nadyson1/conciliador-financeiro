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

  it('grava na próxima linha lógica (392), ignora FALSE até a 791 e confirma sem escrever Mês/Ano', async () => {
    const checkboxDefaults = ['', '', '', '', '', '', '', '', 'FALSE', 'FALSE']
    const lastExpense = ['2026', 'Último lançamento', 'last-row-id', '31/12/2026', '30,00', '12 - Dezembro', 'Casa', 'Pix', 'FALSE', 'FALSE']
    // Linhas 2–390 estão preparadas; o último lançamento está na 391 e as linhas 392–791 têm defaults.
    let currentValues = [headers, ...Array.from({ length: 389 }, () => [...checkboxDefaults]), lastExpense, ...Array.from({ length: 400 }, () => [...checkboxDefaults])] as unknown[][]
    let batchUrl = ''
    let batchBody: { valueInputOption: string; data: { range: string; values: unknown[][] }[] } | undefined
    const columnIndex = (letters: string) => [...letters].reduce((total, letter) => total * 26 + letter.charCodeAt(0) - 64, 0) - 1
    const fetcherMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.includes('values:batchUpdate')) {
        batchUrl = url
        batchBody = JSON.parse(String(init?.body)) as typeof batchBody
        for (const entry of batchBody!.data) {
          const match = entry.range.match(/!([A-Z]+)(\d+):([A-Z]+)\d+$/)!
          const rowNumber = Number(match[2])
          const start = columnIndex(match[1])
          const row = currentValues[rowNumber - 1] ?? Array(10).fill('')
          entry.values[0].forEach((value, index) => { row[start + index] = value })
          currentValues[rowNumber - 1] = row
        }
        const row = currentValues[391]
        row[0] = '2026' // valores derivados calculados pela planilha
        row[5] = '01 - Janeiro'
        return response({ totalUpdatedCells: 8 })
      }
      if (url.includes('/values/')) {
        const range = decodeURIComponent(url).match(/'CUSTOS ANO'!A(\d+):ZZ\d+/)
        if (range) return response({ values: [currentValues[Number(range[1]) - 1] ?? []] })
        return response({ values: currentValues })
      }
      return response({ properties: { title: 'Finanças' }, sheets: [{ properties: { sheetId: 1, title: 'CUSTOS ANO' } }] })
    })
    const fetcher = fetcherMock as unknown as typeof fetch
    const result = await appendCostYearRecord('abcdefghijklmnop', 'token', { description: 'Conta de telefone', date: '2026-01-06', category: 'Casa', amount: 4500, paymentMethod: 'Débito automático', isFixed: false, isEssential: false }, fetcher, { randomBytes: (buffer) => { buffer.set([0x12, 0x34, 0x56, 0x78]); return buffer } })
    expect(result).toMatchObject({ rowCount: 2, alreadyPresent: false, transaction: { sheetRecordId: '12345678', date: '2026-01-06', description: 'Conta de telefone' } })
    expect(decodeURIComponent(batchUrl)).toContain('/values:batchUpdate')
    expect(batchUrl).not.toContain(':append')
    expect(batchBody?.valueInputOption).toBe('USER_ENTERED')
    expect(batchBody?.data.map((entry) => decodeURIComponent(entry.range))).toEqual([
      "'CUSTOS ANO'!B392:E392", "'CUSTOS ANO'!G392:J392",
    ])
    expect(batchBody?.data.some(({ range }) => /!A392|!F392/.test(decodeURIComponent(range)))).toBe(false)
    expect(currentValues[390]).toEqual(lastExpense)
    expect(currentValues[391][1]).toBe('Conta de telefone')
    expect(currentValues[391][5]).toBe('01 - Janeiro')
    expect(currentValues[391][0]).toBe('2026')
    expect(fetcherMock.mock.calls.some(([url]) => String(url).includes(':append'))).toBe(false)
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

  it('recalcula a linha quando outra alteração ocupa o destino antes da gravação', async () => {
    const blank = ['', '', '', '', '', '', '', '', 'FALSE', 'FALSE']
    let currentValues: unknown[][] = [headers, values[1], blank]
    let firstCandidateRead = true
    let writtenRanges: string[] = []
    const columnIndex = (letters: string) => [...letters].reduce((total, letter) => total * 26 + letter.charCodeAt(0) - 64, 0) - 1
    const fetcherMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.includes('values:batchUpdate')) {
        const body = JSON.parse(String(init?.body)) as { data: { range: string; values: unknown[][] }[] }
        writtenRanges = body.data.map(({ range }) => decodeURIComponent(range))
        for (const entry of body.data) {
          const match = decodeURIComponent(entry.range).match(/!([A-Z]+)(\d+):([A-Z]+)\d+$/)!
          const rowNumber = Number(match[2])
          const start = columnIndex(match[1])
          const row = currentValues[rowNumber - 1] ?? Array(10).fill('')
          entry.values[0].forEach((value, index) => { row[start + index] = value })
          currentValues[rowNumber - 1] = row
        }
        const newRow = currentValues[3]
        newRow[0] = '2026'
        newRow[5] = '01 - Janeiro'
        return response({ totalUpdatedCells: 8 })
      }
      if (url.includes('/values/')) {
        const rowNumber = decodeURIComponent(url).match(/'CUSTOS ANO'!A(\d+):ZZ\d+/)?.[1]
        if (rowNumber) {
          if (Number(rowNumber) === 3 && firstCandidateRead) {
            firstCandidateRead = false
            currentValues[2] = ['2026', 'Lançamento concorrente', 'concurrent-id', '05/01/2026', '20,00', '01 - Janeiro', 'Casa', 'Pix', 'FALSE', 'FALSE']
          }
          return response({ values: [currentValues[Number(rowNumber) - 1] ?? []] })
        }
        return response({ values: currentValues })
      }
      return response({ properties: { title: 'Finanças' }, sheets: [{ properties: { title: 'CUSTOS ANO' } }] })
    })
    const result = await appendCostYearRecord('abcdefghijklmnop', 'token', { description: 'Conta de telefone', date: '2026-01-06', category: 'Casa', amount: 4500, paymentMethod: 'Débito automático', isFixed: false, isEssential: false }, fetcherMock as unknown as typeof fetch, { randomBytes: (buffer) => { buffer.set([0x12, 0x34, 0x56, 0x78]); return buffer } })
    expect(writtenRanges.every((range) => /4/.test(range))).toBe(true)
    expect(currentValues[2][1]).toBe('Lançamento concorrente')
    expect(currentValues[3][1]).toBe('Conta de telefone')
    expect(result).toMatchObject({ rowCount: 3, transaction: { sheetRecordId: '12345678' } })
  })

  it('não aceita gravação parcial sem confirmar todos os campos e o ID', async () => {
    const blank = ['', '', '', '', '', '', '', '', 'FALSE', 'FALSE']
    const currentValues: unknown[][] = [headers, values[1], blank]
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.includes('values:batchUpdate')) {
        // Simula API que confirma a requisição, mas só deixa uma parte da linha visível.
        currentValues[2][1] = 'Conta parcial'
        void init
        return response({ totalUpdatedCells: 1 })
      }
      if (url.includes('/values/')) {
        const rowNumber = decodeURIComponent(url).match(/'CUSTOS ANO'!A(\d+):ZZ\d+/)?.[1]
        return response({ values: rowNumber ? [currentValues[Number(rowNumber) - 1] ?? []] : currentValues })
      }
      return response({ properties: { title: 'Finanças' }, sheets: [{ properties: { title: 'CUSTOS ANO' } }] })
    })
    await expect(appendCostYearRecord('abcdefghijklmnop', 'token', { description: 'Conta de telefone', date: '2026-01-06', category: 'Casa', amount: 4500, paymentMethod: 'Débito automático', isFixed: false, isEssential: false }, fetcher, { randomBytes: (buffer) => { buffer.set([0x12, 0x34, 0x56, 0x78]); return buffer } }))
      .rejects.toMatchObject({ code: 'AMBIGUOUS' })
    expect(fetcher.mock.calls.filter(([url]) => String(url).includes('values:batchUpdate'))).toHaveLength(1)
    expect(currentValues[2][1]).toBe('Conta parcial')
    expect(currentValues[2][2]).toBe('')
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

  it('não repete a gravação após resposta ambígua quando a releitura não confirma a linha', async () => {
    const blank = ['', '', '', '', '', '', '', '', 'FALSE', 'FALSE']
    const currentValues: unknown[][] = [headers, values[1], blank]
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.includes('values:batchUpdate')) throw new TypeError('network lost')
      if (url.includes('/values/')) {
        const rowNumber = decodeURIComponent(url).match(/'CUSTOS ANO'!A(\d+):ZZ\d+/)?.[1]
        return response({ values: rowNumber ? [currentValues[Number(rowNumber) - 1] ?? []] : currentValues })
      }
      void init
      return response({ properties: { title: 'Finanças' }, sheets: [{ properties: { title: 'CUSTOS ANO' } }] })
    })
    await expect(appendCostYearRecord('abcdefghijklmnop', 'token', { description: 'Novo item', date: '2026-01-06', category: 'Casa', amount: 1000, paymentMethod: 'Pix', isFixed: false, isEssential: false }, fetcher, { randomBytes: (buffer) => { buffer.set([0, 0, 0, 1]); return buffer } }))
      .rejects.toMatchObject({ code: 'AMBIGUOUS' })
    expect(fetcher.mock.calls.filter(([url]) => String(url).includes('values:batchUpdate'))).toHaveLength(1)
    expect(fetcher.mock.calls.some(([url]) => String(url).includes(':append'))).toBe(false)
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
