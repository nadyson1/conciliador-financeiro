# Conciliador Financeiro

PWA estática para comparar, no próprio dispositivo, os lançamentos da aba `CUSTOS ANO` com um extrato bancário em CSV. A planilha pode ser lida opcionalmente pelo navegador com Google Identity Services e Sheets API; o CSV manual continua disponível. As escritas remotas limitam-se à sincronização técnica em `_CONCILIADOR` e a adicionar uma nova linha em `CUSTOS ANO` após confirmação explícita no formulário.

## O que está implementado

- Importação local de CSV da planilha e CSV bancário/cartão, com delimitador detectado, BOM, UTF-8, acentos e campos entre aspas.
- Leitura opcional e sob demanda da aba existente `CUSTOS ANO` pela Google Sheets API v4; cabeçalhos mapeados pelo nome e convertidos para o mesmo `LedgerTransaction` do CSV.
- Importação de fatura PDF Bradesco com PDF.js, extração local do texto/layout, separação de cartões e compras, detecção de parcelas e exclusão de pagamento anterior.
- Conexão opcional de pastas Google Drive para faturas PDF e extratos CSV, com sincronização manual/ao reconectar e processamento nos parsers locais existentes.
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

CSVs e PDF são lidos e processados em memória no navegador. PDF.js extrai texto usando um worker estático empacotado na própria aplicação e pré-armazenado pela PWA; não há upload do arquivo, extração remota ou OCR. O service worker pré-armazena recursos da aplicação e não configura cache de rede. A integração Google usa OAuth client-side, sem backend, e o escopo `spreadsheets` para ler a planilha, sincronizar decisões em `_CONCILIADOR` e adicionar somente os campos de um lançamento que o usuário confirmou. O access token permanece apenas em memória e é revogado ao desconectar. Extratos, PDFs e resultados completos de matching não são enviados. O IndexedDB e a aba auxiliar guardam apenas tipos de decisão, IDs/fingerprints, IDs relacionados, escolha confirmada e datas de atualização; arquivos e transações completos não são persistidos. A opção **Limpar confirmações salvas** também propaga remoções para outros dispositivos na próxima sincronização.

O Drive é opcional e read-only: após o consentimento de `drive.readonly`, o navegador lista as pastas escolhidas e baixa os arquivos diretamente do Google para processamento local. Apenas configuração e metadados mínimos do índice ficam em `localStorage`; nenhum token ou conteúdo bruto é persistido.

O app mantém `sheetRecordId` e `bankTransactionId` separados; quando IDs de origem não existem ou se repetem, gera fingerprints determinísticos a partir de atributos da movimentação para conservar decisões após a reimportação. IDs de fontes diferentes nunca são comparados como se fossem equivalentes.

`Mês` e `Ano` são retidos sem recálculo. A data normalizada usada para filtros não é gravada de volta. `Categoria`, `Forma de pagamento`, `É fixo?` e `É essencial?` são preservados; categoria e flags não são critérios centrais do matching.

## Matching e classificações

### Privacidade da integração Google Drive

O Drive usa OAuth no navegador e `drive.readonly`, sem backend e sem client secret. A Google Drive API é necessária para listar a pasta e baixar os arquivos; `drive.metadata.readonly` não autoriza download. O Google Picker solicita que o usuário escolha cada pasta. Como `drive.readonly` ainda é um escopo de leitura amplo, a seleção não restringe tecnicamente o token às duas pastas; a aplicação só consulta os IDs escolhidos e só utiliza endpoints de leitura.

Somente IDs/nomes das pastas, horário da última sincronização e metadados mínimos de arquivo (ID, `modifiedTime`, tamanho, MIME, pasta e status) ficam localmente em `localStorage`. Não são salvos tokens, bytes dos PDFs/CSVs ou linhas financeiras. Os metadados de arquivos permitem reconhecer alterações, mas após novo carregamento da PWA ou **Nova conciliação** os conteúdos precisam ser baixados/processados novamente para reconstruir a sessão local.

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

