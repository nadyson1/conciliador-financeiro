/** Canonical audit projection built from the already computed domain states. */
export type ExpectedStateExplanationStep = {
  stage: 'PURE_MATCHING' | 'DECISION' | 'RESERVATION' | 'GROUP_MATCHING' | 'REFUND' | 'FINAL_ASSIGNMENT'
  outcome: string
  evidence?: string[]
  decisionId?: string
}

export type ExpectedReconciliationSubject = {
  subjectId: string
  pureState: string
  expectedState: string
  currentState: string
  explanationChain: ExpectedStateExplanationStep[]
  expectedTargetId?: string
}

/**
 * Projects the canonical expected state for a subject using the production-derived
 * result after valid decisions and global assignment have already been applied.
 * Pure state remains a separate diagnostic baseline.
 */
export function deriveExpectedReconciliationState(input: {
  subjectId: string
  pureState: string
  currentState: string
  canonicalExpectedState?: string
  canonicalEvidence?: string[]
  currentTargetId?: string
  validManualAssignment?: { decisionId: string; targetId: string; outcome?: string }
  validRejection?: { decisionId: string; outcome: string }
  reservationOwner?: { subjectId: string; targetId: string; decisionId: string }
  groupResolution?: { outcome: string; evidence?: string[] }
  refundNeutralized?: boolean
}): ExpectedReconciliationSubject {
  const explanationChain: ExpectedStateExplanationStep[] = [{
    stage: 'PURE_MATCHING', outcome: input.pureState,
    evidence: ['resultado do matcher sem decisões persistidas'],
  }]
  let expectedState = input.canonicalExpectedState ?? input.currentState
  let expectedTargetId = input.currentTargetId
  if (input.refundNeutralized) {
    expectedState = 'CARD_REFUNDED'
    expectedTargetId = undefined
    explanationChain.push({ stage: 'REFUND', outcome: expectedState, evidence: ['compra integralmente neutralizada por crédito/estorno'] })
  } else if (input.validManualAssignment) {
    expectedState = input.validManualAssignment.outcome ?? 'CARD_MATCHED'
    expectedTargetId = input.validManualAssignment.targetId
    explanationChain.push({ stage: 'DECISION', outcome: 'confirmação manual válida aplicada', decisionId: input.validManualAssignment.decisionId, evidence: [input.validManualAssignment.targetId] })
  } else if (input.validRejection) {
    expectedState = input.validRejection.outcome
    expectedTargetId = undefined
    explanationChain.push({ stage: 'DECISION', outcome: 'candidata rejeitada por decisão manual válida', decisionId: input.validRejection.decisionId })
  } else if (input.reservationOwner) {
    explanationChain.push({ stage: 'RESERVATION', outcome: 'candidata reservada para outro subject', decisionId: input.reservationOwner.decisionId, evidence: [input.reservationOwner.subjectId, input.reservationOwner.targetId] })
  } else if (input.groupResolution) {
    expectedState = input.groupResolution.outcome
    explanationChain.push({ stage: 'GROUP_MATCHING', outcome: input.groupResolution.outcome, evidence: input.groupResolution.evidence })
  }
  explanationChain.push({
    stage: 'FINAL_ASSIGNMENT', outcome: expectedState,
    evidence: expectedTargetId ? [expectedTargetId] : input.canonicalEvidence?.length ? input.canonicalEvidence : ['resultado final da atribuição global'],
  })
  return {
    subjectId: input.subjectId,
    pureState: input.pureState,
    expectedState,
    currentState: input.currentState,
    explanationChain,
    ...(expectedTargetId ? { expectedTargetId } : {}),
  }
}
