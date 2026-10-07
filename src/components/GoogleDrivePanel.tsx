import { useState } from 'react'
import type { DriveFolderKind, SavedDriveFolders } from '../integrations/googleDriveStorage'
import type { DriveFileOutcome } from '../integrations/googleDriveProcessing'

export interface DriveStatementFileOutcome {
  fileId: string
  fileName: string
  status: 'PROCESSED' | 'WARNING' | 'ERROR' | 'UNSUPPORTED' | 'IGNORED'
  periodStart?: string | null
  periodEnd?: string | null
  transactionCount?: number
  ignoredRowCount?: number
  excludedRowCount?: number
  overlapCount?: number
  detail?: string
}

export interface DriveSyncSummary { invoicesFound: number; invoicesUnique?: number; invoiceDuplicates?: number; invoiceErrors?: number; invoiceUnsupported?: number; invoiceSkipped?: number; invoiceFileOutcomes?: DriveFileOutcome[]; statementsFound: number; statementFileOutcomes?: DriveStatementFileOutcome[]; alreadyKnown: number; newProcessed: number; errors: number; removedFromFolders: number }

type FileFilter = 'all' | 'problems'

const invoiceStatusView: Record<DriveFileOutcome['status'], { label: string; icon: string; tone: string; detail: string }> = {
  PROCESSED_UNIQUE: { label: 'Processado', icon: '✓', tone: 'success', detail: 'Fatura única processada.' },
  DUPLICATE_FINANCIAL: { label: 'Duplicado financeiro', icon: '⚠', tone: 'duplicate', detail: 'Mesmo conteúdo financeiro já representado; este arquivo permanece como origem da fatura.' },
  PARSE_ERROR: { label: 'Erro', icon: '✕', tone: 'error', detail: 'Não foi possível interpretar ou processar esta fatura.' },
  PROCESSING_ERROR: { label: 'Erro de processamento', icon: '✕', tone: 'error', detail: 'Ocorreu um erro ao baixar ou preparar o arquivo.' },
  UNSUPPORTED: { label: 'Precisa de atenção', icon: '⚠', tone: 'warning', detail: 'Tipo de arquivo não suportado como fatura PDF.' },
  SKIPPED: { label: 'Ignorado', icon: 'ⓘ', tone: 'ignored', detail: 'Arquivo ignorado nesta sessão.' },
}

const statementStatusView: Record<DriveStatementFileOutcome['status'], { label: string; icon: string; tone: string }> = {
  PROCESSED: { label: 'Processado', icon: '✓', tone: 'success' },
  WARNING: { label: 'Precisa de atenção', icon: '⚠', tone: 'warning' },
  ERROR: { label: 'Erro', icon: '✕', tone: 'error' },
  UNSUPPORTED: { label: 'Não suportado', icon: '⚠', tone: 'warning' },
  IGNORED: { label: 'Ignorado', icon: 'ⓘ', tone: 'ignored' },
}

function isInvoiceProblem(outcome: DriveFileOutcome) { return outcome.status !== 'PROCESSED_UNIQUE' }
function formatPeriod(start?: string | null, end?: string | null) {
  return start && end ? `${start} → ${end}` : 'Período não identificado'
}

