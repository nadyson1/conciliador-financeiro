import type { BankTransaction, CardCompositionOption, DuplicateGroup, LedgerTransaction, MatchCandidate, ReconciliationItem, ReconciliationResult } from '../domain/types'
import { descriptionSimilarity, normalizeDescription } from '../importers/normalize'
import { auditBankBalance } from '../domain/bankBalanceAudit'

export const MATCHING_CONFIG = {
  points: { amount: 50, date: [25, 20, 15, 8], description: [25, 20, 12, 5], paymentMethod: 5 },
  minimumCandidateScore: 55,
  automaticMatchScore: 85,
  globalAmbiguityMargin: 10,
  cardPayment: { maxCandidates: 24, maxItems: 18, maxSearchNodes: 75_000, maxSolutions: 8, searchHorizonDays: 365 },
} as const

export interface ReviewDecisions {
  ignoredBankIds?: Set<string>
  rejectedPairKeys?: Set<string>
  confirmedPairs?: Map<string, string>
  confirmedCompositions?: Map<string, string[]>
  identifiedCardPaymentIds?: Set<string>
}

export const pairKey = (bankId: string, sheetId: string) => `${bankId}::${sheetId}`
export const canonicalCompositionKey = (items: LedgerTransaction[]) => items.map((item) => item.sheetRecordId || item.id).sort().join('|')
const sheetIdentity = (sheet: LedgerTransaction) => sheet.sheetRecordId || sheet.id
const genericBankDescriptions = new Set(['pix enviado', 'pix recebido', 'pix qr code dinamico', 'pix qr code estatico', 'compra cartao visa', 'cod lanc 0', 'conta de telefone'])
export const isGenericBankDescription = (description: string) => genericBankDescriptions.has(normalizeDescription(description))
function dayNumber(date: string) { const [year, month, day] = date.split('-').map(Number); return Math.floor(Date.UTC(year, month - 1, day) / 86_400_000) }
function dateDistance(a: string, b: string) { return Math.abs(dayNumber(a) - dayNumber(b)) }
const isInvestmentSheet = (sheet: LedgerTransaction) => sheet.type === 'INVESTMENT' || normalizeDescription(sheet.paymentMethod) === 'investimento'
const cardPaymentMethod = (sheet: LedgerTransaction) => normalizeDescription(sheet.paymentMethod) === 'credito bradesco'
const isPixPaymentDescription = (description: string) => /^(?:pix enviado|pix qr code dinamico|pix qr code estatico|envio pix)(?: |$)/.test(normalizeDescription(description))
const isLegacyTransferAlias = (bank: BankTransaction, sheet: LedgerTransaction) => isPixPaymentDescription(bank.originalDescription)
  && normalizeDescription(sheet.paymentMethod) === 'transferencia' && sheet.type === 'TRANSFER'

