import { useEffect, useState } from 'react'

export interface GoogleSheetsConnectionInfo {
  spreadsheetId: string
  spreadsheetTitle: string
  sheetName: string
  rowCount: number
  lastUpdated: string | null
  connected: boolean
}

export function GoogleSheetsPanel({ configured, info, loading, error, decisionStatus = '', editing, onConnect, onRefresh, onSyncDecisions = () => undefined, onDisconnect, onChangeSheet, onForgetLink }: {
  configured: boolean
  info: GoogleSheetsConnectionInfo | null
  loading: boolean
  error: string
  decisionStatus?: string
  editing: boolean
  onConnect: (input: string) => void
  onRefresh: () => void
  onSyncDecisions?: () => void
  onDisconnect: () => void
  onChangeSheet: () => void
  onForgetLink: () => void
}) {
  const [spreadsheetInput, setSpreadsheetInput] = useState(info?.spreadsheetId ?? '')
  useEffect(() => { if (info?.spreadsheetId) setSpreadsheetInput(info.spreadsheetId) }, [info?.spreadsheetId])
  const linked = info != null
  const canEditLink = !linked || editing
  const formattedUpdate = info?.lastUpdated ? new Date(info.lastUpdated).toLocaleString('pt-BR') : null

  return <section className="panel google-sheets-panel" aria-labelledby="google-sheets-heading">
    <div className="panel-heading"><div><h2 id="google-sheets-heading">Google Sheets</h2><p>Conexão para ler CUSTOS ANO e sincronizar decisões; a fonte dos lançamentos é escolhida abaixo.</p></div><span className={`google-connection-badge ${info?.connected ? 'connected' : ''}`}>{linked ? `✓ Planilha vinculada${info.connected ? ' · Google conectado' : ''}` : 'Opcional'}</span></div>
    {linked && !canEditLink && <div className="google-sheets-info"><strong>{info.spreadsheetTitle}</strong><small>Aba: {info.sheetName}</small><small>{formattedUpdate ? `Última atualização: ${formattedUpdate}` : 'Aguardando conexão para atualizar os dados.'}</small>{!info.connected && error && <small className="google-sheets-warning">Reconecte para atualizar a planilha. Os dados locais atuais foram mantidos.</small>}</div>}
    {canEditLink && <label className="google-sheet-input">URL ou ID da planilha<input value={spreadsheetInput} onChange={(event) => setSpreadsheetInput(event.target.value)} placeholder="https://docs.google.com/spreadsheets/d/..." autoComplete="off" /></label>}
    <div className="google-sheets-actions">
      {!linked || editing
        ? <button className="button button-primary" disabled={loading || !configured || !spreadsheetInput.trim()} onClick={() => onConnect(spreadsheetInput)}>{loading ? 'Validando e carregando…' : linked ? 'Validar e trocar planilha' : 'Conectar Google Sheets'}</button>
        : info.connected
          ? <button className="button button-outline" disabled={loading} onClick={onRefresh}>{loading ? 'Atualizando…' : 'Atualizar dados'}</button>
          : <button className="button button-primary" disabled={loading || !configured} onClick={() => onConnect(info.spreadsheetId)}>{loading ? 'Reconectando…' : 'Reconectar Google'}</button>}
      {linked && !editing && <button className="button button-outline" disabled={loading} onClick={onChangeSheet}>Trocar planilha</button>}
      {linked && <button className="text-button" disabled={loading} onClick={onDisconnect}>Desconectar Google</button>}
      {linked && !editing && <button className="text-button" disabled={loading} onClick={onForgetLink}>Esquecer planilha vinculada</button>}
      {linked && info.connected && !editing && <button className="button button-outline" disabled={loading} onClick={onSyncDecisions}>Sincronizar decisões</button>}
      {linked && editing && <button className="text-button" disabled={loading} onClick={() => { setSpreadsheetInput(info.spreadsheetId); onChangeSheet() }}>Cancelar troca</button>}
    </div>
    {!configured && <p className="google-sheets-note">Falta configurar o OAuth Client ID no arquivo `.env.local`. Veja as instruções no README.</p>}
    {error && <p className="google-sheets-error" role="alert">{error}</p>}
    {decisionStatus && <p className="google-sheets-note" role="status">{decisionStatus}</p>}
    <p className="google-sheets-note">CUSTOS ANO é somente leitura. As decisões de conciliação podem ser gravadas apenas na aba auxiliar _CONCILIADOR. Extratos e PDFs permanecem neste dispositivo.</p>
  </section>
}
