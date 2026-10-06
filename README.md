# Conciliador Financeiro

PWA estática para comparar, no próprio dispositivo, os lançamentos da aba `CUSTOS ANO` com um extrato bancário em CSV. A planilha pode ser lida opcionalmente pelo navegador com Google Identity Services e Sheets API; o CSV manual continua disponível. A única escrita remota é a sincronização explícita das decisões do usuário na aba auxiliar `_CONCILIADOR`.

## O que está implementado

- Importação local de CSV da planilha e CSV bancário/cartão, com delimitador detectado, BOM, UTF-8, acentos e campos entre aspas.
- Leitura opcional e sob demanda da aba existente `CUSTOS ANO` pela Google Sheets API v4; cabeçalhos mapeados pelo nome e convertidos para o mesmo `LedgerTransaction` do CSV.
- Importação de fatura PDF Bradesco com PDF.js, extração local do texto/layout, separação de cartões e compras, detecção de parcelas e exclusão de pagamento anterior.
- Validação matemática de compras, subtotais por cartão e total informado; conciliação das compras individuais apenas contra `Crédito_Bradesco`, com match, revisão manual ou compra ausente.
- Mapeamento editável de cabeçalhos; prévia das linhas; totais válidos e inválidos; detalhes dos problemas encontrados.
- Normalização independente de datas civis, valores em centavos, descrições e campos booleanos.
- Matching explicável, com pesos centralizados, sugestão de candidatos e prevenção de pareamento automático ambíguo.
- Revisão manual para confirmar ou ignorar; classificação separada entre despesas, investimentos, entradas, transferências, pagamentos de cartão e natureza não confirmada.
- Abas próprias para Resumo, Revisão, Ausentes, pagamentos agregados, fatura PDF, Duplicidades, Fora do escopo e Sinalizações; indicadores do dashboard navegam para cada resultado.
- Dashboard, filtros por ano, mês e período personalizado; totais, créditos/débitos e saldos quando o CSV fornece saldo por lançamento.
- Exportação local de ausências, revisão, composições de faturas, itens fora do escopo, duplicidades e resumo.
- Layout escuro responsivo e PWA com manifesto, ícone, service worker e pré-cache do shell estático.

## Privacidade e identificadores

CSVs e PDF são lidos e processados em memória no navegador. PDF.js extrai texto usando um worker estático empacotado na própria aplicação e pré-armazenado pela PWA; não há upload do arquivo, extração remota ou OCR. O service worker pré-armazena recursos da aplicação e não configura cache de rede. A integração Google usa OAuth client-side, sem backend, e o escopo `spreadsheets` para ler `CUSTOS ANO` e sincronizar decisões somente em `_CONCILIADOR`. O access token permanece apenas em memória e é revogado ao desconectar. Nenhum CSV bancário, PDF, extrato, descrição, valor ou resultado completo de matching é enviado ao Google. O IndexedDB e a aba auxiliar guardam apenas tipos de decisão, IDs/fingerprints, IDs relacionados, escolha confirmada e datas de atualização; arquivos e transações completos não são persistidos. A opção **Limpar confirmações salvas** também propaga remoções para outros dispositivos na próxima sincronização.

O app mantém `sheetRecordId` e `bankTransactionId` separados; quando IDs de origem não existem ou se repetem, gera fingerprints determinísticos a partir de atributos da movimentação para conservar decisões após a reimportação. IDs de fontes diferentes nunca são comparados como se fossem equivalentes.

`Mês` e `Ano` são retidos sem recálculo. A data normalizada usada para filtros não é gravada de volta. `Categoria`, `Forma de pagamento`, `É fixo?` e `É essencial?` são preservados; categoria e flags não são critérios centrais do matching.

## Matching e classificações

Pesos iniciais ficam em `src/matching/reconcile.ts`: valor exato (+50), data (+25/20/15/8 para 0–3 dias), descrição (+25/20/12/5 por faixa de similaridade) e forma de pagamento (+5). A direção precisa ser compatível, e a pontuação não usa `sheetRecordId` contra `bankTransactionId`. Correspondências automáticas exigem pontuação mínima e margem sem ambiguidade; os outros candidatos vão para revisão. Valor igual, sozinho, nunca é suficiente para conciliar automaticamente.

Transferências e pagamentos de fatura são separados de despesas. Um CSV que não permita determinar débito ou crédito fica em revisão. PIX não é presumido como despesa por si só. Duplicidades são apenas sinalizadas; nenhuma linha é removida.

O matching comum de despesas continua 1:1. Pagamentos de fatura `GASTOS CARTAO DE CREDITO` têm conciliação 1:N própria, conforme os limites descritos abaixo. Estornos são separados de compras e não entram na lista de compras ausentes.

## Executar

```sh
npm install
npm run dev
```

### Configurar Google Sheets (opcional)

