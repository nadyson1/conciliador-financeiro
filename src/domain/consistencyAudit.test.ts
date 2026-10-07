import { describe, expect, it } from 'vitest'
import { auditConsistency, auditDecisionMerge, DECISION_DOMAIN, derivedMismatchSeverity, filterAuditFindings, recomputeWithoutPersistedDecisions, type AuditFinding } from './consistencyAudit'
import type { BankTransaction, CardStatement, CardStatementMatch, CardStatementTransaction, LedgerTransaction, ReconciliationItem } from './types'
import type { PersistedDecision } from './localDecisions'
import { cardReviewCandidateIdentity, cardTransactionIdentity, cardTransactionIdentityVariants, sheetIdentity, stableFingerprint } from './identity'

const statement: CardStatement = {
  fileName: 'fatura-sintetica.pdf', pageCount: 1, statementIdentity: 'statement-current', transactions: [{
    id: 'kindle-purchase', purchaseDate: '2026-02-02', invoiceDueDate: '2026-03-12', date: '2026-02-02', description: 'Amazon Kindle Unltd', originalDescription: 'Amazon Kindle Unltd', amount: 299, direction: 'DEBIT', type: 'PURCHASE', cardIdentifier: '0000', installment: null, totalInstallments: null, city: '', currency: 'BRL', exchangeRate: null, statementDueDate: '2026-03-12', statementTotal: 299,
  }], cardSubtotals: [], reportedTotal: 299, purchasesDebitsTotal: 299, creditsPaymentsTotal: 0, previousBalance: 0, previousPayment: 0, accountingDifference: 0, dueDate: '2026-03-12', nextClosingDate: null, errors: [],
}
const kindle: LedgerTransaction = {
  id: 'row-new', source: 'SHEET', sheetRecordId: 'kindle-row-1', bankTransactionId: null, date: '2026-03-12', description: 'Assinatura Kindle unlimited (2 meses)', originalDescription: 'Assinatura Kindle unlimited (2 meses)', amount: 299, direction: 'DEBIT', type: 'EXPENSE', paymentMethod: 'Crédito_Bradesco', category: 'Assinaturas', month: '03 - Março', year: '2026', isFixed: false, isEssential: false, installment: null, totalInstallments: null, balanceAfter: null, original: {},
}
const missingMatch = (): CardStatementMatch => ({ transaction: statement.transactions[0], status: 'CARD_MISSING', sheet: null, candidates: [] })
const oldMissing: PersistedDecision = { key: 'CARD_MISSING_CONFIRMED:["old-identity"]', schemaVersion: 1, kind: 'CARD_MISSING_CONFIRMED', identities: ['old-identity'], selected: [], updatedAt: '2026-02-03T00:00:00.000Z' }

