import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { GoogleSheetsPanel } from './GoogleSheetsPanel'

const info = { spreadsheetId: 'spreadsheet-id-12345', sheetName: 'CUSTOS ANO', spreadsheetTitle: 'Finanças', rowCount: 42, lastUpdated: '2026-10-05T12:00:00.000Z', connected: true }
const panel = (props: Partial<React.ComponentProps<typeof GoogleSheetsPanel>> = {}) => <GoogleSheetsPanel configured info={info} loading={false} error="" editing={false} onConnect={vi.fn()} onRefresh={vi.fn()} onDisconnect={vi.fn()} onChangeSheet={vi.fn()} onForgetLink={vi.fn()} {...props}/>
afterEach(cleanup)

describe('painel Google Sheets', () => {
  it('oferece atualização manual, troca de planilha e desconexão', () => {
    const onRefresh = vi.fn(), onDisconnect = vi.fn(), onChangeSheet = vi.fn()
    render(panel({ onRefresh, onDisconnect, onChangeSheet }))
    expect(screen.getByText('Aba: CUSTOS ANO')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Atualizar dados' }))
    fireEvent.click(screen.getByRole('button', { name: 'Trocar planilha' }))
    fireEvent.click(screen.getByRole('button', { name: 'Desconectar Google' }))
    expect(onRefresh).toHaveBeenCalledOnce()
    expect(onChangeSheet).toHaveBeenCalledOnce()
    expect(onDisconnect).toHaveBeenCalledOnce()
  })

  it('mostra reconexão e mantém o vínculo quando o token expirou', () => {
    const onConnect = vi.fn()
    render(panel({ info: { ...info, connected: false }, error: 'A autorização expirou. Reconecte Google.' , onConnect }))
    fireEvent.click(screen.getByRole('button', { name: 'Reconectar Google' }))
    expect(onConnect).toHaveBeenCalledWith(info.spreadsheetId)
    expect(screen.getByRole('alert')).toHaveTextContent('A autorização expirou.')
    expect(screen.getByText('Finanças')).toBeInTheDocument()
  })

  it('permite esquecer o vínculo explicitamente e mantém o CSV disponível', () => {
    const onForgetLink = vi.fn()
    render(<>{panel({ onForgetLink })}<label><input type="radio" name="source"/>Importar CSV</label></>)
    fireEvent.click(screen.getByRole('button', { name: 'Esquecer planilha vinculada' }))
    expect(onForgetLink).toHaveBeenCalledOnce()
    expect(screen.getByLabelText('Importar CSV')).toBeInTheDocument()
  })
})
