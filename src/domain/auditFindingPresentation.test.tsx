import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it } from 'vitest'
import type { AuditFinding } from './consistencyAudit'
import { describeAuditFinding } from './auditFindingPresentation'
import { auditFindingFingerprint, dismissAuditFinding, isAuditFindingDismissed, loadAuditFindingVisibility, restoreAuditFinding, saveAuditFindingVisibility } from './auditFindingVisibility'
import { AuditFindingCard } from '../components/AuditFindingCard'

const makeFinding = (overrides: Partial<AuditFinding> = {}): AuditFinding => ({
  id: 'finding-a', code: 'DERIVED_STATE_MISMATCH', severity: 'INFO', title: 'technical title', detail: 'technical detail',
  technical: { pipeline: { base: 'CARD_REVIEW', later: 'GROUP_MATCHING', final: 'CARD_GROUP_MATCHED' }, auditedAt: '2026-01-01T00:00:00Z' },
  ...overrides,
})

describe('audit finding presentation and visibility', () => {
  beforeEach(() => localStorage.clear())

  it('uses human language for every known finding code', () => {
    const codes: AuditFinding['code'][] = ['MISSING_COM_CANDIDATO', 'CARD_MISSING_NO_CANDIDATE', 'DERIVED_STATE_MISMATCH', 'PREWRITE_MATCH_MISMATCH', 'STALE_MISSING_DECISION', 'ORPHANED_SHEET_REFERENCE', 'EDITED_SHEET_REFERENCE', 'MISSING_ADDED_TO_SHEET_ORPHAN', 'DOUBLE_CLAIM', 'UNUSED_STRONG_CANDIDATE', 'LEGACY_FINGERPRINT_MATCH', 'LOCAL_REMOTE_DECISION_DIVERGENCE', 'NEWER_TOMBSTONE_EXISTS', 'WRONG_DECISION_DOMAIN', 'REVIEW_ONLY_WRONG_CYCLE_CANDIDATES', 'IGNORED_DECISION_REVIEW', 'CURRENT_SOURCE_DIVERGENCE', 'REJECTED_CANDIDATE_FILTERED', 'DECISION_STATUS', 'SYNC_PENDING', 'REVIEW_WITHOUT_CANDIDATES', 'REFUNDED_BUT_MISSING', 'DUPLICATE_BANK_TRANSACTION_ACROSS_STATEMENTS']
    for (const code of codes) {
      const description = describeAuditFinding(makeFinding({ code }))
      expect(description.title).toBeTruthy()
      expect(description.explanation).toBeTruthy()
      expect(description.title).not.toBe(code)
      expect(description.severityLabel).toBe('Informativo')
    }
  })

  it('explains a successful group match without recommending action', () => {
    const description = describeAuditFinding(makeFinding())
    expect(description.title).toBe('As compras foram conciliadas corretamente em grupo')
    expect(description.impact).toContain('Não há divergência financeira')
    expect(description.recommendedAction).toContain('Nenhuma ação necessária')
  })

  it('keeps recommendations conservative for double claims and possible duplicates', () => {
    const ambiguous = describeAuditFinding(makeFinding({ code: 'DOUBLE_CLAIM', severity: 'CRITICAL', technical: { subjects: [{ description: 'Compra A' }, { description: 'Compra B' }] } }))
    expect(ambiguous.recommendedAction).toContain('Revisar manualmente')
    expect(ambiguous.recommendedAction).not.toContain('Descartar')
    const risky = describeAuditFinding(makeFinding({ code: 'CARD_MISSING_NO_CANDIDATE', severity: 'CRITICAL' }))
    expect(risky.recommendedAction).toContain('Não adicione')
  })

  it('persists hidden preferences across reload and restores just that finding', () => {
    const finding = makeFinding()
    const saved = dismissAuditFinding(finding, {}, '2026-10-06T12:00:00.000Z')
    saveAuditFindingVisibility(saved)
    const restoredFromStorage = loadAuditFindingVisibility()
    expect(isAuditFindingDismissed(finding, restoredFromStorage)).toBe(true)
    expect(isAuditFindingDismissed(makeFinding({ technical: { pipeline: { base: 'CARD_REVIEW', later: 'GROUP_MATCHING', final: 'CARD_GROUP_MATCHED' }, auditedAt: '2027-01-01T00:00:00Z' } }), restoredFromStorage)).toBe(true)
    const next = restoreAuditFinding(finding, restoredFromStorage)
    saveAuditFindingVisibility(next)
    expect(isAuditFindingDismissed(finding, loadAuditFindingVisibility())).toBe(false)
  })

  it('reactivates when evidence changes or severity increases without mutating the saved preference', () => {
    const finding = makeFinding()
    const hidden = dismissAuditFinding(finding, {}, '2026-10-06T12:00:00.000Z')
    expect(isAuditFindingDismissed(makeFinding({ severity: 'CRITICAL' }), hidden)).toBe(false)
    expect(isAuditFindingDismissed(makeFinding({ technical: { pipeline: { base: 'CARD_MISSING', later: 'GROUP_MATCHING', final: 'CARD_GROUP_MATCHED' } } }), hidden)).toBe(false)
    expect(Object.keys(hidden)).toHaveLength(1)
  })

  it('does not depend on audit timestamps or finding-list order for identity', () => {
    expect(auditFindingFingerprint(makeFinding())).toBe(auditFindingFingerprint(makeFinding({ technical: { pipeline: { final: 'CARD_GROUP_MATCHED', later: 'GROUP_MATCHING', base: 'CARD_REVIEW' }, auditedAt: '2030-01-01' } })))
  })

  it('shows a human title while retaining the full technical finding in Details técnicos', () => {
    const finding = makeFinding()
    render(<AuditFindingCard finding={finding} visibility={{}} hiddenView={false} onDismiss={() => {}} onRestore={() => {}} onDiscardObsolete={() => {}} onViewPurchase={() => {}} onUseCandidate={() => {}} onInvalidateDecision={() => {}} onReanalyze={() => {}} />)
    expect(screen.getByRole('heading', { name: 'As compras foram conciliadas corretamente em grupo' })).toBeInTheDocument()
    expect(screen.queryByText('DERIVED_STATE_MISMATCH')).not.toBeInTheDocument()
    fireEvent.click(screen.getByText('Detalhes técnicos'))
    expect(screen.getByText(/DERIVED_STATE_MISMATCH/)).toBeInTheDocument()
    expect(screen.getByText(/CARD_REVIEW/)).toBeInTheDocument()
  })
})
