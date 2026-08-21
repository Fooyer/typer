# Constituição do Projeto

> Estas specs (`specs/00-05`) documentam o **typer em si** — o aplicativo Electron, não um projeto
> IRIS específico. Não confundir com a aba "Specs" dentro do próprio app (gerada por
> `electron/specs.ts`, guardada em `userData/specs/<connectionId>/<namespace>/`): aquela é para o
> usuário planejar o _código ObjectScript_ de um servidor conectado; esta pasta é para planejar o
> _typer_. Segue a mesma metodologia (SDD) e a mesma numeração por consistência.

## Objetivo do projeto

Typer é um IDE desktop (Electron + React + Monaco) para editar, navegar e rodar código
ObjectScript/IRIS em um servidor remoto via API Atelier, com um agente de IA (opencode) que lê e
propõe alterações nesse servidor através de ferramentas MCP.

## Princípios

- **Nunca persistir dados do servidor no cliente.** Nada que venha do IRIS (senha, conteúdo de
  documento, resultado de query) pode ser gravado em `localStorage`, `sessionStorage`, ou em
  qualquer arquivo lido pelo processo renderer. O que hoje é persistido no cliente é só
  _preferência local do usuário_ (tema, id de sessão do agente, diretório de specs escolhido) —
  nunca segredo nem conteúdo do servidor. Ver [[05-seguranca]] para o inventário completo.
- **Credencial nunca trafega para o renderer.** A senha da conexão é lida no processo main
  (`connections.getPassword`), usada para montar o `AtelierConnectionConfig` ali mesmo, e nunca
  incluída em nenhum valor retornado por um `ipcMain.handle`. `ConnectionProfile` (o que o
  renderer vê) não tem campo de senha.
- **Toda fronteira de I/O usa `try/catch` e falha de forma explícita e traduzida.** Chamada de
  rede (Atelier), IPC, leitura/escrita de arquivo local (specs, connections.json, secrets.json) —
  todas devem tratar erro e devolver uma mensagem acionável em pt-BR, nunca deixar uma exceção
  não tratada estourar até a UI ou travar um processo em segundo plano.
- **Programação defensiva nas fronteiras, confiança nos invariantes internos.** Validar/sanitizar
  o que entra de fora (nome de arquivo de spec, path da API tester, resposta HTTP do servidor,
  entrada JSON de uma ferramenta MCP) explicitamente. Não adicionar validação redundante em
  funções internas que só recebem dados já validados — three linhas repetidas é melhor que
  abstração prematura, mas checagem de fronteira não é opcional.
- **Escrita no servidor sempre passa por aprovação humana.** Qualquer caminho que grave conteúdo
  em uma classe/rotina IRIS (`atelier.saveDocument`, `agent:pendingWrite`) para pela aprovação do
  usuário antes de tocar o servidor. Isso vale tanto para a UI normal quanto para o agente de IA —
  não existe atalho que grave direto sem essa etapa.
- **Isolamento de processo Electron não é negociável.** Toda `BrowserWindow` usa
  `contextIsolation: true` e `nodeIntegration: false`. A única superfície entre renderer e main é o
  que `preload.ts` expõe explicitamente em `window.electronAPI` — nenhum atalho tipo `require` ou
  `remote` no renderer.
- **Segredo local é criptografado quando possível, nunca gravado em texto puro como fallback.**
  `safeStorage` (criptografia do SO) protege `secrets.json`. Se `safeStorage` não estiver
  disponível, a senha simplesmente não é persistida — não existe fallback para texto puro.

## Restrições técnicas

- Stack: Electron 43, React 19, TypeScript, Vite/Vite+ (`vp`), Monaco Editor, pnpm (workspace).
- Comunicação com o servidor: API Atelier REST (`/api/atelier/v1|v2`), a mesma usada pelo
  vscode-objectscript — sem driver nativo, só HTTP(S) + Basic Auth.
- Agente de IA: `opencode-ai` rodando como processo filho, headless (`opencode run --format json`),
  falando com dois servidores MCP (`iris`, `specs`) que por sua vez falam com o processo main via
  uma ponte HTTP em loopback (`agentBridge.ts`), autenticada por token por sessão.
- Apenas **um agente por vez** no app inteiro (não por aba) — limite deliberado para não estourar
  o pool de sessões/licença do IRIS Community/eval.
- IRIS Community/eval tem pool de sessões pequeno: toda chamada Atelier reaproveita cookie de
  sessão (`cookieJar`) e é serializada por conexão (`MAX_CONCURRENT_REQUESTS_PER_CONNECTION = 2`).
- Idioma da UI, mensagens de erro, comentários e specs geradas: **pt-BR**.

## Fora de escopo

- Driver nativo IRIS (o app só fala Atelier REST).
- Multi-usuário / servidor compartilhado do próprio typer (é um app desktop single-user).
- Editar specs (`.md`) locais nunca precisa de aprovação humana — só escrita em documento IRIS
  precisa. Isso é intencional (specs não compilam, não afetam o servidor) — não "corrigir" para
  exigir aprovação também nas specs.
