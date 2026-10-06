import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PwaUpdateNotice } from './PwaUpdateNotice'

const pwaMocks = vi.hoisted(() => ({ needRefresh: false, update: vi.fn() }))
vi.mock('./pwaRegistration', () => ({ useRegisterSW: () => ({ needRefresh: [pwaMocks.needRefresh, vi.fn()], offlineReady: [false, vi.fn()], updateServiceWorker: pwaMocks.update }) }))

beforeEach(() => { pwaMocks.needRefresh = true; pwaMocks.update.mockReset() })
afterEach(cleanup)

describe('aviso de atualização da PWA', () => {
  it('avisa sobre a nova versão e só recarrega após a ação do usuário, sem limpar armazenamento local', () => {
    localStorage.setItem('conciliador.googleSheets.link.v1', 'vínculo')
    render(<PwaUpdateNotice />)
    expect(screen.getByRole('status', { name: 'Atualização do aplicativo disponível' })).toHaveTextContent('Nova versão disponível')
    fireEvent.click(screen.getByRole('button', { name: 'Atualizar' }))
    expect(pwaMocks.update).toHaveBeenCalledWith(true)
    expect(localStorage.getItem('conciliador.googleSheets.link.v1')).toBe('vínculo')
  })

  it('não mostra o aviso quando não há atualização aguardando', () => {
    pwaMocks.needRefresh = false
    render(<PwaUpdateNotice />)
    expect(screen.queryByText('Nova versão disponível')).not.toBeInTheDocument()
  })
})
