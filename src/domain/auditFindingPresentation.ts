import type { AuditFinding, AuditSeverity } from './consistencyAudit'

export type AuditFindingDescription = { title: string; explanation: string; impact: string; recommendedAction: string; severityLabel: string }
const severityLabels: Record<AuditSeverity, string> = {
  CRITICAL: 'Crítico', REVIEW: 'Precisa de revisão', MAINTENANCE: 'Manutenção', LEGACY: 'Legado', INFO: 'Informativo',
}

const descriptions: Record<AuditFinding['code'], { title: string; explanation: string }> = {
  MISSING_COM_CANDIDATO: { title: 'Há um lançamento compatível que merece conferência', explanation: 'A conciliação marcou uma movimentação como ausente, mas encontrou um lançamento da planilha que pode corresponder a ela.' },
  CARD_MISSING_NO_CANDIDATE: { title: 'Uma compra pode estar sendo considerada ausente incorretamente', explanation: 'Uma linha da planilha foi descartada pela classificação atual, embora seus dados possam ser relevantes para esta compra.' },
  DERIVED_STATE_MISMATCH: { title: 'O resultado da compra mudou durante a conciliação', explanation: 'As etapas da conciliação chegaram a resultados diferentes para esta compra. Confira os dados antes de tomar uma decisão.' },
  PREWRITE_MATCH_MISMATCH: { title: 'A verificação antes de salvar encontrou outro resultado', explanation: 'A busca usada para evitar duplicidades encontrou um lançamento que não aparece no resultado final da conciliação.' },
  STALE_MISSING_DECISION: { title: 'Uma decisão salva pode estar desatualizada', explanation: 'Uma decisão anterior de ausência não corresponde ao resultado atual da compra.' },
  ORPHANED_SHEET_REFERENCE: { title: 'Uma confirmação aponta para um lançamento que não foi encontrado', explanation: 'Há uma decisão salva que referencia uma linha ausente na versão atual da CUSTOS ANO.' },
  EDITED_SHEET_REFERENCE: { title: 'O lançamento vinculado foi alterado', explanation: 'Os dados atuais da linha vinculada diferem dos dados registrados quando a confirmação foi feita.' },
  MISSING_ADDED_TO_SHEET_ORPHAN: { title: 'Uma inclusão confirmada não foi localizada na planilha', explanation: 'O registro esperado após uma inclusão não apareceu na leitura atual da CUSTOS ANO.' },
  DOUBLE_CLAIM: { title: 'O mesmo lançamento está ligado a duas compras', explanation: 'Mais de uma compra está reivindicando a mesma linha da CUSTOS ANO.' },
  UNUSED_STRONG_CANDIDATE: { title: 'Uma linha compatível não foi usada', explanation: 'Existe uma linha que passou pela busca de compatibilidade, mas ela não foi atribuída a esta compra.' },
  LEGACY_FINGERPRINT_MATCH: { title: 'Este vínculo foi criado por uma versão antiga do sistema', explanation: 'O sistema reconheceu o lançamento atual, mas a decisão salva usa uma identidade de uma versão anterior do Conciliador.' },
  LOCAL_REMOTE_DECISION_DIVERGENCE: { title: 'Há uma diferença entre os dados locais e os sincronizados', explanation: 'As cópias local e sincronizada de uma decisão não estão iguais. Confira o resultado da sincronização antes de agir.' },
  NEWER_TOMBSTONE_EXISTS: { title: 'Uma decisão anterior foi removida depois da cópia ativa', explanation: 'Há um registro de remoção mais recente que a decisão ativa encontrada.' },
  WRONG_DECISION_DOMAIN: { title: 'Uma confirmação foi aplicada a um tipo de registro inesperado', explanation: 'Uma decisão parece ter influenciado um item de outra parte da conciliação.' },
  REVIEW_ONLY_WRONG_CYCLE_CANDIDATES: { title: 'As linhas compatíveis parecem pertencer a outro ciclo', explanation: 'Os lançamentos encontrados estão em datas diferentes do período desta fatura.' },
  IGNORED_DECISION_REVIEW: { title: 'Uma decisão de ignorar precisa ser conferida', explanation: 'Uma movimentação ignorada ainda apresenta evidências que podem justificar uma nova análise.' },
  CURRENT_SOURCE_DIVERGENCE: { title: 'A planilha carregada difere da leitura atual', explanation: 'Os dados disponíveis na sessão e a leitura mais recente da CUSTOS ANO não apresentam os mesmos lançamentos.' },
  REJECTED_CANDIDATE_FILTERED: { title: 'Uma rejeição salva removeu uma linha compatível', explanation: 'Uma decisão anterior está excluindo uma linha que a busca atual considera candidata.' },
  DECISION_STATUS: { title: 'Uma decisão salva precisa de conferência', explanation: 'O estado atual de uma decisão não pode ser aplicado com segurança ao resultado analisado.' },
  SYNC_PENDING: { title: 'Há alterações aguardando sincronização', explanation: 'Algumas decisões ainda não foram atualizadas entre este dispositivo e a cópia sincronizada.' },
}

