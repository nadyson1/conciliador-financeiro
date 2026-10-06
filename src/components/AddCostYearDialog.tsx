import { useState, type FormEvent } from 'react'
import type { BankTransaction } from '../domain/types'
import type { CostYearRecordInput } from '../integrations/googleSheets'
import { COST_YEAR_PAYMENT_METHODS, inferCostPaymentMethod } from '../features/costYearRecord'
import { normalizeDate } from '../importers/normalize'

export function AddCostYearDialog({ transaction, initial, categories, connected, saving, error, onCancel, onReconnect, onSubmit }: {
  transaction?: BankTransaction
  initial?: { description: string; date: string; amount: number; paymentSource?: 'BANK' | 'STATEMENT' }
  categories: string[]
  connected: boolean
  saving: boolean
  error: string
  onCancel: () => void
  onReconnect: () => void
  onSubmit: (record: CostYearRecordInput) => void
}) {
  const [description, setDescription] = useState(initial?.description ?? transaction?.originalDescription ?? '')
  const [date, setDate] = useState(initial?.date ?? transaction?.date ?? '')
  const [category, setCategory] = useState('')
  const [amount, setAmount] = useState(((initial?.amount ?? transaction?.amount ?? 0) / 100).toFixed(2))
  const [paymentMethod, setPaymentMethod] = useState(inferCostPaymentMethod(initial?.description ?? transaction?.originalDescription ?? '', initial?.paymentSource ?? 'BANK'))
  const [isFixed, setIsFixed] = useState(false)
  const [isEssential, setIsEssential] = useState(false)
  const [submitted, setSubmitted] = useState(false)
  const errors = {
    description: description.trim() ? '' : 'Informe uma descrição.',
    date: normalizeDate(date) === date ? '' : 'Informe uma data válida.',
    category: categories.includes(category) ? '' : categories.length ? 'Selecione uma categoria disponível na planilha.' : 'Nenhuma categoria disponível foi carregada da planilha.',
    amount: Number.isFinite(Number(amount)) && Number(amount) > 0 ? '' : 'O custo deve ser maior que zero.',
    paymentMethod: COST_YEAR_PAYMENT_METHODS.some((method) => method === paymentMethod) ? '' : 'Selecione uma forma de pagamento válida.',
  }

  function submit(event: FormEvent) {
    event.preventDefault()
    setSubmitted(true)
    if (Object.values(errors).some(Boolean)) return
    onSubmit({ description: description.trim(), date, category, amount: Math.round(Number(amount) * 100), paymentMethod, isFixed, isEssential })
  }

  return <div className="cost-dialog-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget && !saving) onCancel() }}>
    <section className="cost-dialog" role="dialog" aria-modal="true" aria-labelledby="cost-dialog-title">
      <div className="cost-dialog-heading"><div><span className="step-label">NOVA LINHA</span><h2 id="cost-dialog-title">Adicionar lançamento à CUSTOS ANO</h2></div><button type="button" className="icon-button" aria-label="Fechar" disabled={saving} onClick={onCancel}>×</button></div>
      <p className="cost-dialog-note">Será adicionada uma nova linha. Nenhuma linha existente será editada ou removida.</p>
      <form onSubmit={submit} noValidate>
        <label className="cost-field">Descrição<input autoFocus value={description} onChange={(event) => setDescription(event.target.value)} aria-invalid={submitted && Boolean(errors.description)} /></label>
        {submitted && errors.description && <small className="cost-field-error">{errors.description}</small>}
        <div className="cost-dialog-grid">
          <label className="cost-field">Data<input type="date" value={date} onChange={(event) => setDate(event.target.value)} aria-invalid={submitted && Boolean(errors.date)} /></label>
          <label className="cost-field">Custo (R$)<input type="number" inputMode="decimal" min="0.01" step="0.01" value={amount} onChange={(event) => setAmount(event.target.value)} aria-invalid={submitted && Boolean(errors.amount)} /></label>
        </div>
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
