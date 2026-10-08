import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { parseBankStatementText } from './bankStatement'
import { mergeDriveBankSourcesWithStats } from '../integrations/googleDriveMerge'
import { labeledCounterparty, mergeCounterpartyEvidence } from './counterparty'

const fixture = (name: string) => readFileSync(`${process.cwd()}/src/importers/fixtures/${name}`, 'utf8')

describe('importação de extratos Bradesco', () => {
  const mobileText = fixture('bradesco-mobile-synthetic.csv')
  const internetText = fixture('bradesco-internet-synthetic.csv')
  const ofxText = fixture('bradesco-ofx-synthetic.ofx')

  it('detecta CSV Mobile e preserva os movimentos e a regra de seções existente', () => {
    const parsed = parseBankStatementText(mobileText)
    expect(parsed.format).toBe('BRADESCO_CSV_MOBILE')
    expect(parsed.transactions.map((row) => row.originalDescription)).toEqual(['PIX QR CODE ESTATICO', 'DEVOLUCAO PIX', 'PIX RECEBIDO'])
    expect(parsed.declaredPeriodStart).toBe('2026-01-01')
    expect(parsed.actualPeriodEnd).toBe('2026-01-02')
    expect(parsed.declaredPeriodEnd).toBe('2026-01-02')
    expect(parsed.transactions[1]).toMatchObject({ direction: 'CREDIT', type: 'REFUND', amount: 1250 })
  })

  it('detecta CSV Internet Banking e une linhas complementares sem criar movimentações extras', () => {
    const parsed = parseBankStatementText(internetText)
    expect(parsed.format).toBe('BRADESCO_CSV_INTERNET_BANKING')
    expect(parsed.transactions).toHaveLength(2)
    expect(parsed.transactions[0]).toMatchObject({ date: '2026-01-01', amount: 4200, direction: 'DEBIT' })
    expect(parsed.transactions[0].originalDescription).toBe('Pix Qrcode Est')
    expect(parsed.transactions[0].counterpartyName).toBe('Loja Exemplo')
    expect(parsed.transactions[0].sourceDescriptions).toContain('Pix Qrcode Est Des: Loja Exemplo 01/01')
    expect(parsed.transactions[1]).toMatchObject({ direction: 'CREDIT', type: 'REFUND', amount: 1250 })
    expect(parsed.transactions[1].counterpartyName).toBe('Loja Exemplo')
    expect(parsed.ignoredRows).toBeGreaterThanOrEqual(2)
    expect(parseBankStatementText(internetText.replace(/\n/g, '\r')).transactions).toHaveLength(2)
  })

  it('mantém movimentações recentes do Internet Banking fora do período declarado como dados presentes separados', () => {
    const text = `${internetText.trimEnd()}\rFiltro de resultados - Movimentação entre: 01/01/2026 e 01/01/2026;;;;;;\rÚltimos Lançamentos;;;;;;\r02/01/26;PIX RECEBIDO;DOC-2;5,00;;965,50;\rTotal;;;;;965,50;`
    const parsed = parseBankStatementText(text)
    expect(parsed.format).toBe('BRADESCO_CSV_INTERNET_BANKING')
    expect(parsed.declaredPeriodEnd).toBe('2026-01-01')
    expect(parsed.actualPeriodEnd).toBe('2026-01-02')
    expect(parsed.transactions).toHaveLength(3)
    expect(parsed.transactions[2]).toMatchObject({ date: '2026-01-02', direction: 'CREDIT' })
    expect(parsed.issues).toHaveLength(0)
  })

  it('lê OFX, direção, data, valor absoluto, FITID, MEMO e saldo declarado', () => {
    const parsed = parseBankStatementText(ofxText)
    expect(parsed.format).toBe('OFX')
    expect(parsed.transactions).toHaveLength(2)
    expect(parsed.transactions[0]).toMatchObject({ date: '2026-01-01', amount: 4200, direction: 'DEBIT', bankTransactionId: 'ofx:FIT-100' })
    expect(parsed.transactions[0].sourceTransactionIds).toContain('FITID:FIT-100')
    expect(parsed.transactions[0].originalDescription).toBe('Pix Qrcode Est')
    expect(parsed.transactions[0].sourceDescriptions).toContain('Pix Qrcode Est Des: Outra Loja 01/01')
    expect(parsed.transactions[0].counterpartyName).toBe('Loja Exemplo')
    expect(parsed.transactions[1]).toMatchObject({ direction: 'CREDIT', type: 'REFUND', amount: 1250 })
    expect(parsed.transactions[1].counterpartyName).toBe('Loja Exemplo')
    expect(parsed.declaredPeriodStart).toBe('2026-01-01')
    expect(parsed.declaredPeriodEnd).toBe('2026-01-01')
    expect(parsed.actualPeriodEnd).toBe('2026-01-02')
    expect(parsed.balanceEvidence).toEqual({ amount: 97050, date: '2026-01-02' })
  })

  it('prioriza NAME do OFX sobre a contraparte identificada no MEMO e preserva ambas as evidências', () => {
    const parsed = parseBankStatementText(ofxText)
    expect(parsed.transactions[0].counterpartyName).toBe('Loja Exemplo')
    expect(parsed.transactions[0].counterpartyEvidence).toEqual(expect.arrayContaining([
      { name: 'Loja Exemplo', source: 'OFX_NAME' },
      { name: 'Outra Loja', source: 'OFX_MEMO' },
    ]))
    expect(parsed.transactions[1].counterpartyName).toBe('Loja Exemplo')
  })

  it('retira prefixos e datas residuais e normaliza capitalização entre fontes', () => {
    expect(labeledCounterparty('Rem: Pix Marketplace 07/10')).toBe('Pix Marketplace')
    const merged = mergeCounterpartyEvidence(
      [{ name: 'EQUATORIAL PIAUI', source: 'CSV_INTERNET_BANKING' }],
      [{ name: 'Equatorial Piaui', source: 'OFX_NAME' }],
    )
    expect(merged.counterpartyName).toBe('Equatorial Piaui')
    expect(merged.counterpartyEvidence).toHaveLength(2)
  })

  it('deduplica o mesmo movimento nas três fontes e mantém descrições, FITID e provenance', () => {
    const mobile = parseBankStatementText(mobileText).transactions
    const internet = parseBankStatementText(internetText).transactions
    const ofx = parseBankStatementText(ofxText).transactions
    const merged = mergeDriveBankSourcesWithStats([], { mobile, internet, ofx })
    const pix = merged.transactions.find((row) => row.date === '2026-01-01')!
    const refund = merged.transactions.find((row) => row.type === 'REFUND')!
    expect(merged.transactions).toHaveLength(3)
    expect(merged.totalOverlaps).toBe(4)
    expect(pix.statementSourceIds).toEqual(['internet', 'mobile', 'ofx'])
    expect(pix.sourceDescriptions).toEqual(expect.arrayContaining(['PIX QR CODE ESTATICO', expect.stringContaining('Des: Loja Exemplo'), 'Pix Qrcode Est Des: Outra Loja 01/01']))
    expect(pix.originalDescription).toBe('PIX QR CODE ESTATICO')
    expect(pix.counterpartyName).toBe('Loja Exemplo')
    expect(pix.counterpartyEvidence).toEqual(expect.arrayContaining([
      { name: 'Loja Exemplo', source: 'CSV_INTERNET_BANKING' },
      { name: 'Loja Exemplo', source: 'OFX_NAME' },
      { name: 'Outra Loja', source: 'OFX_MEMO' },
    ]))
    expect(refund.sourceTransactionIds).toContain('FITID:FIT-101')
    expect(refund.statementFormats).toEqual(expect.arrayContaining(['BRADESCO_CSV_MOBILE', 'BRADESCO_CSV_INTERNET_BANKING', 'OFX']))
  })

  it('não escolhe arbitrariamente contraparte divergente entre exportações', () => {
    const internet = parseBankStatementText(internetText).transactions
    const conflictingOfx = parseBankStatementText(ofxText).transactions.map((item) => ({
      ...item,
      counterpartyName: item.date === '2026-01-01' ? 'Estabelecimento Diferente' : item.counterpartyName,
      counterpartyEvidence: item.date === '2026-01-01' ? [{ name: 'Estabelecimento Diferente', source: 'OFX_NAME' as const }] : item.counterpartyEvidence,
    }))
    const merged = mergeDriveBankSourcesWithStats([], { internet, conflictingOfx }).transactions.find((item) => item.date === '2026-01-01')!
    expect(merged.counterpartyName).toBeUndefined()
    expect(merged.counterpartyEvidence).toEqual(expect.arrayContaining([
      { name: 'Loja Exemplo', source: 'CSV_INTERNET_BANKING' },
      { name: 'Estabelecimento Diferente', source: 'OFX_NAME' },
    ]))
  })

  it('recusa CSV cujo conteúdo não identifica um layout de extrato suportado', () => {
    expect(() => parseBankStatementText('Data;Nome;Valor\n01/01/2026;Loja;5,00')).toThrow('Layout de extrato não reconhecido.')
  })
})
