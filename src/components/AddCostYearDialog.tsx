import { useState, type FormEvent } from 'react'
import type { BankTransaction } from '../domain/types'
import type { CostYearRecordInput } from '../integrations/googleSheets'
import { COST_YEAR_PAYMENT_METHODS, inferCostPaymentMethod } from '../features/costYearRecord'
import { bankDisplayDescription, normalizeDate } from '../importers/normalize'

function dateLabel(value: string) {
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})$/)
  return match ? `${match[3]}/${match[2]}/${match[1]}` : value
}

export function AddCostYearDialog({ transaction, initial, categories, connected, saving, error, onCancel, onReconnect, onSubmit }: {
  transaction?: BankTransaction
  initial?: { description: string; sheetDate?: string; date?: string; amount: number; paymentSource?: 'BANK' | 'STATEMENT'; purchaseDate?: string; invoiceDueDate?: string | null }
  categories: string[]
  connected: boolean
  saving: boolean
  error: string
  onCancel: () => void
  onReconnect: () => void
  onSubmit: (record: CostYearRecordInput) => void
}) {
  const [description, setDescription] = useState(initial?.description ?? (transaction ? bankDisplayDescription(transaction.originalDescription) : '') )
  const [sheetDate, setSheetDate] = useState(initial?.sheetDate ?? initial?.date ?? transaction?.date ?? '')
  const [category, setCategory] = useState('')
  const [amount, setAmount] = useState(((initial?.amount ?? transaction?.amount ?? 0) / 100).toFixed(2))
  const [paymentMethod, setPaymentMethod] = useState(inferCostPaymentMethod(initial?.description ?? transaction?.originalDescription ?? '', initial?.paymentSource ?? 'BANK'))
  const [isFixed, setIsFixed] = useState(false)
  const [isEssential, setIsEssential] = useState(false)
  const [submitted, setSubmitted] = useState(false)
  const invoiceDateFallback = initial?.paymentSource === 'STATEMENT' && !initial.invoiceDueDate
  const errors = {
    description: description.trim() ? '' : 'Informe uma descrição.',
    date: normalizeDate(sheetDate) === sheetDate ? '' : 'Informe uma data válida.',
    category: categories.includes(category) ? '' : categories.length ? 'Selecione uma categoria disponível na planilha.' : 'Nenhuma categoria disponível foi carregada da planilha.',
    amount: Number.isFinite(Number(amount)) && Number(amount) > 0 ? '' : 'O custo deve ser maior que zero.',
    paymentMethod: COST_YEAR_PAYMENT_METHODS.some((method) => method === paymentMethod) ? '' : 'Selecione uma forma de pagamento válida.',
  }

  function submit(event: FormEvent) {
    event.preventDefault()
    setSubmitted(true)
    if (Object.values(errors).some(Boolean)) return
    onSubmit({ description: description.trim(), date: sheetDate, category, amount: Math.round(Number(amount) * 100), paymentMethod, isFixed, isEssential })
  }

  return <div className="cost-dialog-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget && !saving) onCancel() }}>
    <section className="cost-dialog" role="dialog" aria-modal="true" aria-labelledby="cost-dialog-title">
      <div className="cost-dialog-heading"><div><span className="step-label">NOVA LINHA</span><h2 id="cost-dialog-title">Adicionar lançamento à CUSTOS ANO</h2></div><button type="button" className="icon-button" aria-label="Fechar" disabled={saving} onClick={onCancel}>×</button></div>
      <p className="cost-dialog-note">Será adicionada uma nova linha. Nenhuma linha existente será editada ou removida.</p>
      <form onSubmit={submit} noValidate>
        <label className="cost-field">Descrição<input autoFocus value={description} onChange={(event) => setDescription(event.target.value)} aria-invalid={submitted && Boolean(errors.description)} /></label>
        {submitted && errors.description && <small className="cost-field-error">{errors.description}</small>}
        <div className="cost-dialog-grid">
          <label className="cost-field">Data<input type="date" value={sheetDate} onChange={(event) => setSheetDate(event.target.value)} aria-invalid={submitted && Boolean(errors.date)} /></label>
          <label className="cost-field">Custo (R$)<input type="number" inputMode="decimal" min="0.01" step="0.01" value={amount} onChange={(event) => setAmount(event.target.value)} aria-invalid={submitted && Boolean(errors.amount)} /></label>
        </div>
        {initial?.paymentSource === 'STATEMENT' && <div className="cost-statement-date-context"><small>Data real da compra: {dateLabel(initial.purchaseDate ?? initial.sheetDate ?? initial.date ?? '')}</small><small>{invoiceDateFallback ? 'Vencimento não identificado; a data da compra foi preenchida como alternativa.' : 'Data preenchida pelo vencimento da fatura; você pode editá-la.'}</small></div>}
        {submitted && (errors.date || errors.amount) && <small className="cost-field-error">{errors.date || errors.amount}</small>}
        <label className="cost-field">Categoria<select value={category} onChange={(event) => setCategory(event.target.value)} aria-invalid={submitted && Boolean(errors.category)}><option value="">Selecionar categoria</option>{categories.map((value) => <option key={value}>{value}</option>)}</select></label>
        {submitted && errors.category && <small className="cost-field-error">{errors.category}</small>}
        <label className="cost-field">Forma de pagamento<select value={paymentMethod} onChange={(event) => setPaymentMethod(event.target.value)} aria-invalid={submitted && Boolean(errors.paymentMethod)}><option value="">Confirmar forma de pagamento</option>{COST_YEAR_PAYMENT_METHODS.map((value) => <option key={value}>{value}</option>)}</select></label>
        {submitted && errors.paymentMethod && <small className="cost-field-error">{errors.paymentMethod}</small>}
        <div className="cost-checkboxes"><label><input type="checkbox" checked={isFixed} onChange={(event) => setIsFixed(event.target.checked)} />É fixo?</label><label><input type="checkbox" checked={isEssential} onChange={(event) => setIsEssential(event.target.checked)} />É essencial?</label></div>
        {error && <p className="cost-dialog-error" role="alert">{error}</p>}
        {!connected && <button type="button" className="button button-outline cost-reconnect" onClick={onReconnect} disabled={saving}>Reconectar Google</button>}
        <div className="cost-dialog-actions"><button type="button" className="button button-outline" onClick={onCancel} disabled={saving}>Cancelar</button><button type="submit" className="button button-primary" disabled={saving || !connected}>{saving ? 'Verificando e adicionando…' : 'Adicionar à CUSTOS ANO'}</button></div>
      </form>
    </section>
  </div>
}
