import type { AuditFinding } from '../domain/consistencyAudit'
import type { PersistedDecision } from '../domain/localDecisions'
import { auditFindingDismissal, type AuditFindingVisibility } from '../domain/auditFindingVisibility'
import { describeAuditFinding } from '../domain/auditFindingPresentation'

type Props = {
  finding: AuditFinding
  visibility: AuditFindingVisibility
  onDismiss: (finding: AuditFinding) => void
  onRestore: (finding: AuditFinding) => void
  onDiscardObsolete: (finding: AuditFinding) => void
  onViewPurchase: (finding: AuditFinding) => void
  onUseCandidate: (finding: AuditFinding) => void
  onInvalidateDecision: (finding: AuditFinding, decision: PersistedDecision, explanation: string) => void
  onInvalidateBankConfirmation?: (finding: AuditFinding, assignment: Record<string, unknown>) => void
  isBankConfirmationResolvable?: (finding: AuditFinding, assignment: Record<string, unknown>) => boolean
  onReanalyze: (finding: AuditFinding) => void
  hiddenView: boolean
}

const cents = (value: number) => new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(value / 100)
const date = (value: string) => /^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value.slice(8, 10)}/${value.slice(5, 7)}/${value.slice(0, 4)}` : value

export function AuditFindingCard({ finding, visibility, onDismiss, onRestore, onDiscardObsolete, onViewPurchase, onUseCandidate, onInvalidateDecision, onInvalidateBankConfirmation, isBankConfirmationResolvable, onReanalyze, hiddenView }: Props) {
  const message = describeAuditFinding(finding)
  const dismissed = auditFindingDismissal(finding, visibility)
  const row = finding.technical?.row as Record<string, unknown> | undefined
  const subjects = Array.isArray(finding.technical?.subjects) ? finding.technical.subjects as Record<string, unknown>[] : []
  const safe = finding.technical?.safeInvalidation as Record<string, unknown> | undefined
  const assignments = Array.isArray(finding.technical?.assignments) ? finding.technical.assignments as Record<string, unknown>[] : []

  return <article className={`panel audit-finding audit-${finding.severity.toLowerCase()}`}>
    {hiddenView && dismissed && <p className="audit-hidden-note">Ocultado pelo usuário em {new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short', timeStyle: 'short' }).format(new Date(dismissed.dismissedAt))} · severidade ao ocultar: {message.severityLabel}</p>}
    <div className="audit-finding-copy"><span className={`audit-severity-label audit-severity-${finding.severity.toLowerCase()}`}>{finding.role === 'EXPECTED' || finding.role === 'INFO' ? 'Esperado · Informativo' : message.severityLabel}</span><small>{finding.category} · {finding.invariantId} · confiança {finding.diagnosticConfidence.toLocaleLowerCase('pt-BR')}{finding.severity === 'CRITICAL' && finding.diagnosticConfidence !== 'HIGH' ? ' · certeza limitada' : ''}</small><h3>{message.title}</h3><p>{message.explanation}</p>{finding.code === 'AUDITOR_INTERNAL_INCONSISTENCY' && <p className="audit-internal-note">Este aviso é sobre o mecanismo da Auditoria, não prova erro nos dados financeiros. Não altere a CUSTOS ANO com base apenas nele.</p>}<p className="audit-impact"><strong>Impacto:</strong> {finding.impact ?? message.impact}</p><p className="audit-explanation-summary">{finding.explanationChain?.map((step) => step.outcome).join(' · ') || finding.diagnosis}</p><section className="audit-primary-diagnosis"><strong>Diagnóstico</strong><p>{finding.diagnosis}</p></section>
      <section><strong>Por que isso importa</strong><p>{finding.whyItMatters}</p></section><section><strong>Ação recomendada</strong><p>{finding.recommendedAction}</p></section>
      {finding.relatedFindings?.length ? <details className="audit-related-findings"><summary>{finding.relatedFindings.length} verificações relacionadas</summary><ul>{finding.relatedFindings.map((related, index) => <li key={related.id ?? `${related.code}:${index}`}><strong>{related.code} · {related.role ?? 'RELATED'}</strong><span>Evidência: {related.detail}</span><small>Impacto: {related.impact ?? 'Contribui como evidência para a causa principal; não é contado separadamente.'}</small>{related.technical && <small>Dados: {Object.entries(related.technical).filter(([, value]) => typeof value !== 'object').map(([key, value]) => `${key}: ${String(value)}`).join(' · ') || 'detalhes técnicos disponíveis'}</small>}</li>)}</ul></details> : null}
      {finding.item?.expectedState && <p className="audit-expected-state">Esperado: {finding.item.expectedState.status}{finding.item.expectedState.sheet ? ` · ${finding.item.expectedState.sheet.originalDescription}` : ''}</p>}
      {finding.item && <div className="audit-transaction"><strong>{finding.item.transaction.originalDescription}</strong><span>Compra em {date(finding.item.transaction.purchaseDate)} · {cents(finding.item.transaction.amount)}</span></div>}
      {finding.code === 'DOUBLE_CLAIM' && row && <div className="audit-transaction"><strong>Lançamento da CUSTOS ANO · {String(row.description ?? '')}</strong><span>{date(String(row.date ?? ''))} · {row.amount == null ? 'valor não informado' : cents(Number(row.amount))}</span><strong>Compras relacionadas</strong>{subjects.map((subject, index) => <span key={`${String(subject.fingerprint ?? subject.description)}:${index}`}>{String(subject.description ?? 'Compra')} · {date(String(subject.date ?? ''))}{subject.amount == null ? '' : ` · ${cents(Number(subject.amount))}`}</span>)}</div>}
    </div>
    {finding.code === 'DOUBLE_CLAIM' && finding.severity === 'CRITICAL' && !safe && <p className="cost-write-notice">Conflito precisa de revisão manual. Não há evidência suficiente para descartar um vínculo automaticamente.</p>}
    {finding.code === 'DOUBLE_CLAIM' && safe && <button className="text-button" onClick={() => onDiscardObsolete(finding)}>Descartar vínculo antigo</button>}
    {finding.code === 'PAIR_CONFIRMED_ASSIGNMENT_CONFLICT' && assignments.length > 1 && row && <section className="audit-bank-conflict-actions" aria-label="Confirmações bancárias conflitantes">
      <strong>Confirmações envolvidas</strong>
      <p>Esta ação desfaz somente a confirmação escolhida. Outras decisões e rejeições serão preservadas.</p>
      {assignments.map((assignment, index) => {
        const decisionId = typeof assignment.decisionId === 'string' ? assignment.decisionId : ''
        const decisionKey = typeof assignment.decisionKey === 'string' ? assignment.decisionKey : ''
        const duplicateIdentity = assignments.filter((item) => item.decisionId === decisionId && item.decisionKey === decisionKey).length !== 1
        if (!decisionId || !decisionKey || duplicateIdentity || !onInvalidateBankConfirmation || !isBankConfirmationResolvable?.(finding, assignment)) return null
        return <div className="audit-bank-conflict-assignment" key={`${decisionId}:${index}`}>
          <p><strong>{String(assignment.description ?? 'Movimentação bancária')}{assignment.counterpartyName ? ` · ${String(assignment.counterpartyName)}` : ''}</strong> · {date(String(assignment.date ?? ''))} · {assignment.amount == null ? '' : cents(Number(assignment.amount))}</p>
          <small>Identidade bancária: {String(assignment.bankIdentity ?? assignment.bankId ?? '')}</small>
          <p>CUSTOS ANO: {String(row.description ?? '')} · {date(String(row.date ?? ''))} · {row.amount == null ? '' : cents(Number(row.amount))} · ID {String(row.id ?? '')}</p>
          <small>Decisão {decisionId}</small>
          <button className="text-button" onClick={() => onInvalidateBankConfirmation(finding, assignment)}>Desfazer esta confirmação</button>
        </div>
      })}
    </section>}
    {finding.item && <div className="audit-actions">
      <button className="text-button" onClick={() => onViewPurchase(finding)}>Ver compra na fatura</button>
      {finding.item.candidates.length === 1 && <button className="text-button" onClick={() => onUseCandidate(finding)}>Vincular a este lançamento</button>}
      {finding.item.decisions.filter((entry) => entry.status === 'STALE' || entry.status === 'ORPHANED').map((entry) => <button className="text-button" key={entry.decision.key} onClick={() => onInvalidateDecision(finding, entry.decision, entry.explanation)}>{entry.decision.kind === 'CARD_MISSING_CONFIRMED' ? 'Descartar decisão antiga de ausência' : entry.decision.kind === 'STATEMENT_MATCH_CONFIRMED' ? 'Descartar vínculo antigo' : 'Descartar decisão antiga'}</button>)}
      <button className="text-button" onClick={() => onReanalyze(finding)}>Reanalisar este item</button>
    </div>}
    <details className="audit-technical"><summary>Detalhes técnicos</summary><pre>{JSON.stringify(finding, null, 2)}</pre></details>
    {hiddenView ? <button className="text-button audit-dismiss" onClick={() => onRestore(finding)}>Restaurar aviso</button>
      : <button className="text-button audit-dismiss" onClick={() => onDismiss(finding)}>Ocultar este aviso</button>}
  </article>
}
