import { beforeEach, describe, expect, it } from 'vitest'
import { forgetGoogleSheetLink, GOOGLE_SHEET_TAB_NAME, loadGoogleSheetLink, saveGoogleSheetLink } from './googleSheetLinkStorage'
import type { SavedGoogleSheetLink } from './googleSheetLinkStorage'

const link: SavedGoogleSheetLink = { spreadsheetId: 'spreadsheet-id-12345', sheetName: GOOGLE_SHEET_TAB_NAME, spreadsheetTitle: 'CONTROLE ORÇAMENTÁRIO PESSOAL 2026', lastUpdated: '2026-10-06T03:19:00.000Z', autoConnect: true }

describe('vínculo local Google Sheets', () => {
  beforeEach(() => localStorage.clear())

  it('persiste e restaura somente os metadados do vínculo', () => {
    saveGoogleSheetLink(link)
    expect(loadGoogleSheetLink()).toEqual(link)
    const stored = localStorage.getItem('conciliador.googleSheets.link.v1')!
    expect(stored).not.toContain('amount')
    expect(stored).not.toContain('transactions')
    expect(stored).not.toContain('access_token')
  })

  it('mantém o vínculo ao desconectar e permite desabilitar a atualização automática', () => {
    saveGoogleSheetLink({ ...link, autoConnect: false })
    expect(loadGoogleSheetLink()).toMatchObject({ spreadsheetId: link.spreadsheetId, sheetName: 'CUSTOS ANO', autoConnect: false })
  })

  it('troca o ID somente quando o novo vínculo é salvo após validação', () => {
    saveGoogleSheetLink(link)
    saveGoogleSheetLink({ ...link, spreadsheetId: 'another-sheet-id-67890', spreadsheetTitle: 'Outra planilha' })
    expect(loadGoogleSheetLink()).toMatchObject({ spreadsheetId: 'another-sheet-id-67890', spreadsheetTitle: 'Outra planilha' })
  })

  it('esquece o vínculo somente quando solicitado separadamente', () => {
    saveGoogleSheetLink(link)
    forgetGoogleSheetLink()
    expect(loadGoogleSheetLink()).toBeNull()
  })

  it('ignora dados locais inválidos', () => {
    localStorage.setItem('conciliador.googleSheets.link.v1', JSON.stringify({ spreadsheetId: 'bad', sheetName: 'Outro nome' }))
    expect(loadGoogleSheetLink()).toBeNull()
  })
})
