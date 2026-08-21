# Tarefas

Checklist executável derivado do plano e da constituição. Como o app já está em produção, isto é
majoritariamente um checklist de **auditoria/reforço** dos princípios de segurança e programação
defensiva — não um roadmap de feature. Marque conforme for revisando/corrigindo.

## Fase 1 — Auditoria de fronteiras de I/O (try/catch e erro traduzido)

- [ ] Revisar cada `ipcMain.handle` em `electron/ipc.ts`: confirmar que uma rejeição da função
      chamada não estoura sem tratamento — o próprio `ipcMain.handle` já propaga a rejeição pro
      `invoke` do renderer como erro serializado, então o ponto real a checar é se o **renderer**
      sempre envolve a chamada em `try/catch` (ver `SpecsPanel.tsx` como referência de padrão:
      todo `await window.electronAPI.*` dentro de `try { … } catch (error) { onLog(...) }`).
- [ ] Conferir que todo componente novo que chama `window.electronAPI.*` segue esse mesmo padrão
      (nunca uma chamada solta sem `try/catch` ou `.catch`).
- [ ] Revisar `electron/atelier.ts`: toda função pública já trata erro de rede/HTTP/parsing — ao
      adicionar uma nova chamada Atelier, confirmar que ela também passa pelo `request()`/
      `performRequest()` existentes (não um `fetch` direto e paralelo, que perderia timeout, fila
      de concorrência e tradução de erro).

## Fase 2 — Validação de entrada (defesa contra path traversal / nome hostil)

- [ ] Confirmar que todo nome de arquivo de spec (criar, renomear, ler pela ponte do agente) passa
      por `sanitizeFileName`/`resolveSpecFileName` antes de virar um `path.join` — checar os três
      pontos que hoje fazem essa validação de forma independente (`specs.ts`, `agentBridge.ts`
      duas vezes) e considerar se vale extrair uma única função compartilhada.
- [ ] Confirmar que nome de documento IRIS (`name` em `/documents/:name`) não precisa da mesma
      sanitização porque nunca vira path de filesystem local — só é usado como segmento de URL
      (`encodeURIComponent`) contra a API Atelier. Documentar essa distinção se não estiver clara.
- [ ] Revisar `ApiTester`/`callRestRoute`: o `path` vem de entrada do usuário e é concatenado
      direto na URL — confirmar que isso é intencional (o usuário está testando a própria rota do
      seu servidor) e não um vetor de SSRF adicional além do que o próprio usuário já controla
      (host/porta da conexão).

## Fase 3 — Nenhum dado de servidor no cliente

- [ ] Grep por `localStorage.setItem` em `src/**` e confirmar que cada chamada grava só preferência
      local (tema, diretório escolhido, id de sessão do agente) — nunca senha, token, ou conteúdo
      de documento/query.
- [ ] Confirmar que nenhum valor de retorno de `ipcMain.handle` em `electron/ipc.ts` inclui a senha
      da conexão (checar especificamente `connections:list` e `connections:save`).
- [ ] Confirmar que o diretório de projeto do agente (`agent-projects/<connectionId>/<namespace>`)
      continua contendo só `opencode.json` + `AGENTS.md` — nunca cache de código-fonte do servidor.

## Fase 4 — Aprovação humana para escrita

- [ ] Confirmar que não existe nenhum caminho (atual ou futuro) que chame
      `atelier.saveDocument`/`atelier.compileDocuments` a partir do fluxo do agente sem passar por
      `handleWrite` → `resolvePendingWrite(pendingId, true)`.
- [ ] Ao adicionar uma nova ferramenta MCP que possa gravar algo no servidor, replicar o mesmo
      padrão de "fica pendente até aprovação" — não assumir que é seguro por analogia com
      `specs_write` (que é intencionalmente direto, mas só porque specs não afetam o servidor).

## Fase 5 — Isolamento Electron

- [ ] Toda nova `BrowserWindow` criada (hoje: janela principal em `main.ts`, janela CSP em
      `studioCspWindow.ts`) mantém `contextIsolation: true`, `nodeIntegration: false`.
- [ ] Toda nova função exposta em `preload.ts` é tipada e específica — nunca um canal que aceite
      comando/`eval` arbitrário vindo do renderer.

## Validação

- [ ] `vp check` (format + lint + type check) e `vp test` passam.
- [ ] Teste manual: aprovar e rejeitar uma proposta de escrita do agente, confirmar que rejeição
      não grava nada no servidor e que aprovação seguida de erro de rede reporta `saved: false`
      (não confunde com rejeição).
- [ ] Teste manual: fechar o app com um agente rodando e confirmar (Gerenciador de Tarefas / `ps`)
      que não sobra processo `opencode` órfão.
