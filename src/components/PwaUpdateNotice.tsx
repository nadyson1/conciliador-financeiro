import { useRegisterSW } from './pwaRegistration'

export function PwaUpdateNotice() {
  const { needRefresh: [needRefresh], updateServiceWorker } = useRegisterSW({ immediate: true })
  if (!needRefresh) return null

  return <aside className="pwa-update-notice" role="status" aria-live="polite" aria-label="Atualização do aplicativo disponível">
    <span>Nova versão disponível</span>
    <button className="button button-primary button-small" onClick={() => { void updateServiceWorker(true) }}>Atualizar</button>
  </aside>
}
