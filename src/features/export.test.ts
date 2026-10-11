import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AuditFinding } from '../domain/consistencyAudit'
import { createAuditDiagnosticPayload, exportAuditDiagnosticJson, exportAuditFindings, exportCsv, toAuditCsvRow } from './export'
import { createAuditInputSnapshot } from '../domain/auditInputSnapshot'

describe('exportação local', () => {
  afterEach(() => vi.restoreAllMocks())
  it('cria um CSV com BOM, separador regional e texto escapado no navegador', () => {
    const click = vi.fn()
    const anchor = { href: '', download: '', click } as unknown as HTMLAnchorElement
    vi.spyOn(document, 'createElement').mockReturnValue(anchor)
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:local')
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
    exportCsv('ausencias.csv', ['Descrição', 'Valor'], [['Loja "A"', 1234]])
    expect(anchor.download).toBe('ausencias.csv')
    expect(anchor.href).toBe('blob:local')
    expect(click).toHaveBeenCalledOnce()
    expect(URL.createObjectURL).toHaveBeenCalledOnce()
  })

  it('exporta todos os findings uma linha por finding, incluindo os ocultos e as duas camadas de diagnóstico', async () => {
    const click = vi.fn()
    const anchor = { href: '', download: '', click } as unknown as HTMLAnchorElement
    let blob: Blob | undefined
    vi.spyOn(document, 'createElement').mockReturnValue(anchor)
    vi.spyOn(URL, 'createObjectURL').mockImplementation((value) => { blob = value as Blob; return 'blob:audit' })
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
    const finding: AuditFinding = {
      id: 'bank-sheet-finding', code: 'MISSING_COM_CANDIDATO', severity: 'REVIEW', title: 'Título técnico original', detail: 'Diagnóstico detalhado.',
      category: 'STATE', invariantId: 'INV-03', diagnosis: 'Diagnóstico estruturado.', whyItMatters: 'Evita ausência indevida.', recommendedAction: 'Reanalisar.', diagnosticConfidence: 'HIGH', safeAutomaticAction: false, status: 'ACTIVE', explanationSource: 'NONE',
      technical: {
        bank: { source: 'BANK', id: 'bank-tx-1', bankTransactionId: 'bank-tx-1', date: '2026-06-12', originalDescription: 'PIX ENVIADO', amount: 1250, counterpartyName: 'Loja São João', original: { rawCsv: 'conteúdo bruto privado' }, statementFileName: 'extrato.csv', statementSourceId: 'drive-file-1', statementFormats: ['OFX'] },
        row: { id: 'sheet-row-1', description: 'Mercado São João', date: '2026-06-12', amount: 1250 },
        decision: { kind: 'PAIR_CONFIRMED', key: 'decision-1', identities: ['subject-1'], selected: ['sheet-row-1'] }, currentStatus: 'MISSING', expectedStatus: 'MATCHED',
      },
    }
    const pdfFinding = {
      id: 'pdf-finding', code: 'CARD_MISSING_NO_CANDIDATE', severity: 'CRITICAL', title: 'Título PDF', detail: 'Compra em análise.',
      technical: { statement: { statementIdentity: 'invoice-1', dueDate: '2026-07-12', fileName: 'fatura.pdf', sourceLayout: 'INTERNET_BANKING' }, transaction: { id: 'pdf-tx-1', type: 'PURCHASE', cardIdentifier: 'XXXX 1234', purchaseDate: '2026-06-01', date: '2026-06-01', amount: 2500, originalDescription: 'Assinatura Exemplo' }, currentStatus: 'CARD_MISSING', expectedState: 'CARD_MATCHED' },
    } as unknown as AuditFinding
    const additionalFindings: AuditFinding[] = [
      { id: 'maintenance', code: 'MISSING_ADDED_TO_SHEET_ORPHAN', severity: 'INFO', status: 'MAINTENANCE', category: 'DECISION', invariantId: 'INV-08', diagnosis: 'Ref técnica.', whyItMatters: 'Acompanhar vínculo.', recommendedAction: 'Revisar quando necessário.', diagnosticConfidence: 'MEDIUM', safeAutomaticAction: false, explanationSource: 'SOURCE_LIFECYCLE', title: 'Manutenção', detail: 'Referência técnica ausente.' },
      { id: 'legacy', code: 'LEGACY_FINGERPRINT_MATCH', severity: 'INFO', status: 'LEGACY', category: 'DECISION', invariantId: 'INV-08', diagnosis: 'Identidade antiga.', whyItMatters: 'Identifica formato legado.', recommendedAction: 'Nenhuma ação necessária.', diagnosticConfidence: 'MEDIUM', safeAutomaticAction: false, explanationSource: 'OTHER', title: 'Legado', detail: 'Identidade antiga reconhecida.' },
      { id: 'informational', code: 'SYNC_PENDING', severity: 'INFO', category: 'DECISION', invariantId: 'INV-08', diagnosis: 'Sync pendente.', whyItMatters: 'Atualização em curso.', recommendedAction: 'Aguardar sincronização.', diagnosticConfidence: 'HIGH', safeAutomaticAction: false, status: 'EXPECTED', explanationSource: 'SYNC', title: 'Informativo', detail: 'Sincronização pendente.' },
    ]
    const hiddenIds = new Set(['bank-sheet-finding', 'informational'])
    const auditFindings = [finding, pdfFinding, ...additionalFindings]
    const auditBefore = structuredClone(auditFindings)

    const snapshot = createAuditInputSnapshot({ banks: [], sheets: [], statements: [], decisions: [], capturedAt: '2026-10-07T18:30:00.000Z' })
    exportAuditFindings(auditFindings, hiddenIds, '2026-10-07T18:30:00.000Z', 'RAPIDA', snapshot)
    const csv = await blob!.text()
    const [header, ...rows] = csv.replace(/^\uFEFF/, '').split('\r\n')
    expect(anchor.download).toMatch(/^auditoria_rapida_2026-10-07_\d{4}\.csv$/)
    expect(header).toBe('"Finding ID";"Root Cause";"Role";"Severity";"Confidence";"Subject";"Expected";"Current";"Related Count";"Explanation Summary";"Hidden";"Coverage"')
    expect(rows).toHaveLength(5)
    expect(rows[0]).toContain('"REVIEW"')
    expect(rows[0]).toContain('"MISSING_COM_CANDIDATO"')
    expect(rows[0]).toContain('"COMPLETE"')
    expect(rows[0]).toContain('"Diagnóstico estruturado."')
    expect(rows[0]).toContain('"true"')
    expect(rows.some((row) => row.includes('"MAINTENANCE"'))).toBe(true)
    expect(rows.some((row) => row.includes('"LEGACY"'))).toBe(true)
    expect(rows.some((row) => row.includes('"INFO"') && row.includes('"true"') && row.includes('"COMPLETE"'))).toBe(true)
    expect(csv).not.toContain('conteúdo bruto privado')
    expect(hiddenIds).toEqual(new Set(['bank-sheet-finding', 'informational']))
    expect(auditFindings).toEqual(auditBefore)
    expect(click).toHaveBeenCalledOnce()
    expect(URL.createObjectURL).toHaveBeenCalledOnce()
  })

  it('exporta a execução profunda com estados puro/atual/esperado e preserva o BOM UTF-8', async () => {
    const click = vi.fn()
    const anchor = { href: '', download: '', click } as unknown as HTMLAnchorElement
    let blob: Blob | undefined
    vi.spyOn(document, 'createElement').mockReturnValue(anchor)
    vi.spyOn(URL, 'createObjectURL').mockImplementation((value) => { blob = value as Blob; return 'blob:deep' })
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
    const finding = { id: 'deep', code: 'EXPECTED_OVERRIDE', severity: 'INFO', status: 'EXPECTED', category: 'STATE', invariantId: 'INV-08', title: 'Confirmado', detail: 'Explicado', diagnosis: 'Confirmação manual válida explica a diferença.', whyItMatters: 'Contexto.', recommendedAction: 'Nenhuma ação.', diagnosticConfidence: 'HIGH', safeAutomaticAction: false, explanationSource: 'MANUAL_DECISION', currentState: 'CARD_MATCHED', expectedState: 'CARD_MATCHED', pureState: 'CARD_REVIEW', technical: { pure: 'CARD_REVIEW' } } as unknown as AuditFinding
    exportAuditFindings([finding], new Set(['deep']), '2026-10-07T19:51:00.000Z', 'PROFUNDA')
    const csv = await blob!.text()
    const bytes = await new Promise<Uint8Array>((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => resolve(new Uint8Array(reader.result as ArrayBuffer))
      reader.onerror = () => reject(reader.error)
      reader.readAsArrayBuffer(blob!)
    })
    expect([...bytes.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf])
    expect(anchor.download).toMatch(/^auditoria_profunda_2026-10-07_\d{4}\.csv$/)
    const [header, row] = csv.replace(/^\uFEFF/, '').split('\r\n')
    expect(header).toContain('"Expected";"Current"')
    expect(row).toContain('"CARD_MATCHED"')
    expect(row).toContain('"Confirmação manual válida explica a diferença."')
    expect(row).toContain('"true"')
  })

  it('mantém 10 findings e evidências diretas sem despejar 1,1 MB de avaliações auxiliares no CSV', async () => {
    const click = vi.fn()
    const anchor = { href: '', download: '', click } as unknown as HTMLAnchorElement
    const blobs: Blob[] = []
    vi.spyOn(document, 'createElement').mockReturnValue(anchor)
    vi.spyOn(URL, 'createObjectURL').mockImplementation((value) => { blobs.push(value as Blob); return `blob:${blobs.length}` })
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
    const findings = Array.from({ length: 10 }, (_, index) => ({
      id: `finding-${index}`, code: 'DOUBLE_CLAIM', severity: 'REVIEW', category: 'DECISION', invariantId: 'INV-01', title: `Conflito ${index}`, detail: 'Dois subjects reivindicam a mesma linha.',
      diagnosis: 'Evidência direta preservada.', whyItMatters: 'Evita duplicidade.', recommendedAction: 'Revisar.', diagnosticConfidence: 'HIGH', safeAutomaticAction: false, status: 'ACTIVE', explanationSource: 'NONE',
      technical: {
        row: { id: `sheet-${index}`, date: '2026-06-12', description: `Linha principal ${index}`, amount: 12345 },
        subjects: [
          { type: 'PDF card purchase', description: `Compra origem A ${index}`, date: '2026-05-08', amount: 12345, fingerprint: `subject-a-${index}`, sources: ['invoice-a.pdf'], decisions: ['STATEMENT_MATCH_CONFIRMED'] },
          { type: 'PDF card purchase', description: `Compra origem B ${index}`, date: '2026-04-08', amount: 12345, fingerprint: `subject-b-${index}`, sources: ['invoice-b.pdf'], decisions: [] },
        ],
        candidateRows: [0, 1, 2].map((candidate) => ({ id: `direct-${index}-${candidate}`, date: '2026-06-12', description: `Direta ${candidate}`, amount: 12345 })),
        candidateCountRelevant: 3, candidateCountEvaluated: 100,
        evaluatedCandidates: Array.from({ length: 100 }, (__, candidate) => ({ accepted: false, reason: 'Avaliação auxiliar', row: { id: `trace-${index}-${candidate}`, originalDescription: 'x'.repeat(1100) } })),
      },
    } as unknown as AuditFinding))
    const run = { mode: 'PROFUNDA', auditedAt: '2026-10-07T19:51:00.000Z', findings, recomputation: { performed: true, readOnly: true, persistedDecisionsApplied: false }, summary: {}, items: [], decisionAudit: [], pureStates: {}, currentStates: {} } as unknown as import('../domain/consistencyAudit').ConsistencyAuditResult
    const auditBefore = structuredClone(findings)
    exportAuditFindings(findings, new Set(), run.auditedAt, run.mode)
    const csv = await blobs[0].text()
    const diagnosticBytesBefore = new Blob([JSON.stringify(findings)]).size
    expect(diagnosticBytesBefore).toBeGreaterThanOrEqual(1_000_000)
    expect(new Blob([csv]).size).toBeLessThan(10_000)
    const lines = csv.replace(/^\uFEFF/, '').split('\r\n')
    expect(lines).toHaveLength(11)
    expect(lines[1]).toContain('"finding-0"')
    expect(lines[1]).toContain('"finding-0"')
    expect(lines[1]).not.toContain('trace-0-99')
    expect(toAuditCsvRow(findings[0], run.mode, run.auditedAt, false).candidateCountRelevant).toBe(3)
    expect(toAuditCsvRow(findings[0], run.mode, run.auditedAt, false).candidateCountEvaluated).toBe(100)
    expect(findings).toEqual(auditBefore)
  })

  it('exporta a etapa e a decisão que filtraram uma candidata bancária', () => {
    const finding = {
      id: 'missing-with-rejected-candidate', code: 'MISSING_WITH_STRONG_CANDIDATE', severity: 'CRITICAL', category: 'STATE', invariantId: 'INV-03', title: 'Ausente com candidata', detail: 'A candidata foi rejeitada.', diagnosis: 'Etapa identificada.', whyItMatters: 'Contexto.', recommendedAction: 'Revisar.', diagnosticConfidence: 'HIGH', safeAutomaticAction: false, status: 'ACTIVE', explanationSource: 'MANUAL_DECISION',
      technical: {
        candidateRows: [{ id: 'row-1', sheetRecordId: 'sheet-1', date: '2026-03-12', description: 'Feirinha', amount: 1200 }],
        candidateCountRelevant: 1, candidateCountEvaluated: 1, pipelineStage: 'DECISION_FILTERING / PAIR_REJECTED',
        decisions: [{ kind: 'PAIR_REJECTED', key: 'decision-exact-1' }],
        candidateEvaluations: [{ row: { id: 'row-1', sheetRecordId: 'sheet-1' }, disposition: 'REJECTED_BY_DECISION', reason: 'Par rejeitado explicitamente.', decisionKey: 'decision-exact-1' }],
      },
    } as unknown as AuditFinding
    const row = toAuditCsvRow(finding, 'PROFUNDA', '2026-10-09T10:32:00.000Z', false)
    expect(row).toMatchObject({ candidateCountRelevant: 1, candidateCountEvaluated: 1, explanationStage: 'DECISION_FILTERING / PAIR_REJECTED', decisions: 'PAIR_REJECTED (decision-exact-1)' })
    expect(row.technicalSummary).toContain('REJECTED_BY_DECISION')
    expect(row.technicalSummary).toContain('decision-exact-1')
  })

  it('exporta diagnóstico JSON completo com IDs iguais aos do CSV e findings ocultos', async () => {
    const click = vi.fn()
    const anchor = { href: '', download: '', click } as unknown as HTMLAnchorElement
    let blob: Blob | undefined
    vi.spyOn(document, 'createElement').mockReturnValue(anchor)
    vi.spyOn(URL, 'createObjectURL').mockImplementation((value) => { blob = value as Blob; return 'blob:json' })
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
    const finding = { id: 'shared-finding-id', code: 'DOUBLE_CLAIM', severity: 'REVIEW', category: 'DECISION', invariantId: 'INV-01', title: 'Conflito', detail: 'Detalhe', diagnosis: 'Diagnóstico', whyItMatters: 'Impacto', recommendedAction: 'Revisar', diagnosticConfidence: 'HIGH', safeAutomaticAction: false, status: 'ACTIVE', explanationSource: 'NONE', technical: { evaluatedCandidates: [{ row: { id: 'candidate-full', raw: 'private raw omitted' } }] } } as unknown as AuditFinding
    const auditInputSnapshot = createAuditInputSnapshot({ banks: [], sheets: [], statements: [], decisions: [], capturedAt: '2026-10-07T19:51:00.000Z' })
    const run = { mode: 'RAPIDA', auditedAt: '2026-10-07T19:51:00.000Z', auditInputSnapshot, findings: [finding], recomputation: { performed: true, readOnly: true, persistedDecisionsApplied: false }, summary: {}, items: [], decisionAudit: [], pureStates: {}, currentStates: {}, invariantExecutions: [{ invariantId: 'INV-01', status: 'EXECUTED_PASS', subjectsEvaluated: 1, sourcesRequired: ['bank'], sourcesAvailable: ['bank'], findingIds: [] }], auditSelfChecks: [{ checkId: 'UNIQUE_PRIMARY_ROOT_CAUSE', status: 'PASS', findingIds: [] }] } as unknown as import('../domain/consistencyAudit').ConsistencyAuditResult
    exportAuditDiagnosticJson(run, new Set(['shared-finding-id']))
    const json = JSON.parse(await blob!.text())
    expect(anchor.download).toMatch(/^auditoria_diagnostico_rapida_2026-10-07_\d{4}\.json$/)
    expect(json.findings[0]).toMatchObject({ findingId: 'shared-finding-id', hidden: true, finding: { id: 'shared-finding-id' } })
    expect(json.findings[0].finding.technical.evaluatedCandidates[0].row.id).toBe('candidate-full')
    expect(json.exportFormat).toBe('conciliador-auditoria-diagnostico')
    expect(json.schemaVersion).toBe(2)
    expect(json.snapshot.revisions.custosAnoRevision).toBe(auditInputSnapshot.revisions.custosAnoRevision)
    expect(json.invariantExecutions[0]).toMatchObject({ invariantId: 'INV-01', status: 'EXECUTED_PASS' })
    expect(json.selfChecks[0]).toMatchObject({ checkId: 'UNIQUE_PRIMARY_ROOT_CAUSE', status: 'PASS' })
    expect(JSON.stringify(json)).not.toContain('private raw omitted')
  })

  it('mantém uma linha por finding de topo e deduplica entidades repetidas no JSON v2', async () => {
    const click = vi.fn()
    const anchor = { href: '', download: '', click } as unknown as HTMLAnchorElement
    const blobs: Blob[] = []
    vi.spyOn(document, 'createElement').mockReturnValue(anchor)
    vi.spyOn(URL, 'createObjectURL').mockImplementation((value) => { blobs.push(value as Blob); return `blob:${blobs.length}` })
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
    const transactionList = Array.from({ length: 40 }, (_, index) => ({ id: `tx-${index}`, amount: 1000 + index, originalDescription: `Loja ${index}`, purchaseDate: '2026-06-01' }))
    const item = { fingerprint: 'purchase-a', statement: { statementIdentity: 'invoice-a', fileName: 'fatura.pdf', transactions: transactionList }, transaction: transactionList[0], candidates: [{ id: 'row-a', sheetRecordId: 'row-a', amount: 1000, description: 'Loja' }], evaluatedCandidates: [], decisions: [], explanationChain: [], aliases: [], discarded: [], claimedBy: [], diagnosis: 'MATCHED', pure: { status: 'CARD_MATCHED' }, current: null, expectedState: null } as unknown as import('../domain/consistencyAudit').AuditedCardItem
    const finding = { id: 'primary', code: 'DOUBLE_CLAIM', role: 'PRIMARY', severity: 'REVIEW', invariantId: 'INV-01', category: 'DECISION', title: 'Conflito', detail: 'Conflito', diagnosis: 'Linha reivindicada.', whyItMatters: 'Impacto.', recommendedAction: 'Revisar.', diagnosticConfidence: 'HIGH', safeAutomaticAction: false, status: 'ACTIVE', explanationSource: 'NONE', item, technical: { row: { id: 'row-a', sheetRecordId: 'row-a', amount: 1000, description: 'Loja' } }, relatedFindings: [{ id: 'related', code: 'ASSIGNMENT_CONFLICT', role: 'RELATED', title: 'Reserva', detail: 'Evidência.' }] } as unknown as AuditFinding
    const related = { ...finding, id: 'related-top', role: 'RELATED' } as AuditFinding
    const audit = { mode: 'PROFUNDA', auditedAt: '2026-10-07T19:51:00.000Z', findings: [finding, related], items: [item], decisionAudit: [], invariantExecutions: [], auditSelfChecks: [], summary: {}, recomputation: { performed: true, readOnly: true, persistedDecisionsApplied: false }, pureStates: {}, currentStates: {}, expectedStates: {} } as unknown as import('../domain/consistencyAudit').ConsistencyAuditResult
    exportAuditFindings(audit.findings, new Set(), audit.auditedAt, audit.mode)
    const csv = await blobs[0].text()
    expect(csv.replace(/^\uFEFF/, '').split('\r\n')).toHaveLength(2)
    const duplicateRows = new Blob([JSON.stringify([item, finding])]).size
    const payload = createAuditDiagnosticPayload(audit, new Set())
    const compactJson = JSON.stringify(payload)
    console.info(`Fixture de compactação JSON: ${duplicateRows} → ${compactJson.length} bytes (${((1 - compactJson.length / duplicateRows) * 100).toFixed(1)}% neste caso sintético)`)
    expect(duplicateRows).toBeGreaterThan(compactJson.length)
    expect(payload.exportFormat).toBe('conciliador-auditoria-diagnostico')
    expect(payload.schemaVersion).toBe(2)
    expect(payload.entities.statements['statement:invoice-a']).toBeDefined()
    expect(payload.entities.ledgerRows['sheet:row-a']).toBeDefined()
    expect(payload.findings[0].itemRef).toBe('purchase-a')
    expect('item' in payload.findings[0].finding).toBe(false)
  })
})
