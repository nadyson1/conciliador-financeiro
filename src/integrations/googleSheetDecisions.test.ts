import { beforeEach, describe, expect, it, vi } from 'vitest'
import { addDecisionTombstone, listDecisionTombstones, removeDecisionTombstone, syncGoogleSheetDecisions } from './googleSheetDecisions'
import type { PersistedDecision } from '../domain/localDecisions'
import { stableFingerprint } from '../domain/identity'

const localStoreMocks = vi.hoisted(() => ({ put: vi.fn(), remove: vi.fn() }))
vi.mock('../domain/localDecisions', () => ({ putPersistedDecision: localStoreMocks.put, deletePersistedDecision: localStoreMocks.remove }))

const decision: PersistedDecision = { key: 'PAIR_CONFIRMED:["bank:fingerprint"]', schemaVersion: 1, kind: 'PAIR_CONFIRMED', identities: ['bank:fingerprint'], selected: ['sheet:fingerprint'], updatedAt: '2026-01-02T00:00:00.000Z' }
const headers = ['decisionId', 'decisionType', 'subjectFingerprint', 'status', 'relatedIds', 'metadata', 'createdAt', 'updatedAt', 'schemaVersion']
function response(body: unknown, status = 200) { return { ok: status >= 200 && status < 300, status, json: async () => body } as Response }
function remoteRow(value: PersistedDecision, status = 'ACTIVE') { return [stableFingerprint([value.key]), value.kind, stableFingerprint([value.identities[0] ?? '']), status, JSON.stringify(value.identities), JSON.stringify({ selected: value.selected }), value.updatedAt, value.updatedAt, 1] }

