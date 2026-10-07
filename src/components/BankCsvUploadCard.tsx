import { useState } from 'react'
import type { ChangeEvent } from 'react'
import type { ColumnMap, CsvDocument, Transaction } from '../domain/types'
import { normalizeHeader } from '../importers/csv'

type Upload = { fileName: string; csv: CsvDocument; map: ColumnMap; valid: Transaction[]; issues: { row: number; message: string }[]; rowCount: number; ignoredRows: number; auxiliaryTransactionCount?: number; auxiliaryIncludedCount?: number; auxiliaryOutsidePeriodCount?: number }
type Props = {
  upload: Upload
  accepted: boolean
  onMapChange: (key: keyof ColumnMap, value: string) => void
  onAccept: () => void
  onClear: () => void
  onSelect: (event: ChangeEvent<HTMLInputElement>) => void
  fieldTitles: Record<keyof ColumnMap, string>
  requiredFields: (keyof ColumnMap)[]
  optionalFields: (keyof ColumnMap)[]
}

function profile(upload: Upload) {
  const roles: Record<string, string[]> = {
    date: ['data', 'data da compra', 'data lancamento', 'data transacao', 'dt lancamento', 'date'],
    description: ['descricao', 'historico', 'estabelecimento', 'lancamento', 'description', 'merchant', 'favorecido'],
    amount: ['custo', 'valor', 'valor da transacao', 'valor lancamento', 'amount', 'valor r'],
    debit: ['debito', 'debitos', 'debito r', 'saida', 'saidas'],
    credit: ['credito', 'creditos', 'credito r', 'entrada', 'entradas'],
    direction: ['tipo', 'natureza', 'operacao', 'debito credito'],
    id: ['id', 'identificador', 'id transacao', 'codigo transacao', 'transaction id', 'nsu', 'docto', 'documento'],
    balance: ['saldo', 'saldo apos lancamento', 'saldo final', 'saldo r', 'balance'],
    paymentMethod: ['forma de pagamento', 'meio de pagamento', 'pagamento', 'payment method'],
  }
  const matches = Object.fromEntries(Object.entries(roles).map(([key, names]) => [key, upload.csv.headers.filter((header) => names.includes(normalizeHeader(header)))])) as Record<string, string[]>
  const ambiguous = Object.values(matches).some((headers) => headers.length > 1)
  const missing = [!upload.map.date ? 'Data' : '', !upload.map.description ? 'Histórico/Descrição' : '', !(upload.map.debit && upload.map.credit) && !(upload.map.amount && upload.map.direction) ? 'Entradas e saídas' : ''].filter(Boolean)
  const headers = upload.csv.headers.map(normalizeHeader)
  const bradesco = headers.includes('historico') && headers.includes('credito r') && headers.includes('debito r') && headers.some((header) => header === 'saldo' || header === 'saldo r')
  return { bradesco, ambiguous, missing, recognized: bradesco && !ambiguous && missing.length === 0 && upload.valid.length > 0 }
}

const dateLabel = (date: string) => {
  const [year, month, day] = date.split('-')
  return year && month && day ? `${day}/${month}/${year}` : date
}

