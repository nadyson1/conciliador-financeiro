export type InvoiceSourceRecord = {
  source?: 'MANUAL' | 'DRIVE'
  driveFileId?: string
  driveFileIds?: string[]
  manualSourceIds?: string[]
}

/** Keeps a financial invoice active while at least one currently listed Drive or manual source remains. */
export function retainActiveInvoiceSources<T extends InvoiceSourceRecord>(entries: T[], currentDriveFileIds: ReadonlySet<string>): T[] {
  return entries.flatMap((entry) => {
    const driveFileIds = (entry.driveFileIds ?? (entry.driveFileId ? [entry.driveFileId] : [])).filter((id) => currentDriveFileIds.has(id))
    const manualSourceIds = entry.manualSourceIds ?? (entry.source === 'MANUAL' ? ['manual-upload'] : [])
    if (!manualSourceIds.length && !driveFileIds.length) return []
    return [{ ...entry, driveFileIds, driveFileId: driveFileIds[0], manualSourceIds }]
  })
}

/** Current Drive listings define active CSV sources; the historical index is never used here. */
export function retainCurrentDriveBankSources<T>(sources: Record<string, T>, currentDriveFileIds: ReadonlySet<string>): Record<string, T> {
  return Object.fromEntries(Object.entries(sources).filter(([id]) => currentDriveFileIds.has(id)))
}

export type MissingCounterDiagnostic<T extends { bank: { id: string; originalDescription: string; date: string; amount: number; statementSourceId?: string; statementFileName?: string }; status: string }> = {
  presentInSummaryOnly: { transactionId: string; subjectFingerprint: string; description: string; date: string; amount: number; status: string; source: string; reason: string; item: T }[]
  presentInMissingListOnly: { transactionId: string; subjectFingerprint: string; description: string; date: string; amount: number; status: string; source: string; reason: string; item: T }[]
}

/** Compares rendered counter sources by stable transaction ID and preserves detail for Auditor output. */
export function diagnoseMissingCounterDivergence<T extends { bank: { id: string; originalDescription: string; date: string; amount: number; statementSourceId?: string; statementFileName?: string }; status: string }>(summaryItems: T[], missingListItems: T[]): MissingCounterDiagnostic<T> {
  const summary = new Map(summaryItems.map((item) => [item.bank.id, item]))
  const missing = new Map(missingListItems.map((item) => [item.bank.id, item]))
  const detail = (item: T) => ({
    transactionId: item.bank.id, subjectFingerprint: item.bank.id, description: item.bank.originalDescription, date: item.bank.date, amount: item.bank.amount, status: item.status,
    source: item.bank.statementFileName ?? item.bank.statementSourceId ?? 'não informada',
    reason: `${item.status}; ${item.bank.originalDescription} · ${item.bank.date} · ${item.bank.amount}; fonte ${item.bank.statementFileName ?? item.bank.statementSourceId ?? 'não informada'}`,
    item,
  })
  return {
    presentInSummaryOnly: [...summary].filter(([id]) => !missing.has(id)).map(([, item]) => detail(item)),
    presentInMissingListOnly: [...missing].filter(([id]) => !summary.has(id)).map(([, item]) => detail(item)),
  }
}
