export type Source = 'SHEET' | 'BANK'
export type Direction = 'DEBIT' | 'CREDIT'
export type TransactionType = 'EXPENSE' | 'INVESTMENT' | 'INVESTMENT_INCOME' | 'INCOME' | 'TRANSFER' | 'CARD_PAYMENT' | 'REFUND' | 'OTHER'
export type InvestmentAction = 'APPLICATION' | 'RESCUE' | null
export type MatchStatus = 'MATCHED' | 'REVIEW' | 'REFUNDED' | 'CARD_DIVERGENCE' | 'CARD_PAYMENT_IDENTIFIED' | 'MISSING' | 'DUPLICATE' | 'UNMATCHED_SHEET' | 'IGNORED' | 'OUT_OF_SCOPE'
export type ReconciliationReasonCode = 'MISSING_NO_CANDIDATE' | 'LEGACY_PAYMENT_ALIAS' | 'OUT_OF_SCOPE_TRANSFER' | 'OUT_OF_SCOPE_INVESTMENT' | 'NOT_EXPENSE'

export interface LedgerTransaction {
  id: string
  source: 'SHEET'
  sheetRecordId: string
  bankTransactionId: null
  date: string
  description: string
  originalDescription: string
  amount: number
  direction: 'DEBIT'
  type: TransactionType
  investmentAction?: InvestmentAction
  paymentMethod: string
  category: string
  month: string
  year: string
  isFixed: boolean | null
  isEssential: boolean | null
  installment: number | null
  totalInstallments: number | null
  balanceAfter: null
  original: Record<string, string>
}

export interface BankTransaction {
  id: string
  sourceRow?: number
  statementSourceId?: string
  statementSourceIds?: string[]
  statementFileName?: string
  source: 'BANK'
  sheetRecordId: null
  bankTransactionId: string
  date: string
  description: string
  originalDescription: string
  amount: number
  direction: Direction
  directionKnown?: boolean
  type: TransactionType
  investmentAction?: InvestmentAction
  outOfScopeSubtype?: 'INVEST_FACIL_YIELD'
  paymentMethod: string
  category: ''
  month: ''
  year: string
  isFixed: null
  isEssential: null
  installment: number | null
  totalInstallments: number | null
  balanceAfter: number | null
  original: Record<string, string>
}

export type Transaction = LedgerTransaction | BankTransaction

export interface CsvDocument {
  headers: string[]
  rows: Record<string, string>[]
  auxiliaryRows: Record<string, string>[]
  auxiliaryRowsStartIndex?: number
  auxiliarySectionLabel: string | null
  statementPeriodStart: string | null
  statementPeriodEnd: string | null
  parseErrors: string[]
  delimiter: string
  metadataRowsIgnored: number
}

export interface ColumnMap {
  date: string
  description: string
  amount: string
  direction?: string
  debit?: string
  credit?: string
  paymentMethod?: string
  category?: string
  month?: string
  year?: string
  isFixed?: string
  isEssential?: string
  id?: string
  balance?: string
}

export interface RowIssue {
  row: number
  message: string
}

export interface ExcludedBankRow {
  row: number
  reason: 'EMPTY' | 'REPEATED_HEADER' | 'NO_MOVEMENT' | 'FOOTER_OR_METADATA' | 'OUTSIDE_STATEMENT_PERIOD' | 'DUPLICATE_AUXILIARY'
  date: string | null
  description: string
  document?: string | null
  balanceAfter: number | null
  amount: number | null
  direction: Direction | null
  credit?: number | null
  debit?: number | null
}

export interface ParsedTransactions<T extends Transaction> {
  transactions: T[]
  issues: RowIssue[]
  rowCount: number
  ignoredRows: number
  excludedRows?: ExcludedBankRow[]
}

export interface MatchCandidate {
  bankId: string
  sheetId: string
  score: number
  confidence: number
  reasons: string[]
  dateDistance: number
  descriptionSimilarity: number
  matchMethod?: 'SCORED' | 'STRUCTURAL' | 'MANUAL'
}

export interface ReconciliationItem {
  bank: BankTransaction
  sheet: LedgerTransaction | null
  status: MatchStatus
  candidate: MatchCandidate | null
  composition: LedgerTransaction[]
  compositionOptions: CardCompositionOption[]
  compositionStatus: 'MATCHED' | 'REVIEW' | 'NO_MATCH' | 'LIMITED' | null
  cardSummary?: CardPaymentSummary | null
  reasonCode?: ReconciliationReasonCode
  reviewReason?: 'REFUND_AMBIGUITY' | 'ASSIGNMENT_CONFLICT' | 'DIRECTION_UNCERTAIN'
}