describe('consistency audit', () => {
  it('diagnostica REVIEW sem candidato, estorno ainda ausente e duplicata entre extratos', () => {
    const makeBank = (id: string, sourceId?: string): BankTransaction => ({ id, source: 'BANK', sheetRecordId: null, bankTransactionId: id, date: '2026-09-18', description: 'PIX QR CODE ESTATICO', originalDescription: 'PIX QR CODE ESTATICO', amount: 67770, direction: 'DEBIT', directionKnown: true, type: 'EXPENSE', paymentMethod: '', category: '', month: '', year: '2026', isFixed: null, isEssential: null, installment: null, totalInstallments: null, balanceAfter: null, original: {}, ...(sourceId ? { statementSourceId: sourceId, statementFileName: `${sourceId}.csv` } : {}) })
    const bank = makeBank('original', 'statement-a')
    const reviewItem = { bank: makeBank('review'), status: 'REVIEW', sheet: null, candidate: null, composition: [], compositionOptions: [], compositionStatus: null } as unknown as ReconciliationItem
    const missingItem = { bank, status: 'MISSING', sheet: null, candidate: null, composition: [], compositionOptions: [], compositionStatus: null } as unknown as ReconciliationItem
    const secondCopy = makeBank('duplicate', 'statement-b')
    const report = auditConsistency({ banks: [bank, secondCopy], sheets: [], statements: [], currentCardMatches: [], localDecisions: [], currentBankItems: [reviewItem, missingItem], bankRefundGroups: [{ id: 'refund-group', status: 'REFUNDED', originalTransactionIds: ['original'], refundTransactionId: 'refund', grossAmount: 67770, refundAmount: 67770, netAmount: 0 }] })
    expect(report.findings.map((finding) => finding.code)).toEqual(expect.arrayContaining(['REVIEW_WITHOUT_CANDIDATES', 'REFUNDED_BUT_MISSING', 'DUPLICATE_BANK_TRANSACTION_ACROSS_STATEMENTS']))
  })

  it('não trata provenance de duas fontes em uma movimentação já consolidada como duplicata', () => {
    const merged: BankTransaction = { id: 'merged-pix', source: 'BANK', sheetRecordId: null, bankTransactionId: 'merged-pix', date: '2026-09-18', description: 'PIX QR CODE ESTATICO', originalDescription: 'PIX QR CODE ESTATICO', amount: 67770, direction: 'DEBIT', directionKnown: true, type: 'EXPENSE', paymentMethod: '', category: '', month: '', year: '2026', isFixed: null, isEssential: null, installment: null, totalInstallments: null, balanceAfter: null, original: {}, statementSourceId: 'statement-a', statementSourceIds: ['statement-a', 'statement-b'], statementFileName: 'statement-a.csv' }
    const sourceA = { ...merged, id: 'source-a', statementSourceId: 'statement-a', statementSourceIds: ['statement-a'] }
    const sourceB = { ...merged, id: 'source-b', statementSourceId: 'statement-b', statementSourceIds: ['statement-b'] }
    const report = auditConsistency({ banks: [merged], bankSourceRows: [{ sourceId: 'statement-a', sourceName: 'A.csv', transactions: [sourceA] }, { sourceId: 'statement-b', sourceName: 'B.csv', transactions: [sourceB] }], sheets: [], statements: [], currentCardMatches: [], localDecisions: [] })
    expect(report.findings.some((finding) => finding.code === 'DUPLICATE_BANK_TRANSACTION_ACROSS_STATEMENTS')).toBe(false)
    expect(report.summary.review).toBe(0)
    expect(report.summary.attention).toBe(0)
  })

  it('não cria uma REVIEW por cada uma das 73 sobreposições já consolidadas', () => {
    const banks: BankTransaction[] = Array.from({ length: 73 }, (_, index) => ({ id: `merged-${index}`, source: 'BANK', sheetRecordId: null, bankTransactionId: `merged-${index}`, date: `2026-09-${String((index % 28) + 1).padStart(2, '0')}`, description: `PIX ${index}`, originalDescription: `PIX ${index}`, amount: 1000 + index, direction: 'DEBIT', directionKnown: true, type: 'EXPENSE', paymentMethod: '', category: '', month: '', year: '2026', isFixed: null, isEssential: null, installment: null, totalInstallments: null, balanceAfter: null, original: {}, statementSourceId: 'statement-a', statementSourceIds: ['statement-a', 'statement-b'] }))
    const report = auditConsistency({ banks, sheets: [], statements: [], currentCardMatches: [], localDecisions: [] })
    expect(report.findings.filter((finding) => finding.code === 'DUPLICATE_BANK_TRANSACTION_ACROSS_STATEMENTS')).toHaveLength(0)
    expect(report.summary.review).toBe(0)
    expect(report.summary.attention).toBe(0)
  })

  it('mantém finding quando entidades equivalentes de sources disjuntas sobreviveram ao merge', () => {
    const makeBank = (id: string, sourceId: string): BankTransaction => ({ id, source: 'BANK', sheetRecordId: null, bankTransactionId: id, date: '2026-09-18', description: 'PIX QR CODE ESTATICO', originalDescription: 'PIX QR CODE ESTATICO', amount: 67770, direction: 'DEBIT', directionKnown: true, type: 'EXPENSE', paymentMethod: '', category: '', month: '', year: '2026', isFixed: null, isEssential: null, installment: null, totalInstallments: null, balanceAfter: null, original: {}, statementSourceId: sourceId, statementSourceIds: [sourceId], statementFileName: `${sourceId}.csv` })
    const report = auditConsistency({ banks: [makeBank('survivor-a', 'statement-a'), makeBank('survivor-b', 'statement-b')], sheets: [], statements: [], currentCardMatches: [], localDecisions: [] })
    expect(report.findings.filter((finding) => finding.code === 'DUPLICATE_BANK_TRANSACTION_ACROSS_STATEMENTS')).toHaveLength(1)
    expect(report.findings[0]).toMatchObject({ severity: 'REVIEW', title: 'Possível duplicidade entre extratos não resolvida', technical: { bankTransactionIds: ['survivor-a', 'survivor-b'] } })
    expect(report.summary.attention).toBe(1)
  })

  it.each([
    { label: 'valor', override: { amount: 67771, direction: 'DEBIT' as const } },
    { label: 'direção', override: { amount: 67770, direction: 'CREDIT' as const } },
  ])('mantém em revisão uma representação conflitante entre fontes por $label', ({ override }) => {
    const makeRow = (id: string, sourceId: string, values: { amount: number; direction: 'DEBIT' | 'CREDIT' }): BankTransaction => ({ id, source: 'BANK', sheetRecordId: null, bankTransactionId: id, date: '2026-09-18', description: 'PIX QR CODE ESTATICO', originalDescription: 'PIX QR CODE ESTATICO', amount: values.amount, direction: values.direction, directionKnown: true, type: 'EXPENSE', paymentMethod: '', category: '', month: '', year: '2026', isFixed: null, isEssential: null, installment: null, totalInstallments: null, balanceAfter: null, original: {}, statementSourceId: sourceId, statementSourceIds: [sourceId] })
    const sourceA = makeRow('a', 'statement-a', { amount: 67770, direction: 'DEBIT' })
    const sourceB = makeRow('b', 'statement-b', override)
    const report = auditConsistency({ banks: [sourceA], bankSourceRows: [{ sourceId: 'statement-a', sourceName: 'A.csv', transactions: [sourceA] }, { sourceId: 'statement-b', sourceName: 'B.csv', transactions: [sourceB] }], sheets: [], statements: [], currentCardMatches: [], localDecisions: [] })
    expect(report.findings).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'DUPLICATE_BANK_TRANSACTION_ACROSS_STATEMENTS', severity: 'REVIEW', title: 'Os extratos divergem sobre a mesma movimentação' })]))
    expect(report.summary.review).toBe(1)
  })

  it('audita divergência de contadores e fontes que deveriam ter saído da sessão', () => {
    const bank: BankTransaction = { id: 'stale-tx', source: 'BANK', sheetRecordId: null, bankTransactionId: 'stale-tx', date: '2026-10-01', description: 'PIX', originalDescription: 'PIX ENVIADO', amount: 67770, direction: 'DEBIT', type: 'EXPENSE', paymentMethod: '', category: '', month: '', year: '2026', isFixed: null, isEssential: null, installment: null, totalInstallments: null, balanceAfter: null, original: {}, statementSourceId: 'old-csv', statementSourceIds: ['old-csv'] }
    const item = { bank, status: 'MISSING', sheet: null, candidate: null, composition: [], compositionOptions: [], compositionStatus: null } as unknown as ReconciliationItem
    const report = auditConsistency({
      banks: [bank], sheets: [], statements: [], currentCardMatches: [], localDecisions: [], currentBankItems: [item],
      missingCounterCollections: [{ source: 'card', items: [item] }, { source: 'lista', items: [] }],
      activeDriveSourceIds: [], currentDriveSourceIds: ['pdf-a', 'pdf-b'], missingDriveSourceIds: ['pdf-a'],
      duplicateInvoiceSources: [{ identity: 'invoice-x', sourceIds: ['pdf-a', 'pdf-b'] }],
    })
    expect(report.findings.map(({ code }) => code)).toEqual(expect.arrayContaining(['MISSING_COUNT_DIVERGENCE', 'STALE_ACTIVE_SOURCE', 'DUPLICATE_PRESENT_BUT_MARKED_MISSING']))
    const divergence = report.findings.find(({ code }) => code === 'MISSING_COUNT_DIVERGENCE')!
    expect(divergence.technical?.presentInSummaryOnly).toMatchObject([{ item: { bank: { id: 'stale-tx', originalDescription: 'PIX ENVIADO', amount: 67770 } } }])
  })

  it('exclui compra neutralizada por estorno agregado da auditoria de ausências e candidatos', () => {
    const canceled = { ...statement.transactions[0], financialStatus: 'REFUNDED' as const, refundGroupId: 'refund-group-synthetic' }
    const invoice = { ...statement, transactions: [canceled], refundGroups: [{ id: 'refund-group-synthetic', cardIdentifier: '0000', date: canceled.date, merchant: 'LOJA MODELO', transactionIds: [canceled.id], refundTransactionId: 'refund-credit', purchaseGroupAmount: 299, refundAmount: 299, netAmount: 0, installmentCount: 1 }] }
    const result = auditConsistency({ banks: [], sheets: [], statements: [{ statement: invoice }], currentCardMatches: [{ statementIdentity: invoice.statementIdentity, transactionId: canceled.id, match: { transaction: canceled, status: 'CARD_REFUNDED', sheet: null, candidates: [] } }], localDecisions: [] })
    expect(result.items).toEqual([])
    expect(result.findings.map((finding) => finding.code)).not.toContain('CARD_MISSING_NO_CANDIDATE')
    expect(result.findings.map((finding) => finding.code)).not.toContain('UNUSED_STRONG_CANDIDATE')
    expect(result.findings.map((finding) => finding.code)).not.toContain('DOUBLE_CLAIM')
  })

  const selfitDecisionScenario = () => {
    const makePurchase = (id: string, purchaseDate: string, dueDate: string): CardStatementTransaction => ({ ...statement.transactions[0], id, purchaseDate, date: purchaseDate, invoiceDueDate: dueDate, statementDueDate: dueDate, originalDescription: 'SELFITHOMEROCASTELOBRA', description: 'SELFITHOMEROCASTELOBRA', amount: 12990 })
    const mayPurchase = makePurchase('selfit-may-purchase', '2026-05-08', '2026-06-12')
    const aprilPurchase = makePurchase('selfit-april-purchase', '2026-04-08', '2026-05-12')
    const juneStatement = { ...statement, statementIdentity: 'selfit-june-invoice', dueDate: '2026-06-12', transactions: [mayPurchase] }
    const mayStatement = { ...statement, statementIdentity: 'selfit-may-invoice', dueDate: '2026-05-12', transactions: [aprilPurchase] }
    const makeRow = (id: string, date: string): LedgerTransaction => ({ ...kindle, id, sheetRecordId: id, date, amount: 12990, description: 'Mensalidade Selfit', originalDescription: 'Mensalidade Selfit', type: 'EXPENSE' })
    const mayRow = makeRow('6bf22757', '2026-05-12')
    const juneRow = makeRow('selfit-june-row', '2026-06-12')
    const decisionId = `STATEMENT_MATCH_CONFIRMED:${JSON.stringify([cardTransactionIdentity(juneStatement, mayPurchase)])}`
    const obsoleteDecision: PersistedDecision = { ...oldMissing, key: decisionId, kind: 'STATEMENT_MATCH_CONFIRMED', identities: [cardTransactionIdentity(juneStatement, mayPurchase)], selected: [sheetIdentity(mayRow)], updatedAt: '2026-06-01T00:00:00.000Z' }
    const currentCardMatches = [
      { statementIdentity: mayStatement.statementIdentity, transactionId: aprilPurchase.id, match: { transaction: aprilPurchase, status: 'CARD_MATCHED' as const, sheet: mayRow, candidates: [mayRow] } },
      { statementIdentity: juneStatement.statementIdentity, transactionId: mayPurchase.id, match: { transaction: mayPurchase, status: 'CARD_MATCHED' as const, sheet: juneRow, candidates: [juneRow] } },
    ]
    const input = { banks: [], sheets: [mayRow, juneRow], statements: [{ statement: mayStatement }, { statement: juneStatement }], currentCardMatches, localDecisions: [obsoleteDecision], remoteDecisions: [] }
    return { input, mayRow, juneRow, obsoleteDecision }
  }

  it('offers precise invalidation only when a current exact-cycle match wins and the old subject is reassigned', () => {
    const { input, mayRow, obsoleteDecision } = selfitDecisionScenario()
    const safe = auditConsistency({ ...input, remoteDecisions: [obsoleteDecision], localDecisions: [] }).findings.find((item) => item.code === 'DOUBLE_CLAIM')
    expect(safe?.technical?.safeInvalidation).toMatchObject({ decisionId: stableFingerprint([obsoleteDecision.key]), decisionKey: obsoleteDecision.key, row: { id: '6bf22757' }, proof: { winningSubjectHasExactCycleMatch: true, obsoleteSubjectHasSeparateCurrentMatch: true, onlyTwoSubjectsClaimThisRow: true } })
    expect((safe?.technical?.safeInvalidation as Record<string, unknown>).decision).toEqual(obsoleteDecision)

    const ambiguousMatches = input.currentCardMatches.map((entry) => entry.transactionId === 'selfit-may-purchase'
      ? { ...entry, match: { ...entry.match, status: 'CARD_REVIEW' as const, sheet: null, candidates: [mayRow] } }
      : entry)
    const ambiguous = auditConsistency({ ...input, currentCardMatches: ambiguousMatches }).findings.find((item) => item.code === 'DOUBLE_CLAIM')
    expect(ambiguous?.technical?.safeInvalidation).toBeUndefined()
  })

  it('não propõe ação automática quando a decisão já foi tombstonada', () => {
    const { input, obsoleteDecision } = selfitDecisionScenario()
    const report = auditConsistency({ ...input, localDecisions: [], remoteDecisions: [obsoleteDecision], remoteTombstones: [{ ...obsoleteDecision, updatedAt: '2026-06-02T00:00:00.000Z' }] })
    expect(report.findings.some((item) => item.code === 'DOUBLE_CLAIM')).toBe(false)
  })

  it('finds the synthetic Kindle candidate, pure MATCH, current MISSING and a legacy missing decision without hardcoding its merchant', () => {
    const pure = recomputeWithoutPersistedDecisions({ sheets: [kindle], statements: [{ statement }] })
    expect([...pure.values()][0]).toMatchObject({ status: 'CARD_MATCHED', sheet: kindle })
    const legacy: PersistedDecision = { ...oldMissing, key: `CARD_MISSING_CONFIRMED:${JSON.stringify([cardTransactionIdentityVariants(statement, statement.transactions[0])[1]])}`, identities: [cardTransactionIdentityVariants(statement, statement.transactions[0])[1]] }
    const report = auditConsistency({ banks: [], sheets: [kindle], statements: [{ statement }], currentCardMatches: [{ statementIdentity: statement.statementIdentity, transactionId: 'kindle-purchase', match: missingMatch() }], localDecisions: [legacy] })
    const codes = report.findings.flatMap((finding) => [finding.code, ...(finding.relatedFindings ?? []).map((related) => related.code)])
    expect(codes).toContain('MISSING_COM_CANDIDATO')
    expect(codes).toContain('DERIVED_STATE_MISMATCH')
    expect(codes).toContain('STALE_MISSING_DECISION')
    expect(codes).toContain('LEGACY_FINGERPRINT_MATCH')
    expect(report.items[0]).toMatchObject({ pure: { status: 'CARD_MATCHED' }, current: { status: 'CARD_MISSING' }, candidates: [kindle] })
    expect(report.items[0].evaluatedCandidates).toEqual([{ row: kindle, source: 'FONTE DA ANÁLISE', accepted: true, reason: null }])
  })

  it('reports the pre-write discrepancy using the shared candidate search', () => {
    const noMethodCandidate = { ...kindle, paymentMethod: 'Pix' }
    const report = auditConsistency({ banks: [], sheets: [noMethodCandidate], statements: [{ statement }], currentCardMatches: [{ statementIdentity: statement.statementIdentity, transactionId: 'kindle-purchase', match: missingMatch() }], localDecisions: [] })
    expect(report.findings.map((finding) => finding.code)).not.toContain('PREWRITE_MATCH_MISMATCH')
    const candidateMatch = auditConsistency({ banks: [], sheets: [kindle], statements: [{ statement }], currentCardMatches: [], localDecisions: [] })
    expect(candidateMatch.findings.map((finding) => finding.code)).not.toContain('PREWRITE_MATCH_MISMATCH')
  })

  it('shows the exact failed gate for each evaluated Kindle-like sheet row when no candidate passes', () => {
    const wrongAmount = { ...kindle, amount: 300 }
    const report = auditConsistency({ banks: [], sheets: [wrongAmount], statements: [{ statement }], currentCardMatches: [{ statementIdentity: statement.statementIdentity, transactionId: 'kindle-purchase', match: missingMatch() }], localDecisions: [] })
    expect(report.items[0].pure.status).toBe('CARD_MISSING')
    expect(report.items[0].candidates).toHaveLength(0)
    expect(report.items[0].evaluatedCandidates[0]).toMatchObject({ accepted: false, reason: 'valor diferente: planilha 300 centavos, PDF 299 centavos' })
    expect(report.findings.some((finding) => finding.code === 'CARD_MISSING_NO_CANDIDATE')).toBe(false)
  })

  it('flags a transfer-misclassified Crédito_Bradesco row only when it can create a duplicate', () => {
    const mislabeled = { ...kindle, type: 'TRANSFER' as const }
    const report = auditConsistency({ banks: [], sheets: [mislabeled], statements: [{ statement }], currentCardMatches: [{ statementIdentity: statement.statementIdentity, transactionId: 'kindle-purchase', match: missingMatch() }], localDecisions: [] })
    const finding = report.findings.find((item) => item.code === 'CARD_MISSING_NO_CANDIDATE')
    expect(finding).toMatchObject({ severity: 'CRITICAL', technical: { canAppend: true } })
    expect((finding?.technical?.rejectedRows as Record<string, unknown>[])[0]).toMatchObject({ typeBefore: 'TRANSFER', typeAfter: 'EXPENSE', paymentMethod: 'Crédito_Bradesco' })

    const review = auditConsistency({ banks: [], sheets: [mislabeled], statements: [{ statement }], currentCardMatches: [{ statementIdentity: statement.statementIdentity, transactionId: 'kindle-purchase', match: { ...missingMatch(), status: 'CARD_REVIEW' } }], localDecisions: [] })
    expect(review.findings.find((item) => item.code === 'CARD_MISSING_NO_CANDIDATE')?.severity).toBe('REVIEW')
  })

  it('classifies derived state differences by impact and exposes the group matching stage', () => {
    expect(derivedMismatchSeverity('CARD_REVIEW', 'CARD_GROUP_MATCHED', true)).toBe('INFO')
    expect(derivedMismatchSeverity('CARD_MATCHED', 'CARD_MISSING', true)).toBe('CRITICAL')
    expect(derivedMismatchSeverity('CARD_MISSING', 'CARD_MATCHED', false)).toBe('CRITICAL')
    const secondTransaction = { ...statement.transactions[0], id: 'second-purchase', originalDescription: 'Loja sintética', description: 'Loja sintética' }
    const twoPurchases = { ...statement, transactions: [statement.transactions[0], secondTransaction] }
    const group = { ...missingMatch(), status: 'CARD_GROUP_MATCHED' as const, candidates: [kindle], sheet: null }
    const report = auditConsistency({ banks: [], sheets: [kindle], statements: [{ statement: twoPurchases }], currentCardMatches: [
      { statementIdentity: statement.statementIdentity, transactionId: 'kindle-purchase', match: { ...group, transaction: statement.transactions[0] } },
      { statementIdentity: statement.statementIdentity, transactionId: 'second-purchase', match: { ...group, transaction: secondTransaction } },
    ], localDecisions: [] })
    const derived = report.findings.find((item) => item.code === 'DERIVED_STATE_MISMATCH')
    expect(derived).toMatchObject({ severity: 'INFO', technical: { pipeline: { base: 'CARD_REVIEW', later: 'GROUP_MATCHING / multiplicidade', final: 'CARD_GROUP_MATCHED' } } })
    expect(report.findings.filter((item) => item.code === 'DOUBLE_CLAIM')).toHaveLength(0)
    expect(report.summary.attention).toBe(0)
  })

  it('distinguishes a candidate present only in the session cache from the fresh sheet read', () => {
    const report = auditConsistency({ banks: [], sheets: [], currentSheets: [kindle], statements: [{ statement }], currentCardMatches: [{ statementIdentity: statement.statementIdentity, transactionId: 'kindle-purchase', match: missingMatch() }], localDecisions: [] })
    expect(report.items[0].evaluatedCandidates).toContainEqual({ row: kindle, source: 'CACHE DA SESSÃO', accepted: true, reason: null })
    expect(report.items[0].diagnosis).toContain('cache local')
    expect(report.findings.some((finding) => finding.code === 'CURRENT_SOURCE_DIVERGENCE')).toBe(true)
  })

  it('identifies the persisted rejected-candidate filter as the exact MISSING stage', () => {
    const fingerprint = cardTransactionIdentityVariants(statement, statement.transactions[0])[0]
    const rejected: PersistedDecision = { ...oldMissing, kind: 'CARD_REVIEW_REJECTED_CANDIDATES', key: `CARD_REVIEW_REJECTED_CANDIDATES:${JSON.stringify([fingerprint])}`, identities: [fingerprint], selected: [cardReviewCandidateIdentity(kindle)] }
    const report = auditConsistency({ banks: [], sheets: [kindle], statements: [{ statement }], currentCardMatches: [{ statementIdentity: statement.statementIdentity, transactionId: 'kindle-purchase', match: missingMatch() }], localDecisions: [rejected] })
    expect(report.items[0].diagnosis).toContain('CARD_REVIEW_REJECTED_CANDIDATES removeu')
    const codes = report.findings.flatMap((finding) => [finding.code, ...(finding.relatedFindings ?? []).map((related) => related.code)])
    expect(codes).toContain('REJECTED_CANDIDATE_FILTERED')
    expect(codes).toContain('DERIVED_STATE_MISMATCH')
  })

  it('does not mutate supplied sources or decisions', () => {
    const decisions = [oldMissing]
    const sheets = [kindle]
    const before = JSON.stringify({ decisions, sheets })
    auditConsistency({ banks: [], sheets, statements: [{ statement }], currentCardMatches: [{ statementIdentity: statement.statementIdentity, transactionId: 'kindle-purchase', match: missingMatch() }], localDecisions: decisions })
    expect(JSON.stringify({ decisions, sheets })).toBe(before)
  })

  it('classifies orphaned and edited card row references', () => {
    const identity = cardTransactionIdentityVariants(statement, statement.transactions[0])[0]
    const missingReference: PersistedDecision = { ...oldMissing, key: `STATEMENT_MATCH_CONFIRMED:${JSON.stringify([identity])}`, kind: 'STATEMENT_MATCH_CONFIRMED', identities: [identity], selected: ['deleted-sheet-id'] }
    const report = auditConsistency({ banks: [], sheets: [kindle], statements: [{ statement }], currentCardMatches: [], localDecisions: [missingReference] })
    expect(report.findings.map((finding) => finding.code)).toContain('ORPHANED_SHEET_REFERENCE')
    const edited: PersistedDecision = { ...missingReference, key: `STATEMENT_MATCH_CONFIRMED:${JSON.stringify([identity])}`, selected: [sheetIdentity(kindle)] }
    const incompatible = { ...kindle, amount: 700 }
    const editedReport = auditConsistency({ banks: [], sheets: [incompatible], statements: [{ statement }], currentCardMatches: [], localDecisions: [edited] })
    expect(editedReport.findings.map((finding) => finding.code)).toContain('EDITED_SHEET_REFERENCE')
  })

  it('preserves a human ignore decision and flags it when a matching candidate later appears', () => {
    const identity = cardTransactionIdentityVariants(statement, statement.transactions[0])[0]
    const ignored: PersistedDecision = { ...oldMissing, kind: 'CARD_PURCHASE_IGNORED', key: `CARD_PURCHASE_IGNORED:${JSON.stringify([identity])}`, identities: [identity] }
    const report = auditConsistency({ banks: [], sheets: [kindle], statements: [{ statement }], currentCardMatches: [{ statementIdentity: statement.statementIdentity, transactionId: 'kindle-purchase', match: { ...missingMatch(), status: 'CARD_IGNORED' } }], localDecisions: [ignored] })
    expect(report.findings.map((finding) => finding.code)).toContain('IGNORED_DECISION_REVIEW')
    expect(report.items[0].decisions[0]).toMatchObject({ decision: ignored, status: 'VALID' })
  })

  it('detects orphaned additions, resolved duplicate claims, local/remote divergence and a newer tombstone', () => {
    const identity = cardTransactionIdentityVariants(statement, statement.transactions[0])[0]
    const linked: PersistedDecision = { ...oldMissing, kind: 'STATEMENT_MATCH_CONFIRMED', identities: [identity], key: `STATEMENT_MATCH_CONFIRMED:${JSON.stringify([identity])}`, selected: [sheetIdentity(kindle)] }
    const otherTransaction = { ...statement.transactions[0], id: 'another-purchase', originalDescription: 'Outra compra', description: 'Outra compra' }
    const otherStatement = { ...statement, statementIdentity: 'statement-other', transactions: [otherTransaction] }
    const missingAdded: PersistedDecision = { ...oldMissing, kind: 'MISSING_ADDED_TO_SHEET', identities: ['bank:missing'], key: 'MISSING_ADDED_TO_SHEET:["bank:missing"]', selected: ['removed-row'] }
    const newer = { ...linked, selected: ['different-row'], updatedAt: '2026-04-01T00:00:00.000Z' }
    const report = auditConsistency({ banks: [], sheets: [kindle], statements: [{ statement }, { statement: otherStatement }], currentCardMatches: [
      { statementIdentity: statement.statementIdentity, transactionId: 'kindle-purchase', match: { ...missingMatch(), status: 'CARD_MATCHED', sheet: kindle } },
      { statementIdentity: otherStatement.statementIdentity, transactionId: 'another-purchase', match: { ...missingMatch(), transaction: otherTransaction, status: 'CARD_MATCHED', sheet: kindle } },
    ], localDecisions: [linked, missingAdded], remoteDecisions: [newer], remoteTombstones: [{ ...linked, updatedAt: '2026-05-01T00:00:00.000Z' }] })
    const codes = report.findings.map((finding) => finding.code)
    expect(codes).toContain('DOUBLE_CLAIM')
    const duplicate = report.findings.find((item) => item.code === 'DOUBLE_CLAIM')!
    expect(duplicate.severity).toBe('CRITICAL')
    expect(duplicate.technical?.row).toMatchObject({ id: 'kindle-row-1', description: kindle.originalDescription, amount: 299 })
    expect(duplicate.technical?.subjects).toHaveLength(2)
    expect(duplicate.technical?.claimSources).toContain('matching atual')
    expect(codes).toContain('MISSING_ADDED_TO_SHEET_ORPHAN')
    expect(codes).not.toContain('LOCAL_REMOTE_DECISION_DIVERGENCE')
    expect(codes).not.toContain('NEWER_TOMBSTONE_EXISTS')
    expect(codes).toContain('SYNC_PENDING')
  })

  it('does not retain a tombstoned confirmation as a duplicate claim after reload', () => {
    const identity = cardTransactionIdentityVariants(statement, statement.transactions[0])[0]
    const linked: PersistedDecision = { ...oldMissing, kind: 'STATEMENT_MATCH_CONFIRMED', identities: [identity], key: `STATEMENT_MATCH_CONFIRMED:${JSON.stringify([identity])}`, selected: [sheetIdentity(kindle)], updatedAt: '2026-01-01T10:00:00.000Z' }
    const otherTransaction = { ...statement.transactions[0], id: 'another-purchase', originalDescription: 'Outra compra', description: 'Outra compra' }
    const otherStatement = { ...statement, statementIdentity: 'statement-other', transactions: [otherTransaction] }
    const result = auditConsistency({ banks: [], sheets: [kindle], statements: [{ statement }, { statement: otherStatement }], localDecisions: [linked], remoteTombstones: [{ ...linked, updatedAt: '2026-01-01T10:15:00.000Z' }], currentCardMatches: [
      { statementIdentity: otherStatement.statementIdentity, transactionId: 'another-purchase', match: { ...missingMatch(), transaction: otherTransaction, status: 'CARD_MATCHED', sheet: kindle } },
    ] })
    expect(result.findings.some((item) => item.code === 'DOUBLE_CLAIM')).toBe(false)
  })

  it('uses explicit decision domains and reports wrong-domain only for a proven application', () => {
    const bankDecision: PersistedDecision = { ...oldMissing, kind: 'PAIR_CONFIRMED', key: 'PAIR_CONFIRMED:["bank:x"]', identities: ['bank:x'], selected: ['sheet:x'] }
    const composition: PersistedDecision = { ...oldMissing, kind: 'COMPOSITION_CONFIRMED', key: 'COMPOSITION_CONFIRMED:["bank:payment","statement:invoice"]', identities: ['bank:payment', 'statement:invoice'], selected: ['sheet:a', 'sheet:b'] }
    expect(DECISION_DOMAIN.PAIR_CONFIRMED).toBe('bank-reconciliation')
    expect(DECISION_DOMAIN.COMPOSITION_CONFIRMED).toBe('card-payment-composition')
    const base = { banks: [], sheets: [], statements: [], currentCardMatches: [], localDecisions: [bankDecision, composition] }
    expect(auditConsistency(base).findings.map((item) => item.code)).not.toContain('WRONG_DECISION_DOMAIN')
    const proven = auditConsistency({ ...base, appliedDecisions: [{ decisionKey: bankDecision.key, subjectFingerprint: 'pdf-subject', appliedDomain: 'pdf-card-purchase' }] })
    expect(proven.findings.filter((item) => item.code === 'WRONG_DECISION_DOMAIN')).toHaveLength(1)
  })

  it('resolves newer remote versions and remote tombstones without raising semantic conflicts', () => {
    const oldLocal = { ...oldMissing, kind: 'BANK_IGNORED' as const, key: 'BANK_IGNORED:["bank:x"]', identities: ['bank:x'], updatedAt: '2026-01-01T10:00:00.000Z' }
    const newRemote = { ...oldLocal, selected: ['new-selection'], updatedAt: '2026-01-01T10:15:00.000Z' }
    expect(auditDecisionMerge({ localDecisions: [oldLocal], remoteDecisions: [newRemote] }).conflicts).toHaveLength(0)
    expect(auditDecisionMerge({ localDecisions: [oldLocal], remoteTombstones: [{ ...oldLocal, updatedAt: '2026-01-01T10:15:00.000Z' }] }).conflicts).toHaveLength(0)
    const tieRemote = { ...newRemote, updatedAt: oldLocal.updatedAt }
    const tie = auditDecisionMerge({ localDecisions: [oldLocal], remoteDecisions: [tieRemote] })
    expect(tie.conflicts).toHaveLength(0)
    expect(tie.pendingLocalUpdate).toEqual([oldLocal.key])

    const missingIdentity = cardTransactionIdentityVariants(statement, statement.transactions[0])[0]
    const missing: PersistedDecision = { ...oldMissing, key: `CARD_MISSING_CONFIRMED:${JSON.stringify([missingIdentity])}`, identities: [missingIdentity], updatedAt: '2026-01-01T10:00:00.000Z' }
    const tombstoned = auditConsistency({ banks: [], sheets: [kindle], statements: [{ statement }], currentCardMatches: [{ statementIdentity: statement.statementIdentity, transactionId: 'kindle-purchase', match: missingMatch() }], localDecisions: [missing], remoteTombstones: [{ ...missing, updatedAt: '2026-01-01T10:15:00.000Z' }] })
    const itemCodes = tombstoned.findings.flatMap((finding) => [finding.code, ...(finding.relatedFindings ?? []).map((related) => related.code)])
    expect(tombstoned.items[0].pure.status).toBe('CARD_MATCHED')
    expect(itemCodes).not.toContain('STALE_MISSING_DECISION')
  })

  it('reports only unresolvable payload conflicts and groups fifty stale local copies into one informational finding', () => {
    const local = { ...oldMissing, kind: 'BANK_IGNORED' as const, key: 'BANK_IGNORED:["bank:conflict"]', identities: ['bank:conflict'], selected: [], updatedAt: 'invalid-local' }
    const remote = { ...local, selected: ['incompatible'], updatedAt: 'invalid-remote' }
    expect(auditDecisionMerge({ localDecisions: [local], remoteDecisions: [remote] }).conflicts).toHaveLength(1)
    const locals = Array.from({ length: 50 }, (_, index) => ({ ...oldMissing, kind: 'BANK_IGNORED' as const, key: `BANK_IGNORED:["bank:${index}"]`, identities: [`bank:${index}`], updatedAt: '2026-01-01T10:00:00.000Z' }))
    const remotes = locals.map((item) => ({ ...item, updatedAt: '2026-01-01T10:15:00.000Z' }))
    const merge = auditDecisionMerge({ localDecisions: locals, remoteDecisions: remotes })
    expect(merge.pendingLocalUpdate).toHaveLength(50)
    const result = auditConsistency({ banks: [], sheets: [], statements: [], currentCardMatches: [], localDecisions: locals, remoteDecisions: remotes })
    expect(result.findings.filter((item) => item.code === 'SYNC_PENDING')).toHaveLength(1)
    expect(result.findings.find((item) => item.code === 'SYNC_PENDING')?.technical?.count).toBe(50)
    expect(result.summary.attention).toBe(0)
    expect(result.summary.informational).toBe(1)
  })

  it('filters every severity group and excludes maintenance/information from attention counts', () => {
    const findings = (['CRITICAL', 'REVIEW', 'MAINTENANCE', 'LEGACY', 'INFO'] as const).map((severity) => ({ id: severity, code: 'DECISION_STATUS', severity, title: severity, detail: severity })) as AuditFinding[]
    expect(filterAuditFindings(findings, 'ALL')).toHaveLength(5)
    expect(filterAuditFindings(findings, 'CRITICAL').map((item) => item.severity)).toEqual(['CRITICAL'])
    expect(filterAuditFindings(findings, 'REVIEW').map((item) => item.severity)).toEqual(['REVIEW'])
    expect(filterAuditFindings(findings, 'LEGACY').map((item) => item.severity)).toEqual(['MAINTENANCE', 'LEGACY'])
  })
})