function candidate(bank: BankTransaction, sheet: LedgerTransaction): MatchCandidate | null {
  if (bank.direction !== 'DEBIT' || sheet.direction !== 'DEBIT' || bank.amount !== sheet.amount) return null
  const legacyAlias = isLegacyTransferAlias(bank, sheet)
  if (bank.type === 'TRANSFER' || bank.type === 'CARD_PAYMENT' || bank.type === 'INCOME' || bank.type === 'INVESTMENT_INCOME' || (sheet.type === 'TRANSFER' && !legacyAlias) || sheet.type === 'CARD_PAYMENT') return null
  const investmentPair = bank.type === 'INVESTMENT' && isInvestmentSheet(sheet)
  if (bank.type === 'INVESTMENT' && !investmentPair) return null
  if (sheet.type === 'INVESTMENT' && !investmentPair) return null
  if (!investmentPair && sheet.type !== 'EXPENSE' && !legacyAlias) return null
  if (bank.type !== 'EXPENSE' && bank.type !== 'OTHER' && !investmentPair) return null
  const distance = dateDistance(bank.date, sheet.date)
  if (!investmentPair && distance > 3) return null
  const genericDescription = isGenericBankDescription(bank.originalDescription)
  const similarity = genericDescription ? 0 : descriptionSimilarity(bank.originalDescription, sheet.originalDescription)
  const reasons: string[] = ['Valor exato']
  let score = MATCHING_CONFIG.points.amount
  const datePoints = distance === 0 ? MATCHING_CONFIG.points.date[0] : distance === 1 ? MATCHING_CONFIG.points.date[1] : distance === 2 ? MATCHING_CONFIG.points.date[2] : distance === 3 ? MATCHING_CONFIG.points.date[3] : 0
  score += datePoints
  if (datePoints) reasons.push(distance === 0 ? 'Mesma data' : `Data com ${distance} dia${distance === 1 ? '' : 's'} de diferença`)
  if (bank.directionKnown === false) reasons.push('Direção não confirmada no arquivo')
  else reasons.push('Direção compatível')
  if (genericDescription) reasons.push('Descrição bancária genérica; não usada para reduzir a compatibilidade')
  if (legacyAlias) reasons.push('Alias histórico de forma de pagamento: Pix ↔ Transferência')
  if (similarity >= 0.999) { score += MATCHING_CONFIG.points.description[0]; reasons.push('Descrição exata após normalização') }
  else if (similarity >= 0.72) { score += MATCHING_CONFIG.points.description[1]; reasons.push('Descrição altamente semelhante') }
  else if (similarity >= 0.45) { score += MATCHING_CONFIG.points.description[2]; reasons.push('Descrição parcialmente semelhante') }
  else if (similarity > 0) { score += MATCHING_CONFIG.points.description[3]; reasons.push('Descrição com poucos termos em comum') }
  if (investmentPair) { score += MATCHING_CONFIG.points.paymentMethod; reasons.push('Forma de pagamento Investimento') }
  else if (legacyAlias) reasons.push('Forma de pagamento Transferência reconhecida como alias histórico')
  if (isPixPaymentDescription(bank.originalDescription) && normalizeDescription(sheet.paymentMethod) === 'pix') { score += MATCHING_CONFIG.points.paymentMethod; reasons.push('Forma de pagamento Pix compatível') }
  else if (bank.paymentMethod && sheet.paymentMethod && normalizeDescription(bank.paymentMethod) === normalizeDescription(sheet.paymentMethod)) { score += MATCHING_CONFIG.points.paymentMethod; reasons.push('Forma de pagamento compatível') }
  if (score < MATCHING_CONFIG.minimumCandidateScore) return null
  const dateConfidence = distance === 0 ? 30 : distance === 1 ? 24 : distance === 2 ? 18 : distance === 3 ? 11 : 0
  const confidence = Math.min(94, 45 + (bank.directionKnown === false ? 0 : 15) + dateConfidence + Math.round(similarity * 8))
  return { bankId: bank.id, sheetId: sheet.id, score, confidence, reasons, dateDistance: distance, descriptionSimilarity: similarity, matchMethod: 'SCORED' }
}

/** Returns only rows that pass the same minimum plausibility rules used by reconciliation. */
export function findPlausibleLedgerCandidates(bank: BankTransaction, sheets: LedgerTransaction[]) {
  return sheets.filter((sheet) => candidate(bank, sheet) != null)
}

function structuralCandidate(candidateItem: MatchCandidate, bank: BankTransaction, locallyUnique: boolean): MatchCandidate {
  const genericDescription = isGenericBankDescription(bank.originalDescription)
  return {
    ...candidateItem,
    score: candidateItem.score,
    confidence: candidateItem.confidence,
    matchMethod: 'STRUCTURAL',
    reasons: [
      'Valor exato',
      'Mesma data',
      'Direção compatível',
      locallyUnique ? 'Única candidata plausível' : 'Correspondência 1:1 escolhida globalmente',
      genericDescription ? 'Descrição bancária genérica; não penalizada' : candidateItem.descriptionSimilarity < 0.45 ? 'Descrição com baixa similaridade; evidência estrutural prevaleceu' : 'Descrição compatível',
      ...(candidateItem.reasons.includes('Alias histórico de forma de pagamento: Pix ↔ Transferência') ? ['Alias histórico de forma de pagamento: Pix ↔ Transferência'] : []),
    ],
  }
}

