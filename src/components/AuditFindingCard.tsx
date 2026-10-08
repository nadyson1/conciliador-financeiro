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
  onReanalyze: (finding: AuditFinding) => void
  hiddenView: boolean
}

const cents = (value: number) => new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(value / 100)
const date = (value: string) => /^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value.slice(8, 10)}/${value.slice(5, 7)}/${value.slice(0, 4)}` : value

export function AuditFindingCard({ finding, visibility, onDismiss, onRestore, onDiscardObsolete, onViewPurchase, onUseCandidate, onInvalidateDecision, onReanalyze, hiddenView }: Props) {
  const message = describeAuditFinding(finding)
  const dismissed = auditFindingDismissal(finding, visibility)
  const row = finding.technical?.row as Record<string, unknown> | undefined
  const subjects = Array.isArray(finding.technical?.subjects) ? finding.technical.subjects as Record<string, unknown>[] : []
  const safe = finding.technical?.safeInvalidation as Record<string, unknown> | undefined

  return <article className={`panel audit-finding audit-${finding.severity.toLowerCase()}`}>
    {hiddenView && dismissed && <p className="audit-hidden-note">Ocultado pelo usuário em {new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short', timeStyle: 'short' }).format(new Date(dismissed.dismissedAt))} · severidade ao ocultar: {message.severityLabel}</p>}
    <div className="audit-finding-copy"><span className={`audit-severity-label audit-severity-${finding.severity.toLowerCase()}`}>{message.severityLabel}</span><small>{finding.category} · {finding.invariantId} · confiança {finding.diagnosticConfidence.toLocaleLowerCase('pt-BR')}</small><h3>{message.title}</h3><p>{message.explanation}</p><section><strong>Diagnóstico</strong><p>{finding.diagnosis}</p></section>
      <section><strong>Por que isso importa</strong><p>{finding.whyItMatters}</p></section><section><strong>Ação recomendada</strong><p>{finding.recommendedAction}</p></section>
      {finding.item && <div className="audit-transaction"><strong>{finding.item.transaction.originalDescription}</strong><span>Compra em {date(finding.item.transaction.purchaseDate)} · {cents(finding.item.transaction.amount)}</span></div>}
      {finding.code === 'DOUBLE_CLAIM' && row && <div className="audit-transaction"><strong>Lançamento da CUSTOS ANO · {String(row.description ?? '')}</strong><span>{date(String(row.date ?? ''))} · {row.amount == null ? 'valor não informado' : cents(Number(row.amount))}</span><strong>Compras relacionadas</strong>{subjects.map((subject, index) => <span key={`${String(subject.fingerprint ?? subject.description)}:${index}`}>{String(subject.description ?? 'Compra')} · {date(String(subject.date ?? ''))}{subject.amount == null ? '' : ` · ${cents(Number(subject.amount))}`}</span>)}</div>}
    </div>
    {finding.code === 'DOUBLE_CLAIM' && finding.severity === 'CRITICAL' && !safe && <p className="cost-write-notice">Conflito precisa de revisão manual. Não há evidência suficiente para descartar um vínculo automaticamente.</p>}
    {finding.code === 'DOUBLE_CLAIM' && safe && <button className="text-button" onClick={() => onDiscardObsolete(finding)}>Descartar vínculo antigo</button>}
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
