import type { DriveFolderKind, SavedDriveFolders } from '../integrations/googleDriveStorage'

export interface DriveSyncSummary { invoicesFound: number; statementsFound: number; alreadyKnown: number; newProcessed: number; errors: number; removedFromFolders: number }

export function GoogleDrivePanel({ folders, connected, configured, loading, progress, lastSync, summary, error, loadedStatements = [], onSelectFolder, onSync, onRemoveStatement = () => undefined }: {
  folders: SavedDriveFolders
  connected: boolean
  configured: boolean
  loading: boolean
  progress: string
  lastSync: string | null
  summary: DriveSyncSummary | null
  error: string
  loadedStatements?: { id: string; name: string }[]
  onSelectFolder: (kind: DriveFolderKind) => void
  onSync: () => void
  onRemoveStatement?: (fileId: string) => void
}) {
  return <section className="panel google-drive-panel" aria-labelledby="google-drive-heading">
    <div className="panel-heading"><div><h2 id="google-drive-heading">Fontes do Google Drive</h2><p>Pastas opcionais de faturas e extratos</p></div><span className={`google-connection-badge ${connected ? 'connected' : ''}`}>{connected ? '✓ Google conectado' : 'Opcional'}</span></div>
    <div className="drive-folder-grid">
      {(['invoices', 'statements'] as const).map((kind) => {
        const folder = folders[kind]
        const label = kind === 'invoices' ? 'Faturas PDF' : 'Extratos CSV'
        return <div className="drive-folder-row" key={kind}><div><strong>{label}</strong><small>{folder ? `✓ ${folder.name}` : 'Nenhuma pasta configurada'}</small></div><button className="button button-outline button-small" disabled={!configured || loading} onClick={() => onSelectFolder(kind)}>{folder ? 'Alterar' : 'Selecionar pasta'}</button></div>
      })}
    </div>
    <div className="google-sheets-actions"><button className="button button-primary" disabled={!connected || loading || (!folders.invoices && !folders.statements)} onClick={onSync}>{loading ? 'Sincronizando…' : 'Sincronizar arquivos'}</button>{lastSync && <small>Última sincronização: {new Date(lastSync).toLocaleString('pt-BR')}</small>}</div>
    {progress && <p className="google-sheets-note" role="status">{progress}</p>}
    {loadedStatements.length > 0 && <div className="drive-loaded-files"><strong>Extratos do Drive nesta sessão</strong>{loadedStatements.map((file) => <div key={file.id}><small>{file.name}</small><button className="text-button" disabled={loading} onClick={() => onRemoveStatement(file.id)}>Remover da sessão</button></div>)}</div>}
    {summary && <div className="drive-sync-summary" role="status"><strong>{summary.newProcessed ? `${summary.newProcessed} arquivo(s) novo(s) processado(s)` : 'Sincronização concluída'}</strong><small>Faturas: {summary.invoicesFound} · Extratos: {summary.statementsFound} · Já conhecidos: {summary.alreadyKnown}</small>{summary.errors > 0 && <small className="google-sheets-warning">{summary.errors} arquivo(s) precisam de atenção.</small>}{summary.removedFromFolders > 0 && <small>{summary.removedFromFolders} arquivo(s) processado(s) não estão mais nas pastas; dados e decisões foram mantidos.</small>}</div>}
    {error && <p className="google-sheets-error" role="alert">{error}</p>}
    {!connected && <p className="google-sheets-note">Reconecte o Google para acessar as pastas configuradas.</p>}
    {!configured && <p className="google-sheets-note">Configure a chave de API e o número do projeto no `.env.local` para habilitar a seleção de pastas.</p>}
    <p className="google-sheets-note">Os arquivos são baixados diretamente do seu Google Drive para este dispositivo e processados localmente. O Conciliador não envia PDFs ou extratos para um servidor próprio. Remover da sessão não exclui arquivos do Drive.</p>
  </section>
}