export function findDuplicateGroups(sheets: LedgerTransaction[]): DuplicateGroup[] {
  const groups: DuplicateGroup[] = []
  const compare = (items: LedgerTransaction[]) => {
    const used = new Set<string>()
    for (let i = 0; i < items.length; i += 1) {
      if (used.has(items[i].id)) continue
      const group = [items[i]]
      for (let j = i + 1; j < items.length; j += 1) {
        const a = items[i], b = items[j]
        if (!used.has(b.id) && a.date === b.date && a.amount === b.amount && descriptionSimilarity(a.description, b.description) >= 0.78) group.push(b)
      }
      if (group.length > 1) { group.forEach((item) => used.add(item.id)); groups.push({ source: 'SHEET', transactionIds: group.map((item) => item.id), description: group[0].description, date: group[0].date, amount: group[0].amount }) }
    }
  }
  compare(sheets)
  return groups
}

type CompositionSearch = { options: CardCompositionOption[]; limited: boolean; candidateCount: number; candidateTotal: number }
function searchCompositions(bank: BankTransaction, sheets: LedgerTransaction[]): CompositionSearch {
  const config = MATCHING_CONFIG.cardPayment
  const seenIdentities = new Set<string>()
  const candidates = sheets.filter((sheet) => {
    const identity = sheetIdentity(sheet)
    if (!cardPaymentMethod(sheet) || sheet.type !== 'EXPENSE' || sheet.date > bank.date || dayNumber(bank.date) - dayNumber(sheet.date) > config.searchHorizonDays || seenIdentities.has(identity)) return false
    seenIdentities.add(identity)
    return true
  }).sort((a, b) => b.date.localeCompare(a.date) || a.id.localeCompare(b.id))
  const candidateTotal = candidates.reduce((total, sheet) => total + sheet.amount, 0)
  if (candidates.length > config.maxCandidates) return { options: [], limited: true, candidateCount: candidates.length, candidateTotal }
  const suffix = Array(candidates.length + 1).fill(0)
  for (let i = candidates.length - 1; i >= 0; i -= 1) suffix[i] = suffix[i + 1] + candidates[i].amount
  const solutions = new Map<string, CardCompositionOption>()
  let nodes = 0, limited = false
  const chosen: LedgerTransaction[] = []
  const scoreComposition = (items: LedgerTransaction[]): CardCompositionOption => {
    const ages = items.map((sheet) => dayNumber(bank.date) - dayNumber(sheet.date))
    const averageAge = ages.reduce((sum, age) => sum + age, 0) / ages.length
    const spread = Math.max(...ages) - Math.min(...ages)
    const horizon = config.searchHorizonDays
    const score = 50 + Math.round(25 * (1 - Math.min(averageAge, horizon) / horizon)) + Math.round(25 * (1 - Math.min(spread, horizon) / horizon))
    return { items: [...items].sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id)), score, reasons: ['Soma exata em centavos', 'Todos os itens usam Crédito_Bradesco', 'Nenhum item já confirmado em outra fatura', `Compras em média ${Math.round(averageAge)} dias antes do pagamento`, `Período do conjunto: ${spread} dia${spread === 1 ? '' : 's'}`] }
  }
  const visit = (index: number, total: number) => {
    nodes += 1
    if (nodes > config.maxSearchNodes) { limited = true; return }
    if (total === bank.amount && chosen.length) {
      const option = scoreComposition(chosen)
      const key = canonicalCompositionKey(option.items)
      const existing = solutions.get(key)
      if (!existing || option.score > existing.score) solutions.set(key, option)
      return
    }
    if (index >= candidates.length || total > bank.amount || chosen.length >= config.maxItems || total + suffix[index] < bank.amount || limited) return
    chosen.push(candidates[index]); visit(index + 1, total + candidates[index].amount); chosen.pop()
    visit(index + 1, total)
  }
  visit(0, 0)
  const options = [...solutions.values()].sort((a, b) => b.score - a.score || canonicalCompositionKey(a.items).localeCompare(canonicalCompositionKey(b.items))).slice(0, config.maxSolutions)
  return { options, limited, candidateCount: candidates.length, candidateTotal }
}

function emptyItem(bank: BankTransaction, status: ReconciliationItem['status'], reasonCode?: ReconciliationItem['reasonCode']): ReconciliationItem {
  return { bank, sheet: null, status, candidate: null, composition: [], compositionOptions: [], compositionStatus: null, cardSummary: null, ...(reasonCode ? { reasonCode } : {}) }
}

