# Plano Técnico

## Abordagem

Três camadas Electron clássicas, com fronteira estrita entre elas:

- **main** (`electron/*.ts`): único lugar com acesso a Node/filesystem/rede/credenciais. Fala
  Atelier REST (`atelier.ts`), guarda conexões e segredos (`connections.ts`), gerencia specs locais
  (`specs.ts`), roda o agente (`agentRun.ts`) e expõe a ponte HTTP para os servidores MCP
  (`agentBridge.ts`).
- **preload** (`electron/preload.ts`): única superfície entre main e renderer, via
  `contextBridge.exposeInMainWorld("electronAPI", …)`. Cada função aqui é um `ipcRenderer.invoke`
  tipado — não existe canal "genérico" que aceite comando arbitrário.
- **renderer** (`src/**`): React + Monaco. Só enxerga `window.electronAPI`; nunca `require`,
  nunca `fs`, nunca a senha da conexão.

O agente de IA roda **fora** do processo Electron: `opencode` é um processo filho spawnado por
`agentRun.ts`, que por sua vez spawna dois servidores MCP (`electron/mcp/irisMcpServer.ts`,
`electron/mcp/specsMcpServer.ts`) como processos próprios (via config `mcp.*.command` do
`opencode.json` gerado). Nenhum desses processos tem acesso a Electron/IPC — eles falam com o main
process através de uma ponte HTTP em `127.0.0.1` (`agentBridge.ts`), autenticada por um token de
sessão (`X-Agent-Token`) gerado por execução do agente.

## Módulos / responsabilidades

- `electron/connections.ts` — CRUD de `ConnectionProfile` em `connections.json`
  (`userData/connections.json`) e senha criptografada via `safeStorage` em `secrets.json`
  separado. `getPassword` nunca é exposto por IPC — só usado internamente por `ipc.ts` para montar
  o `AtelierConnectionConfig` antes de chamar `atelier.ts`.
- `electron/atelier.ts` — cliente HTTP da API Atelier: sessão/cookie por conexão, fila de
  concorrência (`MAX_CONCURRENT_REQUESTS_PER_CONNECTION = 2`), timeout com `AbortController`,
  tradução de erro de rede/HTTP/parsing para mensagem em pt-BR. Nenhuma função aqui grava nada em
  disco — é só o cliente REST.
- `electron/ipc.ts` — registra todos os `ipcMain.handle`, resolve `ConnectionProfile` →
  `AtelierConnectionConfig` (injetando a senha) e repassa para `atelier.ts`/`specs.ts`. Fronteira
  onde toda chamada do renderer é validada contra uma conexão existente (`getProfileOrThrow`).
- `electron/specs.ts` — specs locais (`.md`) por conexão+namespace (ou diretório custom escolhido
  pelo usuário). Lista é sempre plana (sem subpastas); todo nome de arquivo passa por
  `sanitizeFileName` antes de tocar o filesystem.
- `electron/agentBridge.ts` — servidor HTTP loopback + fila de "pending writes". É o único lugar
  onde uma proposta de escrita do agente vira, de fato, uma chamada a `atelier.saveDocument` — e só
  depois que `resolvePendingWrite(pendingId, true)` é chamado pela UI.
- `electron/agentRun.ts` — spawna o `opencode` binário direto (não o shim `.CMD` do pnpm, para que
  `kill()`/`taskkill /T` realmente derrube a árvore de processos), gera `opencode.json` +
  `AGENTS.md` num diretório de projeto que **só tem configuração**, nunca código-fonte nem specs.
- `electron/mcp/irisMcpServer.ts`, `electron/mcp/specsMcpServer.ts` — servidores MCP finos que só
  fazem `fetch` para a ponte (`agentBridge.ts`); não tocam Atelier nem filesystem diretamente.
