import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it } from 'vitest'
import type { AuditFinding } from './consistencyAudit'
import { describeAuditFinding } from './auditFindingPresentation'
import { auditFindingFingerprint, auditHideKey, dismissAuditFinding, isAuditFindingDismissed, loadAuditFindingVisibility, restoreAuditFinding, saveAuditFindingVisibility } from './auditFindingVisibility'
import { AuditFindingCard } from '../components/AuditFindingCard'

const makeFinding = (overrides: Partial<AuditFinding> = {}): AuditFinding => ({
  id: 'finding-a', code: 'DERIVED_STATE_MISMATCH', severity: 'INFO', title: 'technical title', detail: 'technical detail',
  category: 'STATE', invariantId: 'INV-08', diagnosis: 'diagnosis', whyItMatters: 'impact', recommendedAction: 'action', diagnosticConfidence: 'HIGH', safeAutomaticAction: false, status: 'ACTIVE', explanationSource: 'NONE',
  technical: { pipeline: { base: 'CARD_REVIEW', later: 'GROUP_MATCHING', final: 'CARD_GROUP_MATCHED' }, auditedAt: '2026-01-01T00:00:00Z' },
  ...overrides,
})

describe('audit finding presentation and visibility', () => {
  beforeEach(() => localStorage.clear())

  it('uses human language for every known finding code', () => {
    const codes: AuditFinding['code'][] = ['MISSING_COM_CANDIDATO', 'MISSING_WITH_STRONG_CANDIDATE', 'CARD_MISSING_NO_CANDIDATE', 'DERIVED_STATE_MISMATCH', 'EXPECTED_OVERRIDE', 'EXPECTED_GROUP_RESOLUTION', 'EXPECTED_MANUAL_RESERVATION', 'PREWRITE_MATCH_MISMATCH', 'STALE_MISSING_DECISION', 'ORPHANED_SHEET_REFERENCE', 'EDITED_SHEET_REFERENCE', 'MISSING_ADDED_TO_SHEET_ORPHAN', 'DOUBLE_CLAIM', 'UNUSED_STRONG_CANDIDATE', 'LEGACY_FINGERPRINT_MATCH', 'LOCAL_REMOTE_DECISION_DIVERGENCE', 'NEWER_TOMBSTONE_EXISTS', 'WRONG_DECISION_DOMAIN', 'REVIEW_ONLY_WRONG_CYCLE_CANDIDATES', 'IGNORED_DECISION_REVIEW', 'CURRENT_SOURCE_DIVERGENCE', 'REJECTED_CANDIDATE_FILTERED', 'DECISION_STATUS', 'SYNC_PENDING', 'REVIEW_WITHOUT_CANDIDATES', 'ASSIGNMENT_CONFLICT', 'REFUNDED_BUT_MISSING', 'DUPLICATE_BANK_TRANSACTION_ACROSS_STATEMENTS', 'INVOICE_TOTAL_MISMATCH', 'CARD_SUBTOTAL_MISMATCH', 'REFUND_NET_MISMATCH', 'RESOLVED_SOURCE_OVERLAP', 'MATCHED_WITHOUT_LINK', 'ACTIVE_ENTITY_WITHOUT_SOURCE', 'SOURCE_POINTS_TO_MISSING_ENTITY', 'SOURCE_CONFLICT']
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

  it('reativa quando a evidência semântica muda, mas mantém ocultação se só a severidade variar', () => {
    const finding = makeFinding()
    const hidden = dismissAuditFinding(finding, {}, '2026-10-06T12:00:00.000Z')
    expect(isAuditFindingDismissed(makeFinding({ severity: 'CRITICAL' }), hidden)).toBe(true)
    expect(isAuditFindingDismissed(makeFinding({ technical: { pipeline: { base: 'CARD_MISSING', later: 'GROUP_MATCHING', final: 'CARD_GROUP_MATCHED' } } }), hidden)).toBe(false)
    expect(Object.keys(hidden)).toHaveLength(1)
  })

  it('does not depend on audit timestamps or finding-list order for identity', () => {
    expect(auditFindingFingerprint(makeFinding())).toBe(auditFindingFingerprint(makeFinding({ technical: { pipeline: { final: 'CARD_GROUP_MATCHED', later: 'GROUP_MATCHING', base: 'CARD_REVIEW' }, auditedAt: '2030-01-01' } })))
  })

  it('mantém EXPECTED_GROUP_RESOLUTION da Amazon oculto entre sessões por chave semântica', () => {
    const amazonFinding = (id: string, auditedAt: string, fingerprint = 'statement-amazon:amazon-digital-0902'): AuditFinding => makeFinding({
      id, code: 'EXPECTED_GROUP_RESOLUTION', invariantId: 'INV-03',
      item: { fingerprint } as NonNullable<AuditFinding['item']>,
      technical: { merchant: 'Amazon Digital BR', auditedAt, pipeline: { base: 'CARD_REVIEW', later: 'GROUP_MATCHING', final: 'CARD_GROUP_MATCHED' } },
    })
    const firstRun = amazonFinding('finding-volatile-1', '2026-10-07T10:00:00.000Z')
    const hidden = dismissAuditFinding(firstRun, {}, '2026-10-07T10:01:00.000Z')
    saveAuditFindingVisibility(hidden)

    // Simula desmontar a UI e criar uma nova sessão com o mesmo finding semântico.
    const secondRun = amazonFinding('finding-volatile-2', '2026-10-08T10:00:00.000Z')
    const differentSubject = amazonFinding('different-subject', '2026-10-08T10:00:00.000Z', 'statement-amazon:other-purchase')
    const restoredSession = loadAuditFindingVisibility()
    expect(auditHideKey(firstRun)).toBe(auditHideKey(secondRun))
    expect(isAuditFindingDismissed(secondRun, restoredSession)).toBe(true)
    expect(isAuditFindingDismissed(differentSubject, restoredSession)).toBe(false)
    expect([differentSubject, secondRun].reverse().map(auditHideKey)[0]).toBe(auditHideKey(firstRun))

    const restored = restoreAuditFinding(secondRun, restoredSession)
    saveAuditFindingVisibility(restored)
    expect(isAuditFindingDismissed(amazonFinding('finding-after-restore', '2026-10-09T10:00:00.000Z'), loadAuditFindingVisibility())).toBe(false)
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