export function reconcile(banks: BankTransaction[], sheets: LedgerTransaction[], decisions: ReviewDecisions = {}): ReconciliationResult {
  const ignored = decisions.ignoredBankIds ?? new Set<string>(), rejected = decisions.rejectedPairKeys ?? new Set<string>()
  const confirmed = decisions.confirmedPairs ?? new Map<string, string>(), confirmedCompositions = decisions.confirmedCompositions ?? new Map<string, string[]>()
  const identifiedCardPaymentIds = decisions.identifiedCardPaymentIds ?? new Set<string>()
  const duplicateGroups = findDuplicateGroups(sheets)
  const allCandidates = banks.flatMap((bank) => sheets.map((sheet) => candidate(bank, sheet)).filter((item): item is MatchCandidate => item != null && !rejected.has(pairKey(item.bankId, item.sheetId))))
  const byBank = groupBy(allCandidates, (item) => item.bankId)
  const usedBanks = new Set<string>(), usedSheets = new Set<string>(), matches = new Map<string, MatchCandidate>()
  for (const [bankId, sheetId] of confirmed) {
    const bank = banks.find((item) => item.id === bankId), sheet = sheets.find((item) => item.id === sheetId)
    if (!bank || !sheet || usedBanks.has(bankId) || usedSheets.has(sheetId) || !candidate(bank, sheet)) continue
    const base = allCandidates.find((item) => item.bankId === bankId && item.sheetId === sheetId) ?? { bankId, sheetId, score: 100, confidence: 100, reasons: [], dateDistance: dateDistance(bank.date, sheet.date), descriptionSimilarity: descriptionSimilarity(bank.description, sheet.description) }
    const forced: MatchCandidate = { ...base, score: 100, confidence: 100, reasons: ['Correspondência confirmada manualmente', ...base.reasons], matchMethod: 'MANUAL' }
    matches.set(bankId, forced); usedBanks.add(bankId); usedSheets.add(sheetId)
  }
  const remainingCandidates = allCandidates.filter((item) => !ignored.has(item.bankId) && !usedBanks.has(item.bankId) && !usedSheets.has(item.sheetId))
  const planned = new Map<string, MatchCandidate>()
  for (const component of candidateComponents(remainingCandidates)) {
    const optimum = solveAssignment(component)
    const componentByBank = groupBy(component, (item) => item.bankId), componentBySheet = groupBy(component, (item) => item.sheetId)
    for (const selected of optimum.pairs) {
      const bank = banks.find((entry) => entry.id === selected.bankId)
      if (!bank) continue
      const alternative = solveAssignment(component, pairKey(selected.bankId, selected.sheetId))
      const globalMargin = optimum.score - alternative.score
      const componentBanks = new Set(component.map((item) => item.bankId)), componentSheets = new Set(component.map((item) => item.sheetId))
      const bankCandidates = componentByBank.get(selected.bankId) ?? []
      const selectedSheet = sheets.find((entry) => entry.id === selected.sheetId)
      const exactPixPreferred = componentBanks.size === 1 && selected.dateDistance === 0 && isPixPaymentDescription(bank.originalDescription) && selectedSheet != null
        && normalizeDescription(selectedSheet.paymentMethod) === 'pix'
        && bankCandidates.filter((item) => normalizeDescription(sheets.find((entry) => entry.id === item.sheetId)?.paymentMethod ?? '') === 'pix').length === 1
        && bankCandidates.filter((item) => item.sheetId !== selected.sheetId && normalizeDescription(sheets.find((entry) => entry.id === item.sheetId)?.paymentMethod ?? '') === 'transferencia').length === bankCandidates.length - 1
      const locallyUniqueSameDay = selected.dateDistance === 0 && (bankCandidates.length === 1 || exactPixPreferred) && componentBySheet.get(selected.sheetId)?.length === 1
      const completeAssignment = componentBanks.size === componentSheets.size && optimum.pairs.length === componentBanks.size
      const onlySameDayOptionForBank = (componentByBank.get(selected.bankId) ?? []).filter((item) => item.dateDistance === 0).length === 1
      const globalSameDayResolution = selected.dateDistance === 0 && completeAssignment && onlySameDayOptionForBank
      const structuralSameDay = locallyUniqueSameDay || globalSameDayResolution
      const globallyAmbiguous = globalMargin < MATCHING_CONFIG.globalAmbiguityMargin && !globalSameDayResolution && !exactPixPreferred
      const plannedCandidate = {
        ...selected,
        reasons: [...selected.reasons, ...(globallyAmbiguous ? ['Mais de uma candidata plausível; revisão necessária', `Há soluções globais próximas (diferença de ${globalMargin} pontos)`] : globalSameDayResolution && globalMargin < MATCHING_CONFIG.globalAmbiguityMargin ? ['Solução global completa; par de mesma data priorizado'] : [`Combinação global supera a alternativa por ${globalMargin} pontos`])],
      }
      planned.set(selected.bankId, plannedCandidate)

      const threshold = bank.type === 'INVESTMENT' ? 75 : MATCHING_CONFIG.automaticMatchScore
      const dateNeedsReview = selected.dateDistance > 0 && selected.dateDistance <= 3
      const hasStrongEvidence = structuralSameDay || (!dateNeedsReview && selected.score >= threshold)
      if (bank.directionKnown === false || globallyAmbiguous || !hasStrongEvidence) continue

      const matched = structuralSameDay ? structuralCandidate(plannedCandidate, bank, locallyUniqueSameDay) : plannedCandidate
      matches.set(selected.bankId, matched)
      usedBanks.add(selected.bankId); usedSheets.add(selected.sheetId)
    }
  }
  const plannedSheetIds = new Set([...planned.values()].map((item) => item.sheetId))

  const cardOptions = new Map<string, CompositionSearch>()
  const cardBanks = banks.filter((bank) => bank.type === 'CARD_PAYMENT').sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id))
  const compositionByBank = new Map<string, LedgerTransaction[]>()
  const confirmedCardSheetIds = new Set<string>()
  const confirmedCardSheetIdentities = new Set<string>()
  for (const bank of cardBanks) {
    if (identifiedCardPaymentIds.has(bank.id)) continue
    const requested = confirmedCompositions.get(bank.id)
    if (!requested?.length || requested.length > MATCHING_CONFIG.cardPayment.maxItems || new Set(requested).size !== requested.length) continue
    const chosen = requested.map((identity) => sheets.find((sheet) => sheetIdentity(sheet) === identity))
    if (chosen.some((sheet) => !sheet || usedSheets.has(sheet.id) || confirmedCardSheetIds.has(sheet.id) || confirmedCardSheetIdentities.has(sheetIdentity(sheet)) || !cardPaymentMethod(sheet) || sheet.type !== 'EXPENSE' || sheet.date > bank.date || dayNumber(bank.date) - dayNumber(sheet.date) > MATCHING_CONFIG.cardPayment.searchHorizonDays) || chosen.reduce((sum, sheet) => sum + (sheet?.amount ?? 0), 0) !== bank.amount) continue
    const valid = chosen as LedgerTransaction[]
    compositionByBank.set(bank.id, valid)
    valid.forEach((sheet) => { confirmedCardSheetIds.add(sheet.id); confirmedCardSheetIdentities.add(sheetIdentity(sheet)); usedSheets.add(sheet.id) })
  }
  for (const bank of cardBanks) {
    if (compositionByBank.has(bank.id) || ignored.has(bank.id) || identifiedCardPaymentIds.has(bank.id)) continue
    // Suggestions for unconfirmed bills are independent: only explicit links reserve sheet rows.
    const search = searchCompositions(bank, sheets.filter((sheet) => !usedSheets.has(sheet.id) && !confirmedCardSheetIds.has(sheet.id) && !confirmedCardSheetIdentities.has(sheetIdentity(sheet))))
    cardOptions.set(bank.id, search)
  }

  const items: ReconciliationItem[] = banks.map((bank) => {
    if (ignored.has(bank.id)) return emptyItem(bank, 'IGNORED')
    if (bank.type === 'CARD_PAYMENT') {
      if (identifiedCardPaymentIds.has(bank.id)) return emptyItem(bank, 'CARD_PAYMENT_IDENTIFIED')
      const composition = compositionByBank.get(bank.id) ?? []
      const search = cardOptions.get(bank.id)
      const compositionStatus = composition.length ? 'MATCHED' : search?.limited ? 'LIMITED' : search?.options.length ? 'REVIEW' : 'NO_MATCH'
      const status = composition.length ? 'MATCHED' : 'CARD_DIVERGENCE'
      return {
        ...emptyItem(bank, status), composition, compositionOptions: search?.options ?? [], compositionStatus,
        cardSummary: search ? { eligiblePurchaseCount: search.candidateCount, eligiblePurchaseTotal: search.candidateTotal, difference: bank.amount - search.candidateTotal, searchHorizonDays: MATCHING_CONFIG.cardPayment.searchHorizonDays } : null,
      }
    }
    if (bank.type === 'INVESTMENT') {
      const matchedInvestment = matches.get(bank.id)
      return { ...emptyItem(bank, 'OUT_OF_SCOPE', 'OUT_OF_SCOPE_INVESTMENT'), sheet: matchedInvestment ? sheets.find((sheet) => sheet.id === matchedInvestment.sheetId) ?? null : null, candidate: matchedInvestment ?? null }
    }
    if (bank.type === 'INVESTMENT_INCOME') return emptyItem(bank, 'OUT_OF_SCOPE', 'OUT_OF_SCOPE_INVESTMENT')
    if (bank.type === 'TRANSFER') return emptyItem(bank, 'OUT_OF_SCOPE', 'OUT_OF_SCOPE_TRANSFER')
    if (bank.direction === 'CREDIT' || bank.type === 'INCOME') return emptyItem(bank, 'OUT_OF_SCOPE', 'NOT_EXPENSE')
    const matched = matches.get(bank.id)
    if (matched) return { ...emptyItem(bank, 'MATCHED', matched.reasons.includes('Alias histórico de forma de pagamento: Pix ↔ Transferência') ? 'LEGACY_PAYMENT_ALIAS' : undefined), sheet: sheets.find((sheet) => sheet.id === matched.sheetId) ?? null, candidate: matched }
    const assigned = planned.get(bank.id)
    if (assigned) return { ...emptyItem(bank, 'REVIEW'), sheet: sheets.find((sheet) => sheet.id === assigned.sheetId) ?? null, candidate: assigned }
    const plausible = (byBank.get(bank.id) ?? []).filter((item) => !usedSheets.has(item.sheetId))
    const available = plausible.filter((item) => !plannedSheetIds.has(item.sheetId)).sort((a, b) => b.score - a.score)
    const best = available[0]
    if (best) return { ...emptyItem(bank, 'REVIEW'), sheet: sheets.find((sheet) => sheet.id === best.sheetId) ?? null, candidate: best }
    if (plausible.length) return emptyItem(bank, 'REVIEW')
    if (bank.directionKnown === false) return emptyItem(bank, 'REVIEW')
    return emptyItem(bank, 'MISSING', 'MISSING_NO_CANDIDATE')
  })
  const matchedSheetIds = new Set([...matches.values()].map((item) => item.sheetId))
  for (const composition of compositionByBank.values()) composition.forEach((sheet) => matchedSheetIds.add(sheet.id))
  const reviewSheetIds = new Set(items.filter((item) => item.status === 'REVIEW' && item.sheet).map((item) => item.sheet!.id))
  const duplicateSheetIds = new Set(duplicateGroups.filter((group) => group.source === 'SHEET').flatMap((group) => group.transactionIds))
  const unmatchedSheet = sheets.filter((sheet) => sheet.type === 'EXPENSE' && !matchedSheetIds.has(sheet.id) && !reviewSheetIds.has(sheet.id) && !duplicateSheetIds.has(sheet.id))
  const balanceAudit = auditBankBalance(banks)
  return { items, unmatchedSheet, duplicateGroups, totals: {
    bankDebit: banks.filter((bank) => bank.direction === 'DEBIT').reduce((sum, bank) => sum + bank.amount, 0),
    bankCredit: banks.filter((bank) => bank.direction === 'CREDIT').reduce((sum, bank) => sum + bank.amount, 0), sheetTotal: sheets.reduce((sum, sheet) => sum + sheet.amount, 0),
    initialBalance: balanceAudit.initialBalance, finalBalance: balanceAudit.reportedBalance,
    calculatedFinalBalance: balanceAudit.calculatedBalance, balanceDifference: balanceAudit.difference,
  } }
}

