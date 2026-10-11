/** Serializes decision mutations within one spreadsheet/workspace in this browser tab. */
const tails = new Map<string, Promise<unknown>>()

export function serializeDecisionMutation<T>(workspaceKey: string, operation: () => Promise<T> | T): Promise<T> {
  const previous = tails.get(workspaceKey) ?? Promise.resolve()
  const current = previous.catch(() => undefined).then(() => {
    const locks = typeof navigator !== 'undefined' ? navigator.locks : undefined
    return locks
      ? locks.request(`conciliador:decision-mutations:${workspaceKey}`, () => operation())
      : operation()
  })
  tails.set(workspaceKey, current)
  void current.finally(() => {
    if (tails.get(workspaceKey) === current) tails.delete(workspaceKey)
  }).catch(() => undefined)
  return current
}

export async function drainDecisionMutationQueue(workspaceKey: string) {
  await (tails.get(workspaceKey) ?? Promise.resolve()).catch(() => undefined)
}

export function decisionRevision(decisions: { key: string; updatedAt: string }[]) {
  return decisions.map((decision) => `${decision.key}@${decision.updatedAt}`).sort().join('|')
}

export function isDecisionRevisionCurrent(derivedRevision: string, effectiveRevision: string) {
  return derivedRevision === effectiveRevision
}
