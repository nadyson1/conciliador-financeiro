import type { AuditFinding, AuditSeverity } from './consistencyAudit'
import { stableFingerprint } from './identity'

const STORAGE_KEY = 'conciliador.auditFindingVisibility.v1'
const SEVERITY_RANK: Record<AuditSeverity, number> = { INFO: 1, LEGACY: 2, MAINTENANCE: 3, REVIEW: 4, CRITICAL: 5 }

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

/** Semantic identity excludes presentation text, severity, audit timestamps, and list order. */
export function auditFindingFingerprint(finding: AuditFinding): string {
  const technical = stableValue(finding.technical ?? {})
  const subject = finding.item?.fingerprint ?? null
  const itemEvidence = finding.item ? stableValue({
    pureState: finding.item.pure.status,
    currentState: finding.item.current?.status ?? null,
    candidates: finding.item.candidates.map((row) => row.sheetRecordId || row.id),
    decisions: finding.item.decisions.map(({ decision, status }) => ({ key: decision.key, status, selected: decision.selected })),
    discarded: finding.item.discarded.map(({ row, reason }) => ({ id: row.sheetRecordId || row.id, reason })),
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
  const fingerprint = auditFindingFingerprint(finding)
  return { ...current, [fingerprint]: { fingerprint, code: finding.code, severityAtDismissal: finding.severity, dismissedAt } }
}

export function restoreAuditFinding(finding: AuditFinding, current: AuditFindingVisibility): AuditFindingVisibility {
  const next = { ...current }
  delete next[auditFindingFingerprint(finding)]
  return next
}

/** A more severe version is shown as active without mutating the saved user preference. */
export function isAuditFindingDismissed(finding: AuditFinding, visibility: AuditFindingVisibility): boolean {
  const saved = visibility[auditFindingFingerprint(finding)]
  return Boolean(saved && SEVERITY_RANK[finding.severity] <= SEVERITY_RANK[saved.severityAtDismissal])
}

export function auditFindingDismissal(finding: AuditFinding, visibility: AuditFindingVisibility): DismissedAuditFinding | undefined {
  const saved = visibility[auditFindingFingerprint(finding)]
  return saved && isAuditFindingDismissed(finding, visibility) ? saved : undefined
}

export const AUDIT_FINDING_VISIBILITY_STORAGE_KEY = STORAGE_KEY
