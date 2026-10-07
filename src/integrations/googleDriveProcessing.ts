export type DriveFileProcessingStatus = 'PROCESSED_UNIQUE' | 'DUPLICATE_FINANCIAL' | 'PARSE_ERROR' | 'PROCESSING_ERROR' | 'UNSUPPORTED' | 'SKIPPED'

export interface DriveFileOutcome {
  fileId: string
  fileName: string
  status: DriveFileProcessingStatus
  financialIdentity?: string
  errorMessage?: string
}

export interface DrivePdfProcessingResult {
  processed: number
  errors: number
  duplicates: number
  semanticIdentities: string[]
  fileOutcomes?: DriveFileOutcome[]
}

/** Prefer a per-file result; use final aggregate counters only as a fallback. */
export function resolveDrivePdfFileOutcome(fileId: string, fileName: string, result: DrivePdfProcessingResult | null | undefined): DriveFileOutcome {
  const explicit = result?.fileOutcomes?.find((outcome) => outcome.fileId === fileId || outcome.fileName === fileName)
  if (explicit) return explicit
  if (result && result.processed > 0) return { fileId, fileName, status: 'PROCESSED_UNIQUE', financialIdentity: result.semanticIdentities[0] }
  if (result && result.duplicates > 0) return { fileId, fileName, status: 'DUPLICATE_FINANCIAL', financialIdentity: result.semanticIdentities[0] }
  if (result?.errors) return { fileId, fileName, status: 'PARSE_ERROR' }
  return { fileId, fileName, status: 'PROCESSING_ERROR', errorMessage: 'O processamento terminou sem resultado por arquivo.' }
}

export function summarizeDriveInvoiceOutcomes(filesFound: number, outcomes: DriveFileOutcome[]) {
  const invoicesUnique = new Set(outcomes
    .filter((outcome) => outcome.status === 'PROCESSED_UNIQUE' || outcome.status === 'DUPLICATE_FINANCIAL')
    .map((outcome) => outcome.financialIdentity)
    .filter((identity): identity is string => Boolean(identity))).size
  return {
    invoicesFound: filesFound,
    invoicesUnique,
    invoiceDuplicates: outcomes.filter((outcome) => outcome.status === 'DUPLICATE_FINANCIAL').length,
    invoiceErrors: outcomes.filter((outcome) => outcome.status === 'PARSE_ERROR' || outcome.status === 'PROCESSING_ERROR').length,
    invoiceUnsupported: outcomes.filter((outcome) => outcome.status === 'UNSUPPORTED').length,
    invoiceSkipped: outcomes.filter((outcome) => outcome.status === 'SKIPPED').length,
    invoiceFileOutcomes: outcomes,
  }
}