const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' ? value as Record<string, unknown> : {}
const money = (cents: unknown) => typeof cents === 'number' ? new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(cents / 100) : ''
const displayDate = (value: unknown) => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value.slice(8, 10)}/${value.slice(5, 7)}/${value.slice(0, 4)}` : String(value ?? '')

export function describeAuditFinding(finding: AuditFinding): AuditFindingDescription {
  const base = descriptions[finding.code]
  const row = record(finding.technical?.row)
  const subjects = Array.isArray(finding.technical?.subjects) ? finding.technical!.subjects.map(record) : []
  let title = base.title
  let explanation = base.explanation
  let impact = finding.severity === 'INFO' || finding.severity === 'LEGACY'
    ? 'O resultado financeiro não indica, por si só, uma divergência que exija correção.'
    : finding.severity === 'CRITICAL'
      ? 'Agir sem conferir pode causar uma duplicidade ou deixar uma despesa sem conciliação.'
      : 'A situação merece conferência antes de alterar uma confirmação ou lançamento.'
  let recommendedAction = finding.severity === 'INFO'
    ? 'Nenhuma ação necessária. Você pode ocultar este aviso.'
    : finding.severity === 'LEGACY'
      ? 'Nenhuma correção é necessária sem outro sinal de divergência. Você pode manter ou ocultar este aviso.'
      : finding.severity === 'CRITICAL'
        ? 'Revise os dados antes de alterar qualquer vínculo ou adicionar uma linha à planilha.'
        : 'Revisar manualmente antes de alterar qualquer vínculo.'

  if (finding.code === 'DERIVED_STATE_MISMATCH' && finding.technical?.pipeline) {
    const pipeline = record(finding.technical.pipeline)
    if (pipeline.base === 'CARD_REVIEW' && pipeline.final === 'CARD_GROUP_MATCHED') {
      title = 'As compras foram conciliadas corretamente em grupo'
      explanation = 'A análise individual encontrou mais de uma combinação possível. Ao considerar compras e lançamentos em conjunto, o sistema encontrou uma correspondência consistente para o grupo.'
      impact = 'Não há divergência financeira identificada neste grupo.'
      recommendedAction = 'Nenhuma ação necessária. Este aviso pode ser ocultado.'
    }
  }
  if (finding.code === 'DOUBLE_CLAIM') {
    const description = String(row.description ?? 'um lançamento')
    const date = displayDate(row.date)
    const amount = money(row.amount)
    title = 'O mesmo lançamento está ligado a duas compras'
    explanation = `${description}${date ? `, de ${date}` : ''}${amount ? ` (${amount})` : ''} está sendo reivindicado por ${subjects.length || 'mais de uma'} compras diferentes.`
    if (finding.technical?.safeInvalidation) {
      impact = 'Um vínculo antigo está entrando em conflito com a correspondência atual.'
      recommendedAction = 'Descartar o vínculo antigo identificado. A ação removerá apenas essa confirmação.'
    } else {
      impact = 'As compras podem disputar o mesmo lançamento e deixar uma delas sem correspondência.'
      recommendedAction = 'Revisar manualmente antes de alterar qualquer vínculo.'
    }
  }
  if (finding.code === 'LEGACY_FINGERPRINT_MATCH') {
    impact = 'O resultado financeiro atual foi reconhecido; o aviso informa apenas que a confirmação é antiga.'
    recommendedAction = 'Nenhuma correção é necessária. Você pode manter ou ocultar este aviso.'
  }
  if (finding.code === 'CARD_MISSING_NO_CANDIDATE' && finding.severity === 'CRITICAL') {
    impact = 'Adicionar esta compra sem revisar pode criar uma despesa duplicada.'
    recommendedAction = 'Não adicione este item novamente antes de revisar a classificação e os dados relacionados.'
  }
  if (finding.code === 'MISSING_COM_CANDIDATO' || finding.code === 'REJECTED_CANDIDATE_FILTERED') {
    recommendedAction = 'Reanalisar este item antes de adicionar uma nova linha à planilha.'
  }
  if (finding.severity === 'CRITICAL' && finding.code !== 'DOUBLE_CLAIM' && finding.code !== 'CARD_MISSING_NO_CANDIDATE') {
    recommendedAction = 'Não faça alterações com base apenas neste aviso. Confira os dados e revise manualmente.'
  }
  return { title, explanation, impact, recommendedAction, severityLabel: severityLabels[finding.severity] }
}