- `electron/studioCspWindow.ts` / `studioCspPreload.ts` — janela isolada (mesma política de
  `contextIsolation`/`nodeIntegration`) para ações CSP do servidor (ex: login de source control),
  com preload mínimo que só repassa `postMessage({result:"done"})` de volta ao main via um canal
  IPC efêmero por janela.
- `src/utils/*` — utilitários puros do renderer: preferências em `localStorage` (tema, diretório
  de specs, sessão do agente ativa), parsing de XML/classe, glob, diagnóstico, download. Nada aqui
  fala com o servidor diretamente — sempre via `window.electronAPI`.

## Modelo de dados

- `ConnectionProfile` (`connections.json`, visível ao renderer): `id, name, host, port, https,
pathPrefix?, username, namespace`. **Sem senha.**
- `secrets.json` (main-only): `Record<connectionId, string base64 de safeStorage.encryptString>`.
- `SpecFileEntry` (specs locais): `name, path, modifiedAt` — lista plana, um nível, só `.md`.
- Sessão do agente (`agentBridge.Session`, só em memória do processo main): token, connectionId,
  namespace, `AtelierConnectionConfig` completo (incluindo senha em texto puro **em memória**,
  nunca serializado), `WebContents` do renderer que iniciou, `runId`, diretório de specs.
- `localStorage` do renderer: só preferências (`typer.specs-dir::…`, `typer.agent-session::…`,
  tema) — nunca conteúdo ou credencial de servidor.

## Decisões e alternativas consideradas

- **Ponte HTTP loopback (não IPC direto) para os servidores MCP** — porque o MCP roda em processo
  filho do `opencode`, fora do controle do Electron; IPC do Electron não alcança processos que não
  foram criados pelo próprio Electron com `contextBridge`. HTTP em `127.0.0.1` com token por sessão
  foi a alternativa mais simples que ainda mantém a aprovação humana no meio do caminho.
- **Escrita de código sempre pendente de aprovação; escrita de spec, não** — specs são notas
  locais que não afetam o servidor nem compilam; introduzir aprovação ali seria fricção sem
  ganho de segurança real. Documentos IRIS compilam e podem ter efeito colateral em produção — a
  aprovação é a mitigação principal contra o agente "alucinar" uma mudança destrutiva.
- **Um agente por vez, app inteiro** — IRIS Community/eval tem pool de sessão pequeno; múltiplas
  conversas simultâneas (mesmo em namespaces diferentes) multiplicam chamadas concorrentes e geram
  503/409. Tradeoff aceito: uma segunda aba espera.
- **`safeStorage` sem fallback em texto puro** — perder a senha (usuário reinsere) é preferível a
  gravá-la em disco sem criptografia do SO.
- **`opencodeBin()` aponta pro binário real, não o shim `.CMD`** — no Windows o shim do pnpm só
  roda via `shell: true`, e `child.kill()` mata só o `cmd.exe`, não o processo real — quebraria o
  botão "Parar" e o cleanup no `before-quit`.

## Riscos

- **IRIS Community/eval derruba sessão sob carga** → mitigado por cookie jar + fila de
  concorrência (`atelier.ts`), mas não elimina 503 sob uso muito paralelo (ex: várias abas de SQL
  Runner ao mesmo tempo além do agente).
- **Servidor lento/instável trava chamada indefinidamente** → mitigado por
  `AbortController`/timeout em toda chamada `fetch` (30s, 120s para compile).
- **Nome de arquivo/documento hostil (`../../etc`, path absoluto)** → mitigado por
  `sanitizeFileName` (specs) e validação explícita nas rotas da ponte (`agentBridge.ts`); ver
  [[05-seguranca]] para o inventário completo de pontos que aceitam nome vindo de fora.
- **Resposta inesperada de servidor Atelier v2/beta (`searchInFiles`)** → tratada com "shape guard"
  explícito que lança erro distinto de "endpoint não existe" vs "formato inesperado", para o
  chamador decidir se cai no fallback client-side.