export function BankCsvUploadCard({ upload, accepted, onMapChange, onAccept, onClear, onSelect, fieldTitles, requiredFields, optionalFields }: Props) {
  const [advancedOpen, setAdvancedOpen] = useState(false)
  const [issuesOpen, setIssuesOpen] = useState(false)
  const dates = upload.valid.map((row) => row.date).filter(Boolean).sort()
  const period = upload.csv.statementPeriodStart && upload.csv.statementPeriodEnd
    ? `Período do extrato: ${dateLabel(upload.csv.statementPeriodStart)} a ${dateLabel(upload.csv.statementPeriodEnd)}`
    : dates.length ? `Período: ${dateLabel(dates[0])} a ${dateLabel(dates[dates.length - 1])}` : 'Período não identificado'
  const auxiliaryNotes = upload.csv.auxiliarySectionLabel ? [
    upload.auxiliaryIncludedCount ? `${upload.auxiliaryIncludedCount} lançamento(s) financeiro(s) de Últimos Lançamentos dentro do período foram incorporados.` : '',
    upload.auxiliaryOutsidePeriodCount ? `${upload.auxiliaryOutsidePeriodCount} lançamento(s) auxiliar(es) fora do período foram ignorados.` : '',
    !upload.auxiliaryIncludedCount && !upload.auxiliaryOutsidePeriodCount && upload.auxiliaryTransactionCount ? `O arquivo também contém ${upload.auxiliaryTransactionCount} lançamentos recentes fora do período selecionado. Eles foram ignorados na conciliação.` : '',
  ].filter(Boolean) : []
  const fields = <div className="mapping-grid"><strong className="mapping-heading">Configuração avançada</strong>{[...requiredFields, ...optionalFields].map((key) => <label className="map-field" key={key}><span>{fieldTitles[key]}{requiredFields.includes(key) && <i> · obrigatório</i>}</span><select value={upload.map[key] ?? ''} onChange={(event) => onMapChange(key, event.target.value)}><option value="">{requiredFields.includes(key) ? 'Selecione uma coluna' : 'Não disponível'}</option>{upload.csv.headers.map((header) => <option key={header} value={header}>{header}</option>)}</select></label>)}</div>
  const preview = <details className="csv-preview"><summary>Ver prévia ▸ <span>{upload.valid.length} válidas · {upload.ignoredRows} ignoradas · {upload.issues.length} problemas</span></summary><div className="preview-table-wrap"><table className="preview-table"><thead><tr>{upload.csv.headers.slice(0, 6).map((header) => <th key={header}>{header}</th>)}</tr></thead><tbody>{upload.csv.rows.slice(0, 4).map((row, index) => <tr key={index}>{upload.csv.headers.slice(0, 6).map((header) => <td key={header}>{row[header]}</td>)}</tr>)}</tbody></table></div></details>
  const issueDetails = upload.issues.length > 0 && <div className="issue-preview"><div><span className="status-icon amber">!</span><span><strong>{upload.issues.length} problema(s) para conferir</strong><small>As linhas inválidas não serão importadas.</small></span><button className="text-button" onClick={() => setIssuesOpen(!issuesOpen)}>{issuesOpen ? 'Recolher' : 'Detalhes'}</button></div>{issuesOpen && <ul>{upload.issues.slice(0, 8).map((issue, index) => <li key={index}>Linha {issue.row}: {issue.message}</li>)}</ul>}</div>
  return <article className={`upload-card upload-card-loaded ${accepted ? 'upload-card-accepted' : ''} upload-card-compact`}>
    <div className="upload-top"><span className="upload-icon bank">◈</span><span className="upload-state">{accepted ? '✓ Extrato carregado' : 'CSV validado'}</span></div>
    <h3>Importar extrato</h3><p className="upload-subtitle">CSV do banco ou cartão</p>
    {accepted ? <>
      <div className="accepted-file"><span className="accepted-check" aria-hidden="true">✓</span><div><strong>Extrato carregado · {upload.valid.length} lançamentos</strong><small>{upload.fileName}</small><small>{period} · {upload.issues.length} problemas</small></div></div>
      <details className="csv-loaded-details"><summary>Ver detalhes</summary><small>Formato identificado: Bradesco</small>{auxiliaryNotes.map((note) => <small key={note}>{note}</small>)}{upload.csv.metadataRowsIgnored > 0 && <small>{upload.csv.metadataRowsIgnored} linha(s) de metadados ignorada(s) antes do cabeçalho.</small>}{preview}{issueDetails}</details>
      <div className="accepted-actions"><label className="button button-outline replace-file"><input type="file" aria-label="Selecionar arquivo CSV" accept=".csv,text/csv" onChange={onSelect}/>Substituir arquivo</label><button className="button button-quiet button-small" onClick={onClear}>Remover</button></div>
    </> : <>
      <div className="bank-recognition-summary"><strong>Extrato reconhecido</strong><span>{upload.fileName}</span><span>{upload.valid.length} lançamentos válidos</span><span>{period}</span>{auxiliaryNotes.map((note) => <span key={note}>{note}</span>)}<span>Formato identificado: Bradesco</span></div>
      <ul className="bank-detected-fields"><li>✓ Data identificada</li><li>✓ Histórico identificado</li><li>✓ Entradas e saídas identificadas</li>{upload.map.balance && <li>✓ Saldo identificado</li>}</ul>
      {upload.issues.length > 0 && <p className="bank-compact-warning">{upload.issues.length} problema(s) de linha; detalhes disponíveis abaixo.</p>}
      <button className="button button-secondary full-button" disabled={!upload.valid.length} onClick={onAccept}>Usar extrato <span aria-hidden="true">→</span></button>
      <button className="text-button bank-advanced-toggle" aria-expanded={advancedOpen} onClick={() => setAdvancedOpen(!advancedOpen)}>Configuração avançada {advancedOpen ? '▾' : '▸'}</button>
      {advancedOpen && <>{fields}{preview}{upload.csv.metadataRowsIgnored > 0 && <details className="csv-metadata"><summary>Detalhes do arquivo</summary><small>{upload.csv.metadataRowsIgnored} linha(s) de metadados ignoradas antes do cabeçalho.</small></details>}{issueDetails}</>}
      {!advancedOpen && <details className="csv-metadata"><summary>Detalhes do arquivo</summary><small>Separador {upload.csv.delimiter === ',' ? 'vírgula' : upload.csv.delimiter === ';' ? 'ponto e vírgula' : upload.csv.delimiter || 'automático'}.</small>{upload.csv.metadataRowsIgnored > 0 && <small>{upload.csv.metadataRowsIgnored} linha(s) de metadados ignoradas antes do cabeçalho.</small>}{preview}{issueDetails}</details>}
    </>}
  </article>
}

export function bankCsvRequiresManualMapping(upload: Upload): boolean {
  const result = profile(upload)
  return !result.recognized
}
