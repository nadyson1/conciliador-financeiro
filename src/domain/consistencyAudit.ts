import type { BankTransaction, CardStatement, CardStatementMatch, CardStatementTransaction, LedgerTransaction } from './types'
import type { PersistedDecision } from './localDecisions'
import { auditPersistedDecisions, type DecisionAudit } from './decisionAudit'
import { cardReviewCandidateIdentity, cardTransactionIdentity, cardTransactionIdentityVariants, sheetIdentity, stableFingerprint } from './identity'
import { deriveCardPurchaseStatus, explainCostYearCandidateRejection, findExistingCostYearCandidates, reconcileCardStatement } from '../importers/cardStatement'
import { canAddMissingToCostYear } from '../features/missingEligibility'
import { classifySheetRecord, normalizeDescription } from '../importers/normalize'

export type AuditCode = 'MISSING_COM_CANDIDATO' | 'CARD_MISSING_NO_CANDIDATE' | 'DERIVED_STATE_MISMATCH' | 'PREWRITE_MATCH_MISMATCH' | 'STALE_MISSING_DECISION' | 'ORPHANED_SHEET_REFERENCE' | 'EDITED_SHEET_REFERENCE' | 'MISSING_ADDED_TO_SHEET_ORPHAN' | 'DOUBLE_CLAIM' | 'UNUSED_STRONG_CANDIDATE' | 'LEGACY_FINGERPRINT_MATCH' | 'LOCAL_REMOTE_DECISION_DIVERGENCE' | 'NEWER_TOMBSTONE_EXISTS' | 'WRONG_DECISION_DOMAIN' | 'REVIEW_ONLY_WRONG_CYCLE_CANDIDATES' | 'IGNORED_DECISION_REVIEW' | 'CURRENT_SOURCE_DIVERGENCE' | 'REJECTED_CANDIDATE_FILTERED' | 'DECISION_STATUS' | 'SYNC_PENDING'
export type AuditSeverity = 'CRITICAL' | 'REVIEW' | 'MAINTENANCE' | 'LEGACY' | 'INFO'
export type DecisionDomain = 'bank-reconciliation' | 'sheet-bank-reconciliation' | 'card-payment-composition' | 'pdf-card-purchase' | 'bank-missing-sheet-record'
export const DECISION_DOMAIN: Record<PersistedDecision['kind'], DecisionDomain> = {
  PAIR_CONFIRMED: 'bank-reconciliation', PAIR_REJECTED: 'bank-reconciliation', BANK_IGNORED: 'bank-reconciliation',
  SHEET_IGNORED: 'sheet-bank-reconciliation', COMPOSITION_CONFIRMED: 'card-payment-composition',
  STATEMENT_MATCH_CONFIRMED: 'pdf-card-purchase', CARD_MISSING_CONFIRMED: 'pdf-card-purchase',
  CARD_PURCHASE_IGNORED: 'pdf-card-purchase', CARD_REVIEW_REJECTED_CANDIDATES: 'pdf-card-purchase',
  MISSING_ADDED_TO_SHEET: 'bank-missing-sheet-record',
}
export type AuditDecisionStatus = DecisionAudit['status'] | 'CONFLICTING' | 'LEGACY_BUT_RESOLVABLE'
export type AuditDecision = { decision: PersistedDecision; status: AuditDecisionStatus; source: 'LOCAL' | 'REMOTE' | 'TOMBSTONE'; explanation: string }
export type AuditedCardItem = {
  statement: CardStatement
  transaction: CardStatementTransaction
  pure: CardStatementMatch
  current: CardStatementMatch | null
  candidates: LedgerTransaction[]
  fingerprint: string
  aliases: string[]
  decisions: AuditDecision[]
  discarded: { row: LedgerTransaction; reason: string }[]
  evaluatedCandidates: { row: LedgerTransaction; source: 'FONTE DA ANÁLISE' | 'CACHE DA SESSÃO'; accepted: boolean; reason: string | null }[]
  claimedBy: string[]
  diagnosis: string
}
export type AppliedDecision = { decisionKey: string; subjectFingerprint: string; appliedDomain: DecisionDomain }
export type AuditFinding = { id: string; code: AuditCode; severity: AuditSeverity; title: string; detail: string; item?: AuditedCardItem; technical?: Record<string, unknown>; relatedFindings?: Pick<AuditFinding, 'code' | 'title' | 'detail' | 'technical'>[] }
export type ConsistencyAuditInput = {
  banks: BankTransaction[]
  sheets: LedgerTransaction[]
  statements: { statement: CardStatement; legacyStatementIdentity?: string }[]
  currentCardMatches: { statementIdentity: string; transactionId: string; match: CardStatementMatch }[]
  currentSheets?: LedgerTransaction[]
  localDecisions: PersistedDecision[]
  remoteDecisions?: PersistedDecision[]
  remoteTombstones?: PersistedDecision[]
  localTombstones?: Record<string, { updatedAt: string; decision: PersistedDecision }>
  appliedDecisions?: AppliedDecision[]
  onlySubjectFingerprints?: string[]
}
export type AuditSummary = { critical: number; review: number; maintenance: number; legacy: number; informational: number; attention: number; evaluatedPurchases: number }
export type ConsistencyAuditResult = { findings: AuditFinding[]; items: AuditedCardItem[]; decisionAudit: AuditDecision[]; auditedAt: string; pureStates: Record<string, string>; currentStates: Record<string, string>; summary: AuditSummary }

export function derivedMismatchSeverity(pure: CardStatementMatch['status'], current: CardStatementMatch['status'], canAppend: boolean): AuditSeverity {
  if ((pure === 'CARD_MATCHED' || pure === 'CARD_GROUP_MATCHED') && current === 'CARD_MISSING') return 'CRITICAL'
  if (pure === 'CARD_MISSING' && (current === 'CARD_MATCHED' || current === 'CARD_GROUP_MATCHED')) return 'CRITICAL'
  if (pure === 'CARD_REVIEW' && current === 'CARD_MISSING' && canAppend) return 'CRITICAL'
  if (pure === 'CARD_REVIEW' && current === 'CARD_GROUP_MATCHED') return 'INFO'
  if (pure === 'CARD_MATCHED' && current === 'CARD_REVIEW') return 'REVIEW'
  return 'REVIEW'
}