export function GoogleDrivePanel({ folders, connected, configured, loading, progress, lastSync, summary, error, loadedStatements = [], onSelectFolder, onSync, onRemoveStatement = () => undefined }: {
  folders: SavedDriveFolders
  connected: boolean
  configured: boolean
  loading: boolean
  progress: string
  lastSync: string | null
  summary: DriveSyncSummary | null
  error: string
  loadedStatements?: { id: string; name: string; periodStart?: string | null; periodEnd?: string | null; transactionCount?: number; overlapCount?: number }[]
  onSelectFolder: (kind: DriveFolderKind) => void
  onSync: () => void
  onRemoveStatement?: (fileId: string) => void
}) {
  const [invoiceFilter, setInvoiceFilter] = useState<FileFilter>('all')
  const [invoiceExpanded, setInvoiceExpanded] = useState(false)
  const [statementExpanded, setStatementExpanded] = useState(false)
  const invoiceOutcomes = summary?.invoiceFileOutcomes ?? []
  const invoiceProblemCount = invoiceOutcomes.filter(isInvoiceProblem).length
  const visibleInvoiceOutcomes = invoiceFilter === 'problems' ? invoiceOutcomes.filter(isInvoiceProblem) : invoiceOutcomes
  const invoiceUniqueCount = summary?.invoicesUnique ?? invoiceOutcomes.filter((outcome) => outcome.status === 'PROCESSED_UNIQUE' || outcome.status === 'DUPLICATE_FINANCIAL').length
  const invoiceDuplicateCount = invoiceOutcomes.length ? invoiceOutcomes.filter((outcome) => outcome.status === 'DUPLICATE_FINANCIAL').length : summary?.invoiceDuplicates ?? 0
  const invoiceErrorCount = invoiceOutcomes.length ? invoiceOutcomes.filter((outcome) => outcome.status === 'PARSE_ERROR' || outcome.status === 'PROCESSING_ERROR').length : summary?.invoiceErrors ?? 0
  const statementOutcomes = summary?.statementFileOutcomes ?? []
  const loadedStatementIds = new Set(loadedStatements.map((file) => file.id))

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
    {summary && <div className="drive-sync-summary" role="status">
      <strong>{summary.newProcessed ? `${summary.newProcessed} arquivo(s) novo(s) processado(s)` : 'Sincronização concluída'}</strong>
      <small>Faturas: {summary.invoicesFound} arquivo(s) encontrado(s){summary.invoicesUnique != null ? ` · ${summary.invoicesUnique} ${summary.invoicesUnique === 1 ? 'fatura única' : 'faturas únicas'} · ${summary.invoiceDuplicates ?? 0} ${summary.invoiceDuplicates === 1 ? 'duplicado ignorado' : 'duplicados ignorados'}` : ''} · Extratos: {summary.statementsFound} arquivo(s) · Já conhecidos: {summary.alreadyKnown}</small>
      {summary.errors > 0 && <small className="google-sheets-warning">{summary.errors} arquivo(s) precisam de atenção.</small>}
      {Boolean(summary.invoiceErrors) && <small className="google-sheets-warning">Faturas com erro: {summary.invoiceErrors}</small>}
      {Boolean(summary.invoiceUnsupported) && <small>Arquivos não suportados: {summary.invoiceUnsupported}</small>}
      {Boolean(summary.invoiceSkipped) && <small>Arquivos ignorados nesta sessão: {summary.invoiceSkipped}</small>}
      <small>Arquivos ausentes desde a última listagem: {summary.removedFromFolders}{summary.removedFromFolders > 0 ? ' · Fontes removidas da conciliação atual; decisões históricas preservadas.' : ''}</small>
      {invoiceOutcomes.length > 0 && <details className="drive-diagnostic-toggle" onToggle={(event) => setInvoiceExpanded(event.currentTarget.open)}>
        <summary aria-expanded={invoiceExpanded} onClick={() => setInvoiceExpanded((expanded) => !expanded)} onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); const next = !event.currentTarget.parentElement?.hasAttribute('open'); if (event.currentTarget.parentElement instanceof HTMLDetailsElement) event.currentTarget.parentElement.open = next; setInvoiceExpanded(next) } }}><span className="drive-disclosure-icon" aria-hidden="true">{invoiceExpanded ? '▾' : '▸'}</span><span><strong>Status das faturas · {invoiceOutcomes.length}</strong><small>{invoiceOutcomes.length} arquivos · {invoiceUniqueCount} únicos · {invoiceDuplicateCount} duplicados · {invoiceErrorCount} erros</small></span></summary>
        <div className="drive-diagnostic-content">
          <div className="drive-diagnostic-filters" role="group" aria-label="Filtrar status das faturas">
            <button type="button" className={invoiceFilter === 'all' ? 'active' : ''} aria-pressed={invoiceFilter === 'all'} onClick={() => setInvoiceFilter('all')}>Todos</button>
            <button type="button" className={invoiceFilter === 'problems' ? 'active' : ''} aria-pressed={invoiceFilter === 'problems'} onClick={() => setInvoiceFilter('problems')}>Só problemas{invoiceProblemCount ? ` · ${invoiceProblemCount}` : ''}</button>
          </div>
          <ul className="drive-file-list">
            {visibleInvoiceOutcomes.map((outcome) => {
              const view = invoiceStatusView[outcome.status]
              return <li key={outcome.fileId} className={`drive-file-card tone-${view.tone}`}>
                <div className="drive-file-heading"><span className="drive-file-icon" aria-hidden="true">{view.icon}</span><strong title={outcome.fileName}>{outcome.fileName}</strong><span className="drive-file-status">{view.label}</span></div>
                <small>{view.detail}</small>
                {outcome.status === 'DUPLICATE_FINANCIAL' && outcome.financialIdentity && <details className="drive-file-technical"><summary>Ver fatura relacionada</summary><small>Identidade da fatura: {outcome.financialIdentity}</small></details>}
                {(outcome.status === 'PARSE_ERROR' || outcome.status === 'PROCESSING_ERROR') && <small className="drive-file-reason">{outcome.errorMessage || (outcome.status === 'PARSE_ERROR' ? 'Confira o conteúdo e o layout do PDF.' : 'Verifique o acesso ao arquivo no Google Drive.')}</small>}
              </li>
            })}
            {visibleInvoiceOutcomes.length === 0 && <li className="drive-file-empty">Nenhum arquivo neste filtro.</li>}
          </ul>
        </div>
      </details>}
      {statementOutcomes.length > 0 && <details className="drive-diagnostic-toggle" onToggle={(event) => setStatementExpanded(event.currentTarget.open)}>
        <summary aria-expanded={statementExpanded} onClick={() => setStatementExpanded((expanded) => !expanded)} onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); const next = !event.currentTarget.parentElement?.hasAttribute('open'); if (event.currentTarget.parentElement instanceof HTMLDetailsElement) event.currentTarget.parentElement.open = next; setStatementExpanded(next) } }}><span className="drive-disclosure-icon" aria-hidden="true">{statementExpanded ? '▾' : '▸'}</span><span><strong>Status dos extratos · {statementOutcomes.length}</strong><small>{statementOutcomes.length} arquivos · {statementOutcomes.reduce((sum, file) => sum + (file.transactionCount ?? 0), 0)} movimentações processadas · {statementOutcomes.reduce((sum, file) => sum + (file.overlapCount ?? 0), 0)} sobreposições</small></span></summary>
        <ul className="drive-file-list drive-statement-list">
          {statementOutcomes.map((file) => {
            const view = statementStatusView[file.status]
            return <li key={file.fileId} className={`drive-file-card tone-${view.tone}`}>
              <div className="drive-file-heading"><span className="drive-file-icon" aria-hidden="true">{view.icon}</span><strong title={file.fileName}>{file.fileName}</strong><span className="drive-file-status">{view.label}</span></div>
              {file.status !== 'UNSUPPORTED' && <small>{formatPeriod(file.periodStart, file.periodEnd)}</small>}
              {file.transactionCount != null && <small>{file.transactionCount} {file.transactionCount === 1 ? 'movimentação' : 'movimentações'} processadas</small>}
              {file.ignoredRowCount != null && file.ignoredRowCount > 0 && <small>{file.ignoredRowCount} {file.ignoredRowCount === 1 ? 'linha ignorada' : 'linhas ignoradas'}</small>}
              {file.excludedRowCount != null && file.excludedRowCount > 0 && <small>{file.excludedRowCount} {file.excludedRowCount === 1 ? 'linha excluída' : 'linhas excluídas'} na leitura</small>}
              {file.overlapCount != null && file.overlapCount > 0 && <small className="drive-file-reason">{file.overlapCount} {file.overlapCount === 1 ? 'movimentação já existia em outro extrato e foi deduplicada' : 'movimentações já existiam em outros extratos e foram deduplicadas'}.</small>}
              {file.detail && <small className={file.status === 'ERROR' || file.status === 'WARNING' ? 'drive-file-reason' : ''}>{file.detail}</small>}
              {loadedStatementIds.has(file.fileId) && <button className="text-button drive-file-action" type="button" disabled={loading} onClick={() => onRemoveStatement(file.fileId)}>Remover da sessão</button>}
            </li>
          })}
        </ul>
      </details>}
    </div>}
    {error && <p className="google-sheets-error" role="alert">{error}</p>}
    {!connected && <p className="google-sheets-note">Reconecte o Google para acessar as pastas configuradas.</p>}
    {!configured && <p className="google-sheets-note">Configure a chave de API e o número do projeto no `.env.local` para habilitar a seleção de pastas.</p>}
    <p className="google-sheets-note">Os arquivos são baixados diretamente do seu Google Drive para este dispositivo e processados localmente. O Conciliador não envia PDFs ou extratos para um servidor próprio. Remover da sessão não exclui arquivos do Drive.</p>
  </section>
}
