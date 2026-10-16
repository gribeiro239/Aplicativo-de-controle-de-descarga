# APP Descarga

Aplicativo local para importar, conferir e analisar valores de descargas, com
histórico persistente e importação de documentos PDF. A interface usa React,
TypeScript e Vite; a versão desktop usa Tauri 2 e SQLite. No navegador, os dados
são armazenados em IndexedDB.

## Preparar o ambiente

- Node.js 22.13 ou superior, compatível com as dependências fixadas no lockfile.
- npm.
- Para o desktop Windows: Rust/Cargo, ferramentas de compilação C++ do Visual
  Studio e WebView2.

Na raiz do projeto, execute no PowerShell:

```powershell
npm.cmd ci
```

Os arquivos `package-lock.json` e `src-tauri/Cargo.lock` devem permanecer
versionados para reproduzir as versões das dependências.

## Base histórica local

Antes de executar o aplicativo, copie a planilha histórica autorizada para
`public/Descargas.xlsx`, preservando o nome e a estrutura de colunas esperada pelo
importador em `src/analytics.worker.ts`.

A planilha contém dados operacionais e não faz parte do repositório. A cópia que
já existe na máquina permanece no local. Em uma instalação nova, o aplicativo
usa esse arquivo para carregar o histórico inicial; também depende dele para
completar campos de bases antigas e backups restaurados. Sem a planilha, essas
operações apresentam erro de base histórica ausente.

O Vite copia o conteúdo de `public/` para a distribuição. Por isso, o build local
inclui a planilha fornecida: distribua o aplicativo e seus instaladores somente
para quem puder acessar esses dados.

## Executar e compilar

```powershell
# Interface no navegador
npm.cmd run dev

# Verificação TypeScript e build da interface
npm.cmd run build

# Prévia do build da interface
npm.cmd run preview

# Aplicativo desktop em desenvolvimento
npm.cmd run desktop:dev

# Instaladores Windows (NSIS e MSI)
npm.cmd run desktop:build
```

O servidor de desenvolvimento usa a porta 5173. Os instaladores são gerados em
`src-tauri/target/release/bundle/` e não entram no Git.

## Organização

- `src/`: interface, análise em worker, extração de PDFs e persistência.
- `src/services/`: contratos para integração futura do assistente.
- `src-tauri/src/`: aplicação desktop e integração local com o bot.
- `src-tauri/migrations/`: migrações versionadas do SQLite.
- `src-tauri/icons/`: ícones do aplicativo.
- `public/`: arquivos estáticos; a planilha histórica é fornecida localmente.
- `scripts/`: consultas de diagnóstico somente leitura ao banco instalado.
- [ARCHITECTURE.md](ARCHITECTURE.md): regras de análise, persistência e integração.

Os scripts de diagnóstico usam `node:sqlite` e o banco em
`%APPDATA%\br.com.appdescarga.desktop\descarga.db`. Eles contêm filtros de
consultas pontuais e não constituem uma suíte de testes nem substituem as regras
do worker atual. Execute-os somente se precisar investigar uma base local.

## Versionamento

Código, configurações, migrações, ícones e lockfiles fazem parte do repositório.
Dependências instaladas, caches, builds, logs, bancos, backups, PDFs de teste,
planilhas locais e configurações de ambiente ficam ignorados pelo `.gitignore`.
Esses arquivos continuam na máquina, mas não devem ser adicionados com `git add -f`.
