import { afterEach, describe, expect, it, vi } from 'vitest'
import { exportCsv } from './export'

describe('exportação local', () => {
  afterEach(() => vi.restoreAllMocks())
  it('cria um CSV com BOM, separador regional e texto escapado no navegador', () => {
    const click = vi.fn()
    const anchor = { href: '', download: '', click } as unknown as HTMLAnchorElement
    vi.spyOn(document, 'createElement').mockReturnValue(anchor)
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:local')
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
    exportCsv('ausencias.csv', ['Descrição', 'Valor'], [['Loja "A"', 1234]])
    expect(anchor.download).toBe('ausencias.csv')
    expect(anchor.href).toBe('blob:local')
    expect(click).toHaveBeenCalledOnce()
    expect(URL.createObjectURL).toHaveBeenCalledOnce()
  })
})