const statusName = (status: CardStatementMatch['status'] | undefined) => status ?? 'UNAVAILABLE'
const isCardPurchaseDecision = (decision: PersistedDecision) => ['STATEMENT_MATCH_CONFIRMED', 'CARD_MISSING_CONFIRMED', 'CARD_PURCHASE_IGNORED', 'CARD_REVIEW_REJECTED_CANDIDATES', 'MISSING_ADDED_TO_SHEET'].includes(decision.kind)
const sheetReference = (decision: PersistedDecision) => decision.selected[0] ?? (decision.kind === 'CARD_REVIEW_REJECTED_CANDIDATES' ? decision.selected[0] : undefined)

type DecisionSnapshot = { decision: PersistedDecision; state: 'ACTIVE' | 'DELETED'; source: 'LOCAL' | 'REMOTE' }
type DecisionMergeAudit = { effective: DecisionSnapshot[]; conflicts: { key: string; local: DecisionSnapshot; remote: DecisionSnapshot; reason: string }[]; pendingLocalUpdate: string[]; pendingRemoteUpdate: string[] }

const decisionPayload = ({ decision, state }: DecisionSnapshot) => JSON.stringify({ kind: decision.kind, identities: decision.identities, selected: decision.selected, state })
const validDecisionSnapshot = ({ decision }: DecisionSnapshot) => decision.key === `${decision.kind}:${JSON.stringify(decision.identities)}`

/** Mirrors deterministic sync precedence: newest timestamp wins; remote wins ties; tombstone is a versioned state. */
export function auditDecisionMerge(input: Pick<ConsistencyAuditInput, 'localDecisions' | 'remoteDecisions' | 'remoteTombstones' | 'localTombstones'>): DecisionMergeAudit {
  const local = new Map<string, DecisionSnapshot>()
  const remote = new Map<string, DecisionSnapshot>()
  input.localDecisions.forEach((decision) => local.set(decision.key, { decision, state: 'ACTIVE', source: 'LOCAL' }))
  Object.entries(input.localTombstones ?? {}).forEach(([key, entry]) => local.set(key, { decision: { ...entry.decision, updatedAt: entry.updatedAt }, state: 'DELETED', source: 'LOCAL' }))
  ;(input.remoteDecisions ?? []).forEach((decision) => remote.set(decision.key, { decision, state: 'ACTIVE', source: 'REMOTE' }))
  ;(input.remoteTombstones ?? []).forEach((decision) => remote.set(decision.key, { decision, state: 'DELETED', source: 'REMOTE' }))
  const conflicts: DecisionMergeAudit['conflicts'] = [], pendingLocalUpdate: string[] = [], pendingRemoteUpdate: string[] = [], effective: DecisionSnapshot[] = []
  for (const key of new Set([...local.keys(), ...remote.keys()])) {
    const left = local.get(key), right = remote.get(key)
    if (!left || !right) { const only = left ?? right; if (only) effective.push(only); continue }
    if (!validDecisionSnapshot(left) || !validDecisionSnapshot(right)) {
      conflicts.push({ key, local: left, remote: right, reason: 'decisionId/key não corresponde ao payload de decisão' })
      continue
    }
    const leftTime = Date.parse(left.decision.updatedAt), rightTime = Date.parse(right.decision.updatedAt)
    const samePayload = decisionPayload(left) === decisionPayload(right)
    if ((!Number.isFinite(leftTime) || !Number.isFinite(rightTime)) && !samePayload) {
      conflicts.push({ key, local: left, remote: right, reason: 'timestamps inválidos impedem escolher com segurança entre payloads diferentes' })
      continue
    }
    const winner = !Number.isFinite(leftTime) ? right : !Number.isFinite(rightTime) ? left : leftTime > rightTime ? left : rightTime > leftTime ? right : right
    effective.push(winner)
    if (winner.source === 'REMOTE' && (!samePayload || left.decision.updatedAt !== right.decision.updatedAt)) pendingLocalUpdate.push(key)
    if (winner.source === 'LOCAL' && (!samePayload || left.decision.updatedAt !== right.decision.updatedAt)) pendingRemoteUpdate.push(key)
  }
  return { effective, conflicts, pendingLocalUpdate, pendingRemoteUpdate }
}

export function summarizeAudit(findings: AuditFinding[], items: AuditedCardItem[]): AuditSummary {
  const uniqueCount = (severities: AuditSeverity[]) => new Set(findings.filter((finding) => severities.includes(finding.severity)).map((finding) => finding.item?.fingerprint ?? (finding.technical?.decision as PersistedDecision | undefined)?.key ?? finding.id)).size
  const critical = uniqueCount(['CRITICAL']), review = uniqueCount(['REVIEW'])
  return { critical, review, maintenance: uniqueCount(['MAINTENANCE']), legacy: uniqueCount(['LEGACY']), informational: uniqueCount(['INFO']), attention: new Set(findings.filter((finding) => finding.severity === 'CRITICAL' || finding.severity === 'REVIEW').map((finding) => finding.item?.fingerprint ?? (finding.technical?.decision as PersistedDecision | undefined)?.key ?? finding.id)).size, evaluatedPurchases: items.length }
}

