# Arquitetura do APP Descarga

## Execução

- `React + Vite`: interface do aplicativo.
- `analytics.worker.ts`: leitura do Excel e regras analíticas fora da thread da interface.
- `storage.ts`: ponte única de persistência.
- `SQLite`: armazenamento do aplicativo instalado pelo Tauri.
- `IndexedDB`: fallback usado somente durante a execução pelo navegador.
- `Tauri 2`: janela desktop, permissões e instaladores Windows.

## Dados

O banco SQLite é criado no diretório de configuração do aplicativo como `descarga.db`.
As alterações de esquema ficam em `src-tauri/migrations` e são executadas por versão.

As importações mantêm o fluxo de conferência existente: um lote entra como pendente e
só participa do histórico depois de aprovado. A impressão digital de cada descarga
continua impedindo duplicidades.

Na tela de análises o usuário monta um cenário sem criar um lote: seleciona grupo macro,
centro de custo e destinatário, informa valor e peso e compara esses dados com o
histórico aprovado. O cenário existe somente durante a análise e não é persistido.
Importações Excel permanecem restritas à tela Bases locais.

A análise histórica é apresentada em quatro blocos independentes: valor pago por faixa
de peso, distribuição percentual de `REEMB?`, resultado financeiro e relação peso ×
valor. A classificação principal compara o valor somente com registros anteriores do
mesmo recorte e da mesma faixa de peso. As regras nunca recorrem a outro grupo, centro
de custo, destinatário, faixa de peso ou à base geral. Menos de três comparáveis
anteriores produz o estado `Histórico insuficiente`.

As faixas são: 0–250 kg, 250–500 kg, 500 kg–1 t, 1–2 t, 2–5 t, 5–8 t,
8–10 t e acima de 10 t. O limite inferior é exclusivo e o superior inclusivo; assim,
250 kg pertence à primeira faixa e 500 kg à segunda. O tipo de veículo não participa
da análise.

O resultado principal também apresenta um score de confiança entendido como aderência
ao histórico da faixa. A mediana do valor equivale a 100%; valores inferiores também
mantêm 100%, e o score diminui proporcionalmente somente quando o valor supera a
mediana. A classificação segue a mesma regra unilateral: apenas valores acima do limite
superior são sinalizados. Média, mediana, mínimo, máximo, MAD, limite esperado e número
de comparáveis são apresentados para a faixa analisada.

Na aba Histórico, o usuário escolhe entre três recortes: grupo de cliente + C.C +
destinatário, somente grupo de cliente ou somente destinatário. Valor, reembolso,
resultado financeiro e peso × valor usam exclusivamente os registros do recorte ativo.
Para o recorte por destinatário, uma análise adicional consolida cada grupo de cliente,
mostrando quantidade de registros, total pago, peso total, valor mediano e mediana por
tonelada. A tabela também apresenta o valor médio e o peso médio por registro para cada
cliente; a média de peso desconsidera registros sem peso válido.

O resultado financeiro cruza `VALOR`, `Vlr Recebido`, `STATUS` e `REEMB?`. O saldo
direto é calculado, mas sua interpretação distingue prejuízo confirmado, valor em
risco, custo absorvido, inclusão no frete, recuperação integral, saldo positivo e
inconsistências. Valores ainda não tratados não são automaticamente convertidos em
prejuízo. Os campos financeiros são preenchidos retroativamente pela base histórica
padrão após a migração SQLite correspondente.

A análise versão 4 introduz a hierarquia `grupo macro de cliente → C.C → destinatário`.
Os grupos são derivados conservadoramente do nome em `CLIENTE`, independentemente do
código original. O agrupamento é uma regra interna e não é exibido como cadastro em
Bases locais. Códigos e nomes originais continuam armazenados como aliases; ajustes
previamente persistidos continuam prevalecendo sobre a sugestão automática e entram
no backup.

As marcas NINFA e YOKI são consolidações obrigatórias: todas as razões sociais cujo
nome contenha a respectiva marca pertencem a um único grupo macro, mesmo quando usam
códigos de cliente diferentes. Essa regra prevalece sobre ajustes locais anteriores.

O campo `C.C` é armazenado em cada registro. Instalações anteriores recebem a coluna
por migração SQLite e a base histórica padrão é usada para preencher retroativamente
os centros de custo por impressão digital. As comparações passam a ser estritas para
o mesmo grupo macro, C.C e destinatário.

O backup é um arquivo JSON versionado e portátil. Ele contém lotes e registros, podendo
ser restaurado no aplicativo desktop ou no modo navegador.

## Extensões futuras

Uma futura sincronização deve ser adicionada atrás de uma API, sem permitir que a
interface acesse diretamente o banco central. As tabelas `app_settings` e `sync_log`
já reservam a configuração e a auditoria desse processo.

O contrato em `src/services/chat.types.ts` reserva a integração futura do chatbot.
O assistente deverá usar ferramentas de consulta controladas, nunca SQL livre nem
acesso direto ao arquivo Excel.

## Integração com o bot Andrew

No aplicativo desktop, `bot-integration.ts` consulta uma fila local em
`%LOCALAPPDATA%\APP Descarga\integracao`. O bot publica em `entrada` um JSON com o
caminho do PDF; o aplicativo processa o documento com o mesmo extrator e as mesmas
regras usadas pela tela, persiste a LCD como histórico aprovado e grava em `respostas`
um JSON contendo somente `score` e `resultado`.

O nome do arquivo identifica a solicitação e permite correlacionar a resposta sem
acrescentar campos ao contrato. Falhas técnicas retornam score nulo e
`ERRO_NA_ANALISE`; detalhes ficam apenas em `integracao\logs`. A pasta pode ser
sobrescrita pela variável de ambiente `APP_DESCARGA_INTEGRATION_DIR`.

## Comandos

```powershell
npm.cmd install
npm.cmd run dev
npm.cmd run build
npm.cmd run desktop:dev
npm.cmd run desktop:build
```

Os dois últimos comandos exigem Rust/Cargo e os pré-requisitos do Tauri para Windows.