1. No Google Cloud Console, habilite a Google Sheets API e configure a tela de consentimento OAuth. O escopo solicitado é `https://www.googleapis.com/auth/spreadsheets`, necessário para escrever apenas na aba auxiliar de decisões. Como o escopo é mais amplo que `spreadsheets.readonly`, usuários já conectados podem precisar conceder autorização novamente uma vez.
2. Crie um OAuth Client ID do tipo **Aplicativo da Web** e inclua a origem exata usada para abrir o app (por exemplo, `http://localhost:4173` no ambiente local e a origem HTTPS publicada). Não crie client secret para esta PWA.
3. Crie `.env.local` na raiz do projeto e informe `VITE_GOOGLE_CLIENT_ID=SEU_CLIENT_ID.apps.googleusercontent.com`.
4. Reinicie o servidor da aplicação. Na tela inicial, informe a URL ou o ID da planilha e escolha **Conectar Google Sheets**.

### Publicar no GitHub Pages

O workflow `.github/workflows/deploy-pages.yml` testa, compila e publica automaticamente o site quando há um push na branch padrão do repositório. O endereço de projeto usa o subdiretório do repositório; a base é inferida do `GITHUB_REPOSITORY` durante o build do Actions. Fora do Actions, inclusive em `npm run dev` e no build local, a base continua sendo `/`.

1. Envie o projeto para um repositório GitHub e abra **Settings → Pages**. Em **Build and deployment → Source**, selecione **GitHub Actions**.
2. Se for usar Google Sheets publicado, abra **Settings → Secrets and variables → Actions → Variables** e crie a variável de repositório `VITE_GOOGLE_CLIENT_ID` com o OAuth Client ID. É um identificador público de cliente; não adicione client secret. O workflow disponibiliza essa variável apenas na etapa de build.
3. No Google Cloud Console, em **APIs & Services → Credentials → OAuth 2.0 Client IDs**, adicione `https://SEU_USUARIO.github.io` em **Authorized JavaScript origins**. A origem não inclui o nome do repositório nem uma barra final. Mantenha também as origens locais que usa para desenvolvimento.
4. Faça push na branch padrão. Acompanhe **Actions → Deploy to GitHub Pages**; ao concluir, a URL aparece no ambiente `github-pages` e normalmente será `https://SEU_USUARIO.github.io/NOME_DO_REPOSITORIO/`. Se o próprio repositório se chamar `SEU_USUARIO.github.io`, o site será publicado em `https://SEU_USUARIO.github.io/`.

O workflow publica os arquivos estáticos de `dist/`. O PDF.js worker, manifesto e service worker são empacotados com a base do repositório, e a PWA mantém o pré-cache/offline dentro do escopo publicado.

Quando uma versão nova estiver pronta, o app mostra **Nova versão disponível** e espera o usuário escolher **Atualizar**. A troca ativa o service worker novo e recarrega a página; não interrompe uma conciliação sem ação do usuário. O service worker atualiza o cache de arquivos estáticos versionados e remove caches antigos do Workbox, sem apagar IndexedDB ou `localStorage`.

A autorização usa o token model do Google Identity Services e solicita `https://www.googleapis.com/auth/spreadsheets`. O app lê a aba `CUSTOS ANO` em modo `FORMATTED_VALUE`; nomes de cabeçalho são mapeados sem depender da ordem. `Mês` e `Ano` são copiados como recebidos e nunca recalculados ou gravados. O vínculo (ID, aba, título e horário da leitura) fica no armazenamento local; ao abrir, o app faz uma tentativa única de autenticação sem prompt e leitura. Se o Google exigir interação, a planilha continua vinculada e aparece **Reconectar Google**. **Atualizar dados** segue disponível manualmente; não há polling. Desconectar revoga o token e mantém o vínculo. **Esquecer planilha vinculada** remove esse metadado local.

Depois que a planilha for carregada com autenticação válida, as decisões locais são sincronizadas automaticamente com `_CONCILIADOR`. Essa aba é criada se estiver ausente; a aba `CUSTOS ANO` nunca é criada, renomeada ou alterada. O botão **Sincronizar decisões** executa a sincronização manual. Sem conexão, as decisões e remoções continuam na cache local/na fila mínima e são enviadas na próxima conexão. Não há polling. Se uma mesma decisão foi alterada em dois dispositivos, vence o registro com `updatedAt` mais recente; em empate, o registro remoto prevalece. Remoções são representadas por tombstones para que uma decisão desfeita offline não reapareça no outro dispositivo.

O esquema da aba `_CONCILIADOR` é versionado por `schemaVersion` e usa as colunas: `decisionId`, `decisionType`, `subjectFingerprint`, `status`, `relatedIds`, `metadata`, `createdAt`, `updatedAt`, `schemaVersion`. `decisionId` e `subjectFingerprint` são fingerprints determinísticos; `relatedIds` contém somente as identidades/fingerprints que a decisão já usa localmente. `metadata` armazena somente os IDs selecionados, não descrições ou valores financeiros. Os tipos sincronizados são `PAIR_CONFIRMED`, `PAIR_REJECTED`, `BANK_IGNORED`, `SHEET_IGNORED`, `COMPOSITION_CONFIRMED`, `STATEMENT_MATCH_CONFIRMED` e `CARD_MISSING_CONFIRMED`. `ACTIVE` e `DELETED` em `status` distinguem decisões ativas de remoções sincronizadas.