Para habilitar também o Drive, configure `VITE_GOOGLE_API_KEY` e `VITE_GOOGLE_PROJECT_NUMBER` no mesmo `.env.local`, após seguir a seção **Configurar fontes Google Drive**. Nenhum client secret é usado.

### Configurar fontes Google Drive (opcional)

1. No mesmo projeto Google Cloud, habilite **Google Drive API** e **Google Picker API**. O seletor oficial precisa de uma chave de API de navegador e do número do projeto (App ID); não é necessário client secret.
2. Crie/reutilize uma chave de API em **APIs & Services → Credentials**. Restrinja-a por **Websites** às origens do app (por exemplo `http://localhost:4173/*` e `https://SEU_USUARIO.github.io/*`) e inclua também `https://docs.google.com/*`, usado pelo iframe do Picker. Restrinja o uso às APIs **Google Drive API** e **Google Picker API**.
3. Em `.env.local`, configure `VITE_GOOGLE_API_KEY` com essa chave e `VITE_GOOGLE_PROJECT_NUMBER` com o número do projeto exibido no Google Cloud. No GitHub Pages, disponibilize os mesmos valores como variables de Actions para o build.
4. Inclua `https://www.googleapis.com/auth/drive.readonly` na configuração de escopos de dados do app OAuth e reconecte Google para conceder essa leitura. Em modo de teste OAuth, inclua sua conta como test user. O seletor permite escolher explicitamente uma pasta para **Faturas PDF** e outra para **Extratos bancários** (CSV e OFX). Os IDs e nomes das pastas ficam neste dispositivo.
5. Com as pastas configuradas, a sincronização ocorre uma vez depois da autenticação Google e também pelo botão **Sincronizar arquivos**. Não há polling. Arquivos novos/alterados são baixados e processados em memória. Após recarregar ou limpar a sessão, os arquivos são baixados de novo quando necessário, pois bytes e dados financeiros não são persistidos.

O escopo `drive.readonly` foi escolhido para permitir listar e baixar automaticamente os arquivos filhos das pastas preexistentes selecionadas. `drive.metadata.readonly` não permite baixar PDFs/CSVs; `drive.file` é mais restrito por arquivo e não concede acesso confiável a todos os filhos de uma pasta só por ela ter sido selecionada. `drive.readonly` é classificado pelo Google como escopo restrito e dá leitura ampla no Drive; o Picker registra a seleção explícita, mas não limita tecnicamente o token às pastas escolhidas. Apps públicos podem precisar de verificação OAuth; como o Conciliador não armazena nem transmite conteúdo Drive a servidores próprios, não há avaliação de segurança de servidor nesta arquitetura. O app não usa métodos de escrita ou exclusão do Drive. A configuração de pastas e o índice local não são sincronizados entre dispositivos.

### Publicar no GitHub Pages

O workflow `.github/workflows/deploy-pages.yml` testa, compila e publica automaticamente o site quando há um push na branch padrão do repositório. O endereço de projeto usa o subdiretório do repositório; a base é inferida do `GITHUB_REPOSITORY` durante o build do Actions. Fora do Actions, inclusive em `npm run dev` e no build local, a base continua sendo `/`.

1. Envie o projeto para um repositório GitHub e abra **Settings → Pages**. Em **Build and deployment → Source**, selecione **GitHub Actions**.
2. Se for usar Google Sheets publicado, abra **Settings → Secrets and variables → Actions → Variables** e crie a variável de repositório `VITE_GOOGLE_CLIENT_ID` com o OAuth Client ID. É um identificador público de cliente; não adicione client secret. O workflow disponibiliza essa variável apenas na etapa de build.
   Para usar também o Drive, crie `VITE_GOOGLE_API_KEY` e `VITE_GOOGLE_PROJECT_NUMBER` como variables de Actions; a chave deve ter restrições de referenciador e de APIs conforme a seção Google Drive.
