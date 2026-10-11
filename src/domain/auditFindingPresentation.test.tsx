import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AuditFinding } from './consistencyAudit'
import { AUDIT_CODE_CATALOG, AUDIT_CODE_LIFECYCLE, describeAuditFinding } from './auditFindingPresentation'
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
  afterEach(() => cleanup())

  it('uses human language for every known finding code', () => {
    const codes = Object.keys(AUDIT_CODE_LIFECYCLE) as AuditFinding['code'][]
    for (const code of codes) {
      const description = describeAuditFinding(makeFinding({ code }))
      expect(description.title).toBeTruthy()
      expect(description.explanation).toBeTruthy()
      expect(description.title).not.toBe(code)
      expect(description.severityLabel).toBe('Informativo')
    }
  })

  it('classifica códigos ativos, legados e relacionados para o contrato do Auditor', () => {
    expect(Object.values(AUDIT_CODE_LIFECYCLE)).toContain('emitted')
    expect(AUDIT_CODE_LIFECYCLE.DOUBLE_CLAIM_AFTER_CONFIRMATION).toBe('related-only')
    expect(AUDIT_CODE_LIFECYCLE.NEWER_TOMBSTONE_EXISTS).toBe('legacy')
    expect(AUDIT_CODE_LIFECYCLE.AUDITOR_INTERNAL_INCONSISTENCY).toBe('emitted')
    expect(AUDIT_CODE_LIFECYCLE).not.toHaveProperty('DECISION_STATUS')
    expect(AUDIT_CODE_LIFECYCLE).not.toHaveProperty('MATCHED_BUT_STILL_REVIEW')
    for (const [code, entry] of Object.entries(AUDIT_CODE_CATALOG)) {
      expect(entry.presentation.title, `${code} presentation`).toBeTruthy()
      expect(entry.severityPolicy, `${code} severity policy`).toBeTruthy()
      expect(entry.confidencePolicy, `${code} confidence policy`).toBeTruthy()
      expect(entry.invariantId, `${code} invariant`).toMatch(/^INV-\d{2}$/)
      expect(entry.role, `${code} role`).toBeTruthy()
      expect(entry.rootCauseBehavior, `${code} root cause`).toBeTruthy()
      expect(entry.exportMapping, `${code} export mapping`).toBeTruthy()
      if (entry.lifecycle === 'related-only') expect(entry.role).toBe('RELATED')
      if (entry.lifecycle === 'legacy') expect(entry.role).not.toBe('PRIMARY')
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

  it('reativa quando a materialidade piora e mantém ocultação quando só muda timestamp ou evidência relacionada', () => {
    const finding = makeFinding()
    const hidden = dismissAuditFinding(finding, {}, '2026-10-06T12:00:00.000Z')
    expect(isAuditFindingDismissed(makeFinding({ severity: 'CRITICAL' }), hidden)).toBe(false)
    expect(isAuditFindingDismissed(makeFinding({ technical: { ...finding.technical, auditedAt: '2030-01-01', related: ['new-related'] } }), hidden)).toBe(true)
    expect(isAuditFindingDismissed(makeFinding({ technical: { pipeline: { base: 'CARD_MISSING', later: 'GROUP_MATCHING', final: 'CARD_GROUP_MATCHED' } } }), hidden)).toBe(false)
    expect(Object.keys(hidden)).toHaveLength(1)
  })

  it('não compartilha ocultação entre subjects e reexibe quando root cause muda materialmente', () => {
    const finding = makeFinding({ item: { fingerprint: 'subject-a' } as NonNullable<AuditFinding['item']>, rootCauseCode: 'ROOT_A' })
    const hidden = dismissAuditFinding(finding, {})
    expect(isAuditFindingDismissed(makeFinding({ item: { fingerprint: 'subject-b' } as NonNullable<AuditFinding['item']>, rootCauseCode: 'ROOT_A' }), hidden)).toBe(false)
    expect(isAuditFindingDismissed(makeFinding({ item: { fingerprint: 'subject-a' } as NonNullable<AuditFinding['item']>, rootCauseCode: 'ROOT_B' }), hidden)).toBe(false)
  })

  it('reexibe quando o impacto declarado aumenta sem depender do texto cosmético', () => {
    const finding = makeFinding({ technical: { impactLevel: 'LOW' } })
    const hidden = dismissAuditFinding(finding, {})
    expect(isAuditFindingDismissed(makeFinding({ technical: { impactLevel: 'HIGH' } }), hidden)).toBe(false)
    expect(isAuditFindingDismissed(makeFinding({ technical: { impactLevel: 'LOW', auditedAt: '2031-01-01', message: 'Texto atualizado' } }), hidden)).toBe(true)
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

  it('mantém findings relacionados recolhidos dentro do primário', () => {
    const finding = makeFinding({ relatedFindings: [{ id: 'related-1', code: 'ASSIGNMENT_CONFLICT', title: 'Reserva relacionada', detail: 'A linha já pertence a outro subject.' }] })
    render(<AuditFindingCard finding={finding} visibility={{}} hiddenView={false} onDismiss={() => {}} onRestore={() => {}} onDiscardObsolete={() => {}} onViewPurchase={() => {}} onUseCandidate={() => {}} onInvalidateDecision={() => {}} onReanalyze={() => {}} />)
    const summary = screen.getByText('1 verificações relacionadas')
    expect(summary).toBeInTheDocument()
    expect(summary.closest('details')).not.toHaveAttribute('open')
    expect(screen.getByText('ASSIGNMENT_CONFLICT · RELATED')).not.toBeVisible()
    fireEvent.click(summary)
    expect(summary.closest('details')).toHaveAttribute('open')
    expect(screen.getByText('ASSIGNMENT_CONFLICT · RELATED')).toBeInTheDocument()
    expect(screen.getByText('Evidência: A linha já pertence a outro subject.')).toBeInTheDocument()
  })

  it('marca confiança limitada em finding crítico e explica que inconsistência interna é técnica', () => {
    const critical = makeFinding({ code: 'AUDITOR_INTERNAL_INCONSISTENCY', severity: 'CRITICAL', diagnosticConfidence: 'LOW' })
    render(<AuditFindingCard finding={critical} visibility={{}} hiddenView={false} onDismiss={() => {}} onRestore={() => {}} onDiscardObsolete={() => {}} onViewPurchase={() => {}} onUseCandidate={() => {}} onInvalidateDecision={() => {}} onReanalyze={() => {}} />)
    expect(screen.getByText(/certeza limitada/)).toBeInTheDocument()
    expect(screen.getByText(/mecanismo da Auditoria/)).toBeInTheDocument()
  })

  it('oferece invalidação por decisionId somente para confirmações de conflito resolvidas no snapshot', () => {
    const finding = makeFinding({
      code: 'PAIR_CONFIRMED_ASSIGNMENT_CONFLICT', severity: 'CRITICAL', category: 'DECISION', invariantId: 'INV-08',
      technical: {
        rowIdentity: 'sheet:row-a',
        row: { id: 'record-123', description: 'Compra sintética', date: '2026-06-12', amount: 4000 },
        assignments: [
          { decisionId: 'id-a', decisionKey: 'PAIR_CONFIRMED:["bank-a"]', bankIdentity: 'bank-a', description: 'PIX A', date: '2026-06-10', amount: 4000 },
          { decisionId: 'id-b', decisionKey: 'PAIR_CONFIRMED:["bank-b"]', bankIdentity: 'bank-b', description: 'PIX B', date: '2026-06-11', amount: 4000 },
        ],
      },
    })
    const invalidate = vi.fn()
    const resolvable = (_finding: AuditFinding, assignment: Record<string, unknown>) => assignment.decisionKey === 'PAIR_CONFIRMED:["bank-a"]'
    render(<AuditFindingCard finding={finding} visibility={{}} hiddenView={false} onDismiss={() => {}} onRestore={() => {}} onDiscardObsolete={() => {}} onViewPurchase={() => {}} onUseCandidate={() => {}} onInvalidateDecision={() => {}} onInvalidateBankConfirmation={invalidate} isBankConfirmationResolvable={resolvable} onReanalyze={() => {}} />)

    const selectedAssignment = document.querySelector('.audit-bank-conflict-assignment') as HTMLElement
    expect(within(selectedAssignment).getByText(/PIX A/)).toBeInTheDocument()
    expect(within(selectedAssignment).getByText(/record-123/)).toBeInTheDocument()
    expect(screen.getAllByRole('button', { name: 'Desfazer esta confirmação' })).toHaveLength(1)
    fireEvent.click(within(selectedAssignment).getByRole('button', { name: 'Desfazer esta confirmação' }))
    expect(invalidate).toHaveBeenCalledWith(finding, finding.technical?.assignments && (finding.technical.assignments as Record<string, unknown>[])[0])
  })

  it('não oferece invalidação quando decisionId não pode ser resolvido sem ambiguidade', () => {
    const finding = makeFinding({ code: 'PAIR_CONFIRMED_ASSIGNMENT_CONFLICT', severity: 'CRITICAL', technical: { rowIdentity: 'row', row: { id: 'row' }, assignments: [{ decisionId: 'same', decisionKey: 'same' }, { decisionId: 'same', decisionKey: 'same' }] } })
    render(<AuditFindingCard finding={finding} visibility={{}} hiddenView={false} onDismiss={() => {}} onRestore={() => {}} onDiscardObsolete={() => {}} onViewPurchase={() => {}} onUseCandidate={() => {}} onInvalidateDecision={() => {}} onInvalidateBankConfirmation={() => {}} isBankConfirmationResolvable={() => true} onReanalyze={() => {}} />)
    expect(screen.queryByRole('button', { name: 'Desfazer esta confirmação' })).not.toBeInTheDocument()
  })
})