`CUSTOS ANO` permanece somente leitura. O app pode criar ou atualizar linhas exclusivamente em `_CONCILIADOR`; não grava despesas, cabeçalhos, IDs, `Mês` ou `Ano` na aba financeira.

Para conferir o service worker e a PWA de produção:

```sh
npm run build
npm run preview
```

O site publicado deve ser servido por HTTPS para instalação fora de `localhost`. Em navegadores compatíveis, use **Instalar aplicativo** quando o botão aparecer ou o comando de instalação do próprio navegador. No Android, abra o endereço no Chrome e escolha instalar/adicionar à tela inicial.

## Testes

```sh
npm test
```

Os testes permanentes usam apenas dados sintéticos e mocks, sem acessar planilhas reais. Cobrem CSV, normalização, classificações, identidades estáveis, matching 1:1, composição 1:N, persistência local e sincronização/conflictos de decisões, isolamento de escrita em `_CONCILIADOR`, parser de fatura, estornos, validação matemática, ambiguidades, prevenção de reutilização, filtros, exportação e navegação da interface. O PDF de referência foi validado localmente e não foi copiado para os testes nem para o repositório.

## Limitações conhecidas

- Cada banco pode exportar cabeçalhos e direção de valores de forma diferente; revise o mapeamento e os itens sinalizados antes de confiar no resultado.
- Sem coluna de direção ou colunas separadas de débito/crédito, o app só infere Entrada/Saída quando a descrição é explícita; nos outros casos, mantém revisão e não declara a despesa ausente.
- A comparação automática aceita igualdade exata em centavos; tarifas, arredondamentos, pagamentos agrupados e parcelas podem precisar de revisão.
- A checagem foi feita em navegador local e em viewports responsivos simulados; a instalação e o modo offline ainda devem ser confirmados nos dispositivos Android/Windows de destino.
- O aplicativo apenas ajuda a comparar um período escolhido; não consegue saber se outra conta, dinheiro em espécie, outro cartão ou uma data fora do período representa o lançamento da planilha ausente.

Fora de escopo nesta versão: OFX, gravação no Google Sheets, backend, contas/login próprias, OCR e qualquer processamento financeiro remoto.

## Matching de fatura do cartão

A composição de `GASTOS CARTAO DE CREDITO` considera somente despesas da `CUSTOS ANO` com forma de pagamento normalizada igual a `Crédito_Bradesco`. Sugestões de faturas são calculadas independentemente e não vinculam nem reservam lançamentos. Só a confirmação explícita registra o vínculo com os `sheetRecordIds` e os bloqueia contra outra fatura confirmada. O algoritmo usa centavos inteiros, deduplica conjuntos por uma chave canônica dos IDs e ordena as alternativas por proximidade e coerência temporal.

O horizonte temporal é configurável e está em 365 dias como janela ampla de busca; ele não confirma pertencimento à fatura. O ranqueamento favorece conjuntos com datas próximas ao pagamento e coerentes entre si. Para manter a busca local previsível, cada fatura considera no máximo 24 compras, até 18 itens por composição, 75.000 nós de busca e apresenta no máximo 8 soluções. Se o limite impedir uma busca completa, o app informa que a composição não pôde ser determinada com segurança. Duplicidades financeiras são verificadas apenas na CUSTOS ANO; movimentações iguais do banco não entram nessa seção.

## Fatura PDF

O parser usa os blocos de texto e a posição dos elementos da tabela `Lançamentos`, e só trata valores na área da tabela como movimentações. Compras usam `amount` positivo com `direction=DEBIT`; estornos usam o valor absoluto com `direction=CREDIT` e `type=REFUND`. Para subtotais líquidos, o crédito reduz o total do cartão uma vez; na equação da fatura, os estornos já estão incluídos em `Créditos/Pagamentos`. Saldo anterior, pagamentos anteriores, opções de financiamento e limites não entram no matching das compras. A validação usa `saldo anterior - créditos/pagamentos + compras/débitos = total da fatura`; `Total da fatura` permanece separado de `Compras/Débitos`. Cada compra é comparada por valor e data com despesas `Crédito_Bradesco`; candidatos ambíguos podem ser confirmados manualmente. Compras do PDF ficam em uma coleção distinta e não viram despesa bancária adicional; o pagamento agregado permanece no fluxo 1:N existente.

O parser atual foi calibrado para faturas Bradesco com camada de texto. PDFs escaneados não são processados porque OCR ainda não faz parte do MVP. A data sem ano usa o ano do vencimento e recua um ano quando o mês da compra é posterior ao vencimento.
