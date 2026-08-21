# Segurança e Programação Defensiva

Complementa a [[00-constituicao]]. Este documento existe para que toda alteração futura no typer
seja avaliada contra os mesmos controles — não é um exercício único, é o padrão a manter.

## Modelo de ameaça (resumo)

O typer roda localmente, single-user, com acesso de rede a um servidor IRIS que o próprio usuário
configura. As superfícies de risco reais são:

1. **Vazamento de credencial/dados do servidor para fora do processo main** (disco não
   criptografado, `localStorage`, log, IPC).
2. **O agente de IA gravando algo destrutivo no servidor sem revisão humana.**
3. **Path/nome hostil vindo de uma fronteira externa** (nome de spec, nome de documento, resposta
   de servidor malformada) causando escrita fora do diretório esperado ou crash não tratado.
4. **Processo filho (`opencode`) ou janela adicional (CSP) escapando do isolamento esperado.**

Fora de escopo do modelo de ameaça: múltiplos usuários do mesmo typer, servidor IRIS hostil por si
só (o usuário decide em que servidor confiar), ataques que exigem acesso físico à máquina do
usuário.

## 1. Nunca gravar dado de servidor no cliente

- `ConnectionProfile` (o que o renderer recebe de `connections:list`/`connections:save`) **não tem
  campo de senha** — ver `electron/connections.ts`. A senha vive só em `secrets.json`
  (criptografado via `safeStorage`) e só é lida de volta dentro do processo main
  (`ipc.ts#toAtelierConfig`) para montar a config que vai para `atelier.ts`.
- `localStorage` (via `src/utils/*Preference.ts`, `agentSession.ts`) guarda **só preferência**:
  tema, diretório de specs escolhido, id de sessão do agente ativo. Nunca senha, nunca conteúdo de
  documento, nunca resultado de query.
- O diretório de projeto do agente (`agent-projects/<connectionId>/<namespace>/`) contém só
  `opencode.json` e `AGENTS.md` — nunca uma cópia em disco do código-fonte do servidor. Todo
  acesso a documento/spec passa pelas ferramentas MCP (`iris_*`, `specs_*`), nunca por leitura de
  arquivo local nesse diretório.
- **Checklist ao adicionar um novo dado vindo do servidor**: antes de guardá-lo em qualquer lugar
  persistente do renderer (state que vira `localStorage`, um novo arquivo em disco fora do
  diretório de specs), perguntar "isso é preferência do usuário sobre a UI, ou é dado que veio do
  IRIS?" — só o primeiro pode ser persistido no cliente.

## 2. Aprovação humana para toda escrita no servidor

- Fluxo: `iris_propose_write` (MCP) → `POST /documents/:name` na ponte (`agentBridge.ts`) →
  `handleWrite` monta o diff (`Diff.createTwoFilesPatch`) e **retorna uma Promise que só resolve**
  quando `resolvePendingWrite(pendingId, approved)` é chamado pela UI (`agent:resolvePendingWrite`
  IPC, disparado pelo usuário clicando aprovar/rejeitar).
- `approved` (decisão humana) e `saved` (se realmente gravou) são campos **separados** de
  propósito — um erro de rede depois do "sim" do usuário não pode ser reportado ao agente como se
  o usuário tivesse rejeitado.
- `endSession` rejeita toda escrita pendente de uma sessão encerrada (run abortado/app fechando)
  em vez de deixar a Promise pendurada — sem isso, abortar um agente com uma escrita pendente
  vazaria uma Promise nunca resolvida e travaria o processo MCP correspondente.
- Escrita de **spec** (`specs_write`) é a única exceção deliberada — não compila, não afeta o
  servidor, não passa por aprovação. Não generalizar esse atalho para nada que toque o servidor.

## 3. Sanitização de nome/path (defesa contra path traversal)

Pontos que hoje validam nome de arquivo antes de um `path.join`:

- `electron/specs.ts#sanitizeFileName` — rejeita string vazia, `/`, `\`, `.`, `..`. Usado por
  `createSpecFile`, `renameSpecFile`, e por `resolveSpecFileName` (usado também pela ponte do
  agente).
- `electron/agentBridge.ts` — as rotas `GET/POST /specs/:name` fazem a mesma checagem
  (`includes("/") || includes("\\") || includes("..")`) **antes** de chamar `specs.ts`, porque o
  nome aqui vem de uma ferramenta MCP controlada pelo modelo, não pela UI — tratar como entrada não
  confiável mesmo sendo "só" o agente.
- Nome de **documento IRIS** (`/documents/:name`) não passa por essa mesma sanitização porque nunca
  vira path de filesystem local — é só um segmento de URL (`encodeURIComponent`) contra a API
  Atelier remota. Isso é intencional, não uma lacuna — mas se `specs.ts`/`agentBridge.ts` ganhar
  uma nova rota que grave em disco local a partir de um nome externo, ela precisa da mesma
  sanitização, não da tratativa de nome de documento.

Ao adicionar qualquer rota nova (na ponte HTTP ou em `ipc.ts`) que receba um nome/path de fora e o
use para acessar o filesystem local: sanitizar antes, seguindo o mesmo padrão acima — nunca confiar
que quem chama (mesmo sendo "só" a UI ou "só" o agente) já validou.

## 4. Rede defensiva

- Toda chamada Atelier tem timeout via `AbortController` (`REQUEST_TIMEOUT_MS = 30_000`, 120s para
  compile) — sem isso, uma conexão travada deixa a UI presa em "Sincronizando…" para sempre.
- Erros de rede (`ECONNREFUSED`, `ENOTFOUND`, `ECONNRESET`/`ETIMEDOUT`, abort por timeout) são
  todos capturados e traduzidos para mensagem específica em pt-BR — nunca uma `TypeError: fetch