const cardStateCodes = new Set<AuditCode>(['MISSING_COM_CANDIDATO', 'CARD_MISSING_NO_CANDIDATE', 'DERIVED_STATE_MISMATCH', 'PREWRITE_MATCH_MISMATCH', 'STALE_MISSING_DECISION', 'ORPHANED_SHEET_REFERENCE', 'EDITED_SHEET_REFERENCE', 'CURRENT_SOURCE_DIVERGENCE', 'REJECTED_CANDIDATE_FILTERED'])
export function deduplicateAuditFindings(findings: AuditFinding[]): AuditFinding[] {
  const output = new Map<string, AuditFinding>()
  for (const finding of findings) {
    const key = finding.item && cardStateCodes.has(finding.code) ? `${finding.item.fingerprint}:card-state` : finding.id
    const previous = output.get(key)
    if (!previous) { output.set(key, finding); continue }
    const priority: Record<AuditSeverity, number> = { CRITICAL: 5, REVIEW: 4, MAINTENANCE: 3, LEGACY: 2, INFO: 1 }
    const primary = priority[finding.severity] > priority[previous.severity] ? finding : previous
    const related = [
      ...(previous.relatedFindings ?? []), { code: previous.code, title: previous.title, detail: previous.detail, ...(previous.technical ? { technical: previous.technical } : {}) },
      ...(finding.relatedFindings ?? []), { code: finding.code, title: finding.title, detail: finding.detail, ...(finding.technical ? { technical: finding.technical } : {}) },
    ].filter((entry, index, all) => all.findIndex((candidate) => candidate.code === entry.code && candidate.detail === entry.detail) === index)
    output.set(key, { ...primary, relatedFindings: related })
  }
  return [...output.values()]
}

export type AuditFilter = 'ALL' | 'CRITICAL' | 'REVIEW' | 'LEGACY' | 'HIDDEN'
export function filterAuditFindings(findings: AuditFinding[], filter: AuditFilter): AuditFinding[] {
  if (filter === 'HIDDEN') return [] // Visibility state is intentionally managed outside the financial audit model.
  if (filter === 'ALL') return findings
  if (filter === 'CRITICAL') return findings.filter((finding) => finding.severity === 'CRITICAL')
  if (filter === 'REVIEW') return findings.filter((finding) => finding.severity === 'REVIEW')
  return findings.filter((finding) => finding.severity === 'LEGACY' || finding.severity === 'MAINTENANCE')
}

function classifyDecisions(decisions: PersistedDecision[], source: AuditDecision['source'], aliases: string[], sheets: LedgerTransaction[], auditRows: DecisionAudit[]): AuditDecision[] {
  return decisions.map((decision) => {
    const validation = auditRows.find((row) => row.decision.key === decision.key)
    const relatedByAlias = aliases.includes(decision.identities[0])
    const selected = sheetReference(decision)
    const referenced = selected ? sheets.find((row) => sheetIdentity(row) === selected || row.id === selected) : undefined
    const status: AuditDecisionStatus = validation?.status === 'ORPHANED' ? 'ORPHANED'
      : relatedByAlias && decision.identities[0] !== aliases[0] ? 'LEGACY_BUT_RESOLVABLE'
        : decision.kind === 'CARD_PURCHASE_IGNORED' && relatedByAlias ? 'VALID'
        : validation?.status === 'STALE' ? 'STALE'
          : validation?.status === 'NEEDS_REVIEW' && referenced ? 'CONFLICTING'
          : validation?.status ?? (relatedByAlias || referenced ? 'NEEDS_REVIEW' : 'NEEDS_REVIEW')
    const explanation = status === 'ORPHANED' ? 'A identidade de linha salva não existe nas linhas atuais.'
      : status === 'STALE' ? 'A decisão deixou de ser compatível com as fontes atuais.'
        : status === 'LEGACY_BUT_RESOLVABLE' ? 'Fingerprint antigo reconhecido por uma variante histórica da compra.'
          : decision.kind === 'CARD_PURCHASE_IGNORED' ? 'Decisão humana de ignorar; mantida e sinalizada para revisão.'
            : status === 'CONFLICTING' ? 'A linha ainda existe, mas os dados atuais não comprovam claramente a decisão salva.'
              : status === 'VALID' ? 'A decisão continua compatível com as fontes atuais.' : 'A decisão precisa de verificação sem alteração automática.'
    return { decision, status, source, explanation }
  })
}

function rejectedReasons(statement: CardStatement, transaction: CardStatementTransaction, rows: LedgerTransaction[]) {
  return rows.map((row) => ({ row, reason: explainCostYearCandidateRejection(statement, transaction, row, rows) })).filter((item): item is { row: LedgerTransaction; reason: string } => item.reason !== null)
}

/** Recomputes card purchase state using the production matcher with all persisted choices omitted. It performs no I/O. */
export function recomputeWithoutPersistedDecisions(input: Pick<ConsistencyAuditInput, 'sheets' | 'statements'>) {
  const consumed = new Set<string>()
  const statements = [...input.statements].sort((a, b) => (a.statement.dueDate ?? '').localeCompare(b.statement.dueDate ?? '') || a.statement.statementIdentity.localeCompare(b.statement.statementIdentity))
  const result = new Map<string, CardStatementMatch>()
  for (const entry of statements) {
    const pure = reconcileCardStatement(entry.statement, input.sheets)
    for (const match of pure.matches) {
      const derived = deriveCardPurchaseStatus(match, { consumedSheetIds: consumed })
      result.set(`${entry.statement.statementIdentity}\u001f${match.transaction.id}`, derived)
      if (derived.status === 'CARD_MATCHED' && derived.sheet) consumed.add(derived.sheet.id)
      if (derived.status === 'CARD_GROUP_MATCHED') derived.candidates.forEach((row) => consumed.add(row.id))
    }
  }
  return result
}