3. No Google Cloud Console, em **APIs & Services → Credentials → OAuth 2.0 Client IDs**, adicione `https://SEU_USUARIO.github.io` em **Authorized JavaScript origins**. A origem não inclui o nome do repositório nem uma barra final. Mantenha também as origens locais que usa para desenvolvimento.
4. Faça push na branch padrão. Acompanhe **Actions → Deploy to GitHub Pages**; ao concluir, a URL aparece no ambiente `github-pages` e normalmente será `https://SEU_USUARIO.github.io/NOME_DO_REPOSITORIO/`. Se o próprio repositório se chamar `SEU_USUARIO.github.io`, o site será publicado em `https://SEU_USUARIO.github.io/`.

O workflow publica os arquivos estáticos de `dist/`. O PDF.js worker, manifesto e service worker são empacotados com a base do repositório, e a PWA mantém o pré-cache/offline dentro do escopo publicado.

Quando uma versão nova estiver pronta, o app mostra **Nova versão disponível** e espera o usuário escolher **Atualizar**. A troca ativa o service worker novo e recarrega a página; não interrompe uma conciliação sem ação do usuário. O service worker atualiza o cache de arquivos estáticos versionados e remove caches antigos do Workbox, sem apagar IndexedDB ou `localStorage`.

A autorização usa o token model do Google Identity Services e solicita `https://www.googleapis.com/auth/spreadsheets`. O app lê a aba `CUSTOS ANO` em modo `FORMATTED_VALUE`; nomes de cabeçalho são mapeados sem depender da ordem. `Mês` e `Ano` são copiados como recebidos e nunca recalculados ou gravados. O vínculo (ID, aba, título e horário da leitura) fica no armazenamento local; ao abrir, o app faz uma tentativa única de autenticação sem prompt e leitura. Se o Google exigir interação, a planilha continua vinculada e aparece **Reconectar Google**. **Atualizar dados** segue disponível manualmente; não há polling. Desconectar revoga o token e mantém o vínculo. **Esquecer planilha vinculada** remove esse metadado local.

Depois que a planilha for carregada com autenticação válida, as decisões locais são sincronizadas automaticamente com `_CONCILIADOR`. Essa aba é criada se estiver ausente. Em `CUSTOS ANO`, o app não edita nem exclui linhas existentes e não escreve em cabeçalhos, `Mês` ou `Ano`; a única operação disponível é acrescentar uma linha após confirmação explícita. O botão **Sincronizar decisões** executa a sincronização manual. Sem conexão, as decisões e remoções continuam na cache local/na fila mínima e são enviadas na próxima conexão. Não há polling. Se uma mesma decisão foi alterada em dois dispositivos, vence o registro com `updatedAt` mais recente; em empate, o registro remoto prevalece. Remoções são representadas por tombstones para que uma decisão desfeita offline não reapareça no outro dispositivo.

O esquema da aba `_CONCILIADOR` é versionado por `schemaVersion` e usa as colunas: `decisionId`, `decisionType`, `subjectFingerprint`, `status`, `relatedIds`, `metadata`, `createdAt`, `updatedAt`, `schemaVersion`. `decisionId` e `subjectFingerprint` são fingerprints determinísticos; `relatedIds` contém somente as identidades/fingerprints que a decisão já usa localmente. `metadata` armazena somente os IDs selecionados, não descrições ou valores financeiros. Os tipos sincronizados incluem `MISSING_ADDED_TO_SHEET`, além de `PAIR_CONFIRMED`, `PAIR_REJECTED`, `BANK_IGNORED`, `SHEET_IGNORED`, `COMPOSITION_CONFIRMED`, `STATEMENT_MATCH_CONFIRMED` e `CARD_MISSING_CONFIRMED`. `ACTIVE` e `DELETED` em `status` distinguem decisões ativas de remoções sincronizadas.

