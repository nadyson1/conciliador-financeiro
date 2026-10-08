export type DecisionKind = 'PAIR_CONFIRMED' | 'PAIR_REJECTED' | 'BANK_IGNORED' | 'SHEET_IGNORED' | 'COMPOSITION_CONFIRMED' | 'STATEMENT_MATCH_CONFIRMED' | 'CARD_MISSING_CONFIRMED' | 'CARD_PURCHASE_IGNORED' | 'CARD_REVIEW_REJECTED_CANDIDATES' | 'MISSING_ADDED_TO_SHEET'

export interface PersistedDecision {
  key: string
  schemaVersion: 1
  kind: DecisionKind
  identities: string[]
  selected: string[]
  updatedAt: string
}

const DATABASE_NAME = 'conciliador-financeiro-decisions'
const DATABASE_VERSION = 1
const STORE_NAME = 'decisions'

export function decisionKey(kind: DecisionKind, identities: string[]) {
  return `${kind}:${JSON.stringify(identities)}`
}

function openDatabase(): Promise<IDBDatabase> {
  if (typeof indexedDB === 'undefined') return Promise.reject(new Error('IndexedDB não está disponível neste dispositivo.'))
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION)
    request.onupgradeneeded = () => {
      const database = request.result
      if (!database.objectStoreNames.contains(STORE_NAME)) database.createObjectStore(STORE_NAME, { keyPath: 'key' })
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('Não foi possível abrir o armazenamento local.'))
  })
}

async function withStore<T>(mode: IDBTransactionMode, operation: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const database = await openDatabase()
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(STORE_NAME, mode)
    const request = operation(transaction.objectStore(STORE_NAME))
    let result: T
    request.onsuccess = () => { result = request.result }
    request.onerror = () => reject(request.error ?? new Error('Falha no armazenamento local.'))
    transaction.oncomplete = () => { database.close(); resolve(result) }
    transaction.onerror = () => { database.close(); reject(transaction.error ?? new Error('Falha no armazenamento local.')) }
    transaction.onabort = () => { database.close(); reject(transaction.error ?? new Error('Operação local cancelada.')) }
  })
}

export const listPersistedDecisions = () => withStore<PersistedDecision[]>('readonly', (store) => store.getAll())

export async function putPersistedDecision(record: PersistedDecision) {
  await withStore<IDBValidKey>('readwrite', (store) => store.put(record))
}

export async function savePersistedDecision(decision: Omit<PersistedDecision, 'schemaVersion' | 'updatedAt'>) {
  const record: PersistedDecision = { ...decision, schemaVersion: 1, updatedAt: new Date().toISOString() }
  await putPersistedDecision(record)
  return record
}

/** Replaces one manual assignment and removes its superseded owners in one IndexedDB transaction. */
export async function replacePersistedDecision(decision: Omit<PersistedDecision, 'schemaVersion' | 'updatedAt'>, supersededKeys: string[]) {
  const record: PersistedDecision = { ...decision, schemaVersion: 1, updatedAt: new Date().toISOString() }
  const database = await openDatabase()
  return new Promise<PersistedDecision>((resolve, reject) => {
    const transaction = database.transaction(STORE_NAME, 'readwrite')
    const store = transaction.objectStore(STORE_NAME)
    supersededKeys.filter((key) => key !== record.key).forEach((key) => store.delete(key))
    store.put(record)
    transaction.oncomplete = () => { database.close(); resolve(record) }
    transaction.onerror = () => { database.close(); reject(transaction.error ?? new Error('Falha ao substituir a confirmação local.')) }
    transaction.onabort = () => { database.close(); reject(transaction.error ?? new Error('Substituição local cancelada.')) }
  })
}

export const deletePersistedDecision = (key: string) => withStore<undefined>('readwrite', (store) => store.delete(key))
export const clearPersistedDecisions = () => withStore<undefined>('readwrite', (store) => store.clear())
