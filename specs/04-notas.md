# Notas e Decisões

## Perguntas em aberto

- O agente hoje é limitado a um por vez **no app inteiro** (não por namespace/conexão) — isso
  continua sendo o comportamento desejado à medida que mais servidores/namespaces forem usados em
  paralelo, ou vale investir em um limite por conexão (mais permissivo) em vez de global?
- `getDocumentReadOnlyStatus` ignora erro silenciosamente quando a query a `%Dictionary` ou ao
  bridge de source control falha (permissão insuficiente, versão antiga do IRIS) — isso é correto
  como "não sabemos, então trata como editável", mas vale expor esse "não sabemos" na UI em vez de
  aparentar certeza?
- `searchInFiles` (API v2) não foi verificado contra um servidor real no momento em que foi escrito
  (ver comentário em `atelier.ts`) — o "shape guard" cobre o formato inesperado, mas seria bom
  validar contra uma versão real de IRIS 2023.1+ assim que disponível.
- `callRestRoute` deixa o usuário testar qualquer path/host:porta da própria conexão — isso é por
  design (é o host que o próprio usuário configurou), mas se no futuro a conexão puder ser
  compartilhada/importada de outro usuário, vale revisitar se isso ainda é seguro por padrão.

## Decisões tomadas

- **safeStorage sem fallback em texto puro** — se a criptografia do SO não estiver disponível, a
  senha simplesmente não é persistida (usuário reinsere na próxima sessão) em vez de gravar em
  `secrets.json` sem proteção. Motivo: perder conveniência é preferível a expor credencial em
  texto puro no disco.
- **`ignoreConflict: true` no save de documento** — este é um app single-user sem cache local do
  `mtime` do servidor, então o controle de concorrência otimista da API Atelier não tem uma
  baseline válida para comparar e sempre acusaria 409 falso-positivo. Aceito como tradeoff de um
  app de usuário único, não algo a "corrigir" adicionando cache de mtime sem necessidade real.
- **Specs (`.md`) não passam por aprovação humana ao serem escritas pelo agente** — diferente de
  documento IRIS. Motivo: specs são notas locais, não compilam, não têm efeito colateral no
  servidor. Ver constituição — não misturar os dois modelos de confiança.
- **Diretório de projeto do agente (`agent-projects/…`) é só configuração** — `opencode` precisa
  de um diretório real para rodar, mas todo acesso a código/specs passa pelas ferramentas MCP, não
  pelo filesystem local desse diretório. `permission: { write: deny, edit: deny, bash: deny }` no
  `opencode.json` gerado reforça isso no nível do próprio opencode, não só por convenção.
- **`opencodeBin()` resolve o binário `.exe` direto, não o shim `.CMD` do pnpm** — necessário para
  que `taskkill /T` (Windows) realmente mate a árvore de processos ao abortar/fechar o app.