Para adicionar uma despesa ausente, o usuário revisa descrição, data, categoria, valor, forma de pagamento e flags antes de confirmar. O app localiza os cabeçalhos pelo nome exato, gera um ID aleatório hexadecimal de oito caracteres e confere a unicidade. A chamada é restrita a append; `Mês` e `Ano` são omitidos para permitir as `ARRAYFORMULA`, e linhas futuras com apenas defaults de checkbox não contam como parte da tabela.

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

### Formatos de extrato bancário

Os extratos Bradesco CSV Mobile e CSV Internet Banking, além de OFX, são identificados pelo conteúdo e normalizados para `BankTransaction`. O CSV Mobile mantém o processamento de período e seções auxiliares existente. O CSV Internet Banking reúne linhas de complemento à movimentação principal. O OFX preserva FITID, tipo, memo, período declarado e saldo informado. Ao sincronizar mais de um formato, movimentos equivalentes são unidos com as fontes e descrições preservadas; casos sem evidência suficiente para deduplicação permanecem separados.

Preferência técnica: OFX oferece os campos bancários mais estruturados e FITID; CSV Internet Banking pode oferecer descrição de favorecido e saldos linha a linha mais detalhados; CSV Mobile permanece suportado para compatibilidade. Não é necessário migrar o formato. Todos os arquivos são interpretados localmente.

Fora de escopo nesta versão: gravação no Google Sheets, backend, contas/login próprias, OCR e qualquer processamento financeiro remoto.

## Matching de fatura do cartão

A composição de `GASTOS CARTAO DE CREDITO` considera somente despesas da `CUSTOS ANO` com forma de pagamento normalizada igual a `Crédito_Bradesco`. Sugestões de faturas são calculadas independentemente e não vinculam nem reservam lançamentos. Só a confirmação explícita registra o vínculo com os `sheetRecordIds` e os bloqueia contra outra fatura confirmada. O algoritmo usa centavos inteiros, deduplica conjuntos por uma chave canônica dos IDs e ordena as alternativas por proximidade e coerência temporal.

O horizonte temporal é configurável e está em 365 dias como janela ampla de busca; ele não confirma pertencimento à fatura. O ranqueamento favorece conjuntos com datas próximas ao pagamento e coerentes entre si. Para manter a busca local previsível, cada fatura considera no máximo 24 compras, até 18 itens por composição, 75.000 nós de busca e apresenta no máximo 8 soluções. Se o limite impedir uma busca completa, o app informa que a composição não pôde ser determinada com segurança. Duplicidades financeiras são verificadas apenas na CUSTOS ANO; movimentações iguais do banco não entram nessa seção.

## Fatura PDF

O parser usa os blocos de texto e a posição dos elementos da tabela `Lançamentos`, e só trata valores na área da tabela como movimentações. Compras usam `amount` positivo com `direction=DEBIT`; estornos usam o valor absoluto com `direction=CREDIT` e `type=REFUND`. Para subtotais líquidos, o crédito reduz o total do cartão uma vez; na equação da fatura, os estornos já estão incluídos em `Créditos/Pagamentos`. Saldo anterior, pagamentos anteriores, opções de financiamento e limites não entram no matching das compras. A validação usa `saldo anterior - créditos/pagamentos + compras/débitos = total da fatura`; `Total da fatura` permanece separado de `Compras/Débitos`. Cada compra é comparada por valor e data com despesas `Crédito_Bradesco`; candidatos ambíguos podem ser confirmados manualmente. Compras do PDF ficam em uma coleção distinta e não viram despesa bancária adicional; o pagamento agregado permanece no fluxo 1:N existente.

O parser atual foi calibrado para faturas Bradesco com camada de texto. PDFs escaneados não são processados porque OCR ainda não faz parte do MVP. A data sem ano usa o ano do vencimento e recua um ano quando o mês da compra é posterior ao vencimento.
