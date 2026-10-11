import { describe, expect, it } from 'vitest'
import { auditConsistency, auditDecisionMerge, calculateDiagnosticConfidence, DECISION_DOMAIN, derivedMismatchSeverity, evaluateInvariantExecutions, filterAuditFindings, finalizeAuditInputSnapshot, recomputeWithoutPersistedDecisions, runAuditSelfChecks, summarizeAudit, type AuditFinding } from './consistencyAudit'
import { deriveExpectedReconciliationState } from './expectedReconciliationState'
import { createAuditInputSnapshot } from './auditInputSnapshot'
import type { BankTransaction, CardStatement, CardStatementMatch, CardStatementTransaction, LedgerTransaction, ReconciliationItem } from './types'
import { decisionKey, type PersistedDecision } from './localDecisions'
import { bankIdentity, cardReviewCandidateIdentity, cardTransactionIdentity, cardTransactionIdentityVariants, sheetIdentity, stableFingerprint } from './identity'
import { reconcile } from '../matching/reconcile'

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
  it('deriva expectedState e explanationChain das regras efetivas sem confundir pure com current', () => {
    const rejected = deriveExpectedReconciliationState({ subjectId: 'bank-a', pureState: 'MATCHED', currentState: 'MISSING', validRejection: { decisionId: 'decision-reject-a', outcome: 'MISSING' } })
    expect(rejected).toMatchObject({ pureState: 'MATCHED', expectedState: 'MISSING', currentState: 'MISSING' })
    expect(rejected.explanationChain.map((step) => step.stage)).toEqual(['PURE_MATCHING', 'DECISION', 'FINAL_ASSIGNMENT'])
    const confirmed = deriveExpectedReconciliationState({ subjectId: 'purchase-a', pureState: 'CARD_REVIEW', currentState: 'CARD_MISSING', validManualAssignment: { decisionId: 'decision-confirm-a', targetId: 'row-a' } })
    expect(confirmed).toMatchObject({ pureState: 'CARD_REVIEW', expectedState: 'CARD_MATCHED', currentState: 'CARD_MISSING', expectedTargetId: 'row-a' })
    expect(confirmed.explanationChain.at(-1)?.outcome).toBe('CARD_MATCHED')
    const reservation = deriveExpectedReconciliationState({ subjectId: 'purchase-b', pureState: 'CARD_MATCHED', currentState: 'CARD_REVIEW', reservationOwner: { subjectId: 'purchase-a', targetId: 'row-a', decisionId: 'decision-a' } })
    expect(reservation).toMatchObject({ expectedState: 'CARD_REVIEW', currentState: 'CARD_REVIEW' })
  })

  it('conta apenas invariantes executadas e informa fontes indisponíveis/revisões mistas', () => {
    const base = { banks: [], sheets: [], statements: [], currentCardMatches: [], localDecisions: [] }
    const partial = evaluateInvariantExecutions({ ...base, statements: [{ statement, legacyStatementIdentity: undefined }], auditInputSnapshot: createAuditInputSnapshot({ banks: [], sheets: [], statements: [statement], decisions: [], unavailableSources: ['google-current-ledger'] }) }, [])
    expect(partial.find((entry) => entry.invariantId === 'INV-04')).toMatchObject({ status: 'UNAVAILABLE', sourcesRequired: expect.arrayContaining(['cardStatements', 'custosAno', 'currentCardResults']) })
    expect(partial.find((entry) => entry.invariantId === 'INV-07')?.status).toBe('NOT_APPLICABLE')
    const mixed = evaluateInvariantExecutions({ ...base, statements: [{ statement }], auditInputSnapshot: createAuditInputSnapshot({ banks: [], sheets: [], statements: [statement], decisions: [], mixedRevisionSources: ['derived-source-result'] }) }, [])
    expect(mixed.find((entry) => entry.invariantId === 'INV-04')?.status).toBe('SKIPPED_DUE_TO_REVISION')
    expect(mixed.filter((entry) => entry.status === 'EXECUTED_PASS').length).toBeLessThan(mixed.length)
  })

  it('contadores consideram apenas findings de topo, sem inflar por evidências relacionadas', () => {
    const primary = { id: 'root', code: 'DOUBLE_CLAIM', severity: 'CRITICAL', role: 'PRIMARY', status: 'ACTIVE', technical: {} } as AuditFinding
    const related = { id: 'child', code: 'ASSIGNMENT_CONFLICT', severity: 'CRITICAL', role: 'RELATED', status: 'ACTIVE', technical: {} } as AuditFinding
    expect(summarizeAudit([primary, related], []).attention).toBe(1)
    expect(summarizeAudit([primary, related], []).critical).toBe(1)
  })

  it('mantém resultados determinísticos para o mesmo snapshot e executa self-checks sem inconsistências', () => {
    const input = { banks: [], sheets: [kindle], statements: [{ statement }], currentCardMatches: [{ statementIdentity: statement.statementIdentity, transactionId: statement.transactions[0].id, match: missingMatch() }], localDecisions: [] }
    const first = auditConsistency(input), second = auditConsistency(input)
    const stable = (report: typeof first) => report.findings.map(({ code, id, severity, rootCauseKey, expectedState, explanationChain }) => ({ code, id, severity, rootCauseKey, expectedState, explanationChain }))
    expect(stable(first)).toEqual(stable(second))
    expect(first.auditSelfChecks.every((check) => check.status !== 'FAIL')).toBe(true)
    expect(first.invariantExecutions).toEqual(expect.arrayContaining([expect.objectContaining({ invariantId: 'INV-04', status: 'EXECUTED_PASS' })]))
  })

  it('detecta violação interna de contrato de contagem de candidatos', () => {
    const check = runAuditSelfChecks({ items: [], decisions: [], findings: [{ id: 'bad-trace', code: 'MISSING_WITH_STRONG_CANDIDATE', severity: 'CRITICAL', category: 'STATE', invariantId: 'INV-03', title: 'Falha', detail: 'Falha', diagnosis: 'Falha', whyItMatters: 'Falha', recommendedAction: 'Revisar', diagnosticConfidence: 'HIGH', safeAutomaticAction: false, status: 'ACTIVE', explanationSource: 'NONE', technical: { candidateCountRelevant: 2, candidateEvaluations: [] }, role: 'PRIMARY', rootCauseCode: 'RECONCILIATION_ASSIGNMENT', rootCauseKey: 'RECONCILIATION_ASSIGNMENT:subject' }] })
    expect(check.find((entry) => entry.checkId === 'CANDIDATE_COUNT_TRACE')).toMatchObject({ status: 'FAIL', findingIds: ['bad-trace'] })
  })

  it('autocheca evidência crítica, referências ao snapshot, chains e duplicação de primary', () => {
    const make = (id: string, overrides: Partial<AuditFinding> = {}): AuditFinding => ({ id, code: 'MISSING_WITH_STRONG_CANDIDATE', severity: 'CRITICAL', category: 'STATE', invariantId: 'INV-03', title: id, detail: id, diagnosis: id, whyItMatters: id, recommendedAction: 'Revisar', diagnosticConfidence: 'HIGH', safeAutomaticAction: false, status: 'ACTIVE', explanationSource: 'NONE', role: 'PRIMARY', rootCauseCode: 'ASSIGNMENT', rootCauseKey: 'ASSIGNMENT:subject', technical: { proof: true }, ...overrides })
    const evidence = make('evidence')
    const duplicate = make('duplicate')
    const related = make('related', { role: 'RELATED', rootCauseKey: 'ORPHAN:subject', technical: {} })
    const noEvidence = make('no-evidence', { rootCauseKey: 'NO_EVIDENCE:subject', technical: {} })
    const reference = make('reference', { rootCauseKey: 'DECISION:subject', technical: { decision: { key: 'absent-decision' } } })
    const subject = { ...auditConsistency({ banks: [], sheets: [], statements: [{ statement }], currentCardMatches: [{ statementIdentity: statement.statementIdentity, transactionId: statement.transactions[0].id, match: missingMatch() }], localDecisions: [] }).items[0], expectedState: missingMatch(), explanationChain: [{ stage: 'PURE_MATCHING' as const, outcome: 'CARD_MATCHED' }] }
    const checks = runAuditSelfChecks({ items: [subject], findings: [evidence, duplicate, related, noEvidence, reference], decisions: [], snapshot: createAuditInputSnapshot({ banks: [], sheets: [], statements: [], decisions: [] }) })
    expect(checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ checkId: 'UNIQUE_PRIMARY_ROOT_CAUSE', status: 'FAIL' }),
      expect.objectContaining({ checkId: 'RELATED_FINDING_HAS_PRIMARY', status: 'FAIL' }),
      expect.objectContaining({ checkId: 'CRITICAL_EVIDENCE', status: 'FAIL' }),
      expect.objectContaining({ checkId: 'DECISION_REFERENCE_IN_SNAPSHOT', status: 'FAIL' }),
      expect.objectContaining({ checkId: 'EXPECTED_STATE_EXPLANATION', status: 'FAIL' }),
    ]))
  })

  it('separa severidade de confiança e reduz confiança quando a evidência é incompleta', () => {
    expect(calculateDiagnosticConfidence({ identityQuality: 'CANONICAL', sourceCoverage: 'COMPLETE', revisionComparable: true, evidenceCount: 3, validDecision: false, targetCanonical: true })).toBe('HIGH')
    expect(calculateDiagnosticConfidence({ identityQuality: 'CANONICAL', sourceCoverage: 'PARTIAL', revisionComparable: true, evidenceCount: 3, validDecision: true, targetCanonical: true })).toBe('LOW')
    expect(calculateDiagnosticConfidence({ identityQuality: 'HEURISTIC', sourceCoverage: 'COMPLETE', revisionComparable: true, evidenceCount: 1, validDecision: false, targetCanonical: false })).toBe('MEDIUM')
    expect(derivedMismatchSeverity('CARD_MATCHED', 'CARD_MISSING', true)).toBe('CRITICAL')
  })

  it('detecta resultado derivado calculado com decisionRevision antiga', () => {
    const report = auditConsistency({ banks: [], sheets: [], statements: [], currentCardMatches: [], localDecisions: [], currentDecisionRevision: 'revision-11', derivedDecisionRevision: 'revision-10' })
    expect(report.findings.find((finding) => finding.code === 'STALE_DECISION_RESULT')?.technical).toEqual({ currentDecisionRevision: 'revision-11', derivedDecisionRevision: 'revision-10' })
  })

  it('detecta conflito global bancário e confirmações válidas que não foram aplicadas', () => {
    const makeBank = (id: string): BankTransaction => ({ id, source: 'BANK', sheetRecordId: null, bankTransactionId: id, date: kindle.date, description: kindle.description, originalDescription: kindle.originalDescription, amount: kindle.amount, direction: 'DEBIT', directionKnown: true, type: 'EXPENSE', paymentMethod: 'Pix', category: '', month: '', year: kindle.year, isFixed: null, isEssential: null, installment: null, totalInstallments: null, balanceAfter: null, original: {} })
    const first = makeBank('bank-owner-a'), second = makeBank('bank-owner-b')
    const pair = (bank: BankTransaction): PersistedDecision => ({ key: decisionKey('PAIR_CONFIRMED', [bankIdentity(bank)]), kind: 'PAIR_CONFIRMED', identities: [bankIdentity(bank)], selected: [sheetIdentity(kindle)], schemaVersion: 1, updatedAt: '2026-10-10T10:00:00.000Z' })
    const conflict = auditConsistency({ banks: [first, second], sheets: [kindle], statements: [], currentCardMatches: [], localDecisions: [pair(first), pair(second)] })
    expect(conflict.findings.find((finding) => finding.code === 'PAIR_CONFIRMED_ASSIGNMENT_CONFLICT')?.technical?.assignments).toHaveLength(2)
    const notApplied = auditConsistency({ banks: [first], sheets: [kindle], statements: [], currentCardMatches: [], localDecisions: [pair(first)] })
    expect(notApplied.findings.map((finding) => finding.code)).toContain('VALID_BANK_MANUAL_MATCH_NOT_APPLIED')
    expect(notApplied.expectedStates[bankIdentity(first)]).toMatchObject({ expectedState: 'MATCHED', currentState: 'UNAVAILABLE', expectedTargetId: sheetIdentity(kindle) })
  })

  it('diagnostica REVIEW sem candidato, estorno ainda ausente e duplicata entre extratos', () => {
    const makeBank = (id: string, sourceId?: string): BankTransaction => ({ id, source: 'BANK', sheetRecordId: null, bankTransactionId: id, date: '2026-09-18', description: 'PIX QR CODE ESTATICO', originalDescription: 'PIX QR CODE ESTATICO', amount: 67770, direction: 'DEBIT', directionKnown: true, type: 'EXPENSE', paymentMethod: '', category: '', month: '', year: '2026', isFixed: null, isEssential: null, installment: null, totalInstallments: null, balanceAfter: null, original: {}, ...(sourceId ? { statementSourceId: sourceId, statementFileName: `${sourceId}.csv` } : {}) })
    const bank = makeBank('original', 'statement-a')
    const reviewItem = { bank: makeBank('review'), status: 'REVIEW', sheet: null, candidate: null, composition: [], compositionOptions: [], compositionStatus: null } as unknown as ReconciliationItem
    const missingItem = { bank, status: 'MISSING', sheet: null, candidate: null, composition: [], compositionOptions: [], compositionStatus: null } as unknown as ReconciliationItem
    const secondCopy = makeBank('duplicate', 'statement-b')
    const report = auditConsistency({ banks: [bank, secondCopy], sheets: [], statements: [], currentCardMatches: [], localDecisions: [], currentBankItems: [reviewItem, missingItem], bankRefundGroups: [{ id: 'refund-group', status: 'REFUNDED', originalTransactionIds: ['original'], refundTransactionId: 'refund', grossAmount: 67770, refundAmount: 67770, netAmount: 0 }] })
    expect(report.findings.map((finding) => finding.code)).toEqual(expect.arrayContaining(['REVIEW_WITHOUT_CANDIDATES', 'REFUNDED_BUT_MISSING', 'DUPLICATE_BANK_TRANSACTION_ACROSS_STATEMENTS']))
  })

  it('audita vínculos de provenance sem inferir por contagem de arquivos', () => {
    const bank: BankTransaction = { id: 'active-bank', source: 'BANK', sheetRecordId: null, bankTransactionId: 'active-bank', date: '2026-09-18', description: 'PIX', originalDescription: 'PIX', amount: 100, direction: 'DEBIT', directionKnown: true, type: 'EXPENSE', paymentMethod: '', category: '', month: '', year: '2026', isFixed: null, isEssential: null, installment: null, totalInstallments: null, balanceAfter: null, original: {} }
    const report = auditConsistency({ banks: [bank], sheets: [], statements: [], currentCardMatches: [], localDecisions: [], sourceProvenance: [{ sourceId: 'drive-file', entityIds: ['missing-entity'] }] })
    expect(report.findings.map((finding) => finding.code)).toEqual(expect.arrayContaining(['ACTIVE_ENTITY_WITHOUT_SOURCE', 'SOURCE_POINTS_TO_MISSING_ENTITY']))
    expect(report.findings.find((finding) => finding.code === 'ACTIVE_ENTITY_WITHOUT_SOURCE')?.technical?.entityId).toBe('active-bank')
  })

  it('detecta inconsistências entre a classificação MISSING e as ações disponíveis', () => {
    const missingExpense: ReconciliationItem = { bank: { id: 'missing-expense', source: 'BANK', sheetRecordId: null, bankTransactionId: 'missing-expense', date: '2026-03-02', description: 'Pix Qrcode Din', originalDescription: 'Pix Qrcode Din', amount: 1700, direction: 'DEBIT', directionKnown: true, type: 'EXPENSE', paymentMethod: 'Pix', category: '', month: '', year: '2026', isFixed: null, isEssential: null, installment: null, totalInstallments: null, balanceAfter: null, original: {} }, status: 'MISSING', sheet: null, candidate: null, composition: [], compositionOptions: [], compositionStatus: null }
    const missingCardPayment: ReconciliationItem = { ...missingExpense, bank: { ...missingExpense.bank, id: 'card-payment', originalDescription: 'Gasto c Credito', description: 'Gasto c Credito', amount: 54996, type: 'CARD_PAYMENT' } }
    const report = auditConsistency({ banks: [], sheets: [], statements: [], currentCardMatches: [], localDecisions: [], currentBankItems: [missingExpense, missingCardPayment], missingActionVisibility: { 'missing-expense': false, 'card-payment': false } })
    expect(report.findings.map((finding) => finding.code)).toContain('MISSING_ACTION_INCONSISTENCY')
    expect(report.findings.map((finding) => finding.code)).toContain('CARD_PAYMENT_AS_EXPENSE_MISSING')
  })

  it('detecta MISSING bancário quando há candidato que passa pelo matching plausível', () => {
    const bank: BankTransaction = { id: 'missing-with-candidate', source: 'BANK', sheetRecordId: null, bankTransactionId: 'missing-with-candidate', date: '2026-03-12', description: 'Kindle', originalDescription: 'Kindle', amount: 299, direction: 'DEBIT', directionKnown: true, type: 'EXPENSE', paymentMethod: 'Crédito_Bradesco', category: '', month: '', year: '2026', isFixed: null, isEssential: null, installment: null, totalInstallments: null, balanceAfter: null, original: {} }
    const item = { bank, status: 'MISSING', sheet: null, candidate: null, composition: [], compositionOptions: [], compositionStatus: null } as unknown as ReconciliationItem
    const report = auditConsistency({ banks: [bank], sheets: [kindle], statements: [], currentCardMatches: [], localDecisions: [], currentBankItems: [item] })
    expect(report.findings).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'MISSING_WITH_STRONG_CANDIDATE', severity: 'CRITICAL' })]))
  })

  it('explica no finding a decisão PAIR_REJECTED que removeu a candidata antes da atribuição', () => {
    const bank: BankTransaction = { id: 'bank-rejected', source: 'BANK', sheetRecordId: null, bankTransactionId: 'bank-rejected', date: '2026-03-12', description: 'PIX ENVIADO', originalDescription: 'PIX ENVIADO', amount: 299, direction: 'DEBIT', directionKnown: true, type: 'EXPENSE', paymentMethod: 'Pix', category: '', month: '', year: '2026', isFixed: null, isEssential: null, installment: null, totalInstallments: null, balanceAfter: null, original: {} }
    const pairKey = 'bank-rejected::row-new'
    const decisionKey = 'PAIR_REJECTED:[bank-rejected,kindle-row-1]'
    const result = reconcile([bank], [kindle], { rejectedPairKeys: new Set([pairKey]), rejectedPairDecisionKeys: new Map([[pairKey, decisionKey]]) })
    const report = auditConsistency({ banks: [bank], sheets: [kindle], currentSheets: [kindle], statements: [], currentCardMatches: [], localDecisions: [], currentBankItems: result.items })
    const finding = report.findings.find((item) => item.code === 'MISSING_WITH_STRONG_CANDIDATE')
    expect(result.items[0].status).toBe('MISSING')
    expect(finding).toMatchObject({
      severity: 'CRITICAL', explanationSource: 'MANUAL_DECISION',
      technical: {
        candidateCountRelevant: 1, candidateCountEvaluated: 1,
        pipelineStage: 'DECISION_FILTERING / PAIR_REJECTED',
        decisions: [{ kind: 'PAIR_REJECTED', key: decisionKey }],
        candidateEvaluations: [{ disposition: 'REJECTED_BY_DECISION', decisionKey, reason: expect.stringContaining('decisão persistida') }],
      },
    })
    expect(finding?.detail).toContain('não pôde ser validada com segurança')
  })

  it('classifica MISSING como esperado quando a única candidata foi rejeitada por decisão ativa válida', () => {
    const bank: BankTransaction = { id: 'bank-rejected', source: 'BANK', sheetRecordId: null, bankTransactionId: 'bank-rejected', date: '2026-03-12', description: 'PIX ENVIADO', originalDescription: 'PIX ENVIADO', amount: 299, direction: 'DEBIT', directionKnown: true, type: 'EXPENSE', paymentMethod: 'Pix', category: '', month: '', year: '2026', isFixed: null, isEssential: null, installment: null, totalInstallments: null, balanceAfter: null, original: {} }
    const rejection: PersistedDecision = { key: decisionKey('PAIR_REJECTED', [bankIdentity(bank), sheetIdentity(kindle)]), schemaVersion: 1, kind: 'PAIR_REJECTED', identities: [bankIdentity(bank), sheetIdentity(kindle)], selected: [], updatedAt: '2026-10-09T12:00:00.000Z' }
    const rejectedKey = 'bank-rejected::row-new'
    const result = reconcile([bank], [kindle], { rejectedPairKeys: new Set([rejectedKey]), rejectedPairDecisionKeys: new Map([[rejectedKey, rejection.key]]) })
    const report = auditConsistency({ banks: [bank], sheets: [kindle], statements: [], currentCardMatches: [], localDecisions: [rejection], currentBankItems: result.items })

    expect(result.items[0].status).toBe('MISSING')
    expect(report.findings.find((finding) => finding.code === 'EXPECTED_MANUAL_REJECTION')).toMatchObject({ severity: 'INFO', status: 'EXPECTED', explanationSource: 'MANUAL_DECISION', currentState: 'MISSING', expectedState: 'MISSING' })
    expect(report.expectedStates[bankIdentity(bank)]).toMatchObject({ expectedState: 'MISSING', currentState: 'MISSING' })
    expect(report.expectedStates[bankIdentity(bank)].explanationChain.map((step) => step.stage)).toContain('DECISION')
    expect(report.findings.some((finding) => finding.code === 'MISSING_WITH_STRONG_CANDIDATE')).toBe(false)
    expect(report.summary).toMatchObject({ critical: 0, attention: 0, informational: 1 })
  })

  it('classifica duas rejeições válidas como esperadas e preserva a trilha das duas decisões', () => {
    const bank: BankTransaction = { id: 'bank-two-rejections', source: 'BANK', sheetRecordId: null, bankTransactionId: 'bank-two-rejections', date: '2026-03-12', description: 'PIX ENVIADO', originalDescription: 'PIX ENVIADO', amount: 299, direction: 'DEBIT', directionKnown: true, type: 'EXPENSE', paymentMethod: 'Pix', category: '', month: '', year: '2026', isFixed: null, isEssential: null, installment: null, totalInstallments: null, balanceAfter: null, original: {} }
    const rows = [kindle, { ...kindle, id: 'second-row-id', sheetRecordId: 'second-row', originalDescription: 'Compra Mercado', description: 'Compra Mercado' }]
    const decisions = rows.map((row): PersistedDecision => ({ key: decisionKey('PAIR_REJECTED', [bankIdentity(bank), sheetIdentity(row)]), schemaVersion: 1, kind: 'PAIR_REJECTED', identities: [bankIdentity(bank), sheetIdentity(row)], selected: [], updatedAt: '2026-10-09T12:00:00.000Z' }))
    const keys = rows.map((row) => `${bank.id}::${row.id}`)
    const result = reconcile([bank], rows, { rejectedPairKeys: new Set(keys), rejectedPairDecisionKeys: new Map(keys.map((key, index) => [key, decisions[index].key])) })
    const report = auditConsistency({ banks: [bank], sheets: rows, statements: [], currentCardMatches: [], localDecisions: decisions, currentBankItems: result.items })
    const finding = report.findings.find((entry) => entry.code === 'EXPECTED_MANUAL_REJECTION')

    expect(result.items[0].status).toBe('MISSING')
    expect(finding?.detail).toContain('2 candidata(s)')
    expect(finding?.technical?.decisions).toHaveLength(2)
    expect(report.findings.some((entry) => entry.code === 'MISSING_WITH_STRONG_CANDIDATE')).toBe(false)
  })

  it('mantém o finding crítico se a rejeição foi tombstonada ou não pode ser validada', () => {
    const bank: BankTransaction = { id: 'bank-rejection-invalid', source: 'BANK', sheetRecordId: null, bankTransactionId: 'bank-rejection-invalid', date: '2026-03-12', description: 'PIX ENVIADO', originalDescription: 'PIX ENVIADO', amount: 299, direction: 'DEBIT', directionKnown: true, type: 'EXPENSE', paymentMethod: 'Pix', category: '', month: '', year: '2026', isFixed: null, isEssential: null, installment: null, totalInstallments: null, balanceAfter: null, original: {} }
    const validKey = decisionKey('PAIR_REJECTED', [bankIdentity(bank), sheetIdentity(kindle)])
    const rejection: PersistedDecision = { key: validKey, schemaVersion: 1, kind: 'PAIR_REJECTED', identities: [bankIdentity(bank), sheetIdentity(kindle)], selected: [], updatedAt: '2026-10-09T12:00:00.000Z' }
    const rejectedKey = 'bank-rejection-invalid::row-new'
    const result = reconcile([bank], [kindle], { rejectedPairKeys: new Set([rejectedKey]), rejectedPairDecisionKeys: new Map([[rejectedKey, validKey]]) })
    const tombstoned = auditConsistency({ banks: [bank], sheets: [kindle], statements: [], currentCardMatches: [], localDecisions: [], localTombstones: { [validKey]: { updatedAt: '2026-10-09T12:01:00.000Z', decision: rejection } }, currentBankItems: result.items })
    const invalid = { ...rejection, key: 'PAIR_REJECTED:legacy-or-malformed' }
    const unvalidated = auditConsistency({ banks: [bank], sheets: [kindle], statements: [], currentCardMatches: [], localDecisions: [invalid], currentBankItems: result.items })
    const confirmation: PersistedDecision = { key: decisionKey('PAIR_CONFIRMED', [bankIdentity(bank)]), schemaVersion: 1, kind: 'PAIR_CONFIRMED', identities: [bankIdentity(bank)], selected: [sheetIdentity(kindle)], updatedAt: '2026-10-09T12:02:00.000Z' }
    const conflicting = auditConsistency({ banks: [bank], sheets: [kindle], statements: [], currentCardMatches: [], localDecisions: [rejection, confirmation], currentBankItems: result.items })

    expect(tombstoned.findings.find((entry) => entry.code === 'MISSING_WITH_STRONG_CANDIDATE')).toMatchObject({ severity: 'CRITICAL', explanationSource: 'MANUAL_DECISION' })
    expect(tombstoned.findings.some((entry) => entry.code === 'EXPECTED_MANUAL_REJECTION')).toBe(false)
    expect(unvalidated.findings.find((entry) => entry.code === 'MISSING_WITH_STRONG_CANDIDATE')).toMatchObject({ severity: 'CRITICAL' })
    expect(conflicting.findings.find((entry) => entry.code === 'MISSING_WITH_STRONG_CANDIDATE')).toMatchObject({ severity: 'CRITICAL' })
  })

  it('aponta divergência de fonte quando a candidata da auditoria não aparece na trilha do resultado atual', () => {
    const bank: BankTransaction = { id: 'bank-source-diff', source: 'BANK', sheetRecordId: null, bankTransactionId: 'bank-source-diff', date: '2026-03-12', description: 'PIX ENVIADO', originalDescription: 'PIX ENVIADO', amount: 299, direction: 'DEBIT', directionKnown: true, type: 'EXPENSE', paymentMethod: 'Pix', category: '', month: '', year: '2026', isFixed: null, isEssential: null, installment: null, totalInstallments: null, balanceAfter: null, original: {} }
    const item = { bank, status: 'MISSING', sheet: null, candidate: null, candidatePipeline: [], composition: [], compositionOptions: [], compositionStatus: null } as unknown as ReconciliationItem
    const report = auditConsistency({ banks: [bank], sheets: [kindle], currentSheets: [], statements: [], currentCardMatches: [], localDecisions: [], currentBankItems: [item] })
    const finding = report.findings.find((entry) => entry.code === 'MISSING_WITH_STRONG_CANDIDATE')
    expect(finding).toMatchObject({
      technical: { candidateCountRelevant: 1, candidateCountEvaluated: 0, pipelineStage: 'SOURCE_OR_TRACE_DIVERGENCE', candidateEvaluations: [{ disposition: 'NOT_IN_CURRENT_MATCHING_PIPELINE', reason: expect.stringContaining('não na cópia') }] },
    })
  })

  it('detecta confirmação manual que ainda deriva para REVIEW', () => {
    const identity = cardTransactionIdentityVariants(statement, statement.transactions[0])[0]
    const confirmed: PersistedDecision = { ...oldMissing, kind: 'STATEMENT_MATCH_CONFIRMED', identities: [identity], key: `STATEMENT_MATCH_CONFIRMED:${JSON.stringify([identity])}`, selected: [sheetIdentity(kindle)] }
    const report = auditConsistency({ banks: [], sheets: [kindle], statements: [{ statement }], currentCardMatches: [{ statementIdentity: statement.statementIdentity, transactionId: 'kindle-purchase', match: { ...missingMatch(), status: 'CARD_REVIEW', candidates: [kindle] } }], localDecisions: [confirmed] })
    expect(report.findings.map((finding) => finding.code)).toContain('VALID_MANUAL_MATCH_NOT_APPLIED')
  })

  it('explica quando o único candidato do matcher puro está reservado por decisão manual válida de outra compra', () => {
    const reservedRow = { ...kindle, id: 'reserved-row', sheetRecordId: '2e4013ed', date: '2026-06-12', originalDescription: 'Mensalidade Selfit', description: 'Mensalidade Selfit', amount: 12990 }
    const mayPurchase: CardStatementTransaction = { ...statement.transactions[0], id: 'selfit-may', purchaseDate: '2026-05-08', date: '2026-05-08', originalDescription: 'Mensalidade Selfit', description: 'Mensalidade Selfit', amount: 12990, statementDueDate: '2026-06-12', invoiceDueDate: '2026-06-12' }
    const junePurchase: CardStatementTransaction = { ...mayPurchase, id: 'selfit-june', purchaseDate: '2026-06-08', date: '2026-06-08', statementDueDate: '2026-07-12', invoiceDueDate: '2026-07-12' }
    const mayStatement = { ...statement, statementIdentity: 'selfit-may-statement', dueDate: '2026-06-12', transactions: [mayPurchase] }
    const juneStatement = { ...statement, statementIdentity: 'selfit-june-statement', dueDate: '2026-07-12', transactions: [junePurchase] }
    const ownerIdentity = cardTransactionIdentity(juneStatement, junePurchase)
    const confirmed: PersistedDecision = { ...oldMissing, kind: 'STATEMENT_MATCH_CONFIRMED', key: `STATEMENT_MATCH_CONFIRMED:${JSON.stringify([ownerIdentity])}`, identities: [ownerIdentity], selected: [sheetIdentity(reservedRow)] }
    const report = auditConsistency({ banks: [], sheets: [reservedRow], statements: [{ statement: mayStatement }, { statement: juneStatement }], currentCardMatches: [
      { statementIdentity: mayStatement.statementIdentity, transactionId: mayPurchase.id, match: { transaction: mayPurchase, status: 'CARD_MISSING', sheet: null, candidates: [] } },
      { statementIdentity: juneStatement.statementIdentity, transactionId: junePurchase.id, match: { transaction: junePurchase, status: 'CARD_MATCHED', sheet: reservedRow, candidates: [reservedRow] } },
    ], localDecisions: [confirmed] })
    const mayItem = report.items.find((item) => item.transaction.id === mayPurchase.id)!
    const reservation = report.findings.find((finding) => finding.code === 'EXPECTED_MANUAL_RESERVATION' && finding.item?.transaction.id === mayPurchase.id)

    expect(mayItem.pure).toMatchObject({ status: 'CARD_MATCHED', sheet: reservedRow })
    expect(mayItem.current?.status).toBe('CARD_MISSING')
    expect(mayItem.diagnosis).toContain('Selfit')
    expect(reservation).toMatchObject({ severity: 'INFO', status: 'EXPECTED', explanationSource: 'ASSIGNMENT', currentState: 'CARD_MISSING', expectedState: 'CARD_MISSING', pureState: 'CARD_MATCHED' })
    expect(reservation?.technical).toMatchObject({ reservationIsExpected: true, reservations: [{ row: { id: '2e4013ed' }, owner: { description: 'Mensalidade Selfit', purchaseDate: '2026-06-08' }, decision: { kind: 'STATEMENT_MATCH_CONFIRMED' } }] })
    expect(report.findings.some((finding) => finding.code === 'MISSING_COM_CANDIDATO' && finding.item?.transaction.id === mayPurchase.id)).toBe(false)
    expect(report.findings.some((finding) => finding.code === 'DERIVED_STATE_MISMATCH' && finding.item?.transaction.id === mayPurchase.id)).toBe(false)
    expect(report.findings.some((finding) => finding.code === 'VALID_MANUAL_MATCH_NOT_APPLIED' && finding.item?.transaction.id === junePurchase.id)).toBe(false)
  })

  it('detecta confirmação válida cujo estado final aponta para outra linha', () => {
    const identity = cardTransactionIdentityVariants(statement, statement.transactions[0])[0]
    const confirmed: PersistedDecision = { ...oldMissing, kind: 'STATEMENT_MATCH_CONFIRMED', identities: [identity], key: `STATEMENT_MATCH_CONFIRMED:${JSON.stringify([identity])}`, selected: [sheetIdentity(kindle)] }
    const otherRow = { ...kindle, id: 'kindle-other-cycle', sheetRecordId: 'kindle-other-cycle', date: '2026-02-02' }
    const report = auditConsistency({ banks: [], sheets: [kindle, otherRow], statements: [{ statement }], currentCardMatches: [{ statementIdentity: statement.statementIdentity, transactionId: 'kindle-purchase', match: { ...missingMatch(), status: 'CARD_MATCHED', sheet: otherRow, candidates: [otherRow] } }], localDecisions: [confirmed] })
    expect(report.findings.find((finding) => finding.code === 'VALID_MANUAL_MATCH_NOT_APPLIED')?.technical).toMatchObject({ validity: 'VALID_GLOBALLY', selected: sheetIdentity(kindle), currentSheetRecordId: 'kindle-other-cycle' })
  })

  it('não trata confirmação manual válida como divergência derivada e mantém revisões de grupo informativas', () => {
    const identity = cardTransactionIdentityVariants(statement, statement.transactions[0])[0]
    const confirmed: PersistedDecision = { ...oldMissing, kind: 'STATEMENT_MATCH_CONFIRMED', identities: [identity], key: `STATEMENT_MATCH_CONFIRMED:${JSON.stringify([identity])}`, selected: [sheetIdentity(kindle)] }
    const secondRow = { ...kindle, id: 'kindle-row-2', sheetRecordId: 'kindle-row-2', originalDescription: 'Kindle assinatura', description: 'Kindle assinatura' }
    const report = auditConsistency({ banks: [], sheets: [kindle, secondRow], statements: [{ statement }], currentCardMatches: [{ statementIdentity: statement.statementIdentity, transactionId: 'kindle-purchase', match: { ...missingMatch(), status: 'CARD_MATCHED', sheet: kindle, candidates: [kindle, secondRow] } }], localDecisions: [confirmed] })
    expect(report.items[0].pure.status).toBe('CARD_REVIEW')
    expect(report.items[0].current?.status).toBe('CARD_MATCHED')
    expect(report.findings.some((finding) => finding.code === 'DERIVED_STATE_MISMATCH')).toBe(false)
    expect(report.findings.find((finding) => finding.code === 'EXPECTED_OVERRIDE')).toMatchObject({ severity: 'INFO', explanationSource: 'MANUAL_DECISION', currentState: 'CARD_MATCHED', expectedState: 'CARD_MATCHED' })
    expect(report.findings.some((finding) => finding.code === 'VALID_MANUAL_MATCH_NOT_APPLIED')).toBe(false)
    expect(report.summary.attention).toBe(0)
  })

  it('mantém conflito bancário em revisão só com candidata e identifica a reserva; sem candidata aponta o vazio', () => {
    const bank: BankTransaction = { id: 'bank-conflict', source: 'BANK', sheetRecordId: null, bankTransactionId: 'bank-conflict', date: '2026-03-02', description: 'PIX ENVIADO', originalDescription: 'PIX ENVIADO', amount: 1200, direction: 'DEBIT', directionKnown: true, type: 'EXPENSE', paymentMethod: 'Pix', category: '', month: '', year: '2026', isFixed: null, isEssential: null, installment: null, totalInstallments: null, balanceAfter: null, original: {} }
    const conflictItem = { bank, status: 'REVIEW', sheet: { ...kindle, id: 'conflict-row' }, candidate: { bankId: bank.id, sheetId: 'conflict-row', score: 90, confidence: 90, reasons: [], dateDistance: 0, descriptionSimilarity: 0.8 }, composition: [], compositionOptions: [], compositionStatus: null, reviewReason: 'ASSIGNMENT_CONFLICT', assignmentConflictOwnerBankId: 'other-bank' } as unknown as ReconciliationItem
    const emptyConflict = { ...conflictItem, sheet: null, candidate: null }
    const report = auditConsistency({ banks: [bank], sheets: [kindle], statements: [], currentCardMatches: [], localDecisions: [], currentBankItems: [conflictItem, emptyConflict] })
    const concrete = report.findings.find((finding) => finding.code === 'ASSIGNMENT_CONFLICT')
    expect(concrete).toMatchObject({ severity: 'REVIEW', technical: { candidateCount: 1, assignmentOwnerBankId: 'other-bank' } })
    expect(report.findings.some((finding) => finding.code === 'REVIEW_WITHOUT_CANDIDATES' && finding.technical?.bank === bank)).toBe(true)
  })

  it('sinaliza double claim quando uma confirmação manual ativa ainda compartilha a linha', () => {
    const identity = cardTransactionIdentityVariants(statement, statement.transactions[0])[0]
    const confirmed: PersistedDecision = { ...oldMissing, kind: 'STATEMENT_MATCH_CONFIRMED', identities: [identity], key: `STATEMENT_MATCH_CONFIRMED:${JSON.stringify([identity])}`, selected: [sheetIdentity(kindle)] }
    const otherTransaction = { ...statement.transactions[0], id: 'other-purchase', originalDescription: 'Outra compra', description: 'Outra compra' }
    const otherStatement = { ...statement, statementIdentity: 'other-invoice', transactions: [otherTransaction] }
    const report = auditConsistency({ banks: [], sheets: [kindle], statements: [{ statement }, { statement: otherStatement }], currentCardMatches: [
      { statementIdentity: statement.statementIdentity, transactionId: 'kindle-purchase', match: { ...missingMatch(), status: 'CARD_MATCHED', sheet: kindle } },
      { statementIdentity: otherStatement.statementIdentity, transactionId: 'other-purchase', match: { ...missingMatch(), transaction: otherTransaction, status: 'CARD_MATCHED', sheet: kindle } },
    ], localDecisions: [confirmed] })
    const root = report.findings.find((finding) => finding.rootCauseCode === 'SHEET_ROW_MULTIPLE_OWNERS')
    expect(root?.code).toBe('RESERVED_SHEET_ROW_REUSED')
    expect(report.findings.flatMap((finding) => finding.relatedFindings ?? []).map((item) => item.code)).toContain('DOUBLE_CLAIM_AFTER_CONFIRMATION')
  })

  it('detecta owners manuais incompatíveis na auditoria rápida e invalida a validade global das duas decisões', () => {
    const firstTx = statement.transactions[0]
    const secondTx = { ...firstTx, id: 'kindle-purchase-july' }
    const secondStatement = { ...statement, statementIdentity: 'statement-july', transactions: [secondTx] }
    const makeDecision = (invoice: CardStatement, transaction: CardStatementTransaction): PersistedDecision => {
      const identity = cardTransactionIdentity(invoice, transaction)
      return { ...oldMissing, kind: 'STATEMENT_MATCH_CONFIRMED', identities: [identity], key: `STATEMENT_MATCH_CONFIRMED:${JSON.stringify([identity])}`, selected: [sheetIdentity(kindle)] }
    }
    const decisions = [makeDecision(statement, firstTx), makeDecision(secondStatement, secondTx)]
    const report = auditConsistency({ mode: 'RAPIDA', banks: [], sheets: [kindle], statements: [{ statement }, { statement: secondStatement }], currentCardMatches: [], localDecisions: decisions })
    const conflict = report.findings.find((finding) => finding.code === 'MULTIPLE_INCOMPATIBLE_ACTIVE_DECISIONS')
    expect(conflict).toMatchObject({ severity: 'CRITICAL', category: 'DECISION', technical: { validity: 'CONFLICTING_ACTIVE_DECISION', relatedInvariantViolations: expect.arrayContaining(['INV-11']) } })
    expect((conflict?.technical?.assignments as unknown[])).toHaveLength(2)
    expect(report.findings.some((finding) => finding.code === 'EXPECTED_OVERRIDE')).toBe(false)
    expect(report.decisionAudit.every((decision) => decision.status === 'CONFLICTING' && decision.structurallyValid && decision.validity === 'CONFLICTING_ACTIVE_DECISION')).toBe(true)
  })

  it('na auditoria profunda reúne symptoms do conflito manual e informa a etapa de reserva que levou a MISSING', () => {
    const firstTx = statement.transactions[0]
    const secondTx = { ...firstTx, id: 'kindle-purchase-july' }
    const secondStatement = { ...statement, statementIdentity: 'statement-july', transactions: [secondTx] }
    const makeDecision = (invoice: CardStatement, transaction: CardStatementTransaction): PersistedDecision => {
      const identity = cardTransactionIdentity(invoice, transaction)
      return { ...oldMissing, kind: 'STATEMENT_MATCH_CONFIRMED', identities: [identity], key: `STATEMENT_MATCH_CONFIRMED:${JSON.stringify([identity])}`, selected: [sheetIdentity(kindle)] }
    }
    const decisions = [makeDecision(statement, firstTx), makeDecision(secondStatement, secondTx)]
    const report = auditConsistency({ banks: [], sheets: [kindle], statements: [{ statement }, { statement: secondStatement }], currentCardMatches: [
      { statementIdentity: statement.statementIdentity, transactionId: firstTx.id, match: { transaction: firstTx, status: 'CARD_MISSING', sheet: null, candidates: [kindle] } },
      { statementIdentity: secondStatement.statementIdentity, transactionId: secondTx.id, match: { transaction: secondTx, status: 'CARD_MATCHED', sheet: kindle, candidates: [kindle] } },
    ], localDecisions: decisions })
    const root = report.findings.find((finding) => finding.code === 'MULTIPLE_INCOMPATIBLE_ACTIVE_DECISIONS')
    expect(root).toBeDefined()
    expect(report.findings.some((finding) => finding.code === 'VALID_MANUAL_MATCH_NOT_APPLIED')).toBe(false)
    expect(report.findings.some((finding) => finding.code === 'MISSING_COM_CANDIDATO')).toBe(false)
    expect(report.items.find((item) => item.transaction.id === firstTx.id)?.diagnosis).toContain('reserva')
    expect(report.items.find((item) => item.transaction.id === firstTx.id)?.decisions.every((decision) => decision.validity === 'CONFLICTING_ACTIVE_DECISION')).toBe(true)
    expect(report.items.find((item) => item.transaction.id === firstTx.id)?.decisions.every((decision) => decision.structurallyValid)).toBe(true)
  })

  it('detecta reutilização automática de uma linha reservada por uma confirmação manual', () => {
    const manualTx = statement.transactions[0]
    const automaticTx = { ...manualTx, id: 'automatic-purchase', originalDescription: 'Kindle assinatura', description: 'Kindle assinatura' }
    const automaticStatement = { ...statement, statementIdentity: 'statement-auto', transactions: [automaticTx] }
    const identity = cardTransactionIdentity(statement, manualTx)
    const decision: PersistedDecision = { ...oldMissing, kind: 'STATEMENT_MATCH_CONFIRMED', identities: [identity], key: `STATEMENT_MATCH_CONFIRMED:${JSON.stringify([identity])}`, selected: [sheetIdentity(kindle)] }
    const report = auditConsistency({ banks: [], sheets: [kindle], statements: [{ statement }, { statement: automaticStatement }], currentCardMatches: [
      { statementIdentity: automaticStatement.statementIdentity, transactionId: automaticTx.id, match: { transaction: automaticTx, status: 'CARD_MATCHED', sheet: kindle, candidates: [kindle] } },
    ], localDecisions: [decision] })
    expect(report.findings).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'RESERVED_SHEET_ROW_REUSED', severity: 'CRITICAL', technical: expect.objectContaining({ validity: 'RESERVED_TARGET_CONFLICT' }) })]))
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
    expect(report.findings).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'SOURCE_CONFLICT', severity: 'REVIEW', title: 'Os extratos divergem sobre a mesma movimentação' })]))
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
    const derived = report.findings.find((item) => item.code === 'EXPECTED_GROUP_RESOLUTION')
    expect(derived).toMatchObject({ severity: 'INFO', explanationSource: 'GROUP_MATCHING', technical: { pipeline: { base: 'CARD_REVIEW', later: 'GROUP_MATCHING / multiplicidade', final: 'CARD_GROUP_MATCHED' } } })
    expect(report.findings.filter((item) => item.code === 'DOUBLE_CLAIM')).toHaveLength(0)
    expect(report.summary.attention).toBe(0)
  })

  it('distinguishes a candidate present only in the session cache from the fresh sheet read', () => {
    const report = auditConsistency({ banks: [], sheets: [], currentSheets: [kindle], statements: [{ statement }], currentCardMatches: [{ statementIdentity: statement.statementIdentity, transactionId: 'kindle-purchase', match: missingMatch() }], localDecisions: [] })
    expect(report.items[0].evaluatedCandidates).toContainEqual({ row: kindle, source: 'CACHE DA SESSÃO', accepted: true, reason: null })
    expect(report.items[0].diagnosis).toContain('cache local')
    expect(report.findings.some((finding) => finding.code === 'CURRENT_SOURCE_DIVERGENCE')).toBe(true)
  })

  it('reclassifies source divergence when displayed and audited source revisions differ', () => {
    const snapshot = createAuditInputSnapshot({ banks: [], sheets: [kindle], statements: [statement], decisions: [], mixedRevisionSources: ['derived-source-result'] })
    const base = auditConsistency({ banks: [], sheets: [], statements: [], currentCardMatches: [], localDecisions: [] })
    const sourceFinding = { id: 'source-diff', code: 'CURRENT_SOURCE_DIVERGENCE', severity: 'CRITICAL', category: 'SOURCE', invariantId: 'INV-08', title: 'Source diff', detail: 'Diff', diagnosis: 'Diff', whyItMatters: 'Diff', recommendedAction: 'Review', diagnosticConfidence: 'HIGH', safeAutomaticAction: false, status: 'ACTIVE', explanationSource: 'SOURCE_LIFECYCLE' } as unknown as AuditFinding
    const report = { ...base, findings: [sourceFinding] }
    const finalized = finalizeAuditInputSnapshot(report, snapshot)
    expect(finalized.findings.find((finding) => finding.code === 'CURRENT_SOURCE_DIVERGENCE')?.severity).toBe('REVIEW')
    expect(finalized.findings.map((finding) => finding.code)).toContain('AUDIT_INPUT_REVISION_MISMATCH')
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

  it('separa auditoria rápida sem recomputação e auditoria profunda read-only', () => {
    const input = { banks: [], sheets: [kindle], statements: [{ statement }], currentCardMatches: [{ statementIdentity: statement.statementIdentity, transactionId: 'kindle-purchase', match: missingMatch() }], localDecisions: [] }
    const quick = auditConsistency({ ...input, mode: 'RAPIDA' })
    const deep = auditConsistency({ ...input, mode: 'PROFUNDA' })
    expect(quick).toMatchObject({ mode: 'RAPIDA', recomputation: { performed: false, readOnly: true, persistedDecisionsApplied: false }, items: [], pureStates: {} })
    expect(quick.summary.evaluatedPurchases).toBe(1)
    expect(deep).toMatchObject({ mode: 'PROFUNDA', recomputation: { performed: true, readOnly: true, persistedDecisionsApplied: false } })
    expect(deep.items).toHaveLength(1)
    expect(deep.findings.every((finding) => finding.code && finding.category && finding.invariantId && finding.diagnosis && finding.recommendedAction && finding.diagnosticConfidence && typeof finding.safeAutomaticAction === 'boolean')).toBe(true)
  })

  it('audita totais da fatura, subtotais de cartões e matemática de estorno sem alterar dados', () => {
    const source = { ...statement, reportedTotal: 1000, accountingDifference: 3, cardSubtotals: [{ cardIdentifier: '1234', amount: 990 }], refundGroups: [{ id: 'refund-1', cardIdentifier: '1234', date: '2026-06-01', merchant: 'Loja sintética', transactionIds: ['purchase-1'], refundTransactionId: 'refund-1', purchaseGroupAmount: 500, refundAmount: 499, netAmount: 2, installmentCount: 1 }] }
    const before = JSON.stringify(source)
    const report = auditConsistency({ banks: [], sheets: [], statements: [{ statement: source }], currentCardMatches: [], localDecisions: [], mode: 'RAPIDA' })
    expect(report.findings.map((finding) => finding.code)).toEqual(expect.arrayContaining(['INVOICE_TOTAL_MISMATCH', 'CARD_SUBTOTAL_MISMATCH', 'REFUND_NET_MISMATCH']))
    expect(JSON.stringify(source)).toBe(before)
    expect(report.recomputation).toMatchObject({ performed: false, readOnly: true, persistedDecisionsApplied: false })
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
    const findings = (['CRITICAL', 'REVIEW', 'INFO', 'INFO', 'INFO'] as const).map((severity, index) => ({ id: `finding-${index}`, code: 'AUDITOR_INTERNAL_INCONSISTENCY', severity, status: index === 2 ? 'MAINTENANCE' : index === 3 ? 'LEGACY' : 'ACTIVE', title: severity, detail: severity })) as AuditFinding[]
    expect(filterAuditFindings(findings, 'ALL')).toHaveLength(5)
    expect(filterAuditFindings(findings, 'CRITICAL').map((item) => item.severity)).toEqual(['CRITICAL'])
    expect(filterAuditFindings(findings, 'REVIEW').map((item) => item.severity)).toEqual(['REVIEW'])
    expect(filterAuditFindings(findings, 'LEGACY').map((item) => item.status)).toEqual(['MAINTENANCE', 'LEGACY'])
  })
})