failed` crua chegando à UI.
- Resposta HTTP não-OK, resposta que não é JSON válido, e `status.summary` de erro do IRIS são
  todos tratados explicitamente antes do retorno "feliz" da função.
- `searchInFiles` valida o **formato** da resposta (não só o status HTTP) antes de devolver ao
  chamador — um servidor mais antigo ou uma resposta inesperada gera um erro distinto de "endpoint
  não existe", permitindo fallback client-side correto em vez de um crash de "propriedade
  indefinida" mais adiante.
- A ponte HTTP do agente (`agentBridge.ts`) exige `X-Agent-Token` válido em toda requisição — sem
  token correspondente a uma sessão ativa, responde 403 antes de tocar qualquer lógica.

## 5. Isolamento de processo Electron

- Toda `BrowserWindow` (janela principal em `main.ts`, janela CSP em `studioCspWindow.ts`) usa
  `contextIsolation: true` e `nodeIntegration: false`.
- `preload.ts` é a única superfície `renderer ↔ main`, via `contextBridge.exposeInMainWorld`. Cada
  função é tipada e específica (ex: `atelier.saveDocument(id, namespace, name, contentLines)`) —
  não existe um canal genérico tipo `invoke(channel, ...args)` que aceitaria comando arbitrário.
- `win.webContents.setWindowOpenHandler` nega abrir qualquer nova janela dentro do app — links
  `http(s)` são abertos no navegador externo (`shell.openExternal`), nunca em uma nova
  `BrowserWindow` do próprio typer.
- `studioCspPreload.ts` (janela CSP) só repassa um `postMessage({result:"done"})` específico para
  um canal IPC efêmero por janela — não expõe nenhuma outra API ao conteúdo carregado (que é
  servido pelo servidor IRIS do usuário, não necessariamente confiável no mesmo nível que o app).
- Processos filhos (`opencode`, os dois servidores MCP) não têm acesso a Electron/IPC — só falam
  com o main process pela ponte HTTP em loopback (`127.0.0.1`), autenticada por token.

## 6. `try/catch` e programação defensiva — onde e como

Padrão já estabelecido no código, a manter em qualquer adição:

- **No renderer**, toda chamada a `window.electronAPI.*` fica dentro de `try { … } await … } catch
(error) { onLog(`Erro ...: ${(error as Error).message}`, "error") }` (ver `SpecsPanel.tsx` como
  referência). Nunca deixar uma chamada solta sem tratamento — um erro do main process que rejeita
  o `invoke` vira uma exceção não tratada na UI se ninguém capturar.
- **No main process**, toda função que faz I/O (rede, disco) trata seu próprio erro e relança uma
  mensagem específica (`AtelierError`, `Error` com texto em pt-BR) em vez de deixar o erro genérico
  do runtime (`ENOENT`, `TypeError`, erro de parsing) vazar sem contexto.
- Erros "esperados e não fatais" são engolidos deliberadamente e documentados como tal (ex:
  `getDocumentReadOnlyStatus` engole falha de query a `%Dictionary`/source control quando não
  aplicável; `seedSddScaffold` ignora `EEXIST` mas relança qualquer outro erro). Ao engolir um erro,
  sempre comentar **por que** é seguro fazer isso — não engolir por conveniência sem justificar.
- Rotas HTTP da ponte (`agentBridge.ts#handleRequest`) têm um `try/catch` no nível mais externo que
  converte qualquer exceção não prevista em `respondJson(res, 500, { error: ... })` — o processo
  MCP do lado do opencode nunca deveria ver uma conexão fechada abruptamente sem corpo de erro.
- Validar formato de entrada explicitamente nas fronteiras que recebem JSON de fora (`JSON.parse`
  do corpo de uma requisição da ponte) antes de usar os campos — não assumir que o shape está
  correto só porque "é o nosso próprio MCP server chamando".

## Checklist de revisão para qualquer PR que toque `electron/*` ou I/O do renderer

- [ ] Toda chamada de rede/disco nova tem timeout (se rede) e tratamento de erro explícito?
- [ ] Algum dado novo vindo do servidor IRIS está sendo persistido no cliente (localStorage,
      arquivo local fora de `specs`)? Se sim, isso é um bug — reverter.
- [ ] Algum nome/path novo vindo de fora (UI ou agente) chega a um `path.join`/`fs.*` sem passar
      por sanitização equivalente a `sanitizeFileName`?
- [ ] Alguma escrita nova em documento IRIS (não spec) contorna o fluxo de aprovação humana
      (`handleWrite`/`resolvePendingWrite`)?
- [ ] Alguma nova `BrowserWindow` ou preload amplia a superfície exposta ao conteúdo carregado sem
      necessidade (contextIsolation, nodeIntegration, funções expostas)?
