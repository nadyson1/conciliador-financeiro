import { describe, expect, it } from 'vitest'
import { decisionRevision, isDecisionRevisionCurrent, serializeDecisionMutation } from './decisionMutationQueue'

describe('fila de mutações de decisões', () => {
  it('preserva a ordem save → remove mesmo quando a primeira gravação demora', async () => {
    const events: string[] = []
    let release!: () => void
    let started!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const startedSignal = new Promise<void>((resolve) => { started = resolve })
    const save = serializeDecisionMutation('workspace-test', async () => { events.push('save:start'); started(); await gate; events.push('save:done') })
    const remove = serializeDecisionMutation('workspace-test', async () => { events.push('remove') })
    await startedSignal
    expect(events).toEqual(['save:start'])
    release()
    await Promise.all([save, remove])
    expect(events).toEqual(['save:start', 'save:done', 'remove'])
  })

  it('continua a fila após falha e permite retry idempotente', async () => {
    const attempts: string[] = []
    await expect(serializeDecisionMutation('retry-test', async () => { attempts.push('failed'); throw new Error('partial remote write') })).rejects.toThrow('partial remote write')
    await serializeDecisionMutation('retry-test', async () => { attempts.push('retry') })
    expect(attempts).toEqual(['failed', 'retry'])
  })

  it('ordena remoção, substituição e sync sem reativar o registro removido', async () => {
    const state = new Map<string, string>([['A', 'ACTIVE']])
    const remove = serializeDecisionMutation('replace-test', async () => { state.set('A', 'DELETED') })
    const replace = serializeDecisionMutation('replace-test', async () => { state.set('B', 'ACTIVE') })
    const sync = serializeDecisionMutation('replace-test', async () => ({ a: state.get('A'), b: state.get('B') }))
    await Promise.all([remove, replace])
    await expect(sync).resolves.toEqual({ a: 'DELETED', b: 'ACTIVE' })
    expect(state).toEqual(new Map([['A', 'DELETED'], ['B', 'ACTIVE']]))
  })

  it('marca resultados derivados como obsoletos quando a revisão efetiva muda', () => {
    const revision10 = decisionRevision([{ key: 'PAIR_CONFIRMED:[bank]', updatedAt: '2026-01-01T00:00:00.000Z' }])
    const revision11 = decisionRevision([{ key: 'PAIR_CONFIRMED:[bank]', updatedAt: '2026-01-01T00:00:00.001Z' }])
    expect(isDecisionRevisionCurrent(revision10, revision10)).toBe(true)
    expect(isDecisionRevisionCurrent(revision10, revision11)).toBe(false)
  })
})
