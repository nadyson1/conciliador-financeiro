import { afterEach, describe, expect, it } from 'vitest'
import { clearPersistedDecisions, deletePersistedDecision, decisionKey, listPersistedDecisions, savePersistedDecision } from './localDecisions'

type RequestLike<T> = IDBRequest<T>

class FakeRequest<T> {
  result!: T
  error: DOMException | null = null
  onsuccess: ((event: Event) => void) | null = null
  onerror: ((event: Event) => void) | null = null
  complete(result: T) { this.result = result; queueMicrotask(() => this.onsuccess?.(new Event('success'))) }
}

class FakeStore {
  constructor(private readonly values: Map<string, unknown>) {}
  getAll() { const request = new FakeRequest<unknown[]>(); request.complete([...this.values.values()]); return request as unknown as RequestLike<unknown[]> }
  put(value: { key: string }) { this.values.set(value.key, structuredClone(value)); const request = new FakeRequest<IDBValidKey>(); request.complete(value.key); return request as unknown as RequestLike<IDBValidKey> }
  delete(key: string) { this.values.delete(key); const request = new FakeRequest<undefined>(); request.complete(undefined); return request as unknown as RequestLike<undefined> }
  clear() { this.values.clear(); const request = new FakeRequest<undefined>(); request.complete(undefined); return request as unknown as RequestLike<undefined> }
}

class FakeTransaction {
  oncomplete: ((event: Event) => void) | null = null
  onerror: ((event: Event) => void) | null = null
  onabort: ((event: Event) => void) | null = null
  constructor(private readonly values: Map<string, unknown>) { setTimeout(() => this.oncomplete?.(new Event('complete')), 1) }
  objectStore() { return new FakeStore(this.values) as unknown as IDBObjectStore }
}

class FakeDatabase {
  objectStoreNames = { contains: () => true }
  constructor(private readonly values: Map<string, unknown>) {}
  transaction() { return new FakeTransaction(this.values) as unknown as IDBTransaction }
  createObjectStore() { return new FakeStore(this.values) as unknown as IDBObjectStore }
  close() {}
}

class FakeIndexedDB {
  private readonly values = new Map<string, unknown>()
  private readonly database = new FakeDatabase(this.values)
  open() {
    const request = new FakeRequest<IDBDatabase>()
    setTimeout(() => {
      Object.defineProperty(request, 'result', { configurable: true, value: this.database })
      ;(request as unknown as { onupgradeneeded?: (event: Event) => void }).onupgradeneeded?.(new Event('upgradeneeded'))
      request.onsuccess?.(new Event('success'))
    }, 0)
    return request as unknown as IDBOpenDBRequest
  }
}

const oldIndexedDB = Object.getOwnPropertyDescriptor(globalThis, 'indexedDB')
afterEach(() => {
  if (oldIndexedDB) Object.defineProperty(globalThis, 'indexedDB', oldIndexedDB)
  else Reflect.deleteProperty(globalThis, 'indexedDB')
})

describe('decisões locais persistidas', () => {
  it('mantém metadados entre leituras, atualiza a escolha, remove uma decisão e limpa apenas sob pedido explícito', async () => {
    Object.defineProperty(globalThis, 'indexedDB', { configurable: true, value: new FakeIndexedDB() as unknown as IDBFactory })
    const key = decisionKey('PAIR_CONFIRMED', ['bank:hash-a'])
    await savePersistedDecision({ key, kind: 'PAIR_CONFIRMED', identities: ['bank:hash-a'], selected: ['sheet:hash-x'] })
    expect(await listPersistedDecisions()).toMatchObject([{ key, schemaVersion: 1, kind: 'PAIR_CONFIRMED', selected: ['sheet:hash-x'] }])
    await savePersistedDecision({ key, kind: 'PAIR_CONFIRMED', identities: ['bank:hash-a'], selected: ['sheet:hash-y'] })
    expect(await listPersistedDecisions()).toHaveLength(1)
    expect((await listPersistedDecisions())[0].selected).toEqual(['sheet:hash-y'])
    await deletePersistedDecision(key)
    expect(await listPersistedDecisions()).toEqual([])
    await savePersistedDecision({ key, kind: 'PAIR_CONFIRMED', identities: ['bank:hash-a'], selected: ['sheet:hash-x'] })
    await clearPersistedDecisions()
    expect(await listPersistedDecisions()).toEqual([])
  })
})