export interface CardPaymentSummary {
  eligiblePurchaseCount: number
  eligiblePurchaseTotal: number
  difference: number
  searchHorizonDays: number
}

export interface CardStatementTransaction {
  id: string
  /** Real purchase date from the statement. `date` remains its compatibility alias. */
  purchaseDate: string
  /** Invoice due date from the statement; distinct from the purchase date. */
  invoiceDueDate: string | null
  date: string
  description: string
  originalDescription: string
  amount: number
  direction: 'DEBIT' | 'CREDIT'
  type: 'PURCHASE' | 'REFUND'
  financialStatus?: 'ACTIVE' | 'REFUNDED'
  refundGroupId?: string
  cardIdentifier: string
  installment: number | null
  totalInstallments: number | null
  city: string
  currency: string
  exchangeRate: number | null
  statementDueDate: string | null
  statementTotal: number | null
}

/** Financial charges/taxes that affect an invoice but are not individual purchases to reconcile. */
export interface CardStatementFinancialAdjustment {
  id: string
  date: string
  description: string
  amount: number
  direction: 'DEBIT' | 'CREDIT'
  kind: 'FEE' | 'TAX' | 'OTHER'
  cardIdentifier: string
}

/** Auditable relationship between a complete installment purchase group and one aggregate refund. */
export interface CardStatementRefundGroup {
  id: string
  cardIdentifier: string
  date: string
  merchant: string
  transactionIds: string[]
  refundTransactionId: string
  purchaseGroupAmount: number
  refundAmount: number
  netAmount: number
  installmentCount: number
}

export interface CardStatement {
  fileName: string
  sourceLayout?: 'MOBILE_APP' | 'INTERNET_BANKING' | 'UNKNOWN'
  pageCount: number
  statementIdentity: string
  transactions: CardStatementTransaction[]
  financialAdjustments?: CardStatementFinancialAdjustment[]
  refundGroups?: CardStatementRefundGroup[]
  cardSubtotals: { cardIdentifier: string; amount: number }[]
  reportedTotal: number | null
  /** How the invoice itself is paid (for example, debit from account). */
  invoicePaymentMethod?: string | null
  /** Day-of-month shown as the best purchase date; not an invoice close date. */
  bestPurchaseDay?: number | null
  purchasesDebitsTotal: number | null
  creditsPaymentsTotal: number | null
  previousBalance: number | null
  previousPayment: number | null
  accountingDifference: number | null
  dueDate: string | null
  nextClosingDate: string | null
  errors: string[]
}

export interface CardStatementMatch {
  transaction: CardStatementTransaction
  status: 'CARD_MATCHED' | 'CARD_GROUP_MATCHED' | 'CARD_REVIEW' | 'CARD_MISSING' | 'CARD_MISSING_CONFIRMED' | 'CARD_IGNORED' | 'CARD_REFUNDED'
  sheet: LedgerTransaction | null
  candidates: LedgerTransaction[]
  evidence?: string[]
}

export interface CardStatementReconciliation {
  matches: CardStatementMatch[]
  eligibleSheetTotal: number
  statementTotal: number
  difference: number
}

export interface CardCompositionOption {
  items: LedgerTransaction[]
  score: number
  reasons: string[]
}

export interface DuplicateGroup {
  source: Source
  transactionIds: string[]
  description: string
  date: string
  amount: number
}

export interface ReconciliationResult {
  items: ReconciliationItem[]
  bankRefundGroups: BankRefundGroup[]
  unmatchedSheet: LedgerTransaction[]
  duplicateGroups: DuplicateGroup[]
  totals: {
    bankDebit: number
    bankCredit: number
    sheetTotal: number
    initialBalance: number | null
    finalBalance: number | null
    calculatedFinalBalance: number | null
    balanceDifference: number | null
  }
}

export interface BankRefundGroup {
  id: string
  status: 'REFUNDED' | 'PARTIAL' | 'REVIEW'
  originalTransactionIds: string[]
  refundTransactionId: string
  grossAmount: number | null
  refundAmount: number
  netAmount: number | null
}
