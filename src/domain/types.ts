export type Source = 'SHEET' | 'BANK'
export type Direction = 'DEBIT' | 'CREDIT'
export type TransactionType = 'EXPENSE' | 'INVESTMENT' | 'INCOME' | 'TRANSFER' | 'CARD_PAYMENT' | 'OTHER'
export type InvestmentAction = 'APPLICATION' | 'RESCUE' | null
export type MatchStatus = 'MATCHED' | 'REVIEW' | 'CARD_DIVERGENCE' | 'CARD_PAYMENT_IDENTIFIED' | 'MISSING' | 'DUPLICATE' | 'UNMATCHED_SHEET' | 'IGNORED' | 'OUT_OF_SCOPE'

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

export interface ParsedTransactions<T extends Transaction> {
  transactions: T[]
  issues: RowIssue[]
  rowCount: number
  ignoredRows: number
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
}

export interface CardPaymentSummary {
  eligiblePurchaseCount: number
  eligiblePurchaseTotal: number
  difference: number
  searchHorizonDays: number
}

export interface CardStatementTransaction {
  id: string
  date: string
  description: string
  originalDescription: string
  amount: number
  direction: 'DEBIT' | 'CREDIT'
  type: 'PURCHASE' | 'REFUND'
  financialStatus?: 'ACTIVE' | 'REFUNDED'
  cardIdentifier: string
  installment: number | null
  totalInstallments: number | null
  city: string
  currency: string
  exchangeRate: number | null
  statementDueDate: string | null
  statementTotal: number | null
}

export interface CardStatement {
  fileName: string
  pageCount: number
  statementIdentity: string
  transactions: CardStatementTransaction[]
  cardSubtotals: { cardIdentifier: string; amount: number }[]
  reportedTotal: number | null
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
  status: 'CARD_MATCHED' | 'CARD_REVIEW' | 'CARD_MISSING' | 'CARD_MISSING_CONFIRMED' | 'CARD_REFUNDED'
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
