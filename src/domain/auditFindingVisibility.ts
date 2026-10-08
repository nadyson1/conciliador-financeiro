import type { AuditFinding, AuditSeverity } from './consistencyAudit'
import { stableFingerprint } from './identity'

const STORAGE_KEY = 'conciliador.auditFindingVisibility.v1'

export type DismissedAuditFinding = {
  fingerprint: string
  code: AuditFinding['code']
  severityAtDismissal: AuditSeverity
  dismissedAt: string
}
export type AuditFindingVisibility = Record<string, DismissedAuditFinding>

function stableValue(value: unknown, key = ''): unknown {
  if (/^(?:timestamp|updatedAt|auditedAt|createdAt|position|index|order)$/i.test(key)) return undefined
  if (Array.isArray(value)) return value.map((item) => stableValue(item)).filter((item) => item !== undefined)
    .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)))
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .flatMap(([childKey, childValue]) => {
      const stable = stableValue(childValue, childKey)
      return stable === undefined ? [] : [[childKey, stable]]
    }))
  return value
}

const semanticAnchorKeys = new Set(['subjectFingerprint', 'subjectId', 'bankId', 'transactionId', 'entityId', 'statementIdentity', 'sourceId', 'identity', 'fingerprint', 'sheetIdentity', 'sheetRecordId', 'decisionKey', 'decisionId'])
function semanticAnchors(value: unknown): unknown[] {
  if (!value || typeof value !== 'object') return []
  if (Array.isArray(value)) return value.flatMap(semanticAnchors)
  return Object.entries(value as Record<string, unknown>).flatMap(([key, child]) => [
    ...(semanticAnchorKeys.has(key) && (typeof child === 'string' || typeof child === 'number') ? [[key, child]] : []),
    ...semanticAnchors(child),
  ])
}

/** Stable identity for the user preference, independent of a finding's runtime ID and presentation. */
export function auditHideKey(finding: AuditFinding): string {
  const subjectFingerprint = finding.item?.fingerprint ?? stableFingerprint([JSON.stringify(semanticAnchors(finding.technical ?? {}))])
  const targetRow = finding.technical?.row as Record<string, unknown> | undefined
  const targetFingerprint = finding.code === 'DOUBLE_CLAIM'
    ? stableFingerprint([String(targetRow?.sheetIdentity ?? targetRow?.sheetRecordId ?? targetRow?.id ?? 'unknown-row')])
    : finding.code === 'DERIVED_STATE_MISMATCH'
      ? stableFingerprint([JSON.stringify(stableValue({ pure: finding.technical?.pure, current: finding.technical?.current, pipeline: finding.technical?.pipeline }))])
    : null
  return `audit:${stableFingerprint([JSON.stringify({ code: finding.code, invariantId: finding.invariantId, subjectFingerprint, targetFingerprint })])}`
}

/** Previous key format retained only to migrate existing user hide preferences on first encounter. */
function legacyAuditFindingFingerprint(finding: AuditFinding): string {
  const technical = stableValue(finding.technical ?? {})
  const subject = finding.item?.fingerprint ?? null
  const itemEvidence = finding.item ? stableValue({
    pureState: finding.item.pure?.status ?? null,
    currentState: finding.item.current?.status ?? null,
    candidates: finding.item.candidates?.map((row) => row.sheetRecordId || row.id) ?? [],
    decisions: finding.item.decisions?.map(({ decision, status }) => ({ key: decision.key, status, selected: decision.selected })) ?? [],
    discarded: finding.item.discarded?.map(({ row, reason }) => ({ id: row.sheetRecordId || row.id, reason })) ?? [],
  }) : null
  const identity = {
    code: finding.code,
    subject,
    itemEvidence,
    technical,
    related: finding.relatedFindings?.map(({ code, technical: detail }) => ({ code, technical: stableValue(detail ?? {}) })) ?? [],
    // For aggregate findings without technical identity, id is the stable domain identity.
    fallback: !subject && !finding.technical ? finding.id : null,
  }
  return `audit:${stableFingerprint([JSON.stringify(identity)])}`
}

/** @deprecated Use auditHideKey. Kept as an alias for existing integrations. */
export const auditFindingFingerprint = auditHideKey

export function loadAuditFindingVisibility(storage: Pick<Storage, 'getItem'> = localStorage): AuditFindingVisibility {
  try {
    const raw = storage.getItem(STORAGE_KEY)
    if (!raw) return {}
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    return Object.fromEntries(Object.entries(parsed as Record<string, unknown>).filter((entry): entry is [string, DismissedAuditFinding] => {
      const value = entry[1] as Partial<DismissedAuditFinding> | null
      return Boolean(value && value.fingerprint === entry[0] && typeof value.code === 'string'
        && value.severityAtDismissal && value.dismissedAt)
    }))
  } catch { return {} }
}

export function saveAuditFindingVisibility(visibility: AuditFindingVisibility, storage: Pick<Storage, 'setItem'> = localStorage): void {
  storage.setItem(STORAGE_KEY, JSON.stringify(visibility))
}

export function dismissAuditFinding(finding: AuditFinding, current: AuditFindingVisibility, dismissedAt = new Date().toISOString()): AuditFindingVisibility {
  const fingerprint = auditHideKey(finding)
  const next = { ...current }
  delete next[legacyAuditFindingFingerprint(finding)]
  return { ...next, [fingerprint]: { fingerprint, code: finding.code, severityAtDismissal: finding.severity, dismissedAt } }
}

export function restoreAuditFinding(finding: AuditFinding, current: AuditFindingVisibility): AuditFindingVisibility {
  const next = { ...current }
  delete next[auditHideKey(finding)]
  delete next[legacyAuditFindingFingerprint(finding)]
  return next
}

/** A finding stays hidden while its semantic key is persisted; severity is presentation, not identity. */
export function isAuditFindingDismissed(finding: AuditFinding, visibility: AuditFindingVisibility): boolean {
  const saved = visibility[auditHideKey(finding)] ?? visibility[legacyAuditFindingFingerprint(finding)]
  return Boolean(saved)
}

export function auditFindingDismissal(finding: AuditFinding, visibility: AuditFindingVisibility): DismissedAuditFinding | undefined {
  const saved = visibility[auditHideKey(finding)] ?? visibility[legacyAuditFindingFingerprint(finding)]
  return saved && isAuditFindingDismissed(finding, visibility) ? saved : undefined
}

export const AUDIT_FINDING_VISIBILITY_STORAGE_KEY = STORAGE_KEY