function groupBy<T, K extends string>(items: T[], key: (item: T) => K) {
  return items.reduce((groups, item) => { const value = key(item); (groups.get(value) ?? groups.set(value, []).get(value)!).push(item); return groups }, new Map<K, T[]>())
}

type AssignmentSolution = { score: number; pairs: MatchCandidate[] }

function solveAssignment(candidates: MatchCandidate[], excludedPair?: string): AssignmentSolution {
  const bankIds = [...new Set(candidates.map((item) => item.bankId))].sort()
  const sheetIds = [...new Set(candidates.map((item) => item.sheetId))].sort()
  if (!bankIds.length || !sheetIds.length) return { score: 0, pairs: [] }

  const candidateByPair = new Map(candidates.map((item) => [pairKey(item.bankId, item.sheetId), item]))
  const columnIds = [...sheetIds, ...bankIds.map((id) => `__unmatched__${id}`)]
  const rowCount = bankIds.length, columnCount = columnIds.length
  const costs = bankIds.map((bankId) => columnIds.map((columnId, columnIndex) => {
    if (columnIndex >= sheetIds.length) return 0
    const edgeKey = pairKey(bankId, columnId)
    const edge = edgeKey === excludedPair ? undefined : candidateByPair.get(edgeKey)
    return edge ? -edge.score : 0
  }))

  // Hungarian assignment for a rectangular cost matrix; dummy columns allow any bank to remain unmatched.
  const u = Array(rowCount + 1).fill(0), v = Array(columnCount + 1).fill(0)
  const p = Array(columnCount + 1).fill(0), way = Array(columnCount + 1).fill(0)
  for (let i = 1; i <= rowCount; i += 1) {
    p[0] = i
    let j0 = 0
    const minv = Array(columnCount + 1).fill(Number.POSITIVE_INFINITY)
    const used = Array(columnCount + 1).fill(false)
    do {
      used[j0] = true
      const i0 = p[j0]
      let delta = Number.POSITIVE_INFINITY, j1 = 0
      for (let j = 1; j <= columnCount; j += 1) {
        if (used[j]) continue
        const current = costs[i0 - 1][j - 1] - u[i0] - v[j]
        if (current < minv[j]) { minv[j] = current; way[j] = j0 }
        if (minv[j] < delta) { delta = minv[j]; j1 = j }
      }
      for (let j = 0; j <= columnCount; j += 1) {
        if (used[j]) { u[p[j]] += delta; v[j] -= delta }
        else minv[j] -= delta
      }
      j0 = j1
    } while (p[j0] !== 0)
    do {
      const j1 = way[j0]
      p[j0] = p[j1]
      j0 = j1
    } while (j0 !== 0)
  }

  const pairs: MatchCandidate[] = []
  for (let j = 1; j <= columnCount; j += 1) {
    if (!p[j] || j > sheetIds.length) continue
    const bankId = bankIds[p[j] - 1], sheetId = sheetIds[j - 1]
    const edgeKey = pairKey(bankId, sheetId)
    const edge = edgeKey === excludedPair ? undefined : candidateByPair.get(edgeKey)
    if (edge) pairs.push(edge)
  }
  return { score: pairs.reduce((total, item) => total + item.score, 0), pairs }
}

function candidateComponents(candidates: MatchCandidate[]): MatchCandidate[][] {
  const byBank = groupBy(candidates, (item) => item.bankId), bySheet = groupBy(candidates, (item) => item.sheetId)
  const unseenBanks = new Set(byBank.keys()), components: MatchCandidate[][] = []
  while (unseenBanks.size) {
    const first = [...unseenBanks].sort()[0]
    const bankQueue = [first], component = new Map<string, MatchCandidate>()
    const seenBanks = new Set<string>(), seenSheets = new Set<string>()
    while (bankQueue.length) {
      const bankId = bankQueue.shift()!
      if (seenBanks.has(bankId)) continue
      seenBanks.add(bankId); unseenBanks.delete(bankId)
      for (const edge of byBank.get(bankId) ?? []) {
        component.set(pairKey(edge.bankId, edge.sheetId), edge)
        if (seenSheets.has(edge.sheetId)) continue
        seenSheets.add(edge.sheetId)
        for (const linked of bySheet.get(edge.sheetId) ?? []) if (!seenBanks.has(linked.bankId)) bankQueue.push(linked.bankId)
      }
    }
    components.push([...component.values()])
  }
  return components
}