export function auditConsistency(input: ConsistencyAuditInput): ConsistencyAuditResult {
  const pure = recomputeWithoutPersistedDecisions(input)
  const decisionContext = { banks: input.banks, sheets: input.sheets, statements: input.statements }
  const mergeAudit = auditDecisionMerge(input)
  const effectiveDecisions = mergeAudit.effective.filter((item) => item.state === 'ACTIVE')
  const allDecisions = effectiveDecisions.map((item) => item.decision)
  const validated = auditPersistedDecisions(allDecisions, decisionContext)
  const currentMap = new Map(input.currentCardMatches.map(({ statementIdentity, transactionId, match }) => [`${statementIdentity}\u001f${transactionId}`, match]))
  const items: AuditedCardItem[] = []
  const findings: AuditFinding[] = []
  const pureStates: Record<string, string> = {}, currentStates: Record<string, string> = {}
  const onlySubjectFingerprints = input.onlySubjectFingerprints ? new Set(input.onlySubjectFingerprints) : null
  for (const entry of input.statements) for (const transaction of entry.statement.transactions.filter((tx) => tx.type === 'PURCHASE')) {
    const key = `${entry.statement.statementIdentity}\u001f${transaction.id}`
    const identity = cardTransactionIdentity(entry.statement, transaction)
    if (onlySubjectFingerprints && !onlySubjectFingerprints.has(identity)) continue
    const aliases = cardTransactionIdentityVariants(entry.statement, transaction, entry.legacyStatementIdentity)
    const pureMatch = pure.get(key) ?? { transaction, status: 'CARD_MISSING' as const, sheet: null, candidates: [] }
    const current = currentMap.get(key) ?? null
    pureStates[identity] = statusName(pureMatch.status)
    currentStates[identity] = statusName(current?.status)
    const candidates = findExistingCostYearCandidates(entry.statement, transaction, input.sheets)
    const correctedRows = input.sheets.map((row) => {
      const correctedType = classifySheetRecord({ description: row.originalDescription, paymentMethod: row.paymentMethod })
      return correctedType !== row.type ? { ...row, type: correctedType } : row
    })
    const correctedCandidates = findExistingCostYearCandidates(entry.statement, transaction, correctedRows)
    const wronglyClassifiedCandidates = correctedCandidates.filter((candidate) => {
      const original = input.sheets.find((row) => row.id === candidate.id)
      return Boolean(original && original.type !== candidate.type && !candidates.some((row) => row.id === candidate.id))
    })
    const evaluateRows = (rows: LedgerTransaction[], source: 'FONTE DA ANÁLISE' | 'CACHE DA SESSÃO') => {
      const rowCandidates = findExistingCostYearCandidates(entry.statement, transaction, rows)
      return rows.map((row) => {
        const reason = explainCostYearCandidateRejection(entry.statement, transaction, row, rows)
        const accepted = reason === null && rowCandidates.some((candidate) => candidate.id === row.id)
        return { row, source, accepted, reason: reason ?? (accepted ? null : 'passou pelos critérios locais, mas foi removida por regra de seleção do conjunto de candidatos') }
      })
    }
    const currentRows = input.currentSheets ?? input.sheets
    const rowKey = (row: LedgerTransaction) => JSON.stringify([row.id, row.date, row.amount, row.originalDescription, row.paymentMethod, row.direction, row.type, row.installment, row.totalInstallments])
    const currentRowKeys = new Set(input.sheets.map(rowKey))
    const evaluatedCandidates = [...evaluateRows(input.sheets, 'FONTE DA ANÁLISE'), ...evaluateRows(currentRows.filter((row) => !currentRowKeys.has(rowKey(row))), 'CACHE DA SESSÃO')]
    const relatedLocal = effectiveDecisions.filter((item) => item.source === 'LOCAL' && isCardPurchaseDecision(item.decision) && aliases.includes(item.decision.identities[0])).map((item) => item.decision)
    const relatedRemote = effectiveDecisions.filter((item) => item.source === 'REMOTE' && isCardPurchaseDecision(item.decision) && aliases.includes(item.decision.identities[0])).map((item) => item.decision)
    const audits = classifyDecisions(relatedLocal, 'LOCAL', aliases, input.sheets, validated)
      .concat(classifyDecisions(relatedRemote, 'REMOTE', aliases, input.sheets, validated))
    const localCandidates = findExistingCostYearCandidates(entry.statement, transaction, input.currentSheets ?? input.sheets)
    const claimedBy = [...pure.entries()].flatMap(([otherKey, match]) => {
      if (otherKey === key) return []
      const claimsCandidate = match.status === 'CARD_MATCHED' && match.sheet && candidates.some((candidate) => candidate.id === match.sheet!.id)
        || match.status === 'CARD_GROUP_MATCHED' && match.candidates.some((candidate) => candidates.some((item) => item.id === candidate.id))
      return claimsCandidate ? [otherKey] : []
    })
    const staleDecision = audits.find((audit) => ['STALE', 'ORPHANED', 'LEGACY_BUT_RESOLVABLE'].includes(audit.status))
    const rejectedCandidateDecision = relatedLocal.find((decision) => decision.kind === 'CARD_REVIEW_REJECTED_CANDIDATES' && candidates.some((row) => decision.selected.includes(cardReviewCandidateIdentity(row))))
    const diagnosis = current?.status === 'CARD_MISSING' && rejectedCandidateDecision
      ? `A decisão persistida CARD_REVIEW_REJECTED_CANDIDATES removeu o(s) candidato(s) ${candidates.filter((row) => rejectedCandidateDecision.selected.includes(cardReviewCandidateIdentity(row))).map((row) => row.sheetRecordId || row.id).join(', ')} na etapa de filtragem pós-geração. Com a decisão ignorada, o matcher puro retorna ${pureMatch.status}.`
      : current?.status === 'CARD_MISSING' && pureMatch.status !== 'CARD_MISSING'
      ? staleDecision ? `O estado muda no estágio de aplicação das decisões: ${staleDecision.decision.kind} (${staleDecision.status}). O matcher puro encontra ${pureMatch.status}.` : localCandidates.length === 0 && candidates.length > 0 ? 'A tela foi calculada com uma cópia anterior de CUSTOS ANO; a releitura encontrou candidato e o matching puro encontra correspondência.' : 'A divergência surge entre o matching calculado para a tela e o recálculo sem decisões; nenhuma decisão persistida relacionada foi identificada.'
      : current?.status === 'CARD_MISSING' && candidates.length === 0 && localCandidates.length > 0 ? 'A sessão tinha candidato(s) em seu cache local, mas a releitura atual da CUSTOS ANO não os contém; os dados usados pela tela e a fonte atual divergem.'
      : current?.status === 'CARD_MISSING' && pureMatch.status === 'CARD_MISSING' && candidates.length === 0 ? 'A compra continua MISSING no matcher puro: nenhum candidato passou pelos critérios compartilhados. Os descartes abaixo mostram linhas avaliadas e o motivo.'
        : current?.status === 'CARD_MISSING' && candidates.length > 0 ? 'O estado MISSING atual contradiz a busca compartilhada de candidatos; confira a etapa de aplicação global/multiplicidade e os IDs consumidos.'
          : pureMatch.status === 'CARD_MATCHED' ? 'A busca de candidatos e o matching global selecionam uma linha atual; o caminho puro não produz MISSING.'
            : `O matcher puro retornou ${pureMatch.status}; os candidatos e evidências mostram o estágio alcançado.`
    const item: AuditedCardItem = { statement: entry.statement, transaction, pure: pureMatch, current, candidates, fingerprint: identity, aliases, decisions: audits, discarded: rejectedReasons(entry.statement, transaction, input.sheets), evaluatedCandidates, claimedBy, diagnosis }
    items.push(item)
    const add = (code: AuditCode, severity: AuditSeverity, title: string, detail: string, technical?: Record<string, unknown>) => findings.push({ id: `${code}:${identity}`, code, severity, title, detail, item, ...(technical ? { technical } : {}) })
    if (current?.status === 'CARD_MISSING' && candidates.length) add('MISSING_COM_CANDIDATO', 'CRITICAL', 'Compra marcada como ausente, mas há candidato', `O matching atual mostra MISSING; a busca compartilhada do pré-check encontrou ${candidates.length} candidato(s).`, { candidates: candidates.map((row) => ({ id: row.id, date: row.date, description: row.originalDescription, amount: row.amount })) })
    if (pureMatch.status === 'CARD_MISSING' && candidates.length === 0 && wronglyClassifiedCandidates.length > 0) {
      const canAppend = canAddMissingToCostYear({ source: 'STATEMENT', status: current?.status ?? pureMatch.status, direction: transaction.direction, type: transaction.type }).eligible
      const severity: AuditSeverity = canAppend && current?.status === 'CARD_MISSING' ? 'CRITICAL' : 'REVIEW'
      add('CARD_MISSING_NO_CANDIDATE', severity, severity === 'CRITICAL' ? 'Linha de despesa descartada pode gerar duplicidade' : 'Linha plausível foi descartada pela classificação', `A busca atual excluiu ${wronglyClassifiedCandidates.length} linha(s) pela natureza registrada, mas a classificação centralizada as reconhece como ${wronglyClassifiedCandidates[0].type}.${severity === 'CRITICAL' ? ' A compra está marcada como ausente e a ação de adicionar está disponível, com risco de duplicar o lançamento.' : ' A compra não está liberada para inclusão como ausente.'}`, { rejectedRows: wronglyClassifiedCandidates.map((row) => ({ id: row.id, sheetRecordId: row.sheetRecordId, typeBefore: input.sheets.find((source) => source.id === row.id)?.type, typeAfter: row.type, date: row.date, description: row.originalDescription, amount: row.amount, paymentMethod: row.paymentMethod, reason: 'natureza incompatível antes da classificação centralizada' })), canAppend })
    }
    if (current?.status === 'CARD_MISSING' && rejectedCandidateDecision) add('REJECTED_CANDIDATE_FILTERED', 'CRITICAL', 'Decisão anterior removeu um candidato válido', 'A rejeição salva corresponde exatamente a uma linha que a busca atual considera candidata; a filtragem dessa decisão transforma o resultado em MISSING.', { decision: rejectedCandidateDecision, candidateIds: candidates.map((row) => row.id) })
    if (current && current.status !== pureMatch.status) {
      const canAppend = canAddMissingToCostYear({ source: 'STATEMENT', status: current.status, direction: transaction.direction, type: transaction.type }).eligible
      const severity = derivedMismatchSeverity(pureMatch.status, current.status, canAppend)
      const stage = pureMatch.status === 'CARD_REVIEW' && current.status === 'CARD_GROUP_MATCHED' ? { base: 'CARD_REVIEW', later: 'GROUP_MATCHING / multiplicidade', final: 'CARD_GROUP_MATCHED', conclusion: 'comportamento esperado após atribuição global' } : null
      add('DERIVED_STATE_MISMATCH', severity, stage ? 'Estado final explicado pelo agrupamento' : 'Estado exibido difere do recálculo puro', stage ? 'A ambiguidade do matching base foi resolvida pela etapa posterior de group matching; não há divergência financeira.' : `Estado base sem decisões: ${pureMatch.status}. Estado final da interface: ${current.status}.${severity === 'CRITICAL' ? ' Esta diferença pode ocultar despesa ou liberar inclusão duplicada.' : ' A divergência requer revisão, mas não foi classificada como risco crítico.'}`, { pure: pureMatch.status, current: current.status, canAppend, ...(stage ? { pipeline: stage } : {}) })
    }
    if (current?.status === 'CARD_MISSING' && candidates.length && localCandidates.length === 0) add('CURRENT_SOURCE_DIVERGENCE', 'CRITICAL', 'Fonte da tela desatualizada', `A cópia de CUSTOS ANO usada pela tela não contém o candidato. A leitura feita pela auditoria encontrou ${candidates.length} candidato(s).`, { currentCandidateIds: [], refreshedCandidateIds: candidates.map((row) => row.id) })
    if (current?.status === 'CARD_MISSING' && candidates.length === 0 && localCandidates.length > 0) add('CURRENT_SOURCE_DIVERGENCE', 'REVIEW', 'Linha do cache não apareceu na fonte atual', 'Uma linha que passava pelo matching na cópia desta sessão não veio na leitura atual de CUSTOS ANO. A fonte atual foi preservada como referência.', { cachedCandidateIds: localCandidates.map((row) => row.id), refreshedCandidateIds: [] })
    if (pureMatch.status === 'CARD_MISSING' && candidates.length) add('PREWRITE_MATCH_MISMATCH', 'CRITICAL', 'Pré-check e matching divergem', `O matching puro retornou MISSING, mas findExistingCostYearCandidates — também usado antes de escrever — encontrou ${candidates.length} linha(s).`, { candidateIds: candidates.map((row) => row.id) })
    const missingDecision = audits.find((decision) => decision.decision.kind === 'CARD_MISSING_CONFIRMED')
    if (missingDecision && candidates.length) add('STALE_MISSING_DECISION', 'REVIEW', 'Decisão antiga de ausência com candidato atual', `${missingDecision.source}: CARD_MISSING_CONFIRMED foi associada à compra, mas existe candidato atual.`)
    for (const audit of audits) {
      if (audit.status === 'ORPHANED') add('ORPHANED_SHEET_REFERENCE', current?.status === 'CARD_MATCHED' || current?.status === 'CARD_GROUP_MATCHED' ? 'MAINTENANCE' : 'REVIEW', 'Decisão aponta para linha inexistente', `${audit.decision.kind}: ${audit.explanation}`)
      else if (audit.status === 'STALE') add('EDITED_SHEET_REFERENCE', current?.status === 'CARD_MATCHED' || current?.status === 'CARD_GROUP_MATCHED' ? 'MAINTENANCE' : 'REVIEW', 'Linha vinculada foi alterada', `${audit.decision.kind}: a linha ainda existe, mas deixou de satisfazer a decisão.`)
      else if (audit.status === 'CONFLICTING') add('EDITED_SHEET_REFERENCE', 'REVIEW', 'Linha vinculada exige revisão', `${audit.decision.kind}: ${audit.explanation}`)
      else if (audit.status === 'LEGACY_BUT_RESOLVABLE') add('LEGACY_FINGERPRINT_MATCH', 'LEGACY', 'Fingerprint legado reconhecido', `${audit.decision.kind}: decisão antiga corresponde a uma variante histórica.`)
      if (audit.decision.kind === 'MISSING_ADDED_TO_SHEET' && audit.status === 'ORPHANED') add('MISSING_ADDED_TO_SHEET_ORPHAN', 'REVIEW', 'Linha adicionada não existe mais', 'A decisão de adição está salva, mas o ID referenciado não aparece na CUSTOS ANO atual.')
      if (audit.decision.kind === 'CARD_PURCHASE_IGNORED' && candidates.length) add('IGNORED_DECISION_REVIEW', 'REVIEW', 'Decisão ignorada merece revisão', 'Há candidato atual; a decisão humana de ignorar foi preservada.')
    }
    if (pureMatch.status === 'CARD_REVIEW' && candidates.length && entry.statement.dueDate) {
      const due = Date.parse(`${entry.statement.dueDate}T00:00:00Z`)
      const priorOnly = candidates.every((row) => {
        const candidateDate = Date.parse(`${row.date}T00:00:00Z`)
        return Number.isFinite(due) && Number.isFinite(candidateDate) && due - candidateDate > 45 * 86400000
      })
      if (priorOnly) add('REVIEW_ONLY_WRONG_CYCLE_CANDIDATES', 'REVIEW', 'Candidatos de revisão pertencem a ciclos anteriores', 'Todos os candidatos de cartão estão datados antes do vencimento desta fatura.', { candidateDates: candidates.map((row) => row.date) })
    }
    if ((current?.status === 'CARD_MISSING' || current?.status === 'CARD_REVIEW') && candidates.length && pureMatch.status !== 'CARD_MATCHED' && pureMatch.status !== 'CARD_GROUP_MATCHED') add('UNUSED_STRONG_CANDIDATE', 'REVIEW', 'Candidato forte não utilizado', 'Existe candidato aceito pela busca de cartão, mas a atribuição global não o consumiu nesta compra.', { candidateIds: candidates.map((row) => row.id), pure: pureMatch.status, current: current.status })
  }

  type ClaimDetail = { id: string; origin: string; type: string; description: string; date: string; amount: number | null }
  type ClaimSubject = ClaimDetail & { sources: Set<string>; decisionTypes: Set<string>; decisions: PersistedDecision[]; groupMembers: Map<string, ClaimDetail & { sources: Set<string>; decisionTypes: Set<string> }> }
  type ClaimInput = ClaimDetail & { groupMembers?: Map<string, ClaimDetail & { sources: Set<string>; decisionTypes: Set<string> }> }
  const claims = new Map<string, { row: LedgerTransaction; subjects: Map<string, ClaimSubject> }>()
  const addClaim = (row: LedgerTransaction, subject: ClaimInput, source: string, decisionType?: string, decision?: PersistedDecision) => {
    const rowKey = sheetIdentity(row)
    const bucket = claims.get(rowKey) ?? { row, subjects: new Map<string, ClaimSubject>() }
    const current = bucket.subjects.get(subject.id) ?? { id: subject.id, origin: subject.origin, type: subject.type, description: subject.description, date: subject.date, amount: subject.amount, sources: new Set<string>(), decisionTypes: new Set<string>(), decisions: [], groupMembers: new Map<string, ClaimDetail & { sources: Set<string>; decisionTypes: Set<string> }>() }
    current.sources.add(source)
    if (decisionType) current.decisionTypes.add(decisionType)
    if (decision && !current.decisions.some((item) => item.key === decision.key)) current.decisions.push(decision)
    if (subject.groupMembers) for (const [key, member] of subject.groupMembers) current.groupMembers.set(key, member)
    bucket.subjects.set(subject.id, current)
    claims.set(rowKey, bucket)
  }
  const resolveStatementSubject = (identity: string) => {
    for (const entry of input.statements) {
      const transaction = entry.statement.transactions.find((item) => cardTransactionIdentityVariants(entry.statement, item, entry.legacyStatementIdentity).includes(identity))
      if (transaction) return { id: cardTransactionIdentity(entry.statement, transaction), origin: 'Fatura PDF', type: 'Compra de cartão', description: transaction.originalDescription, date: transaction.purchaseDate || transaction.date, amount: transaction.amount }
    }
    return { id: identity, origin: 'Decisão histórica', type: 'Compra de cartão', description: identity, date: '', amount: null }
  }
  for (const snapshot of effectiveDecisions.filter((item) => item.state === 'ACTIVE' && item.decision.kind === 'STATEMENT_MATCH_CONFIRMED')) {
    const audit = validated.find((item) => item.decision.key === snapshot.decision.key)
    if (audit?.status !== 'VALID') continue
    const subject = resolveStatementSubject(snapshot.decision.identities[0] ?? snapshot.decision.key)
    for (const ref of snapshot.decision.selected) {
      const row = input.sheets.find((item) => sheetIdentity(item) === ref || item.sheetRecordId === ref || item.id === ref)
      if (row) addClaim(row, subject, `decisão ativa ${snapshot.source.toLocaleLowerCase('pt-BR')}`, snapshot.decision.kind, snapshot.decision)
    }
  }
  for (const current of input.currentCardMatches) {
    const rows = current.match.status === 'CARD_MATCHED' && current.match.sheet ? [current.match.sheet] : current.match.status === 'CARD_GROUP_MATCHED' ? current.match.candidates : []
    if (!rows.length) continue
    const subject = resolveStatementSubject(cardTransactionIdentity(current.statementIdentity, current.match.transaction))
    const source = current.match.status === 'CARD_GROUP_MATCHED' ? 'group matching / multiplicidade' : 'matching atual'
    const groupId = current.match.status === 'CARD_GROUP_MATCHED' ? `group:${current.statementIdentity}:${rows.map(sheetIdentity).sort().join('|')}` : subject.id
    const groupMember = { id: subject.id, origin: subject.origin, type: subject.type, description: subject.description, date: subject.date, amount: subject.amount, sources: new Set([source]), decisionTypes: new Set<string>() }
    for (const row of rows) addClaim(row, { ...subject, id: groupId, groupMembers: current.match.status === 'CARD_GROUP_MATCHED' ? new Map([[subject.id, groupMember]]) : new Map() }, source)
  }
  for (const [rowKey, bucket] of claims) {
    const subjects = [...bucket.subjects.values()]
    if (subjects.length <= 1) continue
    const resolvedSubjects = subjects.filter((subject) => [...subject.sources].some((source) => source === 'matching atual' || source.startsWith('decisão ativa')))
    const severity: AuditSeverity = resolvedSubjects.length > 1 ? 'CRITICAL' : 'INFO'
    const row = bucket.row
    const renderedSubjects = subjects.flatMap((subject) => subject.groupMembers.size ? [...subject.groupMembers.values()] : [subject])
    const origins = [...new Set(subjects.flatMap((subject) => [...subject.sources]))]
    const currentFor = (subjectId: string) => {
      for (const entry of input.statements) {
        const transaction = entry.statement.transactions.find((item) => cardTransactionIdentity(entry.statement, item) === subjectId)
        if (!transaction) continue
        const match = input.currentCardMatches.find((item) => item.statementIdentity === entry.statement.statementIdentity && item.transactionId === transaction.id)?.match
        return match ? { entry, transaction, match } : null
      }
      return null
    }
    const exactCycleMatch = (subjectId: string, candidate: LedgerTransaction) => {
      const resolved = currentFor(subjectId)
      if (!resolved || resolved.match.status !== 'CARD_MATCHED' || !resolved.match.sheet || sheetIdentity(resolved.match.sheet) !== sheetIdentity(candidate)) return false
      const dueDate = resolved.transaction.invoiceDueDate ?? resolved.transaction.statementDueDate ?? resolved.entry.statement.dueDate
      const passesCandidateRules = findExistingCostYearCandidates(resolved.entry.statement, resolved.transaction, [candidate]).some((item) => sheetIdentity(item) === sheetIdentity(candidate))
      const installmentMatch = resolved.transaction.installment != null
        && candidate.installment === resolved.transaction.installment
        && candidate.totalInstallments === resolved.transaction.totalInstallments
      return passesCandidateRules && candidate.amount === resolved.transaction.amount && candidate.direction === 'DEBIT'
        && normalizeDescription(candidate.paymentMethod) === 'credito bradesco'
        && (candidate.date === dueDate || installmentMatch)
    }
    const decisionSubjects = subjects.filter((subject) => subject.decisions.length > 0 && !subject.groupMembers.size)
    let safeInvalidation: Record<string, unknown> | undefined
    if (subjects.length === 2 && decisionSubjects.length === 1) {
      const obsoleteSubject = decisionSubjects[0]
      const decision = obsoleteSubject.decisions[0]
      const winner = subjects.find((subject) => subject.id !== obsoleteSubject.id && subject.sources.has('matching atual') && !subject.groupMembers.size)
      const activeClaimsForRow = effectiveDecisions.filter((snapshot) => snapshot.state === 'ACTIVE'
        && snapshot.decision.kind === 'STATEMENT_MATCH_CONFIRMED'
        && snapshot.decision.selected.some((ref) => ref === rowKey || ref === row.sheetRecordId || ref === row.id))
      const obsoleteAudit = validated.find((item) => item.decision.key === decision.key)
      const oldCurrent = currentFor(obsoleteSubject.id)
      const oldHasSeparateCurrentMatch = Boolean(oldCurrent?.match.status === 'CARD_MATCHED' && oldCurrent.match.sheet
        && sheetIdentity(oldCurrent.match.sheet) !== rowKey && exactCycleMatch(obsoleteSubject.id, oldCurrent.match.sheet))
      const decisionIsIncompatible = obsoleteAudit?.status === 'STALE'
      if (winner && decision.kind === 'STATEMENT_MATCH_CONFIRMED' && activeClaimsForRow.length === 1
        && (oldHasSeparateCurrentMatch || decisionIsIncompatible)
        && exactCycleMatch(winner.id, row)) {
        safeInvalidation = {
          decision,
          decisionId: stableFingerprint([decision.key]),
          decisionKey: decision.key,
          obsoleteSubject: { description: obsoleteSubject.description, date: obsoleteSubject.date, amount: obsoleteSubject.amount, fingerprint: obsoleteSubject.id },
          winningSubject: { description: winner.description, date: winner.date, amount: winner.amount, fingerprint: winner.id },
          row: { id: row.sheetRecordId || row.id, sheetIdentity: rowKey, description: row.originalDescription, date: row.date, amount: row.amount, paymentMethod: row.paymentMethod },
          separateMatch: oldHasSeparateCurrentMatch && oldCurrent?.match.sheet ? { description: oldCurrent.match.sheet.originalDescription, date: oldCurrent.match.sheet.date, amount: oldCurrent.match.sheet.amount, id: oldCurrent.match.sheet.sheetRecordId || oldCurrent.match.sheet.id } : null,
          proof: { winningSubjectHasExactCycleMatch: true, obsoleteSubjectHasSeparateCurrentMatch: oldHasSeparateCurrentMatch, obsoleteDecisionStatus: obsoleteAudit?.status ?? 'UNAVAILABLE', onlyTwoSubjectsClaimThisRow: true },
        }
      }
    }
    findings.push({
      id: `DOUBLE_CLAIM:${rowKey}`, code: 'DOUBLE_CLAIM', severity,
      title: severity === 'CRITICAL' ? 'Uma linha da CUSTOS ANO está atribuída a mais de uma compra' : 'Compartilhamento explicado por group matching',
      detail: `CUSTOS ANO ${row.sheetRecordId || row.id} · ${row.originalDescription} · ${row.date} · ${row.amount} centavos · ${row.paymentMethod}. Há ${renderedSubjects.length} subject(s) relacionado(s); origem: ${origins.join(', ')}.`,
      technical: {
        row: { id: row.sheetRecordId || row.id, sheetIdentity: rowKey, description: row.originalDescription, date: row.date, amount: row.amount, paymentMethod: row.paymentMethod },
        subjects: renderedSubjects.map((subject) => ({ origin: subject.origin, type: subject.type, description: subject.description, date: subject.date, amount: subject.amount, sources: [...subject.sources], decisions: [...subject.decisionTypes], fingerprint: subject.id })),
        claimSources: origins,
        ...(safeInvalidation ? { safeInvalidation } : {}),
      },
    })
  }
  const decisionIndex = new Map(allDecisions.map((decision) => [decision.key, decision]))
  for (const application of input.appliedDecisions ?? []) {
    const decision = decisionIndex.get(application.decisionKey)
    if (!decision) continue
    const expected = DECISION_DOMAIN[decision.kind]
    if (application.appliedDomain !== expected) findings.push({ id: `WRONG_DECISION_DOMAIN:${application.subjectFingerprint}:${decision.key}`, code: 'WRONG_DECISION_DOMAIN', severity: 'CRITICAL', title: 'Decisão aplicada no domínio errado', detail: `${decision.kind} pertence a ${expected}, mas foi observada aplicada em ${application.appliedDomain}.`, technical: { decision, subjectFingerprint: application.subjectFingerprint, expectedDomain: expected, appliedDomain: application.appliedDomain } })
  }
  for (const conflict of mergeAudit.conflicts) findings.push({ id: `LOCAL_REMOTE_DECISION_DIVERGENCE:${conflict.key}`, code: 'LOCAL_REMOTE_DECISION_DIVERGENCE', severity: 'REVIEW', title: 'Conflito real entre decisão local e remota', detail: conflict.reason, technical: { local: conflict.local, remote: conflict.remote } })
  const pendingCount = mergeAudit.pendingLocalUpdate.length + mergeAudit.pendingRemoteUpdate.length
  if (pendingCount) findings.push({ id: 'SYNC_PENDING:decisions', code: 'SYNC_PENDING', severity: 'INFO', title: `${pendingCount} decisão(ões) aguardam sincronização`, detail: 'A diferença local/remota é resolvível pelas regras normais: versão mais nova vence e o remoto vence empates. Nenhuma revisão financeira é necessária.', technical: { localUpdates: mergeAudit.pendingLocalUpdate, remoteUpdates: mergeAudit.pendingRemoteUpdate, count: pendingCount } })
  for (const audit of validated) if (audit.decision.kind === 'MISSING_ADDED_TO_SHEET' && audit.status === 'ORPHANED') findings.push({ id: `MISSING_ADDED_TO_SHEET_ORPHAN:${audit.decision.key}`, code: 'MISSING_ADDED_TO_SHEET_ORPHAN', severity: 'MAINTENANCE', title: 'Linha adicionada não existe mais', detail: 'A decisão de adição está salva, mas o ID referenciado não aparece na CUSTOS ANO atual.', technical: { decision: audit.decision } })
  const deduplicated = deduplicateAuditFindings(findings)
  return { findings: deduplicated, items, decisionAudit: validated.map((audit) => ({ decision: audit.decision, status: audit.status, source: 'LOCAL' as const, explanation: audit.status })), auditedAt: new Date().toISOString(), pureStates, currentStates, summary: summarizeAudit(deduplicated, items) }
}
