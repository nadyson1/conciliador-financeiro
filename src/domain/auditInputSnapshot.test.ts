import { describe, expect, it } from 'vitest'
import { auditConsistency, finalizeAuditInputSnapshot } from './consistencyAudit'
import { cloneAuditInput, compareAuditInputSnapshots, createAuditInputSnapshot } from './auditInputSnapshot'
import type { BankTransaction, LedgerTransaction } from './types'
import type { PersistedDecision } from './localDecisions'

const bank: BankTransaction = { id: 'bank-1', source: 'BANK', sheetRecordId: null, bankTransactionId: 'bank-1', date: '2026-09-18', description: 'PIX', originalDescription: 'PIX', amount: 67770, direction: 'DEBIT', directionKnown: true, type: 'EXPENSE', paymentMethod: 'Pix', category: '', month: '', year: '2026', isFixed: null, isEssential: null, installment: null, totalInstallments: null, balanceAfter: null, original: {} }
const row: LedgerTransaction = { id: 'row-1', source: 'SHEET', sheetRecordId: 'sheet-1', bankTransactionId: null, date: '2026-09-18', description: 'PIX', originalDescription: 'PIX', amount: 67770, direction: 'DEBIT', type: 'EXPENSE', paymentMethod: 'Pix', category: 'Outros', month: '09 - Setembro', year: '2026', isFixed: false, isEssential: false, installment: null, totalInstallments: null, balanceAfter: null, original: {} }
const decision: PersistedDecision = { key: 'PAIR_CONFIRMED:[bank-1]', schemaVersion: 1, kind: 'PAIR_CONFIRMED', identities: ['bank-1'], selected: ['sheet-1'], updatedAt: '2026-10-11T10:00:00.000Z' }
const capture = (overrides: Partial<Parameters<typeof createAuditInputSnapshot>[0]> = {}) => createAuditInputSnapshot({ banks: [bank], statements: [], sheets: [row], decisions: [decision], capturedAt: '2026-10-11T10:00:00.000Z', ...overrides })

describe('audit input snapshot', () => {
  it('marks the run stale when a decision changes after the captured revision', () => {
    const snapshot = capture()
    const changed = { ...decision, updatedAt: '2026-10-11T10:01:00.000Z' }
    const current = capture({ decisions: [changed] })
    const final = compareAuditInputSnapshots(snapshot, current)
    expect(snapshot.revisions.decisionRevision).not.toBe(current.revisions.decisionRevision)
    expect(final.state).toBe('STALE')
    expect(final.staleSources).toContain('decisionRevision')
  })

  it('detects CUSTOS ANO changes while preserving a frozen input copy', () => {
    const originalRows = [row]
    const frozenRows = cloneAuditInput(originalRows)
    const snapshot = capture({ sheets: frozenRows })
    originalRows[0] = { ...row, amount: 90000 }
    const current = capture({ sheets: originalRows })
    expect(frozenRows[0].amount).toBe(67770)
    expect(compareAuditInputSnapshots(snapshot, current).staleSources).toContain('custosAnoRevision')
  })

  it('produces stable revisions regardless of array order or object identity', () => {
    const secondBank = { ...bank, id: 'bank-2', bankTransactionId: 'bank-2', amount: 400 }
    const secondRow = { ...row, id: 'row-2', sheetRecordId: 'sheet-2', amount: 400 }
    const first = capture({ banks: [bank, secondBank], sheets: [row, secondRow] })
    const second = capture({ banks: [{ ...secondBank }, { ...bank }], sheets: [{ ...secondRow }, { ...row }] })
    expect(second.revisions).toEqual(first.revisions)
    expect(compareAuditInputSnapshots(first, second).state).toBe('COMPLETE')
  })

  it('marks unavailable sources PARTIAL and available comparable sources COMPLETE', () => {
    expect(capture({ unavailableSources: ['google-current-ledger'] }).state).toBe('PARTIAL')
    expect(capture().state).toBe('COMPLETE')
  })

  it('reports mixed derived revisions before treating state symptoms as critical', () => {
    const snapshot = capture({ mixedRevisionSources: ['derived-decision-result'] })
    const report = auditConsistency({ banks: [], sheets: [], statements: [], currentCardMatches: [], localDecisions: [], currentDecisionRevision: 'revision-11', derivedDecisionRevision: 'revision-10', auditInputSnapshot: snapshot })
    const finalized = finalizeAuditInputSnapshot(report, snapshot)
    expect(finalized.findings.map((finding) => finding.code)).toContain('AUDIT_INPUT_REVISION_MISMATCH')
    expect(finalized.findings.find((finding) => finding.code === 'STALE_DECISION_RESULT')?.severity).toBe('REVIEW')
    expect(finalized.auditInputSnapshot?.state).toBe('MIXED_REVISION')
  })


  it('runs the same audit snapshot deterministically apart from auditedAt', () => {
    const snapshot = capture()
    const input = { banks: [bank], sheets: [row], statements: [], currentCardMatches: [], localDecisions: [decision], auditInputSnapshot: snapshot }
    const first = auditConsistency(input), second = auditConsistency(input)
    const projection = (result: typeof first) => result.findings.map(({ code, id, severity, status, technical }) => ({ code, id, severity, status, technical }))
    expect(projection(second)).toEqual(projection(first))
  })
})
