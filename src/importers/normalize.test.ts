import { describe, expect, it } from 'vitest'
import { bankDisplayDescription, classifySheetRecord, descriptionSimilarity, investmentAction, normalizeAmount, normalizeBankDescription, normalizeDate, normalizeDescription, transactionType } from './normalize'
import { parseCsvText } from './csv'
import { parseBankRows, parseLedgerRows } from './transactions'
import { initialColumnMap } from './csv'
import { reconcile } from '../matching/reconcile'
import { selectMissingExpenses, summarizeMissingExpenses } from '../domain/bankBalanceAudit'

describe('CSV local e formatos brasileiros', () => {
  it.each([
    ['Pix Qrcode Din', 'Pix QR Code Dinâmico', 'Pix', 'EXPENSE'],
    ['PIX QR CODE DINAMICO', 'Pix QR Code Dinâmico', 'Pix', 'EXPENSE'],
    ['Pix   Qrcode   Est', 'Pix QR Code Estático', 'Pix', 'EXPENSE'],
    ['Pix Qrcode Estático', 'Pix QR Code Estático', 'Pix', 'EXPENSE'],
    ['Pix Enviado', 'Pix Enviado', 'Pix', 'EXPENSE'],
    ['Compra Visa', 'Compra no débito', 'Débito', 'EXPENSE'],
    ['Seguro Cart Deb', 'Seguro cartão de débito', 'Débito automático', 'EXPENSE'],
    ['Gasto c Credito', 'Pagamento de fatura', '', 'CARD_PAYMENT'],
    ['GASTOS CARTAO DE CREDITO', 'Pagamento de fatura', '', 'CARD_PAYMENT'],
  ])('normaliza semanticamente %s', (raw, friendly, payment, type) => {
    expect(normalizeBankDescription(raw)).toMatchObject({ normalizedDescription: friendly, suggestedPaymentMethod: payment, transactionType: type })
    expect(bankDisplayDescription(raw)).toBe(friendly)
  })

  it('mantém a descrição original e a contraparte junto à semântica amigável', () => {
    const parsed = parseBankRows([
      { Data: '16/03/2026', Histórico: 'Pix Qrcode Din Des: Maria Francisca Borge', Débito: '17,00', Crédito: '' },
    ], { date: 'Data', description: 'Histórico', amount: '', debit: 'Débito', credit: 'Crédito' })
    expect(parsed.transactions[0]).toMatchObject({ description: 'Pix Qrcode Din Des: Maria Francisca Borge', originalDescription: 'Pix Qrcode Din Des: Maria Francisca Borge', counterpartyName: 'Maria Francisca Borge' })
    expect(bankDisplayDescription(parsed.transactions[0].originalDescription)).toBe('Pix QR Code Dinâmico')
  })

  it('detecta CSV com vírgula, BOM, acentos e campos entre aspas', () => {
    const parsed = parseCsvText('\uFEFFData,Descrição,Valor\r\n08/01/2026,"Café, centro",13,50')
    expect(parsed.delimiter).toBe(',')
    expect(parsed.headers).toEqual(['Data', 'Descrição', 'Valor'])
    expect(parsed.rows[0].Descrição).toBe('Café, centro')
  })

  it('detecta ponto e vírgula e mantém campos com aspas', () => {
    const parsed = parseCsvText('Data;Descrição;Custo\n08/01/2026;"Mercado; XYZ";R$ 1.234,56')
    expect(parsed.delimiter).toBe(';')
    expect(parsed.rows[0].Descrição).toBe('Mercado; XYZ')
    expect(normalizeAmount(parsed.rows[0].Custo)).toBe(123456)
  })

  it('normaliza valores com vírgula, ponto e sinal negativo para centavos', () => {
    expect(normalizeAmount('R$ 1.234,56')).toBe(123456)
    expect(normalizeAmount('1.234,56')).toBe(123456)
    expect(normalizeAmount('1234,56')).toBe(123456)
    expect(normalizeAmount('1234.56')).toBe(123456)
    expect(normalizeAmount('-45,00')).toBe(-4500)
    expect(normalizeAmount('inválido')).toBeNull()
  })

  it('trata datas civis sem fuso e rejeita datas impossíveis', () => {
    expect(normalizeDate('08/01/2026')).toBe('2026-01-08')
    expect(normalizeDate('2026-01-08T23:00:00-03:00')).toBe('2026-01-08')
    expect(normalizeDate('8 de janeiro de 2026')).toBe('2026-01-08')
    expect(normalizeDate('31/02/2026')).toBeNull()
  })

  it('compara descrições semelhantes e diferencia descrições sem termos comuns', () => {
    expect(normalizeDescription('PAG*ELLIOT')).toBe('pag elliot')
    expect(descriptionSimilarity('PAG*ELLIOT', '99 Shopping p/ Elliot')).toBeGreaterThan(0.45)
    expect(descriptionSimilarity('MERCADO CENTRAL', 'ESCOLA INFANTIL')).toBeLessThan(0.2)
  })

  it('compara abreviações, tokens concatenados e palavras extras de descrições humanas sem marcas específicas', () => {
    expect(descriptionSimilarity('Amazon Kindle Unltd', 'Assinatura Kindle unlimited (2 meses)')).toBeGreaterThan(0.35)
    expect(descriptionSimilarity('SELFITHOMEROCASTELOBRA', 'Mensalidade Selfit')).toBeGreaterThan(0.4)
    expect(descriptionSimilarity('ASAAS*OFICINA CR', 'Oficina Criativa Renovação')).toBeGreaterThan(0.3)
    expect(descriptionSimilarity('Restaurante Central', 'Escola Infantil')).toBeLessThan(0.2)
  })

  it('detecta títulos variados sem depender de acentos ou caixa', () => {
    const headers = ['DESCRIÇÃO', 'Data lançamento', 'CUSTO', 'Mês', 'ANO', 'Forma de pagamento', 'É fixo?', 'É essencial?', 'ID']
    const map = initialColumnMap(headers, 'sheet')
    expect(map.description).toBe('DESCRIÇÃO')
    expect(map.date).toBe('Data lançamento')
    expect(map.amount).toBe('CUSTO')
    expect(map.id).toBe('ID')
  })

  it('marca linha financeira inválida e preserva os dados derivados e o ID existentes', () => {
    const rows: Record<string, string>[] = [
      { Descrição: 'Café', Data: '08/01/2026', Mês: '01 - Janeiro', Ano: '2026', Custo: '13,50', Categoria: 'Alimentação', 'Forma de pagamento': 'Pix', 'É fixo?': 'Não', 'É essencial?': 'Sim', ID: 'abc-007' },
      { Descrição: 'Sem valor', Data: 'inválida', Custo: 'x' },
    ]
    const parsed = parseLedgerRows(rows, { date: 'Data', description: 'Descrição', amount: 'Custo', month: 'Mês', year: 'Ano', category: 'Categoria', paymentMethod: 'Forma de pagamento', isFixed: 'É fixo?', isEssential: 'É essencial?', id: 'ID' })
    expect(parsed.rowCount).toBe(2)
    expect(parsed.transactions).toHaveLength(1)
    expect(parsed.issues).toHaveLength(1)
    expect(parsed.transactions[0]).toMatchObject({ sheetRecordId: 'abc-007', amount: 1350, month: '01 - Janeiro', year: '2026', category: 'Alimentação', isFixed: false, isEssential: true })
  })

  it('classifica direção e natureza separadamente', () => {
    expect(transactionType('Transferencia para CC Nubank')).toBe('TRANSFER')
    expect(transactionType('GASTOS CARTAO DE CREDITO')).toBe('CARD_PAYMENT')
    expect(transactionType('COMPRA CARTAO VISA')).toBe('EXPENSE')
    expect(transactionType('Pix recebido')).toBe('INCOME')
    expect(transactionType('PIX ENVIADO')).toBe('EXPENSE')
    expect(transactionType('PIX QR CODE DINAMICO')).toBe('EXPENSE')
    expect(transactionType('PIX QR CODE ESTATICO')).toBe('EXPENSE')
    expect(transactionType('SEGURO CART DEB BRADESCO')).toBe('EXPENSE')
    expect(transactionType('Pix Qrcode Din')).toBe('EXPENSE')
    expect(transactionType('Pix Qrcode Est')).toBe('EXPENSE')
    expect(transactionType('Seguro Cart Deb')).toBe('EXPENSE')
    expect(transactionType('Compra Visa')).toBe('EXPENSE')
    expect(transactionType('Pix Enviado')).toBe('EXPENSE')
    expect(transactionType('Gasto c Credito')).toBe('CARD_PAYMENT')
    expect(transactionType('GASTOS CARTAO DE CREDITO')).toBe('CARD_PAYMENT')
    expect(transactionType('CONTA DE TELEFONE')).toBe('EXPENSE')
    expect(transactionType('PIX ENTRE CONTAS PROPRIAS')).toBe('TRANSFER')
    expect(transactionType('PIX ENVIADO PARA MINHA OUTRA CONTA')).toBe('TRANSFER')
    expect(transactionType('RENTAB.INVEST FACILCRED*')).toBe('INVESTMENT_INCOME')
    expect(transactionType('RESG/VENCTO CDB')).toBe('INVESTMENT')
    expect(transactionType('APLICACAO CDB')).toBe('INVESTMENT')
    expect(investmentAction('RESG/VENCTO CDB')).toBe('RESCUE')
    expect(investmentAction('APLICACAO CDB')).toBe('APPLICATION')
    expect(transactionType('Histórico sem contexto')).toBe('OTHER')
  })

  it('usa descrição inequívoca de recebimento quando o CSV não traz coluna de direção', () => {
    const parsed = parseBankRows([{ Data: '08/01/2026', Descrição: 'Pix recebido', Valor: '45,00' }], { date: 'Data', description: 'Descrição', amount: 'Valor' })
    expect(parsed.transactions[0]).toMatchObject({ type: 'INCOME', direction: 'CREDIT' })
  })

  it('normaliza variantes do Internet Banking em despesa PIX, débito ou pagamento agregado', () => {
    const rows = parseBankRows([
      { Data: '02/03/2026', Descrição: 'Pix Qrcode Din', Débito: '126,00' },
      { Data: '02/03/2026', Descrição: 'Seguro Cart Deb', Débito: '4,99' },
      { Data: '02/03/2026', Descrição: 'Compra Visa', Débito: '2,39' },
      { Data: '02/03/2026', Descrição: 'Pix Enviado', Débito: '17,00' },
      { Data: '12/03/2026', Descrição: 'Gasto c Credito', Débito: '549,96' },
    ], { date: 'Data', description: 'Descrição', amount: '', debit: 'Débito' })

    expect(rows.transactions.map((item) => [item.type, item.direction, item.directionKnown])).toEqual([
      ['EXPENSE', 'DEBIT', true], ['EXPENSE', 'DEBIT', true], ['EXPENSE', 'DEBIT', true], ['EXPENSE', 'DEBIT', true], ['CARD_PAYMENT', 'DEBIT', true],
    ])
    const reconciled = reconcile(rows.transactions, [])
    const missing = selectMissingExpenses(reconciled.items)
    expect(missing.map((item) => item.bank.originalDescription)).toEqual(['Pix Qrcode Din', 'Seguro Cart Deb', 'Compra Visa', 'Pix Enviado'])
    expect(summarizeMissingExpenses(missing)).toEqual({ count: 4, total: 15038 })
    expect(reconciled.items.find((item) => item.bank.originalDescription === 'Gasto c Credito')?.status).toBe('CARD_DIVERGENCE')
  })

  it('usa forma de pagamento Investimento para classificar linha da CUSTOS ANO', () => {
    const parsed = parseLedgerRows([{ Data: '08/01/2026', Descrição: 'Aplicação mensal', Custo: '4.500,00', 'Forma de pagamento': 'Investimento' }], { date: 'Data', description: 'Descrição', amount: 'Custo', paymentMethod: 'Forma de pagamento' })
    expect(parsed.transactions[0]).toMatchObject({ type: 'INVESTMENT', direction: 'DEBIT', amount: 450000, paymentMethod: 'Investimento' })
  })

  it('prioriza Crédito_Bradesco como despesa em CUSTOS ANO sem deixar heurística ampla sobrescrever a forma', () => {
    expect(classifySheetRecord({ description: 'Compra de merchant desconhecido', paymentMethod: 'Crédito_Bradesco' })).toBe('EXPENSE')
    expect(classifySheetRecord({ description: 'Assinatura Kindle unlimited (2 meses)', paymentMethod: 'Crédito_Bradesco' })).toBe('EXPENSE')
    expect(classifySheetRecord({ description: 'Transferencia para CC Nubank', paymentMethod: 'Crédito_Bradesco' })).toBe('EXPENSE')
    expect(classifySheetRecord({ description: 'Transferência entre contas', paymentMethod: 'Transferência' })).toBe('TRANSFER')
    expect(classifySheetRecord({ description: 'PIX ENTRE CONTAS PROPRIAS', paymentMethod: 'Pix' })).toBe('TRANSFER')
    expect(classifySheetRecord({ description: 'PIX ENVIADO PARA MINHA OUTRA CONTA', paymentMethod: 'Crédito_Bradesco' })).toBe('TRANSFER')
  })

  it('usa a classificação centralizada ao importar CUSTOS ANO e mantém transferências explícitas', () => {
    const parsed = parseLedgerRows([
      { Data: '12/03/2026', Descrição: 'Assinatura Kindle unlimited (2 meses)', Custo: '2,99', 'Forma de pagamento': 'Crédito_Bradesco' },
      { Data: '12/03/2026', Descrição: 'Transferência entre contas', Custo: '200,00', 'Forma de pagamento': 'Transferência' },
    ], { date: 'Data', description: 'Descrição', amount: 'Custo', paymentMethod: 'Forma de pagamento' })
    expect(parsed.transactions.map((item) => item.type)).toEqual(['EXPENSE', 'TRANSFER'])
  })

  it('não inventa a direção nem cria ausência quando CSV não informa a direção da movimentação', () => {
    const parsed = parseBankRows([{ Data: '08/01/2026', Descrição: 'Loja sem contexto', Valor: '45,00' }], { date: 'Data', description: 'Descrição', amount: 'Valor' })
    expect(parsed.transactions[0]).toMatchObject({ direction: 'DEBIT', directionKnown: false, type: 'OTHER' })
    expect(reconcile(parsed.transactions, []).items[0].status).toBe('REVIEW')
  })

  it('lê extrato Bradesco com metadado, direção em colunas separadas, zeros e rodapé', () => {
    const csv = [
      'Extrato de: Ag: 6240 | Conta: 306475-1',
      'Data | Histórico | Docto. | Crédito (R$) | Débito (R$) | Saldo (R$)',
      '30/01/2026 | COD. LANC. 0 | 0 | 0,00 | 0,00 | 1.908,23',
      '02/02/2026 | PIX RECEBIDO | 722215 | 12,00 |  | 1.920,23',
      '02/02/2026 | PIX RECEBIDO | 722215 | 1.175,00 |  | 3.095,23',
      '02/02/2026 | COMPRA CARTAO VISA | 500011 |  | 133,50 | 2.961,73',
      '03/02/2026 | Sem valor | 8 |  |  | 2.961,73',
      'Data | Histórico | Docto. | Crédito (R$) | Débito (R$) | Saldo (R$)',
      'RESUMO | Saldo final |  |  |  | 2.961,73',
    ].join('\n')
    const document = parseCsvText(csv)
    expect(document.delimiter).toBe('|')
    expect(document.metadataRowsIgnored).toBe(1)
    expect(document.headers).toEqual(['Data', 'Histórico', 'Docto.', 'Crédito (R$)', 'Débito (R$)', 'Saldo (R$)'])
    const map = initialColumnMap(document.headers, 'bank')
    expect(map).toMatchObject({ date: 'Data', description: 'Histórico', id: 'Docto.', credit: 'Crédito (R$)', debit: 'Débito (R$)', balance: 'Saldo (R$)' })
    const parsed = parseBankRows(document.rows, map, document.metadataRowsIgnored)
    expect(parsed.transactions).toHaveLength(3)
    expect(parsed.ignoredRows).toBe(4)
    expect(parsed.excludedRows?.map(({ reason }) => reason)).toEqual(['NO_MOVEMENT', 'NO_MOVEMENT', 'REPEATED_HEADER', 'FOOTER_OR_METADATA'])
    expect(parsed.excludedRows?.[1]).toMatchObject({ date: '2026-02-03', description: 'Sem valor', balanceAfter: 296173 })
    expect(parsed.excludedRows?.map(({ row }) => row)).toEqual([3, 7, 8, 9])
    expect(parsed.issues).toHaveLength(0)
    expect(parsed.transactions.map(({ direction, amount, balanceAfter }) => ({ direction, amount, balanceAfter }))).toEqual([
      { direction: 'CREDIT', amount: 1200, balanceAfter: 192023 },
      { direction: 'CREDIT', amount: 117500, balanceAfter: 309523 },
      { direction: 'DEBIT', amount: 13350, balanceAfter: 296173 },
    ])
    expect(parsed.transactions.slice(0, 2).map((transaction) => transaction.type)).toEqual(['INCOME', 'INCOME'])
    expect(parsed.transactions[2]).toMatchObject({ type: 'EXPENSE', description: 'COMPRA CARTAO VISA', originalDescription: 'COMPRA CARTAO VISA' })
    expect(new Set(parsed.transactions.map((transaction) => transaction.bankTransactionId)).size).toBe(3)
    expect(parsed.transactions[0].original['Docto.']).toBe(parsed.transactions[1].original['Docto.'])
    expect(parsed.transactions[0].bankTransactionId).not.toBe(parsed.transactions[1].bankTransactionId)
    const ledger = parseLedgerRows([{ Data: '02/02/2026', Descrição: 'COMPRA CARTAO VISA', Custo: '133,50' }], { date: 'Data', description: 'Descrição', amount: 'Custo' })
    const result = reconcile(parsed.transactions, ledger.transactions)
    expect(result.items.find((item) => item.bank.originalDescription === 'COMPRA CARTAO VISA')?.status).toBe('MATCHED')
  })

  it('sinaliza transação ambígua com débito e crédito preenchidos e não confunde forma de pagamento com direção', () => {
    const parsed = parseBankRows([
      { Data: '02/02/2026', Histórico: 'PIX ENVIADO', Débito: '29,86', Crédito: '', Pagamento: 'Crédito' },
      { Data: '02/02/2026', Histórico: 'Linha ambígua', Débito: '10,00', Crédito: '10,00', Pagamento: '' },
    ], { date: 'Data', description: 'Histórico', amount: '', debit: 'Débito', credit: 'Crédito', paymentMethod: 'Pagamento' })
    expect(parsed.transactions).toHaveLength(1)
    expect(parsed.transactions[0]).toMatchObject({ direction: 'DEBIT', type: 'EXPENSE', amount: 2986, paymentMethod: 'Crédito' })
    expect(parsed.issues).toHaveLength(1)
    expect(parsed.issues[0].message).toContain('Débito e crédito preenchidos')
  })

  it('gera identidades de planilha e banco estáveis sem depender da posição da linha', () => {
    const ledgerRows = [
      { Data: '10/02/2026', Descrição: 'Compra alfa', Custo: '12,00' },
      { Data: '11/02/2026', Descrição: 'Compra beta', Custo: '15,00' },
    ]
    const ledgerMap = { date: 'Data', description: 'Descrição', amount: 'Custo' }
    const firstLedger = parseLedgerRows(ledgerRows, ledgerMap).transactions
    const reorderedLedger = parseLedgerRows([...ledgerRows].reverse(), ledgerMap).transactions
    expect(Object.fromEntries(firstLedger.map((item) => [item.originalDescription, item.sheetRecordId]))).toEqual(Object.fromEntries(reorderedLedger.map((item) => [item.originalDescription, item.sheetRecordId])))

    const bankRows = [
      { Data: '10/02/2026', Histórico: 'COMPRA ALFA', Valor: '12,00', Tipo: 'Débito', Saldo: '100,00' },
      { Data: '11/02/2026', Histórico: 'COMPRA BETA', Valor: '15,00', Tipo: 'Débito', Saldo: '85,00' },
    ]
    const bankMap = { date: 'Data', description: 'Histórico', amount: 'Valor', direction: 'Tipo', balance: 'Saldo' }
    const firstBank = parseBankRows(bankRows, bankMap).transactions
    const reorderedBank = parseBankRows([...bankRows].reverse(), bankMap).transactions
    expect(Object.fromEntries(firstBank.map((item) => [item.originalDescription, item.bankTransactionId]))).toEqual(Object.fromEntries(reorderedBank.map((item) => [item.originalDescription, item.bankTransactionId])))
  })

  it('interpreta rentabilidade com seis campos e ignora total com delimitador final vazio', () => {
    const csv = [
      'Extrato: Agência 0000; Conta 000000-0;;;;',
      'Data;Histórico;Docto.;Crédito (R$);Débito (R$);Saldo (R$)',
      '02/10/2026;RENTAB.INVEST FACILCRED*;2;0,03; ;1.645,72',
      'Últimos Lancamentos;;;;;',
      'Data;Histórico;Docto.;Crédito (R$);Débito (R$);',
      ';;Total;631,95;1.243,35;402,37;',
    ].join('\n')
    const document = parseCsvText(csv)
    expect(document.headers).toHaveLength(6)
    expect(document.metadataRowsIgnored).toBe(1)
    expect(document.parseErrors).toEqual([])
    const row = document.rows.find((entry) => entry['Histórico'] === 'RENTAB.INVEST FACILCRED*')!
    expect(Object.keys(row)).toHaveLength(6)
    expect(row['Crédito (R$)']).toBe('0,03')
    expect(row['Débito (R$)']).toBe('')
    expect(row['Saldo (R$)']).toBe('1.645,72')
    const parsed = parseBankRows(document.rows, initialColumnMap(document.headers, 'bank'))
    expect(parsed.transactions).toHaveLength(1)
    expect(parsed.transactions[0]).toMatchObject({ direction: 'CREDIT', type: 'INVESTMENT_INCOME', outOfScopeSubtype: 'INVEST_FACIL_YIELD', amount: 3, balanceAfter: 164572, description: 'RENTAB.INVEST FACILCRED*' })
    expect(reconcile(parsed.transactions, []).items[0].status).toBe('OUT_OF_SCOPE')
    expect(parsed.issues).toEqual([])
    expect(parsed.ignoredRows).toBe(0)
    expect(parseBankRows(document.auxiliaryRows, initialColumnMap(document.headers, 'bank')).ignoredRows).toBe(2)
  })
})