describe('sincronização de decisões no Google Sheets', () => {
  beforeEach(() => { localStoreMocks.put.mockReset(); localStoreMocks.remove.mockReset() })
  it('cria somente _CONCILIADOR, grava o esquema e faz upsert local sem escrever em CUSTOS ANO', async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(response({ sheets: [{ properties: { title: 'CUSTOS ANO', sheetId: 1 } }] }))
      .mockResolvedValueOnce(response({ replies: [{}] }))
      .mockResolvedValueOnce(response({ values: [] }))
      .mockResolvedValueOnce(response({}))
      .mockResolvedValueOnce(response({}))
    const result = await syncGoogleSheetDecisions('spreadsheet-id-12345', 'token', [decision], {}, fetcher)
    expect(result).toEqual([decision])
    expect(fetcher.mock.calls[1][0]).toContain(':batchUpdate')
    expect(JSON.parse(String((fetcher.mock.calls[1][1] as RequestInit).body)).requests[0].addSheet.properties.title).toBe('_CONCILIADOR')
    const writeCalls = fetcher.mock.calls.slice(3)
    expect(writeCalls.map(([url]) => decodeURIComponent(String(url)))).toEqual(expect.arrayContaining([expect.stringContaining("'_CONCILIADOR'!A1:I1"), expect.stringContaining("'_CONCILIADOR'!A:I")]))
    expect(writeCalls.every(([url]) => !decodeURIComponent(String(url)).includes('CUSTOS ANO'))).toBe(true)
    const appended = JSON.parse(String((writeCalls[1][1] as RequestInit).body)).values[0]
    expect(appended).toEqual([stableFingerprint([decision.key]), decision.kind, stableFingerprint([decision.identities[0]]), 'ACTIVE', JSON.stringify(decision.identities), JSON.stringify({ selected: decision.selected }), decision.updatedAt, decision.updatedAt, 1])
  })

  it('mantém decisão remota mais recente e atualiza a cache local quando vence', async () => {
    const newerRemote = { ...decision, selected: ['sheet:newer'], updatedAt: '2026-01-03T00:00:00.000Z' }
    const fetcher = vi.fn()
      .mockResolvedValueOnce(response({ sheets: [{ properties: { title: 'CUSTOS ANO' } }, { properties: { title: '_CONCILIADOR' } }] }))
      .mockResolvedValueOnce(response({ values: [headers, remoteRow(newerRemote)] }))
    const result = await syncGoogleSheetDecisions('spreadsheet-id-12345', 'token', [decision], {}, fetcher)
    expect(result).toEqual([newerRemote])
    expect(fetcher).toHaveBeenCalledTimes(2)
    expect(localStoreMocks.put).toHaveBeenCalledWith(newerRemote)
  })

  it('sincroniza entre dispositivos a decisão de ausente já adicionado à CUSTOS ANO', async () => {
    const added: PersistedDecision = { key: 'MISSING_ADDED_TO_SHEET:["bank:fingerprint"]', schemaVersion: 1, kind: 'MISSING_ADDED_TO_SHEET', identities: ['bank:fingerprint'], selected: ['sheet:record-8'], updatedAt: '2026-01-04T00:00:00.000Z' }
    const fetcher = vi.fn()
      .mockResolvedValueOnce(response({ sheets: [{ properties: { title: 'CUSTOS ANO' } }, { properties: { title: '_CONCILIADOR' } }] }))
      .mockResolvedValueOnce(response({ values: [headers, remoteRow(added)] }))
    const result = await syncGoogleSheetDecisions('spreadsheet-id-12345', 'token', [], {}, fetcher)
    expect(result).toEqual([added])
    expect(localStoreMocks.put).toHaveBeenCalledWith(added)
    expect(fetcher.mock.calls.slice(2).every(([url]) => decodeURIComponent(String(url)).includes('_CONCILIADOR'))).toBe(true)
  })

  it('envia decisão local mais recente para a linha existente', async () => {
    const olderRemote = { ...decision, selected: ['sheet:old'], updatedAt: '2026-01-01T00:00:00.000Z' }
    const fetcher = vi.fn()
      .mockResolvedValueOnce(response({ sheets: [{ properties: { title: 'CUSTOS ANO' } }, { properties: { title: '_CONCILIADOR' } }] }))
      .mockResolvedValueOnce(response({ values: [headers, remoteRow(olderRemote)] }))
      .mockResolvedValueOnce(response({}))
    await syncGoogleSheetDecisions('spreadsheet-id-12345', 'token', [decision], {}, fetcher)
    expect(fetcher).toHaveBeenCalledTimes(3)
    expect(decodeURIComponent(String(fetcher.mock.calls[2][0]))).toContain("'_CONCILIADOR'!A2:I2")
    expect(JSON.parse(String((fetcher.mock.calls[2][1] as RequestInit).body)).values[0][5]).toBe(JSON.stringify({ selected: decision.selected }))
  })

  it('sincroniza remoção offline como tombstone sem manter a decisão ativa', async () => {
    const deletedAt = '2026-01-04T00:00:00.000Z'
    const fetcher = vi.fn()
      .mockResolvedValueOnce(response({ sheets: [{ properties: { title: 'CUSTOS ANO' } }, { properties: { title: '_CONCILIADOR' } }] }))
      .mockResolvedValueOnce(response({ values: [headers, remoteRow(decision)] }))
      .mockResolvedValueOnce(response({}))
    const active = await syncGoogleSheetDecisions('spreadsheet-id-12345', 'token', [], { [decision.key]: { updatedAt: deletedAt, decision } }, fetcher)
    expect(active).toEqual([])
    expect(JSON.parse(String((fetcher.mock.calls[2][1] as RequestInit).body)).values[0][3]).toBe('DELETED')
    expect(localStoreMocks.remove).toHaveBeenCalledWith(decision.key)
  })

  it('não ressuscita uma confirmação antiga de ausência quando o tombstone é sincronizado', async () => {
    const absence: PersistedDecision = { key: 'CARD_MISSING_CONFIRMED:["statement:kindle"]', schemaVersion: 1, kind: 'CARD_MISSING_CONFIRMED', identities: ['statement:kindle'], selected: [], updatedAt: '2026-01-02T00:00:00.000Z' }
    const deletedAt = '2026-01-04T00:00:00.000Z'
    const fetcher = vi.fn()
      .mockResolvedValueOnce(response({ sheets: [{ properties: { title: 'CUSTOS ANO' } }, { properties: { title: '_CONCILIADOR' } }] }))
      .mockResolvedValueOnce(response({ values: [headers, remoteRow(absence)] }))
      .mockResolvedValueOnce(response({}))
    const active = await syncGoogleSheetDecisions('spreadsheet-id-12345', 'token', [], { [absence.key]: { updatedAt: deletedAt, decision: absence } }, fetcher)
    expect(active).toEqual([])
    expect(JSON.parse(String((fetcher.mock.calls[2][1] as RequestInit).body)).values[0][3]).toBe('DELETED')
    expect(localStoreMocks.remove).toHaveBeenCalledWith(absence.key)
  })

  it('aplica tombstone remoto depois de um registro local antigo e entrega somente decisões ativas após reload/sync', async () => {
    const oldAbsence: PersistedDecision = { key: 'CARD_MISSING_CONFIRMED:["statement:legacy-kindle"]', schemaVersion: 1, kind: 'CARD_MISSING_CONFIRMED', identities: ['statement:legacy-kindle'], selected: [], updatedAt: '2026-01-02T00:00:00.000Z' }
    const deleted = { ...oldAbsence, updatedAt: '2026-01-04T00:00:00.000Z' }
    const fetcher = vi.fn()
      .mockResolvedValueOnce(response({ sheets: [{ properties: { title: 'CUSTOS ANO' } }, { properties: { title: '_CONCILIADOR' } }] }))
      .mockResolvedValueOnce(response({ values: [headers, remoteRow(deleted, 'DELETED')] }))
    const active = await syncGoogleSheetDecisions('spreadsheet-id-12345', 'token', [oldAbsence], {}, fetcher)
    expect(active).toEqual([])
    expect(localStoreMocks.remove).toHaveBeenCalledWith(oldAbsence.key)
    expect(localStoreMocks.put).not.toHaveBeenCalled()
  })

  it('falha sem alterar a aba de dados quando CUSTOS ANO não está presente', async () => {
    const fetcher = vi.fn().mockResolvedValue(response({ sheets: [{ properties: { title: 'Resumo' } }] }))
    await expect(syncGoogleSheetDecisions('spreadsheet-id-12345', 'token', [decision], {}, fetcher)).rejects.toThrow(/CUSTOS ANO não existe/)
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it('mantém tombstones locais mínimos para remoções offline até a sincronização', () => {
    localStorage.clear()
    addDecisionTombstone(decision)
    expect(listDecisionTombstones()).toMatchObject({ [decision.key]: { decision, updatedAt: expect.any(String) } })
    removeDecisionTombstone(decision.key)
    expect(listDecisionTombstones()).toEqual({})
  })
})
