import type { BankTransaction, LedgerTransaction, ReconciliationItem, ReconciliationResult } from '../domain/types'
import type { AuditFinding } from '../domain/consistencyAudit'
import type { ConsistencyAuditResult } from '../domain/consistencyAudit'
import type { AuditInputSnapshot } from '../domain/auditInputSnapshot'
import { describeAuditFinding } from '../domain/auditFindingPresentation'

function csvCell(value: unknown) {
  const text = String(value ?? '')
  return `"${text.replace(/"/g, '""')}"`
}
const money = (cents: number) => `R$ ${(cents / 100).toFixed(2).replace('.', ',')}`
const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
const dateLabel = (value: unknown) => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value.slice(8, 10)}/${value.slice(5, 7)}/${value.slice(0, 4)}` : String(value ?? '')
const moneyLabel = (value: unknown) => typeof value === 'number' ? money(value) : ''
const text = (value: unknown) => typeof value === 'string' || typeof value === 'number' ? String(value) : ''
const unique = (values: string[]) => [...new Set(values.filter(Boolean))]
function safeTechnicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(safeTechnicalValue)
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .filter(([key]) => !['original', 'raw', 'rawContent', 'fileContent', 'bytes', 'blob'].includes(key))
    .map(([key, nested]) => [key, safeTechnicalValue(nested)]))
  return value
}

const auditHeaders = [
  'Finding ID', 'Root Cause', 'Role', 'Severity', 'Confidence', 'Subject', 'Expected', 'Current', 'Related Count', 'Explanation Summary', 'Hidden', 'Coverage',
]

export interface AuditCsvRow {
  findingId: string; mode: string; auditedAt: string; severity: string; category: string; code: string; invariantId: string; title: string; diagnosis: string; recommendedAction: string; confidence: string; status: string; fingerprint: string; subjectType: string;
  transactionId: string; invoiceId: string; card: string; transactionDate: string; transactionAmount: string; transactionDescription: string; counterparty: string; mainSheetId: string; mainSheetDate: string; mainSheetDescription: string; mainSheetAmount: string;
  relatedSheetRows: string; candidateCountRelevant: number; candidateCountEvaluated: number; directEvidence: string; decisions: string; sources: string; pureState: string; currentState: string; expectedState: string; explanationStage: string; technicalSummary: string; hidden: boolean; primaryFindingId: string; rootCauseCode: string; relatedFindingsCount: number; explanationSummary: string
  role: string
}
const sheetLabel = (row: Record<string, unknown>) => [text(row.sheetRecordId ?? row.id ?? row.sheetIdentity), dateLabel(row.date), text(row.originalDescription ?? row.description), moneyLabel(row.amount)].filter(Boolean).join(' · ')
function finiteCount(value: unknown): number | undefined { return typeof value === 'number' && Number.isFinite(value) ? value : undefined }

/** Maps one finding into bounded, purpose-built CSV fields. Trace data belongs in the JSON diagnostic export. */
export function toAuditCsvRow(finding: AuditFinding, mode: 'RAPIDA' | 'PROFUNDA', auditedAt: string, hidden: boolean): AuditCsvRow {
  const technical = record(finding.technical)
  const message = describeAuditFinding(finding)
  const item = finding.item
  const transaction = record(item?.transaction ?? technical.transaction ?? technical.bank ?? technical.bankTransaction)
  const statement = record(item?.statement ?? technical.statement)
  const current = record(item?.current)
  const pure = record(item?.pure)
  const currentSheet = record(current.sheet)
  const pureSheet = record(pure.sheet)
  const primarySheet = Object.keys(record(technical.row)).length ? record(technical.row)
    : Object.keys(currentSheet).length ? currentSheet
      : Object.keys(record(technical.sheet)).length ? record(technical.sheet)
        : Object.keys(record(technical.candidate)).length ? record(technical.candidate)
          : Object.keys(pureSheet).length ? pureSheet : {}
  const directRows = new Map<string, Record<string, unknown>>()
  const addRow = (value: unknown) => {
    const row = record(value)
    if (!Object.keys(row).length) return
    const id = text(row.sheetRecordId ?? row.id ?? row.sheetIdentity)
    if (id) directRows.set(id, row)
  }
  addRow(primarySheet)
  addRow(currentSheet)
  addRow(pureSheet)
  addRow(technical.relatedSheetRow)
  addRow(technical.candidate)
  const candidateRows = Array.isArray(technical.candidateRows) ? technical.candidateRows : []
  candidateRows.forEach(addRow)
  const candidateRowsFromItem = [...(item?.candidates ?? []), ...(Array.isArray(current.candidates) ? current.candidates as Record<string, unknown>[] : []), ...(Array.isArray(pure.candidates) ? pure.candidates as Record<string, unknown>[] : [])]
  candidateRowsFromItem.forEach(addRow)
  const relatedSheetRows = [...directRows.values()].map(sheetLabel).filter(Boolean).join(' | ')
  const evaluations = item?.evaluatedCandidates ?? (Array.isArray(technical.evaluatedCandidates) ? technical.evaluatedCandidates : [])
  const relevantCount = finiteCount(technical.candidateCountRelevant) ?? directRows.size
  const evaluatedCount = finiteCount(technical.candidateCountEvaluated) ?? finiteCount(technical.candidateCount) ?? evaluations.length
  const decisionRows = item?.decisions ?? []
  const decisions = unique([
    ...decisionRows.map(({ decision, status }) => `${decision.kind} (${decision.key}) · ${status}`),
    ...(Object.keys(record(technical.decision)).length ? [`${text(record(technical.decision).kind)} (${text(record(technical.decision).key)})`] : []),
    ...(Array.isArray(technical.decisions) ? technical.decisions.map((value) => { const decision = record(value); return `${text(decision.kind)} (${text(decision.key)})` }) : []),
  ]).join(' | ')
  const subjectEvidence = Array.isArray(technical.subjects) ? technical.subjects.map((value) => {
    const subject = record(value)
    const sourcesForSubject = Array.isArray(subject.sources) ? subject.sources.map(text).filter(Boolean).join(', ') : ''
    const subjectDecisions = Array.isArray(subject.decisions) ? subject.decisions.map(text).filter(Boolean).join(', ') : ''
    return [text(subject.type), text(subject.description), dateLabel(subject.date), moneyLabel(subject.amount), text(subject.fingerprint), sourcesForSubject ? `fontes: ${sourcesForSubject}` : '', subjectDecisions ? `decisões: ${subjectDecisions}` : ''].filter(Boolean).join(' · ')
  }).filter(Boolean) : []
  const directEvidence = unique([
    ...subjectEvidence,
    text(record(technical.bank).bankTransactionId ?? record(technical.bank).id) ? `bank:${text(record(technical.bank).bankTransactionId ?? record(technical.bank).id)}` : '',
    text(record(technical.decision).key) ? `decision:${text(record(technical.decision).key)} (${text(record(technical.decision).kind)})` : '',
  ]).join(' | ')
  const sources = unique([
    text(statement.fileName) ? `${text(statement.sourceLayout) || 'Fatura'} · ${text(statement.fileName)}${text(statement.sourceId) ? ` · ID: ${text(statement.sourceId)}` : ''}` : '',
    text(technical.statementFileName) ? `${text(technical.sourceLayout) || 'Arquivo'} · ${text(technical.statementFileName)}${text(technical.statementSourceId) ? ` · ID: ${text(technical.statementSourceId)}` : ''}` : '',
    text(technical.sourceId) ? `Fonte · ID: ${text(technical.sourceId)}` : '',
    text(transaction.statementFileName ?? transaction.fileName ?? transaction.sourceName) ? `${text(transaction.statementFormats ?? transaction.sourceLayout ?? transaction.sourceType) || 'Arquivo'} · ${text(transaction.statementFileName ?? transaction.fileName ?? transaction.sourceName)}${text(transaction.statementSourceId ?? transaction.sourceId ?? transaction.driveFileId) ? ` · ID: ${text(transaction.statementSourceId ?? transaction.sourceId ?? transaction.driveFileId)}` : ''}` : '',
  ]).join(' | ')
  const summaryKeys = ['reason', 'status', 'currentStatus', 'expectedStatus', 'candidateCount', 'candidateCountRelevant', 'candidateCountEvaluated', 'pipelineStage', 'score', 'threshold', 'difference', 'validManualConfirmation', 'appliedDecision', 'decisionDomain', 'source', 'message']
  const technicalSummary = Object.fromEntries(summaryKeys.filter((key) => technical[key] !== undefined && (typeof technical[key] !== 'object' || technical[key] === null)).map((key) => [key, technical[key]]))
  if (Array.isArray(technical.candidateEvaluations)) technicalSummary.candidateEvaluations = technical.candidateEvaluations.map((value) => {
    const evaluation = record(value), row = record(evaluation.row)
    return { sheetRecordId: text(row.sheetRecordId), id: text(row.id), disposition: text(evaluation.disposition), reason: text(evaluation.reason), decisionKey: text(evaluation.decisionKey), ownerBankId: text(evaluation.ownerBankId) }
  })
  const subjectType = item ? 'Compra de cartão (PDF)' : transaction.bankTransactionId || transaction.direction ? 'Movimentação bancária' : Object.keys(primarySheet).length ? 'Lançamento CUSTOS ANO' : ''
  const transactionId = text(transaction.bankTransactionId ?? transaction.id ?? technical.transactionId)
  const date = dateLabel(transaction.purchaseDate ?? transaction.date)
  const description = text(transaction.originalDescription ?? transaction.description)
  const explanationStage = text(technical.pipelineStage) || (finding.explanationSource === 'MANUAL_DECISION' ? 'Confirmação manual válida' : finding.explanationSource === 'GROUP_MATCHING' ? 'Group matching' : finding.explanationSource ?? '')
  return {
    findingId: finding.id, mode, auditedAt, severity: finding.severity, category: finding.category, code: finding.code, invariantId: finding.invariantId, title: message.title,
    diagnosis: finding.diagnosis, recommendedAction: finding.recommendedAction, confidence: finding.diagnosticConfidence, status: finding.status, fingerprint: item?.fingerprint ?? text(technical.subjectFingerprint), subjectType,
    transactionId, invoiceId: text(statement.statementIdentity ?? technical.invoiceId), card: text(transaction.cardIdentifier), transactionDate: date,
    transactionAmount: moneyLabel(transaction.amount), transactionDescription: description, counterparty: text(transaction.counterpartyName),
    mainSheetId: text(primarySheet.sheetRecordId ?? primarySheet.id ?? primarySheet.sheetIdentity), mainSheetDate: dateLabel(primarySheet.date), mainSheetDescription: text(primarySheet.originalDescription ?? primarySheet.description), mainSheetAmount: moneyLabel(primarySheet.amount),
    relatedSheetRows, candidateCountRelevant: relevantCount, candidateCountEvaluated: evaluatedCount, directEvidence, decisions, sources, pureState: text(pure.status ?? finding.pureState ?? technical.pure),
    currentState: text(current.status ?? finding.currentState ?? technical.currentStatus ?? technical.status), expectedState: text(finding.expectedState ?? technical.expectedStatus ?? technical.expectedState), explanationStage,
    technicalSummary: JSON.stringify(technicalSummary), hidden,
    primaryFindingId: finding.primaryFindingId ?? (finding.role === 'PRIMARY' ? finding.id : ''), rootCauseCode: finding.rootCauseCode ?? finding.rootCauseKey ?? finding.code,
    relatedFindingsCount: finding.relatedFindings?.length ?? 0,
    explanationSummary: (finding.explanationChain ?? item?.explanationChain)?.map((step) => ({ PURE_MATCHING: 'P', DECISION: 'D', RESERVATION: 'R', GROUP_MATCHING: 'G', REFUND: 'F', FINAL_ASSIGNMENT: 'A' }[step.stage])).join('>') ?? '',
    role: finding.role ?? (finding.status === 'LEGACY' ? 'LEGACY' : finding.status === 'MAINTENANCE' ? 'MAINTENANCE' : finding.status === 'EXPECTED' ? 'EXPECTED' : finding.severity === 'INFO' ? 'INFO' : 'PRIMARY'),
  }
}

function auditRowValues(row: AuditCsvRow): unknown[] { return [
  row.findingId, row.rootCauseCode, row.role, row.severity, row.confidence, row.fingerprint || row.transactionId || row.mainSheetId, row.expectedState, row.currentState,
  row.relatedFindingsCount, (row.diagnosis || row.explanationSummary).slice(0, 500), row.hidden,
] }

/** Exports top-level findings (including hidden ones); related evidence stays nested in JSON. */
export function exportAuditFindings(findings: AuditFinding[], hiddenFindingIds: Set<string>, auditedAt: string, mode: 'RAPIDA' | 'PROFUNDA' = 'PROFUNDA', snapshot?: AuditInputSnapshot) {
  const exported = findings.filter((finding) => finding.role !== 'RELATED')
  const rows = exported.map((finding) => [...auditRowValues(toAuditCsvRow(finding, mode, auditedAt, hiddenFindingIds.has(finding.id))), snapshot?.state ?? 'UNAVAILABLE'])
  rows.forEach((row, index) => row.forEach((cell, column) => {
    const length = String(cell ?? '').length
    if (length > 2_000) console.warn(`Célula grande na exportação da auditoria: finding ${exported[index]?.id}, coluna ${auditHeaders[column]}, ${length} caracteres. O resumo foi limitado para manter o CSV compacto.`)
  }))
  const runDate = new Date(auditedAt)
  const validDate = Number.isNaN(runDate.getTime()) ? new Date() : runDate
  const two = (value: number) => String(value).padStart(2, '0')
  const filename = `auditoria_${mode === 'RAPIDA' ? 'rapida' : 'profunda'}_${validDate.getFullYear()}-${two(validDate.getMonth() + 1)}-${two(validDate.getDate())}_${two(validDate.getHours())}${two(validDate.getMinutes())}.csv`
  exportCsv(filename, auditHeaders, rows)
}

const rowRef = (row: Record<string, unknown>) => `sheet:${String(row.sheetRecordId ?? row.id ?? row.sheetIdentity ?? '')}`
const statementRef = (statement: Record<string, unknown>) => `statement:${String(statement.statementIdentity ?? statement.identity ?? statement.sourceId ?? 'unknown')}`
const transactionRef = (transaction: Record<string, unknown>, statement: Record<string, unknown>) => `card:${String(statement.statementIdentity ?? statement.identity ?? statement.sourceId ?? 'unknown')}:${String(transaction.id ?? transaction.transactionId ?? transaction.fingerprint ?? 'unknown')}`

/** JSON diagnostic v2 stores repeated domain entities once and leaves references in findings/items. */
export function createAuditDiagnosticPayload(audit: ConsistencyAuditResult, hiddenFindingIds: Set<string>) {
  const statements = new Map<string, Record<string, unknown>>()
  const transactions = new Map<string, Record<string, unknown>>()
  const ledgerRows = new Map<string, Record<string, unknown>>()
  const purchaseSubjects = new Map<string, Record<string, unknown>>()
  for (const item of audit.items) {
    const statement = item.statement as unknown as Record<string, unknown>
    const txs = (item.statement.transactions ?? []) as unknown as Record<string, unknown>[]
    const sRef = statementRef(statement)
    if (!statements.has(sRef)) {
      const { transactions: _transactions, ...summary } = statement
      statements.set(sRef, safeTechnicalValue(summary) as Record<string, unknown>)
      txs.forEach((transaction) => transactions.set(transactionRef(transaction, statement), safeTechnicalValue(transaction) as Record<string, unknown>))
    }
    transactions.set(transactionRef(item.transaction as unknown as Record<string, unknown>, statement), safeTechnicalValue(item.transaction) as Record<string, unknown>)
    purchaseSubjects.set(`purchase:${item.fingerprint}`, { fingerprint: item.fingerprint, statementRef: sRef, transactionRef: transactionRef(item.transaction as unknown as Record<string, unknown>, statement) })
    ;[...item.candidates, ...item.evaluatedCandidates.map(({ row }) => row)].forEach((row) => {
      const ref = rowRef(row as unknown as Record<string, unknown>)
      if (ref !== 'sheet:') ledgerRows.set(ref, safeTechnicalValue(row) as Record<string, unknown>)
    })
  }
  const compactTechnical = (value: unknown, key = ''): unknown => {
    if (Array.isArray(value)) return value.map((entry) => compactTechnical(entry, key))
    if (!value || typeof value !== 'object') return safeTechnicalValue(value)
    const recordValue = value as Record<string, unknown>
    const possibleRowRef = rowRef(recordValue)
    if (ledgerRows.has(possibleRowRef) && (recordValue.sheetRecordId || recordValue.sheetIdentity || recordValue.date && recordValue.amount)) return { ref: possibleRowRef }
    if (['row', 'sheet', 'candidate'].includes(key)) {
      const ref = rowRef(recordValue)
      if (ledgerRows.has(ref)) return { ref }
    }
    if (key === 'statement') return { ref: statementRef(recordValue) }
    if (key === 'transaction' && (recordValue.purchaseDate || recordValue.cardIdentifier)) {
      const statement = recordValue.statement as Record<string, unknown> | undefined
      const ref = transactionRef(recordValue, statement ?? {})
      if (transactions.has(ref)) return { ref }
    }
    if (key === 'decision' && typeof recordValue.key === 'string') return { ref: `decision:${recordValue.key}` }
    return Object.fromEntries(Object.entries(recordValue).filter(([childKey]) => !['original', 'raw', 'rawContent', 'fileContent', 'bytes', 'blob'].includes(childKey)).map(([childKey, child]) => [childKey, compactTechnical(child, childKey)]))
  }
  const items = audit.items.map((item) => ({
    ...(compactTechnical({ ...item, statement: undefined, transaction: undefined, candidates: undefined, evaluatedCandidates: undefined }) as Record<string, unknown>),
    statementRef: statementRef(item.statement as unknown as Record<string, unknown>),
    transactionRef: transactionRef(item.transaction as unknown as Record<string, unknown>, item.statement as unknown as Record<string, unknown>),
    candidateRefs: item.candidates.map((row) => rowRef(row as unknown as Record<string, unknown>)),
    evaluatedCandidates: item.evaluatedCandidates.map(({ row, ...evaluation }) => ({ ...(safeTechnicalValue(evaluation) as Record<string, unknown>), rowRef: rowRef(row as unknown as Record<string, unknown>) })),
  }))
  const findings = audit.findings.map((finding) => {
    const { item, technical, ...rest } = finding
    return { findingId: finding.id, hidden: hiddenFindingIds.has(finding.id), itemRef: item?.fingerprint ?? null, finding: { ...(safeTechnicalValue(rest) as Record<string, unknown>), ...(technical ? { technical: compactTechnical(technical) } : {}) } }
  })
  const decisions = audit.decisionAudit.map(({ decision, ...entry }) => ({ ...(safeTechnicalValue(entry) as Record<string, unknown>), decisionRef: `decision:${decision.key}` }))
  const decisionEntities = new Map<string, unknown>()
  audit.decisionAudit.forEach(({ decision }) => decisionEntities.set(`decision:${decision.key}`, safeTechnicalValue(decision)))
  return {
    exportFormat: 'conciliador-auditoria-diagnostico', schemaVersion: 2,
    metadata: { mode: audit.mode, auditedAt: audit.auditedAt, recomputation: safeTechnicalValue(audit.recomputation), performance: safeTechnicalValue(audit.performance), summary: safeTechnicalValue(audit.summary) },
    snapshot: safeTechnicalValue(audit.auditInputSnapshot ?? null),
    entities: { statements: Object.fromEntries(statements), cardTransactions: Object.fromEntries(transactions), ledgerRows: Object.fromEntries(ledgerRows), decisions: Object.fromEntries(decisionEntities), purchases: Object.fromEntries(purchaseSubjects) },
    findings, items, decisionAudit: decisions, invariantExecutions: safeTechnicalValue(audit.invariantExecutions), selfChecks: safeTechnicalValue(audit.auditSelfChecks),
    states: { pure: safeTechnicalValue(audit.pureStates), current: safeTechnicalValue(audit.currentStates), expected: safeTechnicalValue(audit.expectedStates) },
  }
}

/** Full, safe diagnostic package for technical investigation; IDs match the compact CSV. */
export function exportAuditDiagnosticJson(audit: ConsistencyAuditResult, hiddenFindingIds: Set<string>) {
  const payload = createAuditDiagnosticPayload(audit, hiddenFindingIds)
  const runDate = new Date(audit.auditedAt)
  const validDate = Number.isNaN(runDate.getTime()) ? new Date() : runDate
  const two = (value: number) => String(value).padStart(2, '0')
  const filename = `auditoria_diagnostico_${audit.mode === 'RAPIDA' ? 'rapida' : 'profunda'}_${validDate.getFullYear()}-${two(validDate.getMonth() + 1)}-${two(validDate.getDate())}_${two(validDate.getHours())}${two(validDate.getMinutes())}.json`
  const exportStartedAt = performance.now()
  const serialized = JSON.stringify(payload, null, 2)
  console.info(`Serialização do diagnóstico da Auditoria: ${serialized.length.toLocaleString('pt-BR')} caracteres em ${(performance.now() - exportStartedAt).toFixed(1)} ms`)
  const url = URL.createObjectURL(new Blob([serialized], { type: 'application/json;charset=utf-8' }))
  const anchor = document.createElement('a')
  anchor.href = url; anchor.download = filename; anchor.click(); URL.revokeObjectURL(url)
}

export function exportCsv(filename: string, headers: string[], rows: unknown[][]) {
  const text = `\uFEFF${[headers, ...rows].map((row) => row.map(csvCell).join(';')).join('\r\n')}`
  const url = URL.createObjectURL(new Blob([text], { type: 'text/csv;charset=utf-8' }))
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  anchor.click()
  URL.revokeObjectURL(url)
}

export function exportMissing(items: ReconciliationItem[]) {
  const missing = items.filter((item) => item.status === 'MISSING')
  exportCsv('possiveis-ausencias.csv', ['Data', 'Descrição original', 'Valor', 'Direção', 'Forma de pagamento', 'ID bancário'], missing.map(({ bank }) => [bank.date, bank.originalDescription, money(bank.amount), bank.direction, bank.paymentMethod, bank.bankTransactionId]))
}

export function exportReviews(items: ReconciliationItem[]) {
  const review = items.filter((item) => item.status === 'REVIEW')
  exportCsv('itens-para-revisao.csv', ['Estado', 'Data banco', 'Descrição banco', 'Valor', 'Data planilha', 'Descrição planilha', 'Pontuação', 'Motivos'], review.map(({ bank, sheet, candidate }) => ['REVIEW', bank.date, bank.originalDescription, money(bank.amount), sheet?.date ?? '', sheet?.originalDescription ?? '', candidate?.score ?? '', candidate?.reasons.join(' / ') ?? '']))
}

export function exportCardPayments(items: ReconciliationItem[]) {
  const cards = items.filter(({ bank }) => bank.type === 'CARD_PAYMENT')
  const rows = cards.flatMap(({ bank, composition, compositionStatus, cardSummary }) => {
    const summary = [cardSummary?.eligiblePurchaseCount ?? 0, money(cardSummary?.eligiblePurchaseTotal ?? 0), money(cardSummary?.difference ?? 0)]
    return composition.length
      ? composition.map((sheet) => [bank.date, bank.originalDescription, money(bank.amount), compositionStatus ?? 'REVIEW', sheet.date, sheet.originalDescription, money(sheet.amount), sheet.paymentMethod, ...summary])
      : [[bank.date, bank.originalDescription, money(bank.amount), compositionStatus ?? 'NO_MATCH', '', '', '', '', ...summary]]
  })
  exportCsv('composicoes-faturas-cartao.csv', ['Data pagamento', 'Descrição banco', 'Total fatura', 'Estado', 'Data compra', 'Descrição compra', 'Valor compra', 'Forma de pagamento', 'Compras elegíveis encontradas', 'Total compras elegíveis', 'Diferença pagamento menos compras'], rows)
}

export function exportOutOfScope(items: ReconciliationItem[]) {
  const outside = items.filter((item) => item.status === 'OUT_OF_SCOPE')
  exportCsv('movimentacoes-fora-do-escopo.csv', ['Data', 'Descrição', 'Direção', 'Tipo', 'Valor', 'Correspondência planilha'], outside.map(({ bank, sheet }) => [bank.date, bank.originalDescription, bank.direction === 'DEBIT' ? 'Saída' : 'Entrada', bank.type, money(bank.amount), sheet?.originalDescription ?? '']))
}

export function exportDuplicates(result: ReconciliationResult, banks: BankTransaction[], sheets: LedgerTransaction[]) {
  const rows = result.duplicateGroups.flatMap((group) => group.transactionIds.map((id) => {
    const transaction = group.source === 'BANK' ? banks.find((item) => item.id === id) : sheets.find((item) => item.id === id)
    return [group.source, transaction?.date ?? group.date, transaction?.originalDescription ?? group.description, money(transaction?.amount ?? group.amount), id]
  }))
  exportCsv('possiveis-duplicidades.csv', ['Origem', 'Data', 'Descrição original', 'Valor', 'Identificador interno'], rows)
}

export function exportSummary(result: ReconciliationResult, items: ReconciliationItem[]) {
  const count = (state: string) => items.filter((item) => item.status === state).length
  exportCsv('resumo-conciliacao.csv', ['Métrica', 'Valor'], [
    ['Conciliadas', count('MATCHED')], ['Para revisão', count('REVIEW')], ['Possíveis ausências', count('MISSING')], ['Divergências de cartão', count('CARD_DIVERGENCE')], ['Fora do escopo', count('OUT_OF_SCOPE')],
    ['Pagamentos de cartão', items.filter((item) => item.bank.type === 'CARD_PAYMENT').length],
    ['Possíveis duplicidades', result.duplicateGroups.length], ['Ignoradas', count('IGNORED')],
    ['Não encontrados no extrato', result.unmatchedSheet.length], ['Total de débitos', money(result.totals.bankDebit)],
    ['Total de créditos', money(result.totals.bankCredit)], ['Total planilha', money(result.totals.sheetTotal)],
    ['Saldo inicial', result.totals.initialBalance == null ? '' : money(result.totals.initialBalance)], ['Saldo final', result.totals.finalBalance == null ? '' : money(result.totals.finalBalance)],
    ['Saldo calculado', result.totals.calculatedFinalBalance == null ? '' : money(result.totals.calculatedFinalBalance)], ['Diferença de saldo', result.totals.balanceDifference == null ? '' : money(result.totals.balanceDifference)],
  ])
}
